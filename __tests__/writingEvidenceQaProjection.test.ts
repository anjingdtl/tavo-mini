/**
 * B4 — Evidence QA Projection（§7: Exact Draft + Chapter Truth Projection
 * + Requirement Checklist + Relevant Evidence）。
 *
 * Red state：ONE QA 只有宽 union projection（12-kind allowlist），没有
 * chapterTruth 渲染、没有要求检查清单、没有相关证据过滤、没有 fail-safe。
 *
 * 验收（B4 绿）：
 *   1. 高置信（至少一个相关证据命中正文/接缝）→ Evidence Projection
 *      生效：QA 输入 = 【章节真相】+【要求检查清单】+【相关证据】+【已有初稿】，
 *      且比 union projection 更小（未被正文提及的 worldbook/人物被过滤）。
 *   2. 零命中 → fail-safe 回退（enabled=false，调用方沿用 union projection）。
 *   3. compileSharedWritingPrompt 集成：传 qaEvidence 时不再输出
 *      【冻结上下文】union 块。
 *   4. 观测：measureStageContextProjection('qa', …).projectedTokens > 0
 *      （isPaidStage 补 qa 后 stages[qa].projectedTokens 不再是 0）。
 */

import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import { projectFrozenContextForStage } from '../src/services/writing/context/stageContextProjection';
import { measureStageContextProjection, percentileTokens } from '../src/services/writing/observability/writingChapterObservability';
import { resolveQaEvidenceProjection } from '../src/services/writing/prompt/evidenceQaProjection';
import {
  continuationRequest,
  makeSource,
} from './helpers/oneShotFixtures';
import type { WritingRequest } from '../src/services/writing/contracts/writingSource';
import type { SharedWritingArtifact } from '../src/services/writing/contracts/writingStage';

const DRAFT_BODY = [
  '夜谈将尽，柳如烟把信物轻轻放在案上。',
  '烛火映着她眉间的霜色，她没有回头，只说了一句：',
  '「仇敌已在北境，我们的时间不多了。」',
].join('\n');

function richRequest(): WritingRequest {
  const request = continuationRequest({ workflowVersion: 5 });
  // 256K 窗口：让 freeze 预算给每个 mandatory 小块留下完整内容，
  // 测试「Mandatory Truth 永不删除」时断言的是完整条目文本。
  request.model = { ...request.model, contextWindow: 262144 };
  request.sourceBundle.preferred.push(
    makeSource({
      kind: 'character',
      content: '柳如烟：北境世家的独女，眉间有霜色，随身携带寒鸦号图册。',
      requirement: 'preferred',
    }),
  );
  request.sourceBundle.preferred.push(
    makeSource({
      kind: 'story_memory',
      content: '故事记忆：主角与柳如烟在雨夜初遇，她曾救对方一命。',
      requirement: 'preferred',
    }),
  );
  request.sourceBundle.optional.push(
    makeSource({
      kind: 'worldbook',
      content: '寒鸦号：北境航行最快的黑帆船，船身刻满旧部族图腾。'.repeat(20),
      requirement: 'optional',
    }),
  );
  request.sourceBundle.optional.push(
    makeSource({
      kind: 'note',
      content: '白虎旗：南境军旗，绣白虎，执旗者为铁壁将军。'.repeat(20),
      requirement: 'optional',
    }),
  );
  return request;
}

function qaArtifacts(): Record<string, SharedWritingArtifact> {
  return {
    draft: { stage: 'draft', body: DRAFT_BODY },
  };
}

function qaInput() {
  const { frozenContext } = buildWritingKernelFreezeTrace({
    request: richRequest(),
  });
  return {
    frozenContext,
    artifacts: qaArtifacts(),
    requirements: frozenContext.requirements,
  };
}

