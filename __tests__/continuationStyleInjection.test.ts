/**
 * WP3: multi-level style injection — renderer, select level, context builder
 * injectable path, strict/balanced policy, prompt compiler, no bare SQL.
 */
import type { OriginalStyleProfileV2 } from '../src/services/continuation/styleProfile/styleProfileV2Schema';
import {
  STYLE_RENDERER_VERSION,
  renderStyleProfile,
  selectStyleRenderLevel,
} from '../src/services/continuation/styleProfile/styleProfileRenderer';
import {
  compilePlannerMessages,
  compileWriterMessages,
  compileCheckerMessages,
  compileRepairMessages,
} from '../src/services/continuation/generation/continuationPromptCompiler';
import type {
  ContinuationContextSnapshot,
  ContinuationPlan,
} from '../src/services/continuation/generation/types';
import { ContinuationCapabilityBlockedError } from '../src/services/continuation/generation/types';
import { computeStyleProfileHash } from '../src/services/continuation/styleProfile/styleProfileHash';

// ---- mocks for builder path ----
jest.mock(
  '../src/services/continuation/styleProfile/styleProfileRepository',
  () => ({
    getInjectableStyleProfile: jest.fn(),
  }),
);

jest.mock('../src/services/continuation/continuationSourceReader', () => ({
  continuationSourceReader: {
    getSnapshot: jest.fn(),
    listBoundedSourceChapters: jest.fn(),
  },
}));

jest.mock('../src/services/continuation/canon/canonQueryService', () => ({
  CanonQueryService: {
    getActiveSnapshot: jest.fn(),
    getContextBundle: jest.fn(),
  },
}));

jest.mock('../src/services/continuation/canon/historicalDigestService', () => ({
  listHistoricalDigestReferences: jest.fn().mockResolvedValue([]),
}));

jest.mock(
  '../src/services/continuation/generation/continuationStateService',
  () => ({
    getEffectiveContinuationState: jest.fn(),
  }),
);

jest.mock(
  '../src/services/continuation/generation/continuationSupplementContextBuilder',
  () => ({
    buildContinuationSupplementContext: jest.fn().mockResolvedValue({
      characterText: '',
      worldbookText: '',
      noteText: '',
      presetText: '',
      selected: [],
      excluded: [],
    }),
  }),
);

jest.mock(
  '../src/services/continuation/generation/generationRepository',
  () => ({
    contentRevisionHash: (t: string) => `hash:${t.length}`,
    ensureGenerationSettings: jest.fn(),
  }),
);

jest.mock('../src/services/database', () => ({
  getChaptersByProject: jest.fn().mockResolvedValue([]),
  getRecentChaptersBeforePosition: jest.fn().mockResolvedValue([]),
  getProjectStoryMemory: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/services/contextBuilder', () => ({
  buildMemoryContext: jest.fn().mockReturnValue(''),
}));

jest.mock('../src/services/storyMemory/storyMemoryRenderer', () => ({
  renderStoryMemoryForContext: jest.fn(),
}));

jest.mock(
  '../src/services/storyMemory/storyMemoryCheckpointEligibility',
  () => ({
    resolveUsableCheckpointForTarget: jest.fn().mockReturnValue({
      usable: false,
      reason: 'missing',
    }),
  }),
);

// Guard: builder must not open DB for style (no bare SQL path).
const mockOpenDatabase = jest.fn();
jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: (...args: unknown[]) => mockOpenDatabase(...args),
}));

import { getInjectableStyleProfile } from '../src/services/continuation/styleProfile/styleProfileRepository';
import { continuationSourceReader } from '../src/services/continuation/continuationSourceReader';
import { CanonQueryService } from '../src/services/continuation/canon/canonQueryService';
import { getEffectiveContinuationState } from '../src/services/continuation/generation/continuationStateService';
import { ensureGenerationSettings } from '../src/services/continuation/generation/generationRepository';
import { buildContinuationContext } from '../src/services/continuation/generation/continuationContextBuilder';
import * as database from '../src/services/database';
import { estimateTokens } from '../src/utils/tokenEstimator';

