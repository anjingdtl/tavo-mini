/**
 * Outline packing / fingerprint / full-stage outline consistency tests
 * (大纲模式升级缺漏修复 — P0/P1).
 */
import {
  buildFactCheckMessages,
  buildProofMessages,
  buildReviewMessages,
  estimateStageInputTokens,
} from '../src/services/pipelineMessages';
import {
  checkRequestFitsContextWindow,
  computeOutlinePacking,
  computeStitchedOutlineFingerprint,
  OUTLINE_CONTRACT_VERSION,
} from '../src/services/outlineContextBuilder';
import {
  parsePersistedPipelineContextSnapshot,
  serializePipelineContextSnapshot,
} from '../src/services/pipelineRunner';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';

function makeOutline(
  id: number,
  title: string,
  content: string,
  position = id - 1,
) {
  return {
    id,
    title,
    content,
    position,
    contentHash: `h${id}`,
    enabled: true,
    updatedAt: 1000 + id,
  };
}

describe('computeOutlinePacking fingerprint coverage', () => {
  test('title-only change alters fingerprint', () => {
    const a = computeOutlinePacking({
      outlines: [makeOutline(1, '主线 A', '内容不变')],
      budgetTokens: 100000,
    });
    const b = computeOutlinePacking({
      outlines: [makeOutline(1, '主线 B', '内容不变')],
      budgetTokens: 100000,
    });
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.stitchedText).toContain('主线 A');
    expect(b.stitchedText).toContain('主线 B');
  });

  test('content / order / enable / contract version change fingerprints', () => {
    const base = computeOutlinePacking({
      outlines: [
        makeOutline(1, '一', 'AAA', 0),
        makeOutline(2, '二', 'BBB', 1),
      ],
      budgetTokens: 100000,
    });
    const contentChanged = computeOutlinePacking({
      outlines: [
        makeOutline(1, '一', 'AAA-changed', 0),
        makeOutline(2, '二', 'BBB', 1),
      ],
      budgetTokens: 100000,
    });
    const orderChanged = computeOutlinePacking({
      outlines: [
        makeOutline(2, '二', 'BBB', 0),
        makeOutline(1, '一', 'AAA', 1),
      ],
      budgetTokens: 100000,
    });
    const disabled = computeOutlinePacking({
      outlines: [
        { ...makeOutline(1, '一', 'AAA', 0), enabled: true },
        { ...makeOutline(2, '二', 'BBB', 1), enabled: false },
      ],
      budgetTokens: 100000,
    });
    const contractBumped = computeOutlinePacking({
      outlines: [
        makeOutline(1, '一', 'AAA', 0),
        makeOutline(2, '二', 'BBB', 1),
      ],
      budgetTokens: 100000,
      contractVersion: OUTLINE_CONTRACT_VERSION + 1,
    });

    expect(contentChanged.fingerprint).not.toBe(base.fingerprint);
    expect(orderChanged.fingerprint).not.toBe(base.fingerprint);
    expect(disabled.fingerprint).not.toBe(base.fingerprint);
    expect(contractBumped.fingerprint).not.toBe(base.fingerprint);
  });

  test('UI packing total includes header/contract (not content-only)', () => {
    const packing = computeOutlinePacking({
      outlines: [makeOutline(1, '标题', '正文内容')],
      budgetTokens: 100000,
    });
    expect(packing.sharedOverheadTokens).toBeGreaterThan(0);
    expect(packing.totalTokens).toBeGreaterThan(packing.items[0].contentTokens);
    expect(packing.fingerprint).toBe(
      computeStitchedOutlineFingerprint(packing.stitchedText),
    );
  });
});

