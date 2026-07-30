/**
 * WP5 integration: injectable style freeze and required-style blocking,
 * chapter numbering consistency with style boundary (Spec §14.5).
 */
import type { OriginalStyleProfileV2 } from '../src/services/continuation/styleProfile/styleProfileV2Schema';
import {
  STYLE_RENDERER_VERSION,
  renderStyleProfile,
} from '../src/services/continuation/styleProfile/styleProfileRenderer';
import { compileWriterMessages } from '../src/services/continuation/generation/continuationPromptCompiler';
import type { ContinuationPlan } from '../src/services/continuation/generation/types';
import { ContinuationCapabilityBlockedError } from '../src/services/continuation/generation/types';
import { makeContinuationChapterNumbering } from '../src/services/continuation/chapterNumbering/continuationChapterNumbering';
import { computeStyleProfileHash } from '../src/services/continuation/styleProfile/styleProfileHash';

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

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn().mockRejectedValue(new Error('no bare SQL')),
}));

import { getInjectableStyleProfile } from '../src/services/continuation/styleProfile/styleProfileRepository';
import { continuationSourceReader } from '../src/services/continuation/continuationSourceReader';
import { CanonQueryService } from '../src/services/continuation/canon/canonQueryService';
import { getEffectiveContinuationState } from '../src/services/continuation/generation/continuationStateService';
import { ensureGenerationSettings } from '../src/services/continuation/generation/generationRepository';
import { buildContinuationContext } from '../src/services/continuation/generation/continuationContextBuilder';

function validProfile(): OriginalStyleProfileV2 {
  return {
    schemaVersion: 2,
    summary: '冷峻克制的第三人称限制视角。',
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
    ],
    globalAvoid: ['系统面板'],
    confidence: 0.82,
    coverage: {
      sourceChapterCount: 20,
      sampledChapterCount: 8,
      sampledKinds: ['boundary', 'dialogue'],
    },
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
    // boundary at source chapter position 19 → display 第 20 章
    boundaryPosition: 19,
    boundaryCharOffsetExclusive: 5000,
    analysisRunId: 'run-1',
    canonSnapshotId: 'canon-1',
    profileSchemaVersion: 2,
    analyzerVersion: 'style-v2-2',
    profileJson: profile,
    metricsJson: metrics,
    sampleRefsJson: sampleRefs,
    userOverridesJson: userOverrides,
    profileHash: computeStyleProfileHash({
      profile,
      metrics,
      sampleRefs,
      profileSchemaVersion: 2,
      analyzerVersion: 'style-v2-2',
      userOverrides,
    }),
    confidence: 0.82,
    state: 'ready',
    reviewStatus: 'confirmed',
    errorCode: null,
    errorMessage: null,
    createdAt: 't',
    updatedAt: 't',
    completedAt: 't',
  };
}

describe('continuationStyleIntegration (WP5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (continuationSourceReader.getSnapshot as jest.Mock).mockResolvedValue({
      projectId: 1,
      sourceId: 10,
      sourceVersion: 3,
      normalizedSha256: 'abc123',
      parserVersion: 'p1',
      normalizationVersion: 'n1',
      boundary: {
        chapterId: 99,
        chapterPosition: 19,
        charOffsetExclusive: 5000,
      },
    });
    (
      continuationSourceReader.listBoundedSourceChapters as jest.Mock
    ).mockResolvedValue([
      {
        id: 99,
        position: 19,
        title: '第 20 章',
        content: '原著结尾。',
      },
    ]);
    (CanonQueryService.getActiveSnapshot as jest.Mock).mockResolvedValue({
      id: 'canon-1',
      revision: 1,
      boundaryPosition: 19,
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
      coverage: { analyzedChapterCount: 20, sourceChapterCount: 20 },
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

  it('injectable profile freezes style onto snapshot and writer prompt', async () => {
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

    expect(snapshot.style).not.toBeNull();
    expect(snapshot.style?.profileId).toBe('sp-ready-1');
    expect(snapshot.style?.rendererVersion).toBe(STYLE_RENDERER_VERSION);
    expect(snapshot.style?.frozenProfile).toMatchObject({
      schemaVersion: 2,
      summary: expect.stringContaining('第三人称'),
    });

    const styleCat = trace.categories.find(c => c.name === 'originalStyle');
    expect(styleCat?.selected).toBe(1);
    expect(styleCat?.tokens).toBeGreaterThan(0);

    const writer = compileWriterMessages(snapshot, emptyPlan)[0].content;
    expect(writer).toContain('第三人称');
    expect(writer).toContain('保持克制');
  });

  it('blocks when profile is missing, including legacy balanced settings', async () => {
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

  it('boundary chapter 20 → first continuation displays and titles as 第 21 章', () => {
    // boundaryChapterNumber is 1-based source chapter number at boundary.
    const numbering = makeContinuationChapterNumbering(20);
    expect(numbering.getDisplayNumber(0 as any)).toBe(21);
    expect(numbering.getDefaultTitle(0 as any)).toBe('第 21 章');
    expect(numbering.getDisplayNumber(1 as any)).toBe(22);
    expect(numbering.getDefaultTitle(1 as any)).toBe('第 22 章');

    // Style sample coverage aligns with the same boundary (source count 20).
    const profile = validProfile();
    expect(profile.coverage.sourceChapterCount).toBe(20);
    const compact = renderStyleProfile(profile, 'compact');
    expect(compact.text.length).toBeGreaterThan(0);
  });
});