function validProfile(): OriginalStyleProfileV2 {
  return {
    schemaVersion: 2,
    summary: '冷峻克制的第三人称限制视角，短句为主。',
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
        register: '书面口语混合',
        concreteness: '具体',
        lexicalPreferences: ['动词驱动'],
        expressionsToAvoid: ['套话'],
      },
      tone: {
        baseline: '克制冷静',
        emotionalAmplitude: '低',
        humorAndRestraint: '克制',
      },
      rhythm: {
        scenePacing: '中速',
        expositionDensity: '低',
        transitionMethods: ['时间跳跃'],
        chapterEndingPatterns: ['悬念收束'],
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
      sentenceAndParagraphShift: '句长略增',
      activeNarrativePatterns: ['对峙'],
    },
    sceneVariants: [
      {
        sceneType: 'action',
        instructions: ['短促动词链'],
        avoid: ['长描写'],
        confidence: 0.8,
      },
    ],
    characterVoices: [
      {
        canonCharacterId: 5,
        sourceName: '林凡',
        speechRegister: '冷淡简短',
        sentenceHabits: ['常用反问'],
        interactionHabits: ['少解释'],
        avoid: ['长篇独白'],
        confidence: 0.7,
      },
      {
        canonCharacterId: 9,
        sourceName: '路人甲',
        speechRegister: '随意',
        sentenceHabits: ['口头禅'],
        interactionHabits: [],
        avoid: [],
        confidence: 0.5,
      },
    ],
    globalAvoid: ['系统面板', '突然觉醒'],
    confidence: 0.8,
    coverage: {
      sourceChapterCount: 20,
      sampledChapterCount: 8,
      sampledKinds: ['boundary', 'dialogue'],
    },
  };
}

