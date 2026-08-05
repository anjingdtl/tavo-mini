/**
 * Seal 1: Frozen Draft request + frozen audit candidates.
 */
import {
  compileDraftFromFrozenRequest,
} from '../src/services/pipeline/compileStageRequest';
import {
  buildPostDraftAuditContextFromFrozen,
} from '../src/services/postDraftRetrieval';
import {
  computeFrozenDraftRequestFingerprint,
  serializePipelineTaskContext,
  parsePersistedPipelineTaskContext,
} from '../src/services/pipelineTaskContext';
import type { FrozenDraftRequest } from '../src/types/pipelineFrozen';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';
import type { FrozenAuditCandidates } from '../src/types/pipelineFrozen';

function frozenDraft(messages: Array<{ role: string; content: string }>): FrozenDraftRequest {
  const estimatedInputTokens = 100;
  const reservedOutputTokens = 1000;
  const safetyMargin = 512;
  const contextWindow = 128000;
  return {
    messages: messages as any,
    estimatedInputTokens,
    reservedOutputTokens,
    safetyMargin,
    contextWindow,
    allocations: [],
    requestFingerprint: computeFrozenDraftRequestFingerprint(messages as any, {
      estimatedInputTokens,
      reservedOutputTokens,
      safetyMargin,
      contextWindow,
    }),
    chapterTitle: '第 1 章',
    prevEnding: '',
    userPrompt: 'continue',
  };
}

const execution: PipelineExecutionSnapshot = {
  pipelineMode: 'full',
  draftMaxTokens: 1000,
  reviewMaxTokens: 500,
  factCheckMaxTokens: 500,
  proofMaxTokens: 1000,
  draftPresetId: null,
  reviewPresetId: null,
  factCheckPresetId: null,
  proofPresetId: null,
  draftPreset: null,
  reviewPreset: null,
  factCheckPreset: null,
  proofPreset: null,
  model: {
    llmConfigId: 1,
    name: 'm',
    provider: 'openai_compatible',
    modelName: 'model-a',
    contextWindow: 128000,
    maxOutputTokens: 8000,
  },
  createdAt: Date.now(),
};

function snap(overrides: Partial<PipelineContextSnapshot> = {}): PipelineContextSnapshot {
  return {
    presetText: 'preset',
    storyMemoryText: 'sm',
    characterText: '角色「甲」\n描述：旧',
    noteText: '',
    worldbookText: '关键词「旧词」：旧世界',
    episodicMemoryText: '第 1 章「序」摘要：旧事件',
    recentBridgeText: '',
    currentInstructionText: '',
    retrievalUserPrompt: 'write',
    outlineText: '大纲A',
    outlineFingerprint: 'fp',
    outlineIds: [1],
    outlineComplete: true,
    outlineEstimatedTokens: 10,
    projectId: 1,
    chapterId: 2,
    createdAt: Date.now(),
    snapshotVersion: 1,
    ...overrides,
  };
}

describe('frozen draft request', () => {
  test('resume uses frozen messages without live recompile', () => {
    const frozen = frozenDraft([
      { role: 'system', content: 'FROZEN_OUTLINE_V1' },
      { role: 'user', content: 'write chapter' },
    ]);
    const ready = compileDraftFromFrozenRequest({ frozen });
    expect(ready.ready).toBe(true);
    if (!ready.ready) return;
    expect(ready.messages).toEqual(frozen.messages);
    expect(ready.messages[0].content).toBe('FROZEN_OUTLINE_V1');
  });

  test('draft retry appends instruction and rechecks window', () => {
    const frozen = frozenDraft([
      { role: 'system', content: 'ctx' },
      { role: 'user', content: 'body' },
    ]);
    const retry = compileDraftFromFrozenRequest({
      frozen,
      retryInstruction: '请直接输出章节正文',
    });
    expect(retry.ready).toBe(true);
    if (!retry.ready) return;
    expect(retry.messages).toHaveLength(3);
    expect(retry.messages[2].content).toContain('直接输出');
  });

  test('draft retry blocks when window exceeded (no model path)', () => {
    const huge = '字'.repeat(50000);
    const frozen = frozenDraft([
      { role: 'system', content: huge },
      { role: 'user', content: huge },
    ]);
    frozen.contextWindow = 1000;
    frozen.reservedOutputTokens = 800;
    frozen.safetyMargin = 200;
    frozen.estimatedInputTokens = 50000;
    const retry = compileDraftFromFrozenRequest({
      frozen,
      retryInstruction: 'retry ' + 'x'.repeat(5000),
    });
    expect(retry.ready).toBe(false);
    if (retry.ready) return;
    expect(retry.error.code).toBe('CONTEXT_WINDOW_EXCEEDED');
  });

  test('serialize/parse preserves frozen draft request', () => {
    const frozen = frozenDraft([{ role: 'system', content: 'stable' }]);
    const ser = serializePipelineTaskContext({
      draftContext: snap(),
      execution,
      frozenDraftRequest: frozen,
    });
    const parsed = parsePersistedPipelineTaskContext(ser);
    expect(parsed.frozenDraftRequest?.messages[0].content).toBe('stable');
    expect(parsed.frozenDraftRequest?.requestFingerprint).toBe(
      frozen.requestFingerprint,
    );
  });
});

