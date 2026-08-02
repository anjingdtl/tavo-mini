#!/usr/bin/env python3
"""Apply the continuation target-length/Repair safety patch to tavo-mini.

Run from anywhere:
  python apply_continuation_length_repair.py /path/to/tavo-mini

The script is intentionally fail-fast: every replacement must match the current
main-branch source exactly once, otherwise no ambiguous partial edit is made.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

ROOT_REL = Path("src/services/continuation/generation")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    result, count = re.subn(
        pattern, lambda _match: replacement, text, count=1, flags=re.S
    )
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one regex match, found {count}")
    return result


def write_new(path: Path, content: str) -> None:
    if path.exists() and path.read_text(encoding="utf-8") != content:
        raise RuntimeError(f"refusing to overwrite existing different file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


LENGTH_CONTRACT = r'''export const CONTINUATION_LENGTH_TOLERANCE_HAN = 500;

export interface ContinuationLengthContract {
  targetHanCharacters: number;
  minHanCharacters: number;
  maxHanCharacters: number;
  toleranceHanCharacters: number;
}

export type ContinuationLengthEvaluation =
  | {
      status: 'within';
      actualHanCharacters: number;
      targetDelta: number;
      contract: ContinuationLengthContract;
    }
  | {
      status: 'under';
      actualHanCharacters: number;
      targetDelta: number;
      missingToMinimum: number;
      contract: ContinuationLengthContract;
    }
  | {
      status: 'over';
      actualHanCharacters: number;
      targetDelta: number;
      excessOverMaximum: number;
      contract: ContinuationLengthContract;
    };

const LENGTH_ISSUE_SUBTYPES = new Set([
  'chapter_length_under_target',
  'chapter_length_over_target',
]);

export function countHanCharacters(text: string): number {
  return (
    text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []
  ).length;
}

export function resolveContinuationLengthContract(
  targetChapterChars: number,
): ContinuationLengthContract {
  const parsed = Number(targetChapterChars);
  const targetHanCharacters = Math.max(
    1,
    Math.floor(Number.isFinite(parsed) ? parsed : 1),
  );
  const toleranceHanCharacters = CONTINUATION_LENGTH_TOLERANCE_HAN;

  return {
    targetHanCharacters,
    minHanCharacters: Math.max(
      1,
      targetHanCharacters - toleranceHanCharacters,
    ),
    maxHanCharacters: targetHanCharacters + toleranceHanCharacters,
    toleranceHanCharacters,
  };
}

export function evaluateContinuationLength(
  content: string,
  targetOrContract: number | ContinuationLengthContract,
): ContinuationLengthEvaluation {
  const contract =
    typeof targetOrContract === 'number'
      ? resolveContinuationLengthContract(targetOrContract)
      : targetOrContract;
  const actualHanCharacters = countHanCharacters(content);
  const targetDelta = actualHanCharacters - contract.targetHanCharacters;

  if (actualHanCharacters < contract.minHanCharacters) {
    return {
      status: 'under',
      actualHanCharacters,
      targetDelta,
      missingToMinimum: contract.minHanCharacters - actualHanCharacters,
      contract,
    };
  }

  if (actualHanCharacters > contract.maxHanCharacters) {
    return {
      status: 'over',
      actualHanCharacters,
      targetDelta,
      excessOverMaximum: actualHanCharacters - contract.maxHanCharacters,
      contract,
    };
  }

  return {
    status: 'within',
    actualHanCharacters,
    targetDelta,
    contract,
  };
}

export function isContinuationLengthIssueSubtype(subtype: string): boolean {
  return LENGTH_ISSUE_SUBTYPES.has(subtype);
}
'''

REPAIR_PATCH = r'''import { stripModelJson } from '../canon/canonJsonValidators';
import {
  countHanCharacters,
  evaluateContinuationLength,
  resolveContinuationLengthContract,
} from './continuationLengthContract';

interface RepairPatch {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Apply UTF-16 half-open repair patches to a complete chapter. `start === end`
 * is a pure insertion, used when a length-under-target issue needs new prose.
 */
export function applyRepairPatches(
  original: string,
  raw: string,
): string | null {
  let parsed: { patches?: unknown };
  try {
    parsed = JSON.parse(stripModelJson(raw));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.patches) || !parsed.patches.length) {
    return null;
  }

  const patches: RepairPatch[] = [];
  for (const value of parsed.patches) {
    if (!value || typeof value !== 'object') return null;
    const patch = value as Record<string, unknown>;
    const start = Number(patch.start);
    const end = Number(patch.end);
    const replacement = patch.replacement;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > original.length ||
      typeof replacement !== 'string' ||
      !replacement.trim()
    ) {
      return null;
    }
    if (
      start === end &&
      start > 0 &&
      start < original.length &&
      original[start - 1] !== '\n' &&
      original[start] !== '\n'
    ) {
      return null;
    }
    patches.push({ start, end, replacement });
  }

  patches.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < patches.length; index += 1) {
    const previous = patches[index - 1];
    const current = patches[index];
    if (current.start < previous.end) return null;
    if (current.start === previous.start) return null;
  }

  return patches
    .slice()
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce(
      (content, patch) =>
        `${content.slice(0, patch.start)}${patch.replacement}${content.slice(
          patch.end,
        )}`,
      original,
    );
}

/**
 * Repair may improve an already-invalid Writer candidate without reaching the
 * target band in one call. It must never break a previously valid chapter,
 * catastrophically contract the text, or move materially farther from target.
 */
export function isRepairCandidateUsable(
  original: string,
  candidate: string,
  targetChapterChars: number,
): boolean {
  const contract = resolveContinuationLengthContract(targetChapterChars);
  const originalHan = countHanCharacters(original);
  const candidateHan = countHanCharacters(candidate);
  if (originalHan === 0 || candidateHan === 0) return false;

  const originalLength = evaluateContinuationLength(original, contract);
  const candidateLength = evaluateContinuationLength(candidate, contract);

  if (
    originalLength.status === 'within' &&
    candidateLength.status !== 'within'
  ) {
    return false;
  }

  const preservationRatio = originalLength.status === 'within' ? 0.8 : 0.65;
  if (candidateHan < Math.floor(originalHan * preservationRatio)) {
    return false;
  }

  if (originalLength.status !== 'within') {
    const originalDistance = Math.abs(
      originalHan - contract.targetHanCharacters,
    );
    const candidateDistance = Math.abs(
      candidateHan - contract.targetHanCharacters,
    );
    const allowedRegression = Math.min(
      100,
      Math.floor(contract.toleranceHanCharacters * 0.2),
    );
    if (candidateDistance > originalDistance + allowedRegression) {
      return false;
    }
  }

  const expansionCeiling = Math.max(
    contract.maxHanCharacters,
    Math.ceil(originalHan * 1.5),
  );
  return candidateHan <= expansionCeiling;
}
'''

WRITER_FUNCTION = r'''export function compileWriterMessages(
  snapshot: ContinuationContextSnapshot,
  plan?: ContinuationPlan,
): ChatMessage[] {
  const standardWorkflow = !plan;
  const lengthContract = resolveContinuationLengthContract(
    snapshot.settingsSnapshot.values.targetChapterChars,
  );
  const lengthRule = [
    `【正文长度硬约束】目标 ${lengthContract.targetHanCharacters} 个汉字；允许范围 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字。`,
    '汉字数只统计 CJK 汉字，不包含标点、空格、换行、数字和英文字母。少于下限或多于上限均视为未完成。',
    '不得通过摘要、提纲、剧情概述、重复句或无意义水文控制长度；必须保留完整场景、人物互动、因果推进和自然章末。',
  ].join('\n');
  const system = [
    standardWorkflow
      ? '你是长篇小说续写写手。只输出一个 JSON object，不要 Markdown、代码围栏、解释文字或推理内容。'
      : '你是长篇小说续写写手。只输出本章正文，不要分析说明、不要标题行。',
    ...(standardWorkflow
      ? [
          'JSON 顶层必须严格为 {"schemaVersion":1,"plan":{...},"content":"..."}。plan 必须包含 chapterGoal、centralConflict、beats、participatingCharacterIds；characterActions、plotAdvances、foreshadowingActions、proposedStateChanges、risks 若无内容可输出空数组或省略，content 只包含本章正文，不含标题、JSON 包装或解释。',
          '先在同一次 completion 的 plan 中收束章节目标、核心冲突、节拍和参与人物，再按该 plan 写 content；不得先独立调用规划，也不得把 plan 写入 content。',
        ]
      : []),
    lengthRule,
    '遵守人物知识边界；不复制大段原著原文；不引入被策略禁止的死亡/复活/新体系。',
    primaryAnchorRule(snapshot),
    '模仿抽象文风特征，禁止复制原著原句。用户本章明确要求优先于自动风格画像。',
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    ...(plan
      ? [
          `【规划（已确认版本）】\n目标：${plan.chapterGoal}\n冲突：${
            plan.centralConflict
          }\n节拍：${plan.beats.map(b => b.summary).join(' / ')}`,
        ]
      : []),
    stateBlock(snapshot),
    primaryAnchorBlock(snapshot),
    recentBlock(snapshot),
    memoryBlock(snapshot),
    episodicBlock(snapshot),
    historicalDigestBlock(snapshot),
    styleBlock(snapshot, 'writer', plan ? { plan } : undefined),
    supplementsBlock(snapshot),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `生成${displayTargetTitle(snapshot)}。正文目标 ${
        lengthContract.targetHanCharacters
      } 个汉字，必须保持在 ${lengthContract.minHanCharacters}–${
        lengthContract.maxHanCharacters
      } 个汉字。用户要求：\n${snapshot.bundles.userInstruction}`,
    },
  ];
}
'''

REPAIR_FUNCTION = r'''export function compileRepairMessages(
  snapshot: ContinuationContextSnapshot,
  artifactText: string,
  openChecks: ContinuationCheckResult[],
  delivery: 'full' | 'patch' = 'full',
): ChatMessage[] {
  const patchDelivery = delivery === 'patch';
  const lengthContract = resolveContinuationLengthContract(
    snapshot.settingsSnapshot.values.targetChapterChars,
  );
  const originalHanCharacters = countHanCharacters(artifactText);
  const issues = openChecks
    .filter(c => c.severity === 'error' || c.severity === 'blocking')
    .map(c => {
      const chapterLevel = isContinuationLengthIssueSubtype(c.subtype);
      const location = chapterLevel
        ? '章节级长度问题（无局部 offset）'
        : `@${c.generatedStart}-${c.generatedEnd} 命中片段:${
            c.generatedExcerpt || '（无定位片段）'
          }`;
      return `- [${c.severity}/${c.category}/${c.subtype}] ${
        c.description
      } ${location} 建议:${c.suggestedFix ?? ''}`;
    })
    .join('\n');
  const anchorExcerpt =
    snapshot.primaryAnchor?.excerpt || snapshot.bundles.seam?.excerpt || '';
  const repairLengthContract = [
    `【Repair 长度硬性验收】当前完整正文含 ${originalHanCharacters} 个汉字；本次目标 ${lengthContract.targetHanCharacters} 个汉字，应用全部补丁后的完整正文必须保持在 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字。`,
    '汉字数只统计 CJK 汉字，不包含标点、空格、换行、数字和英文字母。长度不足时应补充具体动作、对话、因果、人物反应、冲突推进或结果余波；长度超出时优先压缩重复描写、重复心理和不推进剧情的对话。',
    '不得用摘要、提纲、概括句、重复同一句、无意义水文或大段删除来规避长度要求；必须保留完整事件链、人物互动和自然收束。',
  ].join('\n');
  const overlapInstructions = openChecks.some(
    c =>
      c.subtype === 'source_overlap' ||
      c.subtype === 'continuation_anchor_overlap',
  )
    ? [
        patchDelivery
          ? '本次标准 Repair 的输出是应用到最终候选正文的 JSON 补丁，不是修改建议、解释、审查报告或完整正文。'
          : '本次修复的输出就是最终候选正文，不是修改建议、解释、审查报告、JSON 或局部补丁。',
        '接缝重合是硬错误：必须重写命中段落的叙事动作、信息组织和措辞，让正文从接缝之后的新事件继续推进；不能只删标点、替换几个词、压缩句子或把同一段原文换位置。',
        '修复后正文不得再次复制接缝或命中片段中的连续原文，也不得用“刚才/此前发生的事情”重新复述同一段；若无法保留原句，优先保证章节目标、冲突和节拍继续成立。',
        anchorExcerpt
          ? `【仅用于消除接缝重合的参考接缝】\n${anchorExcerpt}`
          : '【接缝参考】（快照未提供可展示片段，仍须依据检查命中片段改写）',
      ].join('\n')
    : patchDelivery
    ? '本次标准 Repair 的输出是应用到最终候选正文的 JSON 补丁；不要输出问题清单、解释或完整正文。'
    : '本次修复的输出就是最终候选正文，只输出修复后的完整正文；不要输出问题清单、解释、JSON 或局部补丁。';
  const system = [
    patchDelivery
      ? '你是续写终稿修复助手。先在内部逐项执行修复清单，然后只输出严格 JSON 修订补丁。不得输出思维过程、审查说明、Markdown 标题或“已修复”等套话。'
      : '你是续写终稿修复助手。先在内部逐项执行修复清单，再只输出修复后的完整正文。不得输出思维过程、审查说明、JSON、Markdown 标题或“已修复”等套话。',
    overlapInstructions,
    '对每一项 error/blocking 都必须完成可验证的修改；输出前重新检查：硬规则/Canon 证据、冻结状态与知识边界、人物关系、章节目标与冲突、接缝不重复。不要因单一风格问题重写无关段落，也不要修改已通过的 Canon 事实。',
    patchDelivery
      ? `你返回的是应用到完整原文的局部补丁。普通问题必须由覆盖其 @start-@end 区间的补丁实质修正；章节级长度问题没有局部 offset，可以在自然段边界使用 start=end 的纯插入补丁，或用较大区间的精简替换补丁。客户端会保留所有未命中的有效正文。`
      : '原文不是参考摘要，而是必须覆盖的完整修订底稿。先保留原文每个有效段落、事件节点、人物互动、情绪转折和结尾收束，再逐项完成 Checker 指出的实质修正；Repair 不是原文复述、机械删句、只改命中句或只返回局部补丁。',
    ...(patchDelivery
      ? [
          '定向修订原则：事实与 Canon 优先；不引入未被原文或 Canon 支持的新人物、新地点、新物品、新能力或规则；不得擅自改变章节目标；不得删除不存在问题的重要情节；尽量最小必要修改，并保留原文创意与叙事风格。',
        ]
      : [
          `除非 Checker 明确要求删除，修正后必须在原有完整事件链、人物互动、细节和收束的基础上输出完整终稿；不得把整章压缩成摘要、提纲、几百字短候选或“修改建议”。`,
        ]),
    repairLengthContract,
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    stateBlock(snapshot),
    styleBlock(snapshot, 'repair', { openChecks }),
    `【待修复问题】\n${issues || '（无 blocking/error）'}`,
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: patchDelivery
        ? [
            '【Repair 补丁交付契约：优先级最高】',
            '只输出严格 JSON：{"patches":[{"start":0,"end":12,"replacement":"替换后的连续正文"}]}。start/end 必须是下方原文的 UTF-16 半开位置，start 包含、end 不包含；允许 start=end 表示纯插入。patches 按 start 升序、不得重叠，也不得在同一位置重复插入。replacement 必须是可直接应用的自然小说正文，不能为空。',
            '普通 error/blocking 必须由覆盖其 @start-@end 的补丁实质修正；章节级长度问题不要求覆盖局部区间。扩写时优先在自然段边界插入完整段落，压缩时用更短但叙事完整的段落替换冗余区间。',
            `应用补丁后的完整正文必须包含 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字，并尽量接近 ${lengthContract.targetHanCharacters}。不要返回完整章节、摘要、问题说明、Markdown 或 JSON 之外的文字。`,
            '【完整原文开始】',
            artifactText,
            '【完整原文结束】',
            '现在只输出 JSON 补丁对象。',
          ].join('\n\n')
        : [
            '【最终交付契约：优先级最高】',
            '交付物必须是可直接替换下方原文的完整修订章节，不是修改说明、摘要、提纲、局部重写或只包含命中段落的补丁。输出从修订后章节第一句开始，到自然章末结束；不得加入前言、计数、标签或解释。',
            `最终正文必须包含 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字，并尽量接近 ${lengthContract.targetHanCharacters}。`,
            '先在内部以原文的每个有效段落、事件节点、人物互动、因果、情绪转折和结尾为覆盖清单；修正问题时改写对应段落，但不得遗漏其余有效内容。',
            '【完整原文开始】',
            artifactText,
            '【完整原文结束】',
            '现在仅输出完整修订章节。',
          ].join('\n\n'),
    },
  ];
}
'''

JEST_TEST = r'''import {
  countHanCharacters,
  evaluateContinuationLength,
  resolveContinuationLengthContract,
} from '../src/services/continuation/generation/continuationLengthContract';
import {
  applyRepairPatches,
  isRepairCandidateUsable,
} from '../src/services/continuation/generation/continuationRepairPatch';
import {
  bindIssuesToArtifact,
  filterBySettings,
  runDeterministicChecks,
} from '../src/services/continuation/generation/continuationChecker';

const han = (length: number) => '甲'.repeat(length);

function snapshot(targetChapterChars = 3000): any {
  return {
    settingsSnapshot: {
      values: {
        targetChapterChars,
        worldRuleLevel: 'off',
        characterLevel: 'off',
        relationshipLevel: 'off',
        plotLevel: 'off',
        experienceLevel: 'off',
        knowledgeLevel: 'off',
        styleLevel: 'off',
        resurrectionPolicy: 'allow',
      },
    },
    bundles: {
      canon: { worldRules: [], evidenceRefs: [] },
      effectiveState: { knowledge: [] },
      seam: { summary: '', excerpt: '' },
      recentChapters: [],
      style: null,
    },
    primaryAnchor: null,
  };
}

describe('continuation target Han length contract', () => {
  it('uses target ±500 and ignores punctuation/whitespace/Latin characters', () => {
    expect(resolveContinuationLengthContract(3000)).toEqual({
      targetHanCharacters: 3000,
      minHanCharacters: 2500,
      maxHanCharacters: 3500,
      toleranceHanCharacters: 500,
    });
    expect(countHanCharacters('甲，乙。\nABC 123！')).toBe(2);
    expect(evaluateContinuationLength(han(2500), 3000).status).toBe('within');
    expect(evaluateContinuationLength(han(3500), 3000).status).toBe('within');
    expect(evaluateContinuationLength(han(2499), 3000).status).toBe('under');
    expect(evaluateContinuationLength(han(3501), 3000).status).toBe('over');
  });

  it('keeps local length errors severe even without evidence and with style checks off', () => {
    const snap = snapshot();
    const local = runDeterministicChecks(han(2499), snap);
    const bound = bindIssuesToArtifact(local, han(2499), new Set());
    const filtered = filterBySettings(bound, snap.settingsSnapshot.values);
    expect(filtered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtype: 'chapter_length_under_target',
          severity: 'error',
        }),
      ]),
    );
  });
});

describe('continuation repair patch safety', () => {
  it('supports pure insertion patches', () => {
    const original = '甲甲\n\n乙乙';
    const result = applyRepairPatches(
      original,
      JSON.stringify({
        patches: [{ start: 4, end: 4, replacement: '新增段落\n\n' }],
      }),
    );
    expect(result).toBe('甲甲\n\n新增段落\n\n乙乙');
  });

  it('rejects raw full-text fallback, overlap and duplicate insertions', () => {
    expect(applyRepairPatches(han(3000), '几百字摘要')).toBeNull();
    expect(
      applyRepairPatches(
        'abcdef',
        JSON.stringify({
          patches: [
            { start: 1, end: 4, replacement: 'x' },
            { start: 3, end: 5, replacement: 'y' },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      applyRepairPatches(
        'abcdef',
        JSON.stringify({
          patches: [
            { start: 2, end: 2, replacement: 'x' },
            { start: 2, end: 2, replacement: 'y' },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('rejects collapse and preserves a previously valid length band', () => {
    expect(isRepairCandidateUsable(han(3000), han(600), 3000)).toBe(false);
    expect(isRepairCandidateUsable(han(3000), han(2400), 3000)).toBe(false);
    expect(isRepairCandidateUsable(han(3000), han(2800), 3000)).toBe(true);
  });

  it('allows a safe first Repair to improve an invalid Writer candidate', () => {
    expect(isRepairCandidateUsable(han(2100), han(2400), 3000)).toBe(true);
    expect(isRepairCandidateUsable(han(2100), han(1200), 3000)).toBe(false);
    expect(isRepairCandidateUsable(han(2100), han(1800), 3000)).toBe(false);
  });
});
'''


def patch_checker(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        "} from './types';\n",
        "} from './types';\nimport {\n"
        "  evaluateContinuationLength,\n"
        "  isContinuationLengthIssueSubtype,\n"
        "  resolveContinuationLengthContract,\n"
        "} from './continuationLengthContract';\n",
        "checker import",
    )
    text = regex_once(
        text,
        r"\n// The product's preferred chapter size is a quality signal, not a safety\n"
        r"// gate\.[\s\S]*?function countHanCharacters\(text: string\): number \{[\s\S]*?\n\}\n",
        "\n",
        "remove fixed checker length constants",
    )
    text = regex_once(
        text,
        r"  const hanCharacters = countHanCharacters\(artifactText\);\n"
        r"  if \([\s\S]*?\n  \}\n\n  // Future leakage markers",
        """  const lengthContract = resolveContinuationLengthContract(\n    settings.targetChapterChars,\n  );\n  const lengthEvaluation = evaluateContinuationLength(\n    artifactText,\n    lengthContract,\n  );\n  if (lengthEvaluation.status !== 'within') {\n    const under = lengthEvaluation.status === 'under';\n    issues.push({\n      category: 'style',\n      subtype: under\n        ? 'chapter_length_under_target'\n        : 'chapter_length_over_target',\n      severity: 'error',\n      confidence: 1,\n      generatedStart: null,\n      generatedEnd: null,\n      generatedExcerpt: '',\n      description: under\n        ? `正文含汉字 ${lengthEvaluation.actualHanCharacters} 个，低于本次允许下限 ${lengthContract.minHanCharacters}；目标为 ${lengthContract.targetHanCharacters}。`\n        : `正文含汉字 ${lengthEvaluation.actualHanCharacters} 个，高于本次允许上限 ${lengthContract.maxHanCharacters}；目标为 ${lengthContract.targetHanCharacters}。`,\n      evidenceIds: [],\n      suggestedFix: under\n        ? `在保留完整事件链的基础上自然扩写约 ${Math.max(\n            1,\n            lengthContract.targetHanCharacters -\n              lengthEvaluation.actualHanCharacters,\n          )} 个汉字，最终保持在 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字。`\n        : `优先压缩重复描写、重复心理和不推进剧情的对话，减少约 ${Math.max(\n            1,\n            lengthEvaluation.actualHanCharacters -\n              lengthContract.targetHanCharacters,\n          )} 个汉字，最终保持在 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字。`,\n    });\n  }\n\n  // Future leakage markers""",
        "dynamic deterministic length check",
    )
    text = replace_once(
        text,
        "    const localOverlapGate =\n      issue.subtype === 'source_overlap' ||\n      issue.subtype === 'continuation_anchor_overlap';\n",
        "    const localDeterministicGate =\n"
        "      issue.subtype === 'source_overlap' ||\n"
        "      issue.subtype === 'continuation_anchor_overlap' ||\n"
        "      isContinuationLengthIssueSubtype(issue.subtype);\n",
        "checker local gate",
    )
    text = text.replace("!localOverlapGate", "!localDeterministicGate")
    text = replace_once(
        text,
        "  return issues.filter(i => !levelOff(settings, i.category));\n",
        "  return issues.filter(\n"
        "    i =>\n"
        "      isContinuationLengthIssueSubtype(i.subtype) ||\n"
        "      !levelOff(settings, i.category),\n"
        "  );\n",
        "checker settings filter",
    )
    path.write_text(text, encoding="utf-8")