function miniSnapshot(
  overrides: Partial<ContinuationContextSnapshot> = {},
): ContinuationContextSnapshot {
  const profile = validProfile();
  return {
    schemaVersion: 1,
    projectId: 1,
    targetChapterId: 10,
    targetPosition: 0 as any,
    source: {
      projectId: 1,
      sourceId: 1,
      sourceVersion: 1,
      normalizedSha256: 'abc',
      parserVersion: 'v1',
      normalizationVersion: 'v1',
      boundary: {
        chapterId: 5,
        chapterPosition: 19 as any,
        charOffsetExclusive: 1000 as any,
      },
    },
    canon: {
      snapshotId: 'snap',
      revision: 1,
      boundaryGlobalCharOffset: 1000,
      capabilities: {
        worldRules: true,
        characterProfiles: true,
        characterStates: true,
        relationships: true,
        plotThreads: true,
        experiences: true,
        knowledgeBoundaries: true,
        timelineEvents: true,
        evidenceValidated: true,
      },
    },
    storyMemory: {
      stateFingerprint: 'fp',
      throughPosition: -1,
      status: 'ready',
    },
    inputRevisionHash: 'h',
    style: {
      profileId: 'sp-1',
      profileHash: 'a'.repeat(64),
      profileSchemaVersion: 2,
      analyzerVersion: 'style-v2-4',
      rendererVersion: STYLE_RENDERER_VERSION,
      sourceFingerprint: '1|1|abc|v1|v1|5|19|1000',
      boundaryCharOffsetExclusive: 1000,
      frozenProfile: profile,
      userOverrides: { note: '少用感叹号' },
      renderLevel: 'standard',
      styleTokens: 800,
      omitReason: null,
    },
    settingsSnapshot: {
      schemaVersion: 1,
      values: {
        projectId: 1,
        strictnessProfile: 'balanced',
        worldRuleLevel: 'strict',
        characterLevel: 'strict',
        relationshipLevel: 'strict',
        plotLevel: 'balanced',
        experienceLevel: 'strict',
        knowledgeLevel: 'strict',
        styleLevel: 'balanced',
        allowNewCharacters: true,
        allowNewLocations: true,
        allowNewOrganizations: true,
        majorRelationshipChangePolicy: 'require_confirmation',
        majorPowerChangePolicy: 'require_confirmation',
        characterDeathPolicy: 'require_confirmation',
        resurrectionPolicy: 'forbid',
        plannerLlmConfigId: null,
        writerLlmConfigId: null,
        checkerLlmConfigId: null,
        repairLlmConfigId: null,
        stateExtractionLlmConfigId: null,
        plannerConfirmationPolicy: 'risk_only',
        checkerEnabled: true,
        maxRepairRounds: 1,
        targetChapterChars: 3000,
        customRulesJson: '[]',
        createdAt: 't',
        updatedAt: 't',
      },
      resolvedModelConfigIds: {
        planner: 1,
        writer: 1,
        checker: 1,
        repair: 1,
        stateExtraction: 1,
      },
    },
    bundles: {
      lockedRules: [],
      canon: {
        snapshot: {} as any,
        worldRules: [],
        characters: [],
        characterStates: [],
        relationships: [],
        experiences: [],
        knowledge: [],
        plotThreads: [],
        timelineEvents: [],
        evidenceRefs: [],
        estimatedTokens: 0,
        omittedReasonCounts: {},
      },
      effectiveState: {
        schemaVersion: 1,
        targetPosition: 0 as any,
        characterStates: [],
        relationships: [],
        plotThreads: [],
        knowledge: [],
        experiences: [],
        freshness: {
          canonReady: true,
          storyMemoryStatus: 'ready',
          pendingStateExtractionCount: 0,
          pendingMajorProposalCount: 0,
          dirtyFromPosition: null,
        },
        appliedEventIds: [],
        omittedReasons: [],
      },
      seam: { summary: '末章', excerpt: '结尾' },
      recentChapters: [],
      storyMemory: { summary: '', estimatedTokens: 0 },
      episodic: [],
      style: {
        projectId: 1,
        sourceId: 1,
        canonSnapshotId: 'snap',
        canonRevision: 1,
        narrativePerson: '第三人称',
        tense: '过去时',
        averageSentenceLength: 15,
        averageParagraphLength: 80,
        dialogueRatio: 0.25,
        descriptionRatio: 0.2,
        pacingNotes: '中速',
        lexicalNotes: '书面',
        sampleEvidenceIds: [],
        reviewStatus: 'confirmed',
      },
      userInstruction: '推进主线',
    },
    createdAt: 't',
    ...overrides,
  };
}

const emptyPlan: ContinuationPlan = {
  schemaVersion: 1,
  chapterGoal: '推进',
  centralConflict: '冲突',
  beats: [{ order: 1, summary: '节拍' }],
  participatingCharacterIds: [5],
  characterActions: [],
  plotAdvances: [],
  foreshadowingActions: [],
  proposedStateChanges: [],
  risks: [],
};

describe('styleProfileRenderer levels', () => {
  const profile = validProfile();

  it('compact covers person / distance / tone / taboos', () => {
    const r = renderStyleProfile(profile, 'compact');
    expect(r.level).toBe('compact');
    expect(r.text).toContain('第三人称');
    expect(r.text).toContain('贴近主角');
    expect(r.text).toContain('克制冷静');
    expect(r.text).toMatch(/系统面板|突然觉醒/);
    expect(r.estimatedTokens).toBeGreaterThan(0);
  });

  it('standard adds sentence/dialogue/description/pacing', () => {
    const r = renderStyleProfile(profile, 'standard');
    expect(r.text).toContain('短句为主');
    expect(r.text).toContain('对话');
    expect(r.text).toContain('时间跳跃');
    expect(r.text).toContain('边界附近');
    expect(r.estimatedTokens).toBeGreaterThan(
      renderStyleProfile(profile, 'compact').estimatedTokens,
    );
  });

  it('detailed adds scene variants and participating character voices only', () => {
    const r = renderStyleProfile(profile, 'detailed', {
      participatingCharacterIds: [5],
    });
    expect(r.text).toContain('场景变体');
    expect(r.text).toContain('action');
    expect(r.text).toContain('林凡');
    expect(r.text).not.toContain('路人甲');
    expect(r.text).toContain('禁止复制');
  });

  it('planner stage only injects planning-relevant style', () => {
    const r = renderStyleProfile(profile, 'standard', { stage: 'planner' });
    expect(r.text).toContain('规划约束');
    expect(r.text).toContain('场景节奏');
    expect(r.text).toContain('章末');
    expect(r.text).not.toContain('完整禁忌');
  });
});

