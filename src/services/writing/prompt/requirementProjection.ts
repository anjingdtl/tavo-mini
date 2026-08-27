import type { FrozenWritingContext } from '../contracts/frozenWritingContext';
import type {
  WritingRequirement,
  WritingRequirements,
} from '../contracts/writingRequirement';
import type { SharedWritingStageName } from '../contracts/writingPolicy';
import type { WritingStageArtifacts } from '../contracts/writingStage';
import {
  aggregateStageFindings,
  formatAggregatedFindingsBlock,
} from '../context/findingsAggregator';

const KIND_LABEL: Record<string, string> = {
  outline: '大纲',
  canon: 'Canon',
  boundary: '原著边界',
  seam: '接缝',
  anchor: '锚点',
  style: '文风',
  character: '人物',
  'world-rule': '世界规则',
  obligation: '义务',
  plot: '情节',
  length: '篇幅',
  'protected-passage': '受保护段落',
  'user-instruction': '用户指令',
  fact: '事实',
  continuity: '连续性',
};

export function projectRequirementsForStage(input: {
  stage: SharedWritingStageName;
  requirements: WritingRequirements;
  frozenContext: FrozenWritingContext;
}): string {
  const relevant = input.requirements.items.filter(item =>
    requirementAppliesToStage(input.stage, item),
  );
  if (relevant.length === 0) {
    return '【写作要求】\n【Requirement Checklist】\n（本阶段无额外结构化要求）';
  }
  const blocks = new Map<string, WritingRequirement[]>();
  for (const item of relevant) {
    const list = blocks.get(item.kind) || [];
    list.push(item);
    blocks.set(item.kind, list);
  }
  const sections: string[] = ['【写作要求】', '【Requirement Checklist】'];
  for (const [kind, items] of blocks) {
    sections.push(`【${KIND_LABEL[kind] || kind}】`);
    for (const item of items) {
      const severity =
        item.severity === 'blocking' || item.severity === 'mandatory'
          ? '必须'
          : item.severity === 'preferred'
          ? '优先'
          : '参考';
      const text = item.text.trim();
      if (!text) continue;
      sections.push(`- (${severity}) ${text.slice(0, 2400)}`);
    }
  }
  return sections.join('\n');
}

function requirementAppliesToStage(
  stage: SharedWritingStageName,
  item: WritingRequirement,
): boolean {
  if (stage === 'persist' || stage === 'finalValidate') return false;
  // Phase 4 (二 §7.2 ONE QA): the unified qa stage sees the union of legacy
  // Review / Audit / FactCheck requirements. Scenario differences arrive as
  // requirement kinds, so the compiler itself stays one implementation.
  if (stage === 'qa') {
    return (
      item.kind === 'outline' ||
      item.kind === 'plot' ||
      item.kind === 'style' ||
      item.kind === 'user-instruction' ||
      item.kind === 'obligation' ||
      item.kind === 'canon' ||
      item.kind === 'boundary' ||
      item.kind === 'fact' ||
      item.kind === 'continuity' ||
      item.kind === 'character' ||
      item.kind === 'world-rule'
    );
  }
  if (stage === 'audit' || stage === 'factCheck') {
    return (
      item.kind === 'canon' ||
      item.kind === 'boundary' ||
      item.kind === 'fact' ||
      item.kind === 'continuity' ||
      item.kind === 'character' ||
      item.kind === 'world-rule' ||
      item.kind === 'obligation'
    );
  }
  if (stage === 'review') {
    return (
      item.kind === 'outline' ||
      item.kind === 'plot' ||
      item.kind === 'style' ||
      item.kind === 'user-instruction' ||
      item.kind === 'obligation'
    );
  }
  if (stage === 'proof') {
    return (
      item.kind === 'style' ||
      item.kind === 'protected-passage' ||
      item.kind === 'obligation' ||
      item.kind === 'length'
    );
  }
  return true;
}

export function previousArtifactBlock(
  artifacts: WritingStageArtifacts,
  stage?: SharedWritingStageName,
): string {
  if (stage === 'draft' || stage === 'finalValidate' || stage === 'persist') {
    return '';
  }
  const draft = readBody(artifacts.draft);
  const revision = readBody(artifacts.revision);
  if (
    stage === 'qa' ||
    stage === 'review' ||
    stage === 'audit' ||
    stage === 'factCheck'
  ) {
    return draft ? `【已有初稿】\n${draft}` : '';
  }
  const findings = formatAggregatedFindingsBlock(aggregateStageFindings(artifacts));
  if (stage === 'proof') {
    const candidate = revision || draft;
    return [candidate ? `【终稿候选】\n${candidate}` : '', findings]
      .filter(Boolean)
      .join('\n\n');
  }
  return [draft ? `【已有初稿】\n${draft}` : '', findings].filter(Boolean).join('\n\n');
}

function readBody(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && value) {
    const row = value as Record<string, unknown>;
    if (typeof row.body === 'string' && row.body.trim()) return row.body.trim();
    if (typeof row.content === 'string' && row.content.trim()) {
      return row.content.trim();
    }
  }
  return '';
}

export function instructionBlock(frozen: FrozenWritingContext): string {
  const instruction = frozen.instruction;
  return [
    '【本章指令】',
    `标题：${instruction.title || '（无）'}`,
    `梗概：${instruction.synopsis || '（无）'}`,
    `用户要求：${instruction.userInstruction || '（无）'}`,
    instruction.currentContent
      ? `当前正文/接缝：\n${instruction.currentContent.slice(0, 4000)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
