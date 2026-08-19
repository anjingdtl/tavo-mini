/**
 * Phase 2 (二期) Phase 0 baseline — Standard Pipeline cost & call graph.
 *
 * Observe-only: this test does NOT change production behavior. It pins the
 * CURRENT (pre-compact) production call graph and proves the four measurement
 * axes (Logical / Formatter / Physical / Protocol Fallback) are distinct and
 * aggregatable per chapter × stage. The real-LLM 2+2+1+1 samples are the
 * Phase 3 / Phase 7 acceptance target; this structural baseline derives the
 * same topology from the real Freeze pipeline (same precedent as the Phase 1
 * ONE-Flow structural baseline).
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import {
  WRITING_STAGE_DAG,
  writingStageDependencies,
} from '../src/services/writing/stages/writingStageDag';
import {
  beginWritingStageTiming,
  bindWritingObservabilityCollector,
  endWritingStageTiming,
  finalizeWritingKernelObservability,
  measureStructuralChapterObservability,
  recordWritingLlmCall,
  resetWritingObservabilityForTests,
  snapshotWritingObservability,
} from '../src/services/writing';
import {
  continuationRequest,
  outlineRequest,
} from './helpers/oneShotFixtures';

beforeEach(() => {
  resetWritingObservabilityForTests();
});

describe('Phase 2 Phase 0 — Standard Pipeline baseline', () => {
  test('B1: current production DAG is explicitly authoritative', () => {
    // The shared kernel DAG is the single source of truth for stage order.
    const serial = WRITING_STAGE_DAG.filter(node => node.parallelGroup === null).map(
      node => node.stage,
    );
    expect(serial).toEqual([
      'draft',
      'revision',
      'proof',
      'finalValidate',
      'persist',
    ]);
    const qa = WRITING_STAGE_DAG.filter(node => node.parallelGroup === 'qa').map(
      node => node.stage,
    );
    expect(qa).toEqual(['review', 'audit', 'factCheck']);
    expect(writingStageDependencies('revision')).toEqual([
      'draft',
      'review',
      'audit',
      'factCheck',
    ]);
    expect(writingStageDependencies('proof')).toEqual(['revision']);
  });

  test('B2: Standard call graph per source adapter (structural), 2+2+1+1 shape', () => {
    const outlineA = measureStructuralChapterObservability({
      frozenContext: buildWritingKernelFreezeTrace({
        request: { ...outlineRequest({}), writingRunId: 'wr-base-out-a' },
      }).frozenContext,
      sampleKind: 'outline_standard',
    });
    const outlineB = measureStructuralChapterObservability({
      frozenContext: buildWritingKernelFreezeTrace({
        request: { ...outlineRequest({}), writingRunId: 'wr-base-out-b' },
      }).frozenContext,
      sampleKind: 'outline_standard',
    });
    const continuationA = measureStructuralChapterObservability({
      frozenContext: buildWritingKernelFreezeTrace({
        request: { ...continuationRequest({}), writingRunId: 'wr-base-con-a' },
      }).frozenContext,
      sampleKind: 'continuation_standard',
    });
    const continuationB = measureStructuralChapterObservability({
      frozenContext: buildWritingKernelFreezeTrace({
        request: { ...continuationRequest({}), writingRunId: 'wr-base-con-b' },
      }).frozenContext,
      sampleKind: 'continuation_standard',
    });
    const oneShotOutline = measureStructuralChapterObservability({
      frozenContext: buildWritingKernelFreezeTrace({
        request: outlineRequest({ executionProfile: 'one_shot' }),
      }).frozenContext,
      sampleKind: 'one_shot',
    });
    const oneShotContinuation = measureStructuralChapterObservability({
      frozenContext: buildWritingKernelFreezeTrace({
        request: continuationRequest({ executionProfile: 'one_shot' }),
      }).frozenContext,
      sampleKind: 'one_shot',
    });

    const outlineStages = paidStages(outlineA);
    expect(outlineStages).toEqual([
      'draft',
      'review',
      'factCheck',
      'revision',
      'proof',
    ]);
    expect(outlineA.llm.logicalStageCallCount).toBe(5);
    expect(outlineA.llm.chapterWritingPaidCallCount).toBe(5);

    const continuationStages = paidStages(continuationA);
    expect(continuationStages).toEqual([
      'draft',
      'review',
      'audit',
      'revision',
      'proof',
    ]);
    expect(continuationA.llm.logicalStageCallCount).toBe(5);

    // Same compact-standard target: both adapters stay on ONE kernel; only
    // the frozen skip rules differ (audit vs factCheck coverage).
    expect(oneShotOutline.llm.chapterWritingPaidCallCount).toBe(1);
    expect(oneShotContinuation.llm.chapterWritingPaidCallCount).toBe(1);
    expect(paidStages(oneShotOutline)).toEqual(['draft']);
    expect(paidStages(oneShotContinuation)).toEqual(['draft']);

    // Stage-level snapshots: every paid stage carries the four counters.
    for (const sample of [outlineA, outlineB, continuationA, continuationB]) {
      for (const stage of sample.stages) {
        expect(stage).toMatchObject({
          logicalStageCallCount: expect.any(Number),
          formatterCallCount: expect.any(Number),
          physicalRequestCount: expect.any(Number),
          protocolFallbackCount: expect.any(Number),
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
        });
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      note:
        'structural baseline: same Standard Pipeline topology derived from the real Freeze pipeline; no LLM paid',
      outlineStandard: [summarize(outlineA), summarize(outlineB)],
      continuationStandard: [summarize(continuationA), summarize(continuationB)],
      oneShot: [summarize(oneShotOutline), summarize(oneShotContinuation)],
    };
    const reportDir = path.join(__dirname, '..', 'test-logs');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, 'phase2-structural-baseline.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  });

  test('B3: Logical / Formatter / Physical / Protocol-fallback are distinct and per-chapter aggregatable', () => {
    const { trace } = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    bindWritingObservabilityCollector(trace);
    const genId = trace.generationTraceId;

    // Two logical stages + one formatter + one protocol fallback on one stage.
    beginWritingStageTiming(genId, 'draft');
    recordWritingLlmCall(genId, {
      kind: 'logical_stage',
      stage: 'draft',
      inputTokens: 100,
      outputTokens: 50,
      physicalRequestCount: 2, // one fallback
      protocolFallbackCount: 1,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      durationMs: 30,
    });
    endWritingStageTiming({ generationTraceId: genId, stage: 'draft', status: 'completed' });

    beginWritingStageTiming(genId, 'review');
    recordWritingLlmCall(genId, {
      kind: 'logical_stage',
      stage: 'review',
      inputTokens: 200,
      outputTokens: 60,
      physicalRequestCount: 1,
      protocolFallbackCount: 0,
      promptCacheHitTokens: 10,
      promptCacheMissTokens: 190,
      durationMs: 40,
    });
    recordWritingLlmCall(genId, {
      kind: 'formatter',
      stage: 'review',
      inputTokens: 300,
      outputTokens: 20,
      physicalRequestCount: 1,
      protocolFallbackCount: 0,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      durationMs: 25,
    });
    endWritingStageTiming({ generationTraceId: genId, stage: 'review', status: 'completed' });

    const snap = snapshotWritingObservability(trace);
    expect(snap).toBeDefined();
    expect(snap!.llm.logicalStageCallCount).toBe(2);
    expect(snap!.llm.formatterCallCount).toBe(1);
    expect(snap!.llm.physicalRequestCount).toBe(4);
    expect(snap!.llm.protocolFallbackCount).toBe(1);
    expect(snap!.llm.chapterWritingPaidCallCount).toBe(3);
    expect(snap!.llm.inputTokens).toBe(600);
    expect(snap!.llm.outputTokens).toBe(130);

    const draftStage = snap!.stages.find(item => item.stage === 'draft')!;
    const reviewStage = snap!.stages.find(item => item.stage === 'review')!;
    expect(draftStage).toMatchObject({
      logicalStageCallCount: 1,
      formatterCallCount: 0,
      physicalRequestCount: 2,
      protocolFallbackCount: 1,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(reviewStage).toMatchObject({
      logicalStageCallCount: 1,
      formatterCallCount: 1,
      physicalRequestCount: 2,
      protocolFallbackCount: 0,
      inputTokens: 500,
      outputTokens: 80,
    });

    // Per-chapter aggregation over the stage table (the Phase-2 §10.2 metric).
    const aggregate = {
      logical: snap!.stages.reduce((sum, s) => sum + s.logicalStageCallCount, 0),
      formatter: snap!.stages.reduce((sum, s) => sum + s.formatterCallCount, 0),
      physical: snap!.stages.reduce((sum, s) => sum + s.physicalRequestCount, 0),
      fallback: snap!.stages.reduce((sum, s) => sum + s.protocolFallbackCount, 0),
      inputTokens: snap!.stages.reduce((sum, s) => sum + s.inputTokens, 0),
      outputTokens: snap!.stages.reduce((sum, s) => sum + s.outputTokens, 0),
      executionMs: snap!.stages.reduce((sum, s) => sum + s.stageExecutionMs, 0),
    };
    expect(aggregate).toEqual({
      logical: 2,
      formatter: 1,
      physical: 4,
      fallback: 1,
      inputTokens: 600,
      outputTokens: 130,
      executionMs: expect.any(Number),
    });
  });

  test('B4: finalizeWritingKernelObservability attaches the snapshot to the trace', () => {
    const { trace, frozenContext } = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    bindWritingObservabilityCollector(trace, frozenContext);
    const genId = trace.generationTraceId;
    beginWritingStageTiming(genId, 'draft');
    recordWritingLlmCall(genId, {
      kind: 'logical_stage',
      stage: 'draft',
      inputTokens: 5,
      outputTokens: 5,
      physicalRequestCount: 1,
      protocolFallbackCount: 0,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      durationMs: 1,
    });
    endWritingStageTiming({ generationTraceId: genId, stage: 'draft', status: 'completed' });
    const finalized = finalizeWritingKernelObservability(trace, frozenContext);
    expect(finalized.observability).toBeDefined();
    expect(finalized.observability!.generationTraceId).toBe(genId);
    expect(finalized.observability!.stages.map(s => s.stage)).toContain('draft');
    expect(finalized.observability!.freezeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

function paidStages(
  sample: ReturnType<typeof measureStructuralChapterObservability>,
): string[] {
  return sample.stages
    .filter(stage => stage.status !== 'skipped')
    .map(stage => stage.stage);
}

function summarize(
  sample: ReturnType<typeof measureStructuralChapterObservability>,
) {
  return {
    generationTraceId: sample.generationTraceId,
    freezeFingerprint: sample.freezeFingerprint,
    scenario: sample.scenario,
    executionProfile: sample.executionProfile,
    paidStages: paidStages(sample),
    chapterWritingPaidCallCount: sample.llm.chapterWritingPaidCallCount,
    logicalStageCallCount: sample.llm.logicalStageCallCount,
    formatterCallCount: sample.llm.formatterCallCount,
    physicalRequestCount: sample.llm.physicalRequestCount,
    protocolFallbackCount: sample.llm.protocolFallbackCount,
    stageProjectedContextTokens: sample.context.stageProjectedContextTokens,
    duplicateContextTokens: sample.context.duplicateContextTokens,
    duplicateContextRatio: sample.context.duplicateContextRatio,
    perStage: sample.stages.map(stage => ({
      stage: stage.stage,
      status: stage.status,
      logicalStageCallCount: stage.logicalStageCallCount,
      formatterCallCount: stage.formatterCallCount,
      physicalRequestCount: stage.physicalRequestCount,
      protocolFallbackCount: stage.protocolFallbackCount,
      inputTokens: stage.inputTokens,
      outputTokens: stage.outputTokens,
      projectedTokens: stage.projectedTokens,
      frozenContextTokens: stage.frozenContextTokens,
    })),
  };
}