describe('selectStyleRenderLevel', () => {
  const profile = validProfile();

  it('returns null for off', () => {
    const r = selectStyleRenderLevel(profile, 10_000, 'off');
    expect(r.level).toBeNull();
    expect(r.reason).toBe('style_level_off');
  });

  it('degrades detailed → standard → compact for balanced', () => {
    const full = renderStyleProfile(profile, 'detailed').estimatedTokens;
    const std = renderStyleProfile(profile, 'standard').estimatedTokens;
    const compact = renderStyleProfile(profile, 'compact').estimatedTokens;

    expect(selectStyleRenderLevel(profile, full + 10, 'balanced').level).toBe(
      'detailed',
    );
    expect(selectStyleRenderLevel(profile, std + 5, 'balanced').level).toBe(
      'standard',
    );
    expect(selectStyleRenderLevel(profile, compact + 5, 'balanced').level).toBe(
      'compact',
    );
    expect(
      selectStyleRenderLevel(profile, Math.max(1, compact - 1), 'balanced')
        .level,
    ).toBeNull();
  });

  it('strict blocks when even compact does not fit', () => {
    const compact = renderStyleProfile(profile, 'compact').estimatedTokens;
    const r = selectStyleRenderLevel(
      profile,
      Math.max(0, compact - 1),
      'strict',
    );
    expect(r.level).toBeNull();
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/insufficient/);
  });
});

describe('prompt compiler style injection', () => {
  it('writer includes frozen style + user overrides', () => {
    const snap = miniSnapshot();
    const writer = compileWriterMessages(snap, emptyPlan)[0].content;
    expect(writer).toContain('第三人称');
    expect(writer).toContain('少用感叹号');
    expect(writer).toMatch(/原著风格/);
  });

  it('planner includes planning style block', () => {
    const snap = miniSnapshot();
    const planner = compilePlannerMessages(snap)[0].content;
    expect(planner).toContain('规划约束');
    expect(planner).toContain('中速');
  });

  it('checker and repair receive style contract', () => {
    const snap = miniSnapshot();
    const checker = compileCheckerMessages(snap, '他走了。')[0].content;
    expect(checker).toContain('检查契约');
    const repair = compileRepairMessages(snap, '他走了。', [
      {
        id: 1,
        runId: 'r',
        chapterId: 1,
        artifactId: 'a',
        artifactHash: 'h',
        category: 'style',
        subtype: 'pov_shift',
        severity: 'error',
        confidence: 0.5,
        generatedStart: 0,
        generatedEnd: 1,
        generatedExcerpt: '我',
        description: '人称漂移',
        entityRefType: null,
        entityRefId: null,
        evidenceIds: [],
        suggestedFix: '统一人称',
        resolutionStatus: 'open',
        createdAt: 't',
        updatedAt: 't',
      },
    ])[0].content;
    expect(repair).toMatch(/修复|风格/);
  });

  it('does not let a stale off snapshot suppress original style content', () => {
    const snap = miniSnapshot();
    snap.settingsSnapshot.values.styleLevel = 'off';
    const writer = compileWriterMessages(snap, emptyPlan)[0].content;
    expect(writer).toContain('【原著风格');
    expect(writer).toContain('第三人称');
  });
});