describe('four stages share full outline (no silent 6000 clip)', () => {
  test('review / factCheck / proof keep a long outline byte-identical', () => {
    // Far larger than the old 6000-token clip budget.
    const longOutline = '大纲节点。'.repeat(4000); // ~8000 tokens
    const review = buildReviewMessages('初稿正文', {
      presetText: 'p',
      characterText: 'c',
      noteText: '',
      worldbookText: '',
      storyMemoryText: '',
      episodicMemoryText: '',
      recentBridgeText: '',
      currentInstructionText: '',
      retrievalUserPrompt: '',
      outlineText: longOutline,
    });
    const fact = buildFactCheckMessages('初稿正文', {
      presetText: 'p',
      currentInstructionText: '',
      retrievalUserPrompt: '',
      recentBridgeText: '',
      storyMemoryText: '',
      episodicMemoryText: '',
      worldbookText: '',
      characterText: '',
      noteText: '',
      outlineText: longOutline,
    });
    const proof = buildProofMessages('初稿正文', '', '', {
      presetText: 'p',
      currentInstructionText: '',
      retrievalUserPrompt: '',
      relevantCharacterConstraints: '',
      relevantWorldRules: '',
      currentStoryState: '',
      episodicMemoryText: '',
      noteText: '',
      recentBridgeText: '',
      outlineText: longOutline,
    });

    const reviewUser = review.find(m => m.role === 'user')!.content;
    const factUser = fact.find(m => m.role === 'user')!.content;
    const proofUser = proof.find(m => m.role === 'user')!.content;

    expect(reviewUser).toContain(longOutline);
    expect(factUser).toContain(longOutline);
    expect(proofUser).toContain(longOutline);
    // No truncation marker or mid-cut of the long block.
    expect(reviewUser.indexOf(longOutline)).toBeGreaterThan(-1);
    expect(factUser.indexOf(longOutline)).toBeGreaterThan(-1);
    expect(proofUser.indexOf(longOutline)).toBeGreaterThan(-1);
  });
});

describe('context window final check', () => {
  test('blocks when input + output + safety exceed window', () => {
    const reason = checkRequestFitsContextWindow({
      estimatedInputTokens: 9000,
      reservedOutputTokens: 2000,
      contextWindow: 8000,
      stageLabel: '初稿',
    });
    expect(reason).toBeTruthy();
    expect(reason).toContain('初稿');
    expect(reason).toContain('超出');
  });

  test('passes when request fits', () => {
    const reason = checkRequestFitsContextWindow({
      estimatedInputTokens: 1000,
      reservedOutputTokens: 500,
      contextWindow: 32000,
      stageLabel: '初稿',
    });
    expect(reason).toBeNull();
  });

  test('unknown window blocks real generation', () => {
    const reason = checkRequestFitsContextWindow({
      estimatedInputTokens: 10,
      reservedOutputTokens: 10,
      contextWindow: 0,
    });
    expect(reason).toBeTruthy();
    expect(reason).toContain('上下文窗口');
  });

  test('estimateStageInputTokens grows with messages', () => {
    const small = estimateStageInputTokens([
      { role: 'user', content: '短' },
    ]);
    const large = estimateStageInputTokens([
      { role: 'user', content: '短'.repeat(500) },
    ]);
    expect(large).toBeGreaterThan(small);
  });
});

describe('pipeline context snapshot persistence helpers', () => {
  const baseSnapshot: PipelineContextSnapshot = {
    presetText: 'preset',
    storyMemoryText: '',
    characterText: '',
    noteText: '',
    worldbookText: '',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '写第 3 章',
    retrievalUserPrompt: '',
    outlineText: '完整冻结大纲正文',
    outlineFingerprint: 'abc',
    outlineIds: [1, 2],
    outlineComplete: true,
    outlineEstimatedTokens: 12,
  };

  test('round-trips frozen snapshot with integrity hash', () => {
    const persisted = serializePipelineContextSnapshot(baseSnapshot);
    expect(persisted.pipelineContextVersion).toBe(1);
    expect(persisted.pipelineContextHash).toHaveLength(32);
    const restored = parsePersistedPipelineContextSnapshot(persisted);
    expect(restored.outlineText).toBe('完整冻结大纲正文');
    expect(restored.outlineIds).toEqual([1, 2]);
  });

  test('rejects missing snapshot', () => {
    expect(() =>
      parsePersistedPipelineContextSnapshot({
        pipelineContextJson: null,
        pipelineContextHash: null,
      }),
    ).toThrow(/没有冻结/);
  });

  test('rejects corrupted hash', () => {
    const persisted = serializePipelineContextSnapshot(baseSnapshot);
    expect(() =>
      parsePersistedPipelineContextSnapshot({
        ...persisted,
        pipelineContextHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
      }),
    ).toThrow(/校验失败|损坏/);
  });

  test('rejects broken JSON', () => {
    expect(() =>
      parsePersistedPipelineContextSnapshot({
        pipelineContextJson: '{not-json',
        pipelineContextHash: null,
      }),
    ).toThrow(/损坏|无效/);
  });
});
