import type {
  BatchChapterSummary,
  BatchMainlinePatch,
  MainlineChangeResult,
  StoryMemoryBatchPatchDraft,
} from './storyMemoryTypes';

/**
 * Deterministic reconciler for the Story Memory
 * `chapterSummaries ↔ mainlinePatch` classification contract.
 *
 * 背景：真实复杂长篇测试中，模型多次返回 HTTP 200，但
 * `chapterSummaries` 写了主线变化/新线索/已解决事项，而结构化 `mainlinePatch`
 * 没有对应的 mutation（`currentArcUpdate.action='none'` 且各 op 数组为空）。
 * 旧的 `validateBatchMainlineSummaryConsistency` 会一律判定为
 * `MEMORY_CHECKPOINT_SCHEMA_INVALID`，进入 paid Repair / Fresh Retry，三次后
 * fail closed，白白消耗了真实 API 配额。
 *
 * 本函数在严格结构化校验**之前**做一次本地收束：把仅属于「检索摘要分类差异」
 * 的内容从 mainline 分类字段降级为 `events[]`（信息仍保留，可用于检索），并保证
 * Structured State 始终是唯一的持久事实权威。它**绝不**从 Summary 反向制造
 * thread / conflict / objective 等长期状态。
 *
 * 治理方案 §4 规则 A-E 的本地实现。只产出 diagnostics 供 log/QA/tests，不写库。
 */

export interface StoryMemoryMainlineReconcileDiagnostics {
  /** Summary.mainlineChanges 被降级为 events 的条数。 */
  downgradedMainlineChanges: number;
  /** Summary.newThreads 被降级为 events 的条数。 */
  downgradedNewThreads: number;
  /** Summary.resolvedThreads 被降级为 events 的条数。 */
  downgradedResolvedThreads: number;
  /** 被本地归一化的 assessment 结果（'changed'|'unchanged'），未改动时为 null。 */
  normalizedAssessment: MainlineChangeResult | null;
}

export interface StoryMemoryMainlineReconcileResult {
  reconciledDraft: StoryMemoryBatchPatchDraft;
  diagnostics: StoryMemoryMainlineReconcileDiagnostics;
}

/**
 * Batch-level mainline mutation detector.
 *
 * Mirror of the chapter-level `hasMainlineStateMutation` in storyMemoryValidator
 * — the five user-visible mainline fields. `timelineAnchors` / `completedBeats`
 * are deliberately excluded (they are retrieval-only, not persistent mainline
 * state), exactly as in the chapter-level helper.
 */
export function hasBatchMainlineStateMutation(
  patch: BatchMainlinePatch,
): boolean {
  return Boolean(
    patch.currentArcUpdate.action !== 'none' ||
      patch.currentObjective ||
      patch.conflictUpserts.length > 0 ||
      (patch.conflictResolutions?.length ?? 0) > 0 ||
      patch.threadOpens.length > 0 ||
      patch.threadUpdates.length > 0 ||
      patch.threadResolutions.length > 0 ||
      patch.foreshadowingUpserts.length > 0,
  );
}

/**
 * Whether the batch mainline patch carries a structured closure op for Rule C.
 * Mirrors `validateBatchMainlineSummaryConsistency`'s closure check.
 */
function hasBatchStructuredClosure(patch: BatchMainlinePatch): boolean {
  return (
    patch.threadResolutions.length > 0 ||
    patch.conflictResolutions.length > 0 ||
    patch.currentArcUpdate.action === 'complete' ||
    patch.currentArcUpdate.action === 'replace' ||
    patch.foreshadowingUpserts.some(item => item.status === 'paid')
  );
}

/**
 * Reconcile one Story Memory batch draft's mainline-classification divergence
 * against its structured mainline patch, in place of a paid Repair round.
 *
 * 不可变性：返回新的 draft 对象与新的 chapterSummaries / mainlinePatch 浅拷贝；
 * 原始 draft 不被修改（调用方常需要对同一原始输出做多次尝试）。
 */