describe('buildContinuationContext style path', () => {
  const baseSettings = {
    projectId: 1,
    strictnessProfile: 'balanced' as const,
    worldRuleLevel: 'balanced' as const,
    characterLevel: 'balanced' as const,
    relationshipLevel: 'balanced' as const,
    plotLevel: 'balanced' as const,
    experienceLevel: 'balanced' as const,
    knowledgeLevel: 'balanced' as const,
    styleLevel: 'balanced' as const,
    allowNewCharacters: true,
    allowNewLocations: true,
    allowNewOrganizations: true,
    majorRelationshipChangePolicy: 'require_confirmation' as const,
    majorPowerChangePolicy: 'require_confirmation' as const,
    characterDeathPolicy: 'require_confirmation' as const,
    resurrectionPolicy: 'forbid' as const,
    plannerLlmConfigId: null,
    writerLlmConfigId: null,
    checkerLlmConfigId: null,
    repairLlmConfigId: null,
    stateExtractionLlmConfigId: null,
    plannerConfirmationPolicy: 'risk_only' as const,
    checkerEnabled: true,
    maxRepairRounds: 1,
    targetChapterChars: 2000,
    customRulesJson: '[]',
    createdAt: 't',
    updatedAt: 't',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenDatabase.mockRejectedValue(
      new Error('bare SQL path should not open DB'),
    );

    (continuationSourceReader.getSnapshot as jest.Mock).mockResolvedValue({
      projectId: 1,
      sourceId: 10,
      sourceVersion: 3,
      normalizedSha256: 'abc123',
      parserVersion: 'p1',
      normalizationVersion: 'n1',
      boundary: {
        chapterId: 99,
        chapterPosition: 5,
        charOffsetExclusive: 5000,
      },
    });
    (
      continuationSourceReader.listBoundedSourceChapters as jest.Mock
    ).mockResolvedValue([
      {
        id: 1,
        position: 5,
        title: '末章',
        content: '原著结尾事件。',
      },
    ]);
    (CanonQueryService.getActiveSnapshot as jest.Mock).mockResolvedValue({
      id: 'canon-1',
      revision: 1,
      boundaryPosition: 5,
      boundaryCharOffsetExclusive: 5000,
      capabilities: {
        worldRules: true,
        characterProfiles: true,
        characterStates: true,
        relationships: true,
        plotThreads: true,
        experiences: true,
        knowledgeBoundaries: true,
        timelineEvents: true,
        evidenceValidated: true,
      },
      coverage: { analyzedChapterCount: 5, sourceChapterCount: 5 },
    });
    (CanonQueryService.getContextBundle as jest.Mock).mockResolvedValue({
      worldRules: [],
      characters: [],
      characterStates: [],
      relationships: [],
      experiences: [],
      knowledge: [],
      plotThreads: [],
      timelineEvents: [],
      evidenceRefs: [],
      estimatedTokens: 10,
      omittedReasonCounts: {},
    });
    (getEffectiveContinuationState as jest.Mock).mockResolvedValue({
      schemaVersion: 1,
      targetPosition: 0,
      characterStates: [],
      relationships: [],
      plotThreads: [],
      knowledge: [],
      experiences: [],
      freshness: {
        canonReady: true,
        storyMemoryStatus: 'ready',
        pendingStateExtractionCount: 0,
        pendingMajorProposalCount: 0,
        dirtyFromPosition: null,
      },
      appliedEventIds: [],
      omittedReasons: [],
    });
    (ensureGenerationSettings as jest.Mock).mockResolvedValue(baseSettings);
  });

  function injectableRow(profile: OriginalStyleProfileV2 = validProfile()) {
    const metrics = {
      schemaVersion: 2,
      sentenceLength: { mean: 14 },
      paragraphLength: { mean: 70 },
      dialogue: { ratio: 0.22 },
      person: { firstPersonRatio: 0.1 },
      functionalRatios: { environment: 0.2 },
    };
    const sampleRefs: unknown[] = [];
    const userOverrides = { note: '保持克制' };
    return {
      id: 'sp-ready-1',
      projectId: 1,
      sourceId: 10,
      sourceVersion: 3,
      sourceSha256: 'abc123',
      parserVersion: 'p1',
      normalizationVersion: 'n1',
      boundaryChapterId: 99,
      boundaryPosition: 5,
      boundaryCharOffsetExclusive: 5000,
      analysisRunId: 'run-1',
      canonSnapshotId: 'canon-1',
      profileSchemaVersion: 2,
      analyzerVersion: 'style-v2-4',
      profileJson: profile,
      metricsJson: metrics,
      sampleRefsJson: sampleRefs,
      userOverridesJson: userOverrides,
      profileHash: computeStyleProfileHash({
        profile,
        metrics,
        sampleRefs,
        profileSchemaVersion: 2,
        analyzerVersion: 'style-v2-4',
        userOverrides,
      }),
      confidence: 0.8,
      state: 'ready',
      reviewStatus: 'confirmed',
      errorCode: null,
      errorMessage: null,
      createdAt: 't',
      updatedAt: 't',
      completedAt: 't',
    };
  }

  it('uses getInjectableStyleProfile and freezes style onto snapshot', async () => {
    (getInjectableStyleProfile as jest.Mock).mockResolvedValue(injectableRow());

    const { snapshot, trace } = await buildContinuationContext({
      projectId: 1,
      targetChapterId: 10,
      targetPosition: 0 as any,
      currentChapterContent: '',
      userInstruction: '推进',
      modelContextLimit: 32_768,
      maxOutputTokens: 2048,
      activeLlmConfigId: 1,
    });

    expect(getInjectableStyleProfile).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        sourceId: 10,
        sourceVersion: 3,
        sourceSha256: 'abc123',
        boundaryCharOffsetExclusive: 5000,
      }),
    );
    expect(mockOpenDatabase).not.toHaveBeenCalled();
    expect(snapshot.style).not.toBeNull();
    expect(snapshot.style?.profileId).toBe('sp-ready-1');
    expect(snapshot.style?.rendererVersion).toBe(STYLE_RENDERER_VERSION);
    expect(snapshot.style?.renderLevel).toMatch(/compact|standard|detailed/);
    expect(snapshot.workflowVersion).toBe(2);
    expect(snapshot.bundles.style?.narrativePerson).toContain('三');
    expect(snapshot.contextBudget?.styleTokens).toBeGreaterThan(0);

    const styleCat = trace.categories.find(c => c.name === 'originalStyle');
    expect(styleCat).toBeDefined();
    expect(styleCat!.selected).toBe(1);
    expect(styleCat!.tokens).toBeGreaterThan(0);

    const writer = compileWriterMessages(snapshot, emptyPlan)[0].content;
    expect(writer).toContain('第三人称');
    expect(writer).toContain('保持克制');
  });

  it('counts the latest continuation anchor in the writer context budget', async () => {
    (getInjectableStyleProfile as jest.Mock).mockResolvedValue(injectableRow());
    const continuationTail =
      '续写上一章的结尾：雨停之后，沈舟握紧钥匙，决定连夜去旧码头。';
    // H1-Generation: buildContinuationContext 改用 getRecentChaptersBeforePosition
    // 按 position 降序取最近章节，不再全表加载 getChaptersByProject。
    (database.getRecentChaptersBeforePosition as jest.Mock).mockResolvedValue([
      {
        id: 21,
        project_id: 1,
        position: 0,
        title: '续写第一章',
        content: continuationTail,
      },
    ]);

    const { snapshot, trace } = await buildContinuationContext({
      projectId: 1,
      targetChapterId: 22,
      targetPosition: 1 as any,
      currentChapterContent: '',
      userInstruction: '承接上一章推进',
      modelContextLimit: 32_768,
      maxOutputTokens: 2048,
      activeLlmConfigId: 1,
    });

    expect(
      continuationSourceReader.listBoundedSourceChapters,
    ).not.toHaveBeenCalled();
    expect(snapshot.primaryAnchor).toMatchObject({
      kind: 'continuation_chapter',
      chapterId: 21,
      excerpt: continuationTail,
    });
    expect(compileWriterMessages(snapshot, emptyPlan)[0].content).toContain(
      continuationTail,
    );

    const anchorCategory = trace.categories.find(
      category => category.name === 'primaryAnchor',
    );
    expect(anchorCategory).toMatchObject({ candidates: 1, selected: 1 });
    expect(anchorCategory?.tokens).toBe(
      estimateTokens(snapshot.primaryAnchor!.excerpt),
    );
    const recentCategory = trace.categories.find(
      category => category.name === 'recentChapters',
    );
    // The immediately previous continuation chapter is fully supplied by the
    // primary-anchor block. It must not be reported as a bridge-budget trim.
    expect(recentCategory).toMatchObject({
      candidates: 1,
      selected: 0,
      coveredByPrimaryAnchor: 1,
    });
    expect(recentCategory?.omittedReasonCounts).toEqual({
      already_covered_by_primary_anchor: 1,
    });
    expect(trace.totalInputTokens).toBe(
      trace.categories.reduce((sum, category) => sum + category.tokens, 0),
    );
  });

  it('strict blocks generation when no injectable profile', async () => {
    (getInjectableStyleProfile as jest.Mock).mockResolvedValue(null);
    (ensureGenerationSettings as jest.Mock).mockResolvedValue({
      ...baseSettings,
      styleLevel: 'strict',
    });

    await expect(
      buildContinuationContext({
        projectId: 1,
        targetChapterId: 10,
        targetPosition: 0 as any,
        currentChapterContent: '',
        userInstruction: '推进',
        modelContextLimit: 32_768,
        maxOutputTokens: 2048,
        activeLlmConfigId: 1,
      }),
    ).rejects.toBeInstanceOf(ContinuationCapabilityBlockedError);
  });

  it('blocks generation when profile is missing, even under a legacy balanced setting', async () => {
    (getInjectableStyleProfile as jest.Mock).mockResolvedValue(null);

    await expect(
      buildContinuationContext({
        projectId: 1,
        targetChapterId: 10,
        targetPosition: 0 as any,
        currentChapterContent: '',
        userInstruction: '推进',
        modelContextLimit: 32_768,
        maxOutputTokens: 2048,
        activeLlmConfigId: 1,
      }),
    ).rejects.toBeInstanceOf(ContinuationCapabilityBlockedError);
  });

  it('does not let a legacy off setting bypass required style injection', async () => {
    (ensureGenerationSettings as jest.Mock).mockResolvedValue({
      ...baseSettings,
      styleLevel: 'off',
    });

    (getInjectableStyleProfile as jest.Mock).mockResolvedValue(null);
    await expect(
      buildContinuationContext({
        projectId: 1,
        targetChapterId: 10,
        targetPosition: 0 as any,
        currentChapterContent: '',
        userInstruction: '推进',
        modelContextLimit: 32_768,
        maxOutputTokens: 2048,
        activeLlmConfigId: 1,
      }),
    ).rejects.toBeInstanceOf(ContinuationCapabilityBlockedError);
    expect(getInjectableStyleProfile).toHaveBeenCalledTimes(1);
  });

  it('reads only the boundary chapter when no continuation正文 exists', async () => {
    (getInjectableStyleProfile as jest.Mock).mockResolvedValue(injectableRow());
    (database.getRecentChaptersBeforePosition as jest.Mock).mockResolvedValue(
      [],
    );
    const rangeReader = jest.fn().mockResolvedValue([
      {
        id: 99,
        position: 5,
        title: '末章',
        content: '原著结尾事件。',
      },
    ]);
    (continuationSourceReader as any).listBoundedSourceChaptersForRange =
      rangeReader;

    await buildContinuationContext({
      projectId: 1,
      targetChapterId: 10,
      targetPosition: 0 as any,
      currentChapterContent: '',
      userInstruction: '推进',
      modelContextLimit: 32_768,
      maxOutputTokens: 2048,
      activeLlmConfigId: 1,
    });

    expect(rangeReader).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: expect.objectContaining({ chapterPosition: 5 }),
      }),
      5,
      6,
    );
    expect(
      continuationSourceReader.listBoundedSourceChapters,
    ).not.toHaveBeenCalled();
    delete (continuationSourceReader as any).listBoundedSourceChaptersForRange;
  });
});
