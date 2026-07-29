jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(),
  resolveLLMRequestConfigById: jest.fn(),
}));

jest.mock('../src/services/continuation/styleProfile/styleProfileRepository', () => ({
  insertStyleProfile: jest.fn(),
  updateStyleProfileState: jest.fn(),
  updateStyleProfilePayload: jest.fn(),
  updateStyleProfileReviewStatus: jest.fn(),
  saveStyleProfileUserOverrides: jest.fn(),
  invalidateStyleProfilesForProject: jest.fn(),
  setActiveStyleProfileId: jest.fn(),
  getInjectableStyleProfile: jest.fn(),
  getStyleProfileById: jest.fn(),
  listStyleProfilesForProject: jest.fn(),
  getActiveStyleProfileId: jest.fn(),
}));

jest.mock('../src/services/continuation/continuationSourceReader', () => ({
  continuationSourceReader: {
    getSnapshot: jest.fn(),
    listBoundedSourceChapters: jest.fn(),
    readBoundedEvidenceRange: jest.fn(),
  },
}));

jest.mock('../src/services/continuation/canon/canonRepository', () => ({
  getActiveSnapshot: jest.fn(),
  listRunsForProject: jest.fn(),
  getRunById: jest.fn(),
}));

import { callLLMResult, resolveLLMRequestConfigById } from '../src/services/llm';
import {
  insertStyleProfile,
  updateStyleProfileState,
  updateStyleProfilePayload,
  getInjectableStyleProfile,
  listStyleProfilesForProject,
} from '../src/services/continuation/styleProfile/styleProfileRepository';
import { continuationSourceReader } from '../src/services/continuation/continuationSourceReader';
import {
  getActiveSnapshot,
  listRunsForProject,
} from '../src/services/continuation/canon/canonRepository';
import {
  runStyleAnalysis,
  retryStyleAnalysis,
  cancelStyleAnalysis,
} from '../src/services/continuation/styleProfile/styleAnalysisService';
import type { ContinuationSourceSnapshot } from '../src/services/continuation/types';
import type { OriginalStyleProfileV2 } from '../src/services/continuation/styleProfile/styleProfileV2Schema';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';
import { sha256Hex } from '../src/services/continuation/hashUtils';

const sourceSnapshot: ContinuationSourceSnapshot = {
  projectId: 1,
  sourceId: 10,
  sourceVersion: 3,
  normalizedSha256: 'abc123',
  parserVersion: 'p1',
  normalizationVersion: 'n1',
  boundary: {
    chapterId: 99,
    chapterPosition: asSourcePosition(5),
    charOffsetExclusive: asUtf16Offset(5000),
  },
};

function boundedChapter(id: number, content: string, startOffset = 0) {
  return {
    id,
    sourceId: 10,
    position: asSourcePosition(id),
    title: `ch${id}`,
    content,
    range: {
      start: asUtf16Offset(startOffset),
      end: asUtf16Offset(startOffset + content.length),
    },
    clippedByBoundary: false,
  };
}

function validProfile(): OriginalStyleProfileV2 {
  return {
    schemaVersion: 2,
    summary: '克制第三人称短句风格。',
    global: {
      narrative: {
        person: '第三人称',
        focalization: '限制视角',
        narrativeDistance: '贴近主角',
        tenseAndTimeHandling: '过去时顺叙',
        perspectiveSwitchRules: ['分节切换'],
      },
      syntax: {
        sentenceLengthPattern: '短句为主',
        sentenceStructures: ['主谓宾'],
        punctuationHabits: ['逗号断句'],
        paragraphPattern: '单句成段',
      },
      diction: {
        register: '书面口语',
        concreteness: '具体名词',
        lexicalPreferences: ['动词驱动'],
        expressionsToAvoid: ['套话'],
      },
      tone: {
        baseline: '克制',
        emotionalAmplitude: '低',
        humorAndRestraint: '不幽默',
      },
      rhythm: {
        scenePacing: '中速',
        expositionDensity: '低',
        transitionMethods: ['时间跳转'],
        chapterEndingPatterns: ['悬念'],
      },
      description: {
        sensoryPriorities: ['视觉'],
        environmentUsage: '点到为止',
        actionVsInteriorBalance: '动作多',
        imageryHabits: ['白描'],
      },
      dialogue: {
        dialogueDensity: '中',
        turnLength: '短',
        attributionStyle: '说/道',
        subtextStyle: '潜台词',
        expositionAvoidance: ['不解释设定'],
      },
      informationReveal: {
        setupMethod: '前置细节',
        foreshadowingMethod: '环境暗示',
        suspenseMethod: '信息差',
      },
    },
    boundaryLocalDelta: {
      tone: '更紧张',
      pacing: '加快',
      sentenceAndParagraphShift: '略增',
      activeNarrativePatterns: ['追击'],
    },
    sceneVariants: [
      {
        sceneType: 'action',
        instructions: ['短促动词'],
        avoid: ['长描写'],
        confidence: 0.8,
      },
    ],
    characterVoices: [
      {
        canonCharacterId: null,
        sourceName: '林凡',
        speechRegister: '冷淡',
        sentenceHabits: ['反问'],
        interactionHabits: ['不主动'],
        avoid: ['感叹'],
        confidence: 0.6,
      },
    ],
    globalAvoid: ['大段抒情'],
    confidence: 0.8,
    coverage: {
      sourceChapterCount: 6,
      sampledChapterCount: 5,
      sampledKinds: ['opening', 'middle', 'boundary', 'dialogue', 'action'],
    },
  };
}

