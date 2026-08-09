import {
  DEFAULT_BRIEF_TRIGGER_POLICY,
  briefRequiredSourceIds,
  type BriefCompilerInputV1,
  type BriefTriggerPolicy,
} from './briefCompilerTypes';

export interface BriefTriggerDecision {
  callApi: boolean;
  reasons: string[];
  requiredCount: number;
  executableCount: number;
  protectedCount: number;
  normalizedChars: number;
}

/** Pure complexity trigger. No draft, database, settings or LLM access. */
export function shouldCallBriefCompiler(
  input: BriefCompilerInputV1,
  policy: BriefTriggerPolicy = DEFAULT_BRIEF_TRIGGER_POLICY,
): BriefTriggerDecision {
  const reviewItems = [
    ...(input.review?.executableCorrections || []),
    ...(input.review?.unlocatedRequired || []),
  ];
  const factItems = input.factCheck?.corrections || [];
  const allItems = [...reviewItems, ...factItems];
  const requiredCount = briefRequiredSourceIds(input).length;
  const executableCount = allItems.length;
  const protectedCount =
    (input.factCheck?.protectedFacts?.length || 0) +
    (input.factCheck?.hardConstraints?.length || 0);
  const normalizedChars = JSON.stringify(input).length;
  const reasons: string[] = [];

  if (requiredCount >= policy.minHardOrRequired) {
    reasons.push('hard/required 数量达到复杂度阈值');
  }
  if (executableCount >= policy.minAllExecutable) {
    reasons.push('可执行审核项数量达到复杂度阈值');
  }
  if ((input.review?.unlocatedRequired?.length || 0) > 0) {
    reasons.push('存在无法安全定位的 required/hard');
  }
  if (allItems.some(item =>
    (item.severity === 'hard' || item.severity === 'required') &&
    (item.locationHint === 'chapter' || item.locationHint === 'unlocated'),
  )) {
    reasons.push('存在章节级或无法定位的 hard/required');
  }
  if (
    protectedCount >= policy.minProtectedFactsAndConstraints
  ) {
    reasons.push('protectedFacts + hardConstraints 达到复杂度阈值');
  }
  if (
    (input.review?.outlineExecution.missingBeats.length || 0) > 0 ||
    (input.review?.outlineExecution.mustNotAdvance.length || 0) > 0
  ) {
    reasons.push('存在大纲缺失节点或不得提前推进边界');
  }
  if (input.review?.outlineExecution.endingGoal?.trim()) {
    reasons.push('存在章节结尾目标，需要语义归并');
  }
  if (normalizedChars > policy.maxNormalizedChars) {
    reasons.push('归一化审核输入超过字符阈值');
  }

  return {
    callApi: reasons.length > 0,
    reasons,
    requiredCount,
    executableCount,
    protectedCount,
    normalizedChars,
  };
}