describe('B4 — resolveQaEvidenceProjection', () => {
  test('high-confidence: relevant evidence is kept, irrelevant candidates are dropped', () => {
    const { frozenContext, artifacts, requirements } = qaInput();
    const result = resolveQaEvidenceProjection({
      stage: 'qa',
      frozenContext,
      artifacts,
      requirements,
    });

    expect(result.enabled).toBe(true);
    expect(result.fallbackReason).toBeNull();
    // 三件套区块齐全
    expect(result.text).toContain('【章节真相】');
    expect(result.text).toContain('【要求检查清单】');
    expect(result.text).toContain('【相关证据】');
    // Mandatory Truth 永不删除：canon / boundary / seam / writer_style / story_memory
    // 的渲染块都在（freeze 预算会把短小块裁短，故对 truth 块做存在性断言；
    // 全量原文由【要求检查清单】从 requirements 提供，下面断言）
    expect(result.text).toContain('Canon');
    expect(result.text).toContain('接缝');
    expect(result.text).toContain('边界');
    expect(result.text).toContain('原著');
    expect(result.text).toContain('故事记忆');
    // 要求检查清单携带完整强制要求原文（不经 render 裁剪）
    expect(result.text).toContain('Canon：主角已获得信物。');
    expect(result.text).toContain('接缝：夜谈未完。');
    expect(result.text).toContain('边界：止于第 2 章。');
    // 命中正文的人物保留
    expect(result.text).toContain('柳如烟');
    // 未被正文提及的世界书条目被过滤
    expect(result.text).not.toContain('寒鸦号');
    expect(result.text).not.toContain('白虎旗');
    // 相关证据比 union 投影更小
    const union = projectFrozenContextForStage({
      frozenContext,
      stage: 'qa',
    });
    expect(result.projectedTokens).toBeGreaterThan(0);
    expect(result.projectedTokens).toBeLessThan(union.projectedTokens);
  });

  test('zero entity hits → fail-safe fallback (enabled=false, no-entity-hit)', () => {
    const { frozenContext, artifacts, requirements } = qaInput();
    const emptyDraft = resolveQaEvidenceProjection({
      stage: 'qa',
      frozenContext,
      artifacts: {
        draft: { stage: 'draft', body: '这一页只写了一个无关的黄昏。' },
      },
      requirements,
    });
    // 正文不提及任何 relevant 实体（柳如烟/寒鸦号/白虎旗都不在）
    expect(emptyDraft.enabled).toBe(false);
    expect(emptyDraft.fallbackReason).toBe('no-entity-hit');

    const noRelevant = resolveQaEvidenceProjection({
      stage: 'qa',
      frozenContext: buildWritingKernelFreezeTrace({
        request: continuationRequest({ workflowVersion: 5 }),
      }).frozenContext,
      artifacts,
      requirements: { version: 1, items: [], fingerprint: 'empty' },
    });
    // 场景里根本没有 character/worldbook/note 可过滤 → 同样回退
    expect(noRelevant.enabled).toBe(false);
    expect(noRelevant.fallbackReason).toBe('no-entity-hit');
  });

  test('mandatory truths survive even when evidence projection is disabled (fallback keeps union)', () => {
    // fail-safe 语义：enabled=false 时调用方必须回到 union projection。
    const { frozenContext, requirements } = qaInput();
    const emptyDraft = resolveQaEvidenceProjection({
      stage: 'qa',
      frozenContext,
      artifacts: {
        draft: { stage: 'draft', body: '无关正文。' },
      },
      requirements,
    });
    expect(emptyDraft.enabled).toBe(false);
    const union = projectFrozenContextForStage({ frozenContext, stage: 'qa' });
    expect(union.text).toContain('Canon');
    expect(union.text).toContain('接缝');
  });
});

describe('B4 — compileSharedWritingPrompt integration', () => {
  test('qaEvidence present → QA uses Evidence Projection instead of the union block', () => {
    const { frozenContext, artifacts, requirements } = qaInput();
    const projection = resolveQaEvidenceProjection({
      stage: 'qa',
      frozenContext,
      artifacts,
      requirements,
    });
    expect(projection.enabled).toBe(true);

    const compiled = compileSharedWritingPrompt({
      stage: 'qa',
      frozenContext,
      artifacts,
      requirements,
      stagePolicy: frozenContext.stagePolicy,
      qaEvidence: projection,
    });
    const user = compiled.messages[1].content;
    expect(user).toContain('【章节真相】');
    expect(user).toContain('【要求检查清单】');
    expect(user).toContain('【相关证据】');
    expect(user).toContain('【已有初稿】');
    expect(user).not.toContain('【冻结上下文】');
  });

  test('no qaEvidence → QA keeps the legacy union projection block', () => {
    const { frozenContext, artifacts, requirements } = qaInput();
    const compiled = compileSharedWritingPrompt({
      stage: 'qa',
      frozenContext,
      artifacts,
      requirements,
      stagePolicy: frozenContext.stagePolicy,
    });
    const user = compiled.messages[1].content;
    expect(user).toContain('【冻结上下文】');
    expect(user).toContain('【已有初稿】');
  });
});

describe('B4 — observability', () => {
  test('qa stage structural projection tokens are measured (> 0)', () => {
    const { frozenContext, artifacts } = qaInput();
    const measure = measureStageContextProjection({
      stage: 'qa',
      frozenContext,
      artifacts,
    });
    expect(measure.projectedTokens).toBeGreaterThan(0);
  });

  test('percentileTokens helper computes the p50 for QA-vs-Draft comparison', () => {
    expect(percentileTokens([100, 200, 300], 50)).toBe(200);
    expect(percentileTokens([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentileTokens([], 50)).toBeNull();
    expect(percentileTokens([7], 50)).toBe(7);
  });
});