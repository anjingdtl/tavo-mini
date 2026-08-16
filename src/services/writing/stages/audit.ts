import type {
  SharedWritingStageInput,
  SharedWritingStageResult,
} from '../contracts/writingStage';
import { runSharedStage } from './sharedStage';

export async function runAuditStage<T = unknown>(
  input: SharedWritingStageInput,
): Promise<SharedWritingStageResult<T>> {
  return runSharedStage<T>({ stage: 'audit', stageInput: input });
}