export function reconcileStoryMemoryMainlineDraft(
  draft: StoryMemoryBatchPatchDraft,
): StoryMemoryMainlineReconcileResult {
  const diagnostics: StoryMemoryMainlineReconcileDiagnostics = {
    downgradedMainlineChanges: 0,
    downgradedNewThreads: 0,
    downgradedResolvedThreads: 0,
    normalizedAssessment: null,
  };

  const mainline = draft.mainlinePatch;
  const hasMutation = hasBatchMainlineStateMutation(mainline);
  const hasClosure = hasBatchStructuredClosure(mainline);

  // Rules A/B/C: only downgrade when the structured side genuinely has no op.
  // If structured mutation/closure exists, the strict validator will consider
  // the contract satisfied; leave the summary text untouched (information-rich).
  const needDowngradeMainline = !hasMutation;
  const needDowngradeNewThreads =
    mainline.threadOpens.length === 0 && mainline.threadUpdates.length === 0;
  const needDowngradeResolvedThreads = !hasClosure;

  // Shallow-clone chapters so we never mutate caller state.
  const newSummaries: BatchChapterSummary[] = draft.chapterSummaries.map(
    summary => {
      let events = summary.events;
      let mainlineChanges = summary.mainlineChanges;
      let newThreads = summary.newThreads;
      let resolvedThreads = summary.resolvedThreads;

      const moveIntoEvents = (items: string[], label: string): string[] => {
        const meaningful = items.filter(item => item.trim().length > 0);
        if (meaningful.length === 0) return events;
        const tagged = meaningful.map(item => `[${label}] ${item.trim()}`);
        return events.concat(tagged);
      };

      const mainlineTexts = nonEmpty(summary.mainlineChanges);
      const newThreadTexts = nonEmpty(summary.newThreads);
      const resolvedThreadTexts = nonEmpty(summary.resolvedThreads);

      if (needDowngradeMainline && mainlineTexts.length > 0) {
        events = moveIntoEvents(summary.mainlineChanges, '主线');
        mainlineChanges = [];
        diagnostics.downgradedMainlineChanges += mainlineTexts.length;
      }
      if (needDowngradeNewThreads && newThreadTexts.length > 0) {
        events = moveIntoEvents(summary.newThreads, '新线索');
        newThreads = [];
        diagnostics.downgradedNewThreads += newThreadTexts.length;
      }
      if (needDowngradeResolvedThreads && resolvedThreadTexts.length > 0) {
        events = moveIntoEvents(summary.resolvedThreads, '已解决');
        resolvedThreads = [];
        diagnostics.downgradedResolvedThreads += resolvedThreadTexts.length;
      }

      if (
        events === summary.events &&
        mainlineChanges === summary.mainlineChanges &&
        newThreads === summary.newThreads &&
        resolvedThreads === summary.resolvedThreads
      ) {
        return summary;
      }
      return {
        ...summary,
        events,
        mainlineChanges,
        newThreads,
        resolvedThreads,
      };
    },
  );

  // Rules D/E: assessment ↔ mutation label normalization (label fix only,
  // never synthesizing or removing real state).
  const assessment = mainline.assessment;
  let newMainline = mainline;
  if (assessment) {
    if (assessment.result === 'unchanged' && hasMutation) {
      // Rule D: real mutation exists but labeled unchanged → flip to changed.
      newMainline = {
        ...mainline,
        assessment: {
          result: 'changed',
          reason: assessment.reason.trim()
            ? assessment.reason
            : '检测到主线结构化变化。',
        },
      };
      diagnostics.normalizedAssessment = 'changed';
    } else if (assessment.result === 'changed' && !hasMutation) {
      // Rule E: no mutation but labeled changed → flip to unchanged.
      newMainline = {
        ...mainline,
        assessment: {
          result: 'unchanged',
          reason: assessment.reason.trim()
            ? assessment.reason
            : '未检测到主线结构化变化。',
        },
      };
      diagnostics.normalizedAssessment = 'unchanged';
    }
  }

  const reconciledDraft: StoryMemoryBatchPatchDraft = {
    ...draft,
    chapterSummaries: newSummaries,
    mainlinePatch: newMainline,
  };

  return { reconciledDraft, diagnostics };
}

function nonEmpty(items: string[]): string[] {
  return (items ?? []).filter(item => item?.trim().length > 0);
}

/**
 * Convenience type alias for tests / callers that build a batch draft inline.
 * The reconciler only reads `chapterSummaries` and `mainlinePatch`.
 */
export type BatchDraftWithMainline = StoryMemoryBatchPatchDraft;
