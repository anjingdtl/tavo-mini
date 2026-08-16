/**
 * Outline's durable substrate adapter. It owns checkpoint/SQLite details only;
 * the shared stage functions decide when this operation is invoked.
 */
export {
  runOutlineWritingCapability as runOutlineStageOperation,
} from './outlineWritingCapability';
