/**
 * Continuation durable ledger helpers only.
 *
 * Writer LLM, prompt compilation, revision and final reviser authority live
 * in the shared Writing Stage Set. This module may persist stage rows and
 * record durable failures.
 */
import {
  appendContinuationGenerationTraceEvent,
} from '../../continuation/generation/continuationGenerationTrace';
import {
  casUpdateRunState,
  ensureContinuationV5StageResults,
} from '../../continuation/generation/generationRepository';
import {
  ContinuationCapabilityBlockedError,
  ContinuationStageOutputTruncatedError,
} from '../../continuation/generation/types';
import type {
  ContinuationContextSnapshotV5,
  ContinuationContextTrace,
} from '../../continuation/generation/types';
import {
  formatUnknownError,
  formatUnknownErrorCode,
} from '../../continuation/generation/errorFormat';
import type { StageLlmCaller } from '../scenario/continuationWritingTypes';

export interface V5PipelineOptions {
  callStage?: StageLlmCaller;
  deterministicOnly?: boolean;
  signal: AbortSignal;
  projectId: number;
}

export async function ensureContinuationStageLedger(
  snapshot: ContinuationContextSnapshotV5,
  runId: string,
  opts?: { compactTopology?: boolean },
): Promise<void> {
  await ensureContinuationV5StageResults({
    runId,
    compactOnly: opts?.compactTopology,
    stages: {
      draft_writer: {
        configId: snapshot.stageBudgets.draft_writer.configId,
        compiledPromptTokens:
          snapshot.stageBudgets.draft_writer.compiledPromptTokens,
        minimumOutputTokens:
          snapshot.stageBudgets.draft_writer.minimumOutputTokens,
        maximumOutputTokens:
          snapshot.stageBudgets.draft_writer.maximumOutputTokens,
      },
      narrative_architect: {
        configId: snapshot.stageBudgets.narrative_architect.configId,
        compiledPromptTokens:
          snapshot.stageBudgets.narrative_architect.compiledPromptTokens,
        minimumOutputTokens:
          snapshot.stageBudgets.narrative_architect.minimumOutputTokens,
        maximumOutputTokens:
          snapshot.stageBudgets.narrative_architect.maximumOutputTokens,
      },
      revision_writer: {
        configId: snapshot.stageBudgets.revision_writer.configId,
        compiledPromptTokens:
          snapshot.stageBudgets.revision_writer.compiledPromptTokens,
        minimumOutputTokens:
          snapshot.stageBudgets.revision_writer.minimumOutputTokens,
        maximumOutputTokens:
          snapshot.stageBudgets.revision_writer.maximumOutputTokens,
      },
      adversarial_auditor: {
        configId: snapshot.stageBudgets.adversarial_auditor.configId,
        compiledPromptTokens:
          snapshot.stageBudgets.adversarial_auditor.compiledPromptTokens,
        minimumOutputTokens:
          snapshot.stageBudgets.adversarial_auditor.minimumOutputTokens,
        maximumOutputTokens:
          snapshot.stageBudgets.adversarial_auditor.maximumOutputTokens,
      },
      // Phase 4 §7.2: the unified_qa ledger row carries the compact Standard
      // ONE QA call. The compact driver always writes this row, even when the
      // legacy auditor row stays empty for legacy resume.
      unified_qa: {
        configId: snapshot.stageBudgets.adversarial_auditor.configId,
        compiledPromptTokens:
          snapshot.stageBudgets.adversarial_auditor.compiledPromptTokens,
        minimumOutputTokens:
          snapshot.stageBudgets.adversarial_auditor.minimumOutputTokens,
        maximumOutputTokens:
          snapshot.stageBudgets.adversarial_auditor.maximumOutputTokens,
      },
      final_reviser: {
        configId: snapshot.stageBudgets.final_reviser.configId,
        compiledPromptTokens:
          snapshot.stageBudgets.final_reviser.compiledPromptTokens,
        minimumOutputTokens:
          snapshot.stageBudgets.final_reviser.minimumOutputTokens,
        maximumOutputTokens:
          snapshot.stageBudgets.final_reviser.maximumOutputTokens,
      },
    },
  });
}

export async function finalizeContinuationCapabilityError(
  runId: string,
  error: unknown,
  trace?: ContinuationContextTrace,
): Promise<void> {
  try {
    const message = formatUnknownError(error);
    const code =
      error instanceof ContinuationStageOutputTruncatedError
        ? 'draft_writer_output_truncated'
        : error instanceof ContinuationCapabilityBlockedError
        ? error.code
        : formatUnknownErrorCode(error, 'stage_failed');
    const isRegenerate =
      code.startsWith('revision_') ||
      code.startsWith('final_') ||
      code === 'revision_writer_failed' ||
      code === 'revision_writer_output_truncated' ||
      code === 'revision_writer_reserved_without_artifact' ||
      code === 'final_soft_promote_failed';
    await casUpdateRunState(
      runId,
      ['running', 'queued', 'awaiting_user', 'awaiting_regeneration', 'failed'],
      {
        state: isRegenerate ? 'awaiting_regeneration' : 'failed',
        stage: 'awaiting_user',
        errorCode: code,
        errorMessage: isRegenerate
          ? `${message} 本次不会自动回退到初稿或第一次修订稿。`
          : message,
        contextTraceJson: trace
          ? JSON.stringify(
              appendContinuationGenerationTraceEvent(trace, {
                event: isRegenerate ? 'awaiting_regeneration' : 'failed',
                state: isRegenerate ? 'awaiting_regeneration' : 'failed',
                stage: 'awaiting_user',
                reason: code,
                eligibility: {
                  status: isRegenerate ? 'rejected' : 'unknown',
                  rejectionCode: isRegenerate ? code : null,
                },
              }),
            )
          : undefined,
        completedAt: isRegenerate ? null : new Date().toISOString(),
      },
    );
  } catch {
    // best-effort
  }
}
