/**
 * Historical V5 compatibility boundary.
 *
 * Execution Compatibility is deliberately NO: unfinished V5 runs must not
 * re-enter the retired continuation Writer. New continuation work enters the
 * unified Writing Kernel through productionWritingEntry instead.
 */
import type { V5PipelineOptions } from '../../../writing/stages/continuationStageCapabilities';
import type {
  ContinuationContextSnapshotV5,
  ContinuationContextTrace,
  ContinuationGenerationRun,
} from '../types';
import { ContinuationOutdatedError } from '../types';

export async function runContinuationCapabilityChain(
  _run: ContinuationGenerationRun,
  _snapshot: ContinuationContextSnapshotV5,
  _trace: ContinuationContextTrace,
  _options: V5PipelineOptions,
): Promise<void> {
  throw new ContinuationOutdatedError(
    '历史 V5 续写执行态已废弃，请通过统一 Writing Kernel 重新发起。',
  );
}