def patch_prompt(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        "} from '../styleProfile/styleProfileRenderer';\n",
        "} from '../styleProfile/styleProfileRenderer';\n"
        "import {\n"
        "  countHanCharacters,\n"
        "  isContinuationLengthIssueSubtype,\n"
        "  resolveContinuationLengthContract,\n"
        "} from './continuationLengthContract';\n",
        "prompt imports",
    )
    text = regex_once(
        text,
        r"export function compileWriterMessages\([\s\S]*?\n\}\n\nexport function compileCheckerMessages",
        WRITER_FUNCTION + "\nexport function compileCheckerMessages",
        "replace writer compiler",
    )
    text = regex_once(
        text,
        r"export function compileRepairMessages\([\s\S]*?\n\}\n\nexport function compileStateExtractionMessages",
        REPAIR_FUNCTION + "\nexport function compileStateExtractionMessages",
        "replace repair compiler",
    )
    path.write_text(text, encoding="utf-8")


def patch_runner(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        "import { type ContinuationStageBudgets } from './continuationContextBudget';\n",
        "import { type ContinuationStageBudgets } from './continuationContextBudget';\n"
        "import { resolveContinuationLengthContract } from './continuationLengthContract';\n"
        "import {\n"
        "  applyRepairPatches,\n"
        "  isRepairCandidateUsable,\n"
        "} from './continuationRepairPatch';\n"
        "export {\n"
        "  applyRepairPatches,\n"
        "  isRepairCandidateUsable,\n"
        "} from './continuationRepairPatch';\n",
        "runner imports",
    )
    text = regex_once(
        text,
        r"\nfunction countHanCharacters\(text: string\): number \{[\s\S]*?\n\}\n\nfunction defaultPlan",
        "\nfunction defaultPlan",
        "remove runner local length safety",
    )
    text = regex_once(
        text,
        r"\ninterface RepairPatch \{[\s\S]*?\n\}\n\n/\*\*\n \* Strict standard-workflow Writer contract",
        "\n/**\n * Strict standard-workflow Writer contract",
        "remove runner local patch implementation",
    )
    text = text.replace(
        "targetChapterChars: generationSettings.targetChapterChars,",
        "targetChapterChars: resolveContinuationLengthContract(\n"
        "      generationSettings.targetChapterChars,\n"
        "    ).maxHanCharacters,",
    )
    text = text.replace(
        "targetChapterChars: snapshot.settingsSnapshot.values.targetChapterChars,",
        "targetChapterChars: resolveContinuationLengthContract(\n"
        "        snapshot.settingsSnapshot.values.targetChapterChars,\n"
        "      ).maxHanCharacters,",
    )
    text = replace_once(
        text,
        "          repaired =\n            applyRepairPatches(artifact.content, repairResult.text) ??\n            repairResult.text.trim();\n          repairUsedLlm = Boolean(repaired);\n",
        "          repaired = applyRepairPatches(\n"
        "            artifact.content,\n"
        "            repairResult.text,\n"
        "          );\n"
        "          repairUsedLlm = repaired !== null;\n"
        "          if (!repaired) {\n"
        "            tokenUsage.repair = {\n"
        "              ...(tokenUsage.repair ?? {}),\n"
        "              warning: 'invalid_patch_writer_artifact_retained',\n"
        "              warningMessage:\n"
        "                'Repair 未返回可应用的 JSON 补丁，已保留修复前正文。',\n"
        "            };\n"
        "          }\n",
        "remove standard raw repair fallback",
    )
    text = replace_once(
        text,
        "          'Repair 候选相对 Writer 正文过度缩短或偏离 2500–4000 汉字质量带，已保留 Writer artifact；本次不重试，也不再次调用 Checker。',\n",
        "          'Repair 候选破坏本次动态长度契约、发生过度缩短或明显远离目标，已保留修复前 artifact；本次不重试，也不再次调用 Checker。',\n",
        "dynamic repair rejection message",
    )
    text = replace_once(
        text,
        "    const repaired =\n      applyRepairPatches(artifact.content, result.text) ?? result.text.trim();\n    if (!repaired) throw new Error('额外 Repair 未返回正文，候选正文保持不变');\n",
        "    const repaired = applyRepairPatches(artifact.content, result.text);\n"
        "    if (!repaired) {\n"
        "      throw new Error(\n"
        "        '额外 Repair 未返回可应用的 JSON 补丁，候选正文保持不变',\n"
        "      );\n"
        "    }\n",
        "remove extra raw repair fallback",
    )
    text = replace_once(
        text,
        "        '额外 Repair 候选相对当前正文过度缩短，已保留原候选；本次不再重试，也不会调用 LLM Checker。',\n",
        "        '额外 Repair 候选破坏动态长度契约、过度缩短或明显远离目标，已保留原候选；本次不再重试，也不会调用 LLM Checker。',\n",
        "extra repair rejection message",
    )
    path.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo", type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
    generation = repo / ROOT_REL
    required = [
        generation / "continuationChecker.ts",
        generation / "continuationPromptCompiler.ts",
        generation / "continuationGenerationRunner.ts",
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise SystemExit("missing repository files:\n" + "\n".join(missing))

    write_new(generation / "continuationLengthContract.ts", LENGTH_CONTRACT)
    write_new(generation / "continuationRepairPatch.ts", REPAIR_PATCH)
    patch_checker(generation / "continuationChecker.ts")
    patch_prompt(generation / "continuationPromptCompiler.ts")
    patch_runner(generation / "continuationGenerationRunner.ts")
    write_new(repo / "__tests__/continuationLengthRepair.test.ts", JEST_TEST)
    print("continuation length/Repair patch applied")


if __name__ == "__main__":
    main()
