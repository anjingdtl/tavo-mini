/**
 * Compatibility-only continuation chain for historical V5 entry wrappers.
 * Production enters the shared Writing Stage Set directly and never imports
 * this module.
 */
import { ensureContinuationStageLedger } from '../../../writing/stages/continuationStageCapabilities';
import type { V5PipelineOptions } from '../../../writing/stages/continuationStageCapabilities';
import {
  runContinuationDraftCapability,
  runContinuationProofCapability,
  runContinuationRevisionAndAuditCapability,
} from './continuationV5Writers';
import type {
  ContinuationContextSnapshotV5,
  ContinuationContextTrace,
  ContinuationGenerationRun,
} from '../types';

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('用户取消'), { code: 'cancelled' });
  }
}

export async function runContinuationCapabilityChain(
  run: ContinuationGenerationRun,
  snapshot: ContinuationContextSnapshotV5,
  trace: ContinuationContextTrace,
  options: V5PipelineOptions,
): Promise<void> {
  assertNotAborted(options.signal);
  await ensureContinuationStageLedger(snapshot, run.id);
  const draft = await runContinuationDraftCapability(run, snapshot, options);
  assertNotAborted(options.signal);
  const revision = await runContinuationRevisionAndAuditCapability(
    run,
    snapshot,
    options,
    draft.draftArtifact,
    draft.architecture,
    draft.architectureHash,
  );
  assertNotAborted(options.signal);
  await runContinuationProofCapability(
    run,
    snapshot,
    trace,
    options,
    revision.revisionArtifact,
    draft.architecture,
    draft.architectureHash,
    revision.audit,
    revision.auditContractHash,
    draft.architectureDegraded,
    revision.auditorDegraded,
  );
}