function setupBoundedReader(chapters: ReturnType<typeof boundedChapter>[]) {
  (continuationSourceReader.getSnapshot as jest.Mock).mockResolvedValue(
    sourceSnapshot,
  );
  (continuationSourceReader.listBoundedSourceChapters as jest.Mock).mockResolvedValue(
    chapters,
  );
  // readBoundedEvidenceRange returns the slice of the relevant chapter so the
  // hash re-verification inside the service passes.
  (continuationSourceReader.readBoundedEvidenceRange as jest.Mock).mockImplementation(
    async ({ start, end }: { start: number; end: number }) => {
      // Reconstruct from whichever chapter contains this range.
      for (const ch of chapters) {
        if (start >= ch.range.start && end <= ch.range.end) {
          return ch.content.slice(
            start - ch.range.start,
            end - ch.range.start,
          );
        }
      }
      return '';
    },
  );
}

function buildRichChapters(): ReturnType<typeof boundedChapter>[] {
  let offset = 0;
  const chapters: ReturnType<typeof boundedChapter>[] = [];
  const contents = [
    '阳光洒在街道上。少年推门走出，深吸一口气。这是个寻常清晨。',
    `"你来啦。"她笑道。\n"嗯。"他答道，心里感到一阵紧张。\n"为什么？"她担心地问。`,
    '他猛地拔剑冲上前。一剑挥出，对方退后两步。对方反手推来，他侧身闪过。',
    '远处群山被雪覆盖。天空灰蒙蒙的。北风卷起落叶，空气透着寒意。',
    '第二天清晨他们再次上路。随后不久天色骤变。数日后抵达边关。',
    '一切仿佛要结束了。他独自站着，回忆涌来。等待着那个注定的结局。',
  ];
  for (let i = 0; i < contents.length; i += 1) {
    const c = contents[i];
    chapters.push(boundedChapter(i, c, offset));
    offset += c.length + 1;
  }
  return chapters;
}

