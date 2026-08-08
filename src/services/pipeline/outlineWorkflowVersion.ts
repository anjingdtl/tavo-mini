/**
 * Outline pipeline workflow version (V5-Lite) decision.
 *
 * `outlineWorkflowVersion` is frozen ONCE into PipelineExecutionSnapshot at
 * first task start; resume always uses the frozen value. The default here is
 * the rollback switch described in the V5-Lite plan §4.4: flipping it back to
 * 1 makes all FUTURE tasks use Legacy semantics without touching frozen tasks.
 */
export type OutlineWorkflowVersion = 1 | 2;

/**
 * Default workflow version for newly frozen outline chapter tasks.
 * Keep 1 in production until real-chapter A/B passes; flip to 2 in a
 * dedicated commit after validation.
 */
export const DEFAULT_OUTLINE_WORKFLOW_VERSION: OutlineWorkflowVersion = 1;

/**
 * Pure gate for freezing V2 on a real outline chapter task.
 *
 * V2 enable conditions (§4.2):
 *   - project mode === 'outline'
 *   - targetType === 'chapter' (chapter.id > 0; freeform pseudo-chapters use id 0)
 *   - default version === 2
 *
 * Project creation time and existing chapter body length never participate.
 */
export function shouldFreezeOutlineWorkflowV2(params: {
  projectMode: string | null | undefined;
  chapterId: number;
  defaultVersion?: OutlineWorkflowVersion;
}): boolean {
  if (params.projectMode !== 'outline') return false;
  if (!Number.isInteger(params.chapterId) || params.chapterId <= 0) return false;
  return (params.defaultVersion ?? DEFAULT_OUTLINE_WORKFLOW_VERSION) === 2;
}
