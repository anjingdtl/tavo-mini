/**
 * Revision ChangeSet（B2）：Draft → Final 的确定性解释投影。
 *
 * 约束：
 *  - 不新增 LLM Stage、不改 prompt：修改清单由本地 LCS diff 计算，
 *    before/after 均为真实正文片段；
 *  - 不是正文 authority（Final Body 仍是最终正文）；
 *  - 无修改时 changes 为空，UI 明确显示「AI 未修改正文」；
 *  - reason/findingIds 来自 QA findings 的本地文本关联，找不到时
 *    明确标注「未关联」，绝不编造原因。
 */

import { sha256Hex } from '../continuation/hashUtils';

export type RevisionChangeType = 'add' | 'delete' | 'rewrite';

export interface RevisionChange {
  id: string;
  anchorId: string;
  changeType: RevisionChangeType;
  beforeText: string;
  afterText: string;
  reason: string;
  findingIds: string[];
  beforeFingerprint: string;
  afterFingerprint: string;
}

export interface RevisionChangeSet {
  version: 1;
  draftFingerprint: string;
  finalFingerprint: string;
  changes: RevisionChange[];
}

/** QA finding 形状（与 compact QA 结构化输出兼容的子集）。 */
export interface RevisionFindingLike {
  issue: string;
  severity: 'blocking' | 'warning';
  target?: string | null;
}

export const REVISION_CHANGE_MAX = 20;

/**
 * LCS 成对序列：a[i] 与 b[j] 相等的下标对（按序）。
 * 使用 Myers-lite O(n*m) 动态规划（正文段落数通常 < 400，可接受）。
 */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function classifyChange(before: string, after: string): RevisionChangeType {
  const b = before.trim();
  const a = after.trim();
  if (!b) return 'add';
  if (!a) return 'delete';
  if (a.includes(b)) return 'add';
  if (b.includes(a)) return 'delete';
  return 'rewrite';
}

function trimSharedWhitespace(before: string, after: string): {
  before: string;
  after: string;
} {
  const leading = Math.min(
    before.length - before.trimStart().length,
    after.length - after.trimStart().length,
  );
  const rawBefore = before.slice(leading);
  const rawAfter = after.slice(leading);
  const trailing = Math.min(
    rawBefore.length - rawBefore.trimEnd().length,
    rawAfter.length - rawAfter.trimEnd().length,
  );
  return {
    before: rawBefore.slice(0, rawBefore.length - trailing),
    after: rawAfter.slice(0, rawAfter.length - trailing),
  };
}

/** 改前片段是否出现在 finding 的原文范围内（issue/target 任一包含）。 */
function findMatchingFindings(
  beforeText: string,
  findings: RevisionFindingLike[],
): { matched: RevisionFindingLike[]; hitIndices: number[] } {
  const trimmed = beforeText.trim();
  const needles = collectNeedles(trimmed);
  const matched: RevisionFindingLike[] = [];
  const hitIndices: number[] = [];
  findings.forEach((finding, index) => {
    const scope = `${finding.issue}\n${finding.target ?? ''}`;
    if (needles.some(needle => needle.length > 0 && scope.includes(needle))) {
      matched.push(finding);
      hitIndices.push(index);
    }
  });
  return { matched, hitIndices };
}

/**
 * 生成用于命中的文本窗口：完整片段 + 4-gram/6-gram/8-gram 滑动子串（上限
 * 60 个），覆盖「finding 只引用片段内短语（如人名/关键设定）」。
 */
function collectNeedles(trimmed: string): string[] {
  const needles: string[] = [trimmed];
  for (const windowLen of [4, 6, 8]) {
    for (let start = 0; start + windowLen <= trimmed.length; start += 1) {
      if (needles.length >= 60) break;
      const slice = trimmed.slice(start, start + windowLen);
      if (!needles.includes(slice)) needles.push(slice);
    }
    if (needles.length >= 60) break;
  }
  return needles.slice(0, 60);
}

export function buildRevisionChangeSetEmpty(body: string): RevisionChangeSet {
  const fingerprint = sha256Hex(String(body ?? '').trim());
  return {
    version: 1,
    draftFingerprint: fingerprint,
    finalFingerprint: fingerprint,
    changes: [],
  };
}

/**
 * 计算 Draft → Final 的修改清单（确定性本地 diff）。
 *
 * 算法：段落（\n）级 LCS 成对序列 → 相邻公共段之间的区域即差异区 →
 * 单条 change；before/after 收敛到共享空白之外的真实正文片段。
 */
export function computeRevisionChangeSet(
  draftBody: string,
  finalBody: string,
  findings: RevisionFindingLike[],
): RevisionChangeSet {
  const draft = String(draftBody ?? '');
  const final = String(finalBody ?? '');
  const draftFingerprint = sha256Hex(draft.trim());
  const finalFingerprint = sha256Hex(final.trim());
  if (!draft.trim() || !final.trim()) {
    return { version: 1, draftFingerprint, finalFingerprint, changes: [] };
  }

  const draftParas = draft.split('\n');
  const finalParas = final.split('\n');
  const pairs = lcsPairs(draftParas, finalParas);

  const changes: RevisionChange[] = [];
  let prevP = -1;
  let prevQ = -1;
  for (const [cp, cq] of pairs) {
    if (cp > prevP + 1 || cq > prevQ + 1) {
      const beforeBlock = draftParas.slice(prevP + 1, cp).join('\n');
      const afterBlock = finalParas.slice(prevQ + 1, cq).join('\n');
      pushChange(changes, beforeBlock, afterBlock, findings);
      if (changes.length >= REVISION_CHANGE_MAX) break;
    }
    prevP = cp;
    prevQ = cq;
  }
  if (changes.length < REVISION_CHANGE_MAX) {
    const tailBefore = draftParas.slice(prevP + 1).join('\n');
    const tailAfter = finalParas.slice(prevQ + 1).join('\n');
    pushChange(changes, tailBefore, tailAfter, findings);
  }

  changes.sort((a, b) => {
    const posA = draft.indexOf(a.beforeText || a.afterText);
    const posB = draft.indexOf(b.beforeText || b.afterText);
    return (posA < 0 ? Number.MAX_SAFE_INTEGER : posA) -
      (posB < 0 ? Number.MAX_SAFE_INTEGER : posB);
  });
  return { version: 1, draftFingerprint, finalFingerprint, changes };
}

function pushChange(
  changes: RevisionChange[],
  beforeText: string,
  afterText: string,
  findings: RevisionFindingLike[],
): void {
  if (changes.length >= REVISION_CHANGE_MAX) return;
  const { before, after } = trimSharedWhitespace(beforeText, afterText);
  if (!before && !after) return;
  if (before === after) return;
  const { matched, hitIndices } = findMatchingFindings(before, findings);
  changes.push({
    id: `rev-diff-${changes.length}`,
    anchorId: `anchor-${changes.length}`,
    changeType: classifyChange(before, after),
    beforeText: before,
    afterText: after,
    reason:
      matched.length > 0
        ? matched[0].issue
        : findings.length > 0
        ? `未关联到具体检查项（共 ${findings.length} 项检查）`
        : '未关联到具体检查项',
    findingIds: hitIndices.map(hit => `f${hit}`),
    beforeFingerprint: sha256Hex(before),
    afterFingerprint: sha256Hex(after),
  });
}