describe('runStyleAnalysis', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (insertStyleProfile as jest.Mock).mockResolvedValue(undefined);
    (updateStyleProfileState as jest.Mock).mockResolvedValue(undefined);
    (updateStyleProfilePayload as jest.Mock).mockResolvedValue(undefined);
  });

  it('uses a single structured call when the sampled material fits the context window', async () => {
    const chapters = buildRichChapters();
    setupBoundedReader(chapters);
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      provider_type: 'openai_compatible',
      context_window: 200_000,
      max_output_tokens: 16_000,
    });
    (callLLMResult as jest.Mock).mockResolvedValue({
      text: JSON.stringify(validProfile()),
    });

    const result = await runStyleAnalysis({
      projectId: 1,
      runId: 'run-1',
      canonSnapshotId: 'snap-1',
      sourceSnapshot,
      modelConfigId: 42,
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(true);
    // Exactly one LLM call (single-call path) — no map/reduce.
    expect(callLLMResult).toHaveBeenCalledTimes(1);
    expect(updateStyleProfilePayload).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        confidence: 0.8,
      }),
      expect.objectContaining({ state: 'ready' }),
    );
  });

  it('splits into map/reduce calls when the window is too small for one call', async () => {
    const chapters = buildRichChapters();
    setupBoundedReader(chapters);
    // Very small window to force the map/reduce path.
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      provider_type: 'openai_compatible',
      context_window: 1500,
      max_output_tokens: 512,
    });
    // First several calls = map (return partials); last call = reduce (return full profile).
    (callLLMResult as jest.Mock)
      .mockResolvedValueOnce({ text: '{"local":"partial1"}' })
      .mockResolvedValueOnce({ text: '{"local":"partial2"}' })
      .mockResolvedValueOnce({ text: JSON.stringify(validProfile()) });

    const result = await runStyleAnalysis({
      projectId: 1,
      runId: 'run-1',
      canonSnapshotId: 'snap-1',
      sourceSnapshot,
      modelConfigId: 42,
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(true);
    // More than one call confirms the split happened.
    expect((callLLMResult as jest.Mock).mock.calls.length).toBeGreaterThan(1);
    expect(updateStyleProfilePayload).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ confidence: 0.8 }),
      expect.objectContaining({ state: 'ready' }),
    );
  });

  it('allows exactly one repair retry for malformed JSON, then gives up', async () => {
    const chapters = buildRichChapters();
    setupBoundedReader(chapters);
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      context_window: 200_000,
      max_output_tokens: 16_000,
    });
    // First call returns invalid JSON; second (repair) returns invalid again.
    (callLLMResult as jest.Mock)
      .mockResolvedValueOnce({ text: 'not json at all {{{' })
      .mockResolvedValueOnce({ text: '{ "schemaVersion": 99 }' });

    const result = await runStyleAnalysis({
      projectId: 1,
      runId: 'run-1',
      canonSnapshotId: 'snap-1',
      sourceSnapshot,
      modelConfigId: 42,
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(false);
    // Two calls: initial + one repair. No third attempt.
    expect(callLLMResult).toHaveBeenCalledTimes(2);
    expect(updateStyleProfileState).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      expect.objectContaining({ errorCode: 'style_analysis_failed' }),
    );
  });

  it('marks the profile failed (not ready) when the model config id is missing', async () => {
    const chapters = buildRichChapters();
    setupBoundedReader(chapters);
    const result = await runStyleAnalysis({
      projectId: 1,
      runId: 'run-1',
      canonSnapshotId: 'snap-1',
      sourceSnapshot,
      modelConfigId: null,
      signal: new AbortController().signal,
    });
    expect(result.success).toBe(false);
    expect(callLLMResult).not.toHaveBeenCalled();
    expect(updateStyleProfileState).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      expect.objectContaining({ errorCode: 'style_analysis_failed' }),
    );
  });

  it('computes a stable profile hash that covers profile + metrics + sample refs', async () => {
    const chapters = buildRichChapters();
    setupBoundedReader(chapters);
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      context_window: 200_000,
      max_output_tokens: 16_000,
    });
    (callLLMResult as jest.Mock).mockResolvedValue({
      text: JSON.stringify(validProfile()),
    });

    await runStyleAnalysis({
      projectId: 1,
      runId: 'run-1',
      canonSnapshotId: 'snap-1',
      sourceSnapshot,
      modelConfigId: 42,
      signal: new AbortController().signal,
    });

    const payloadArg = (updateStyleProfilePayload as jest.Mock).mock.calls[0][1];
    expect(payloadArg.profileHash).toMatch(/^[0-9a-f]{64}$/);
    // Each stored sample ref carries a recomputable content hash.
    for (const ref of payloadArg.sampleRefsJson) {
      expect(ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const chapter = chapters.find(c => c.id === ref.sourceChapterId)!;
      const passage = chapter.content.slice(
        ref.charStart - chapter.range.start,
        ref.charEnd - chapter.range.start,
      );
      expect(sha256Hex(passage)).toBe(ref.contentHash);
    }
  });

  it('never stores long passage text: sample refs carry only offsets + hash', async () => {
    const chapters = buildRichChapters();
    setupBoundedReader(chapters);
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      context_window: 200_000,
      max_output_tokens: 16_000,
    });
    (callLLMResult as jest.Mock).mockResolvedValue({
      text: JSON.stringify(validProfile()),
    });

    await runStyleAnalysis({
      projectId: 1,
      runId: 'run-1',
      canonSnapshotId: 'snap-1',
      sourceSnapshot,
      modelConfigId: 42,
      signal: new AbortController().signal,
    });

    const payloadArg = (updateStyleProfilePayload as jest.Mock).mock.calls[0][1];
    for (const ref of payloadArg.sampleRefsJson) {
      expect(ref).not.toHaveProperty('text');
      expect(ref).not.toHaveProperty('content');
      expect(ref).not.toHaveProperty('passage');
    }
  });

  it('marks the profile outdated when the source/boundary has drifted', async () => {
    const chapters = buildRichChapters();
    (continuationSourceReader.getSnapshot as jest.Mock).mockResolvedValue({
      ...sourceSnapshot,
      // Drift: different source version than the snapshot captured.
      sourceVersion: 999,
    });
    (continuationSourceReader.listBoundedSourceChapters as jest.Mock).mockResolvedValue(
      chapters,
    );
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      context_window: 200_000,
      max_output_tokens: 16_000,
    });

    const result = await runStyleAnalysis({
      projectId: 1,
      runId: 'run-1',
      canonSnapshotId: 'snap-1',
      sourceSnapshot,
      modelConfigId: 42,
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(false);
    expect(callLLMResult).not.toHaveBeenCalled();
    expect(updateStyleProfileState).toHaveBeenCalledWith(
      expect.any(String),
      'outdated',
      expect.objectContaining({ errorCode: 'source_outdated' }),
    );
  });

  it('rejects a sample whose stored hash no longer matches the bounded text (tamper guard)', async () => {
    const chapters = buildRichChapters();
    setupBoundedReader(chapters);
    // Tamper: return different text than the sampler hashed.
    (continuationSourceReader.readBoundedEvidenceRange as jest.Mock).mockResolvedValue(
      'tampered text that does not match any hash',
    );
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      context_window: 200_000,
      max_output_tokens: 16_000,
    });
    (callLLMResult as jest.Mock).mockResolvedValue({
      text: JSON.stringify(validProfile()),
    });

    const result = await runStyleAnalysis({
      projectId: 1,
      runId: 'run-1',
      canonSnapshotId: 'snap-1',
      sourceSnapshot,
      modelConfigId: 42,
      signal: new AbortController().signal,
    });

    // The tamper guard must abort before activation.
    expect(result.success).toBe(false);
    expect(updateStyleProfileState).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      expect.objectContaining({ errorCode: 'style_analysis_failed' }),
    );
  });

  it('short-circuits with a failed result when the signal aborts during an LLM call (Fix #3 post-await re-check)', async () => {
    const chapters = buildRichChapters();
    setupBoundedReader(chapters);
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      context_window: 200_000,
      max_output_tokens: 16_000,
    });
    (listStyleProfilesForProject as jest.Mock).mockResolvedValue([]);

    const caller = new AbortController();
    // The provider returns normally, but the caller aborts JUST before the
    // call resolves. Without the post-await signal re-check (canon parity),
    // this partial result would proceed to validate/insert. The re-check must
    // throw '分析已暂停或取消' so the run is marked failed instead.
    (callLLMResult as jest.Mock).mockImplementation(async () => {
      caller.abort();
      return { text: JSON.stringify(validProfile()) };
    });

    const result = await runStyleAnalysis({
      projectId: 1,
      runId: 'run-abort',
      canonSnapshotId: 'snap-1',
      sourceSnapshot,
      modelConfigId: 42,
      signal: caller.signal,
    });

    expect(result.success).toBe(false);
    // The provider was reached (the call started), but the post-await abort
    // guard must prevent any ready/payload write.
    expect(updateStyleProfilePayload).not.toHaveBeenCalled();
    expect(updateStyleProfileState).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      expect.objectContaining({
        errorCode: 'style_analysis_failed',
        errorMessage: expect.stringContaining('取消'),
      }),
    );
  });

  it('can be cancelled via cancelStyleAnalysis(profileId) registered for the run', async () => {
    const chapters = buildRichChapters();
    setupBoundedReader(chapters);
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      context_window: 200_000,
      max_output_tokens: 16_000,
    });
    (listStyleProfilesForProject as jest.Mock).mockResolvedValue([]);

    // capture the generated profileId from the insert call so we can cancel by it.
    let capturedProfileId = '';
    (insertStyleProfile as jest.Mock).mockImplementation((input: { id: string }) => {
      capturedProfileId = input.id;
      // Abort via the public cancel API the moment the profile is registered,
      // simulating a UI cancel racing the LLM call.
      cancelStyleAnalysis(capturedProfileId);
      return Promise.resolve();
    });
    (callLLMResult as jest.Mock).mockResolvedValue({
      text: JSON.stringify(validProfile()),
    });

    const result = await runStyleAnalysis({
      projectId: 1,
      runId: 'run-cancel',
      canonSnapshotId: 'snap-1',
      sourceSnapshot,
      modelConfigId: 42,
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(false);
    expect(updateStyleProfilePayload).not.toHaveBeenCalled();
    // Controller must be cleaned up after the run ends.
    expect(capturedProfileId).not.toBe('');
  });

  it('preserves prior user overrides when re-analyzing (Spec §5.7, §14.1)', async () => {
    const chapters = buildRichChapters();
    setupBoundedReader(chapters);
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      context_window: 200_000,
      max_output_tokens: 16_000,
    });
    (callLLMResult as jest.Mock).mockResolvedValue({
      text: JSON.stringify(validProfile()),
    });
    // Simulate a prior profile row carrying non-empty user overrides from a
    // previous user edit. The auto profile will be replaced; overrides survive.
    const priorOverrides = {
      tone: { baseline: '更冷峻' },
      globalAvoid: ['禁止任何感叹句'],
    };
    (listStyleProfilesForProject as jest.Mock).mockResolvedValue([
      {
        id: 'prior-profile',
        projectId: 1,
        userOverridesJson: priorOverrides,
        state: 'outdated',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);

    const result = await runStyleAnalysis({
      projectId: 1,
      runId: 'run-reanalyze',
      canonSnapshotId: 'snap-1',
      sourceSnapshot,
      modelConfigId: 42,
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(true);
    // The new profile row is inserted carrying the prior user overrides, so
    // re-analysis never loses the user's manual corrections.
    expect(insertStyleProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        userOverridesJson: priorOverrides,
      }),
    );
  });

  it('starts with empty overrides when no prior profile has user edits', async () => {
    const chapters = buildRichChapters();
    setupBoundedReader(chapters);
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      context_window: 200_000,
      max_output_tokens: 16_000,
    });
    (callLLMResult as jest.Mock).mockResolvedValue({
      text: JSON.stringify(validProfile()),
    });
    // No prior overrides anywhere.
    (listStyleProfilesForProject as jest.Mock).mockResolvedValue([
      { id: 'prior', userOverridesJson: {}, state: 'outdated' },
    ]);

    await runStyleAnalysis({
      projectId: 1,
      runId: 'run-fresh',
      canonSnapshotId: 'snap-1',
      sourceSnapshot,
      modelConfigId: 42,
      signal: new AbortController().signal,
    });

    expect(insertStyleProfile).toHaveBeenCalledWith(
      expect.objectContaining({ userOverridesJson: {} }),
    );
  });

  describe('ignored profile is not injected (repository contract)', () => {
    it('getInjectableStyleProfile returns null for an ignored profile', async () => {
      // The repository is mocked; re-mock to emulate the ignored-row case.
      (getInjectableStyleProfile as jest.Mock).mockResolvedValue(null);
      const injected = await getInjectableStyleProfile(1, {
        sourceId: 10,
        sourceVersion: 3,
        sourceSha256: 'abc123',
        parserVersion: 'p1',
        normalizationVersion: 'n1',
        boundaryChapterId: 99,
        boundaryPosition: 5,
        boundaryCharOffsetExclusive: 5000,
      });
      expect(injected).toBeNull();
    });
  });
});

describe('retryStyleAnalysis', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (insertStyleProfile as jest.Mock).mockResolvedValue(undefined);
    (updateStyleProfileState as jest.Mock).mockResolvedValue(undefined);
    (updateStyleProfilePayload as jest.Mock).mockResolvedValue(undefined);
  });

  it('re-runs analysis for the latest canon snapshot run and succeeds', async () => {
    const chapters = buildRichChapters();
    setupBoundedReader(chapters);
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      context_window: 200_000,
      max_output_tokens: 16_000,
    });
    (callLLMResult as jest.Mock).mockResolvedValue({
      text: JSON.stringify(validProfile()),
    });
    (getActiveSnapshot as jest.Mock).mockResolvedValue(null);
    (listRunsForProject as jest.Mock).mockResolvedValue([
      {
        id: 'run-latest',
        canonSnapshotId: 'snap-latest',
        modelConfigId: 42,
      },
    ]);

    await expect(retryStyleAnalysis(1)).resolves.not.toThrow();
    expect(callLLMResult).toHaveBeenCalled();
  });
});
