import type {
  FrozenWritingContext,
  WritingKernelTrace,
} from '../contracts/frozenWritingContext';
import type {
  SharedWritingStage,
  SharedWritingStageInput,
  SharedWritingStageResult,
  WritingDurablePersistAdapter,
  WritingStageArtifacts,
} from '../contracts/writingStage';
import { runAuditStage } from './audit';
import { runDraftStage } from './draft';
import { runFactCheckStage } from './factCheck';
import { runFinalValidateStage } from './finalValidate';
import { runPersistStage } from './persist';
import { runProofStage } from './proof';
import { runRevisionStage } from './revision';
import { runReviewStage } from './review';
import type { SemanticApplyCheckInput } from './semanticApply';
import type { StageLlmCaller } from '../scenario/continuationWritingTypes';
import { toFrozenStageModelConfig } from '../contracts/freezeModelConfig';
import {
  addWritingStagePersistMs,
  beginWritingStageTiming,
  bindWritingObservabilityCollector,
  endWritingStageTiming,
} from '../observability/writingObservabilityCollector';
import { nextWritingStageWave, readyWritingStages } from './writingStageDag';

export interface WritingStagesRunInput {
  frozenContext: FrozenWritingContext;
  trace: WritingKernelTrace;
  stages: SharedWritingStage[];
  artifacts?: WritingStageArtifacts;
  persistAdapter?: WritingDurablePersistAdapter;
  semanticApply?:
    | SemanticApplyCheckInput
    | (() => Promise<SemanticApplyCheckInput>);
  callStage?: StageLlmCaller;
  abortSignal?: AbortSignal;
}

/** The only stage dispatcher used after Freeze by both durable substrates. */
export async function runWritingStages(
  input: WritingStagesRunInput,
): Promise<SharedWritingStageResult[]> {
  bindWritingObservabilityCollector(input.trace, input.frozenContext);
  const artifacts: WritingStageArtifacts = { ...(input.artifacts || {}) };
  if (input.persistAdapter?.loadExisting) {
    for (const stage of [
      'draft',
      'review',
      'audit',
      'factCheck',
      'revision',
      'proof',
      'finalValidate',
    ] as const) {
      if (artifacts[stage]) continue;
      const existing = await input.persistAdapter.loadExisting(stage);
      if (existing?.body) artifacts[stage] = existing;
    }
  }

  const remaining = [...input.stages];
  const resultByStage = new Map<SharedWritingStage, SharedWritingStageResult>();
  const persistGate = { tail: Promise.resolve() };
  const executeOne = (stage: SharedWritingStage) =>
    executeWritingStage({
      stage,
      run: input,
      artifacts,
      persistGate,
    });

  while (remaining.length > 0) {
    const ready = readyWritingStages({
      remaining,
      stageOrder: input.stages,
    });
    if (ready.length === 0) {
      throw new Error(
        `WRITING_STAGE_DAG_DEADLOCK: ${remaining.join(', ')}`,
      );
    }
    const wave = nextWritingStageWave(ready);
    const waveResults = await Promise.all(wave.map(stage => executeOne(stage)));
    for (let index = 0; index < wave.length; index += 1) {
      const stage = wave[index];
      const result = waveResults[index];
      resultByStage.set(stage, result);
      if (result.artifact) artifacts[stage] = result.artifact;
      const persistAdapter = wrapPersistAdapterForObservability(
        input.persistAdapter,
        input.frozenContext.generationTraceId,
        stage,
        persistGate,
      );
      if (result.status === 'skipped') {
        await persistAdapter?.persistStageSkip?.(stage, result);
      } else if (result.status !== 'completed') {
        const error =
          result.error instanceof Error
            ? result.error
            : Object.assign(
                new Error(
                  `Shared ${stage} stage ${result.status}: ${result.diagnostics.join('; ')}`,
                ),
                { code: result.diagnostics[0] },
              );
        await persistAdapter?.persistStageFailure?.(stage, error);
        throw error;
      }
      const pos = remaining.indexOf(stage);
      if (pos >= 0) remaining.splice(pos, 1);
    }
  }

  return input.stages.map(stage => resultByStage.get(stage)!);
}

