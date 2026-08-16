/**
 * Outline capability provider for the shared Writing Stage Set.
 *
 * It supplies the legacy durable SQLite/checkpoint operation to the shared
 * stage boundary. It does not schedule stages or own Freeze; those remain in
 * `runWritingStages` and `runWritingKernel`.
 */
export {
  runOutlineWritingCapability,
} from '../../pipeline/outlineStageRuntime';