describe('frozen audit candidates', () => {
  const frozenCandidates: FrozenAuditCandidates = {
    episodicCandidates: [
      {
        id: 10,
        position: 0,
        title: '序',
        memory_summary: '甲回到故乡',
      },
      {
        id: 11,
        position: 1,
        title: '二',
        memory_summary: '乙出现',
      },
    ],
    characterCandidates: [
      { id: 1, name: '甲', cardText: '角色「甲」\n描述：新卡' },
      { id: 2, name: '丙', cardText: '角色「丙」\n描述：候选' },
    ],
    worldbookCandidates: [
      {
        id: 1,
        keywords: ['神器'],
        secondaryKeywords: [],
        content: '神器设定',
        constant: false,
        position: 0,
      },
    ],
    contextConfig: {
      strategy: 'sliding',
      slidingWindowSize: 1000,
      customRangeStart: 0,
      customRangeEnd: -1,
      resourceBudget: 5000,
      includeResources: true,
      memoryTopK: 5,
      episodicMemoryBudgetTokens: 5000,
      worldbookRecursive: true,
    },
    chapterPosition: 2,
    chapterTitle: '三',
    chapterSynopsis: '',
    rawChapterIds: [],
    storyStateText: '',
    createdAt: Date.now(),
  };

  test('rebuild does not require live repositories (pure frozen)', () => {
    const original = snap();
    const draftText = '丙拿起了神器，甲回忆起故乡。';
    const result = buildPostDraftAuditContextFromFrozen(
      original,
      draftText,
      frozenCandidates,
    );
    expect(result.fellBack).toBe(false);
    // Character 丙 should be mergeable from frozen pool when mentioned.
    expect(result.snapshot.characterText).toContain('丙');
    // Worldbook 神器 activated from frozen pool.
    expect(result.snapshot.worldbookText).toContain('神器');
  });

  test('same draft + same frozen candidates → same auditContext', () => {
    const original = snap();
    const draftText = '丙与神器';
    const a = buildPostDraftAuditContextFromFrozen(
      original,
      draftText,
      frozenCandidates,
    );
    const b = buildPostDraftAuditContextFromFrozen(
      original,
      draftText,
      frozenCandidates,
    );
    expect(a.snapshot.characterText).toBe(b.snapshot.characterText);
    expect(a.snapshot.worldbookText).toBe(b.snapshot.worldbookText);
    expect(a.snapshot.episodicMemoryText).toBe(b.snapshot.episodicMemoryText);
  });

  test('serialize/parse preserves frozen audit candidates', () => {
    const ser = serializePipelineTaskContext({
      draftContext: snap(),
      execution,
      frozenAuditCandidates: frozenCandidates,
      frozenDraftRequest: frozenDraft([{ role: 'user', content: 'x' }]),
    });
    const parsed = parsePersistedPipelineTaskContext(ser);
    expect(parsed.frozenAuditCandidates?.characterCandidates).toHaveLength(2);
    expect(parsed.frozenAuditCandidates?.worldbookCandidates[0].keywords).toEqual([
      '神器',
    ]);
  });
});