async function executeWritingStage(args: {
  stage: SharedWritingStage;
  run: WritingStagesRunInput;
  artifacts: WritingStageArtifacts;
  persistGate: { tail: Promise<void> };
}): Promise<SharedWritingStageResult> {
  const { stage, artifacts } = args;
  const input = args.run;
  const persistAdapter = wrapPersistAdapterForObservability(
    input.persistAdapter,
    input.frozenContext.generationTraceId,
    stage,
    args.persistGate,
  );
  beginWritingStageTiming(input.frozenContext.generationTraceId, stage);
  const stageInput: SharedWritingStageInput = {
    frozenContext: input.frozenContext,
    artifacts,
    requirements: input.frozenContext.requirements,
    stagePolicy: {
      ...input.frozenContext.stagePolicy,
      outputContract:
        input.frozenContext.stagePolicy.outputContract ||
        (input.frozenContext.stagePolicy.reviewMode === 'continuation-v5'
          ? 'json_envelope'
          : 'prose'),
      skipRules: input.frozenContext.stagePolicy.skipRules || {},
    },
    modelConfig: toFrozenStageModelConfig(input.frozenContext.model),
    trace: input.trace,
    semanticApply: input.semanticApply,
    persistAdapter,
    callStage: input.callStage,
    abortSignal: input.abortSignal,
  };
  let result: SharedWritingStageResult;
  switch (stage) {
    case 'draft':
      result = await runDraftStage(stageInput);
      break;
    case 'review':
      result = await runReviewStage(stageInput);
      break;
    case 'audit':
      result = await runAuditStage(stageInput);
      break;
    case 'factCheck':
      result = await runFactCheckStage(stageInput);
      break;
    case 'revision':
      result = await runRevisionStage(stageInput);
      break;
    case 'proof':
      result = await runProofStage(stageInput);
      break;
    case 'finalValidate':
      result = await runFinalValidateStage(stageInput);
      break;
    case 'persist':
      result = await runPersistStage(stageInput);
      break;
  }
  endWritingStageTiming({
    generationTraceId: input.frozenContext.generationTraceId,
    stage,
    status: result.status,
    skipReason: result.skipReason,
    policyRuleId: result.policyRuleId,
    frozenContext: input.frozenContext,
    artifacts,
  });
  return result;
}

function wrapPersistAdapterForObservability(
  adapter: WritingDurablePersistAdapter | undefined,
  generationTraceId: string,
  stage: SharedWritingStage,
  persistGate?: { tail: Promise<void> },
): WritingDurablePersistAdapter | undefined {
  if (!adapter) return adapter;
  const time = async <T>(work: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    const run = async () => {
      try {
        return await work();
      } finally {
        addWritingStagePersistMs(generationTraceId, stage, Date.now() - startedAt);
      }
    };
    if (!persistGate) return run();
    const queued = persistGate.tail.then(run, run);
    persistGate.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };
  return {
    ...adapter,
    loadExisting: adapter.loadExisting
      ? (name => adapter.loadExisting!(name))
      : undefined,
    reserve: adapter.reserve
      ? name => time(() => adapter.reserve!(name))
      : undefined,
    persistStageArtifact: (name, artifact) =>
      time(() => adapter.persistStageArtifact(name, artifact)),
    persistStageFailure: adapter.persistStageFailure
      ? (name, error) => time(() => adapter.persistStageFailure!(name, error))
      : undefined,
    persistStageSkip: adapter.persistStageSkip
      ? (name, result) => time(() => adapter.persistStageSkip!(name, result))
      : undefined,
    persistFinal: adapter.persistFinal
      ? artifacts => time(() => adapter.persistFinal!(artifacts))
      : undefined,
  };
}
