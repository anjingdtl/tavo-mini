/**
 * Phase 3 core unit tests: checker, repair, plan parse, fingerprints,
 * UTF-16 ranges, adopt vs finalize contracts (logic layer).
 */
import {
  bindIssuesToArtifact,
  parseCheckerLlmJson,
  runDeterministicChecks,
} from '../src/services/continuation/generation/continuationChecker';
import {
  shouldRunRepair,
  tryDeterministicRepair,
} from '../src/services/continuation/generation/continuationRepairService';
import {
  contentRevisionHash,
  proposalFingerprint,
} from '../src/services/continuation/generation/generationRepository';
import { deterministicExtractFromText } from '../src/services/continuation/generation/continuationStateOutboxWorker';
import { isContinuationRunId } from '../src/services/continuation/generation/continuationGenerationRunner';
import { summarizeTrace } from '../src/services/continuation/generation/continuationContextTrace';
import {
  compilePlannerMessages,
  compileWriterMessages,
} from '../src/services/continuation/generation/continuationPromptCompiler';
import type {
  ContinuationCheckResult,
  ContinuationContextSnapshot,
  ContinuationContextTrace,
} from '../src/services/continuation/generation/types';

function miniSnapshot(
  overrides: Partial<ContinuationContextSnapshot> = {},
): ContinuationContextSnapshot {
  return {
    schemaVersion: 1,
    projectId: 1,
    targetChapterId: 10,
    targetPosition: 20 as any,
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
        controlLlmConfigId: null,
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
      lockedRules: ['[locked] 禁复活'],
      canon: {
        snapshot: {} as any,
        worldRules: [
          {
            id: 1,
            constraintLevel: 'hard',
            reviewStatus: 'locked',
            title: '死亡不可逆',
            description: '不可复活',
          } as any,
        ],
        characters: [],
        characterStates: [],
        relationships: [],
        experiences: [],
        knowledge: [],
        plotThreads: [],
        timelineEvents: [],
        evidenceRefs: [11, 22],
        estimatedTokens: 10,
        omittedReasonCounts: {},
      },
      effectiveState: {
        schemaVersion: 1,
        targetPosition: 20 as any,
        characterStates: [],
        relationships: [],
        plotThreads: [],
        knowledge: [
          {
            ref: { refType: 'canon_character', id: 1 },
            factKey: 'secret',
            factSummary: '皇位继承秘密',
            knowledgeState: 'unknown',
          },
        ],
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
      style: null,
      userInstruction: '推进主线',
    },
    createdAt: 't',
    ...overrides,
  };
}

describe('continuation Phase 3 core', () => {
  test('run id prefix ct_', () => {
    expect(isContinuationRunId('ct_abc')).toBe(true);
    expect(isContinuationRunId('pipeline_1')).toBe(false);
  });

  test('contentRevisionHash is stable SHA-256', () => {
    const a = contentRevisionHash('你好世界');
    const b = contentRevisionHash('你好世界');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    expect(contentRevisionHash('你好世界!')).not.toBe(a);
  });

  test('proposalFingerprint is deterministic', () => {
    const fp1 = proposalFingerprint({
      proposalType: 'character_state',
      subjectRefType: 'canon_character',
      subjectRefId: '1',
      payloadJson: JSON.stringify({ summary: '受伤' }),
      evidenceStart: 0,
      evidenceEnd: 4,
    });
    const fp2 = proposalFingerprint({
      proposalType: 'character_state',
      subjectRefType: 'canon_character',
      subjectRefId: '1',
      payloadJson: JSON.stringify({ summary: '受伤' }),
      evidenceStart: 0,
      evidenceEnd: 4,
    });
    expect(fp1).toBe(fp2);
  });

  test('deterministic checker flags future leakage as blocking', () => {
    const text = '他走向城门。【未来揭示】真相大白';
    const issues = runDeterministicChecks(text, miniSnapshot());
    expect(issues.some(i => i.subtype === 'future_leakage')).toBe(true);
    expect(
      issues.find(i => i.subtype === 'future_leakage')?.severity,
    ).toBe('blocking');
  });

  test('resurrection forbidden under policy', () => {
    const text = '主角死而复生，继续战斗。';
    const issues = runDeterministicChecks(text, miniSnapshot());
    expect(issues.some(i => i.subtype === 'resurrection_forbidden')).toBe(true);
  });

  test('UTF-16 half-open ranges with emoji', () => {
    const text = '前缀😀后缀FUTURE_SOURCE_LEAK';
    const issues = runDeterministicChecks(text, miniSnapshot());
    const leak = issues.find(i => i.subtype === 'future_leakage')!;
    expect(leak.generatedStart).not.toBeNull();
    expect(leak.generatedEnd).toBeGreaterThan(leak.generatedStart!);
    expect(text.slice(leak.generatedStart!, leak.generatedEnd!)).toBe(
      'FUTURE_SOURCE_LEAK',
    );
  });

  test('bindIssues drops invalid ranges and demotes no-evidence blocking', () => {
    const text = 'abcde';
    const bound = bindIssuesToArtifact(
      [
        {
          category: 'plot',
          subtype: 'x',
          severity: 'blocking',
          confidence: 1,
          generatedStart: 0,
          generatedEnd: 99,
          generatedExcerpt: '',
          description: 'bad range',
          evidenceIds: [],
        },
      ],
      text,
      new Set([1]),
    );
    expect(bound[0].generatedStart).toBeNull();
    expect(bound[0].severity).toBe('warning');
  });

  test('parseCheckerLlmJson tolerates fences and filters evidence', () => {
    const raw =
      '```json\n{"issues":[{"category":"world","subtype":"rule","severity":"error","confidence":0.9,"generatedStart":0,"generatedEnd":2,"generatedExcerpt":"ab","description":"冲突","evidenceIds":[11,999]}]}\n```';
    const issues = parseCheckerLlmJson(raw);
    expect(issues).toHaveLength(1);
    const bound = bindIssuesToArtifact(issues, 'abcdef', new Set([11]));
    expect(bound[0].evidenceIds).toEqual([11]);
  });

  test('demotes an un-actionable severe Checker issue before the single Repair call', () => {
    const issues = parseCheckerLlmJson(
      JSON.stringify({
        issues: [
          {
            category: 'world',
            subtype: 'ambiguous',
            severity: 'blocking',
            confidence: 1,
            generatedStart: null,
            generatedEnd: null,
            generatedExcerpt: '',
            description: '可能与设定不符',
            evidenceIds: [11],
          },
        ],
      }),
    );
    expect(issues[0].severity).toBe('warning');
  });

  test('repair removes future leakage and shouldRunRepair respects rounds', () => {
    const text = '正常。【未来揭示】泄露';
    const snap = miniSnapshot();
    const issues = runDeterministicChecks(text, snap);
    const checks: ContinuationCheckResult[] = issues.map((i, idx) => ({
      id: idx + 1,
      runId: 'ct_x',
      chapterId: 1,
      artifactId: 'a',
      artifactHash: 'h',
      category: i.category,
      subtype: i.subtype,
      severity: i.severity,
      confidence: i.confidence,
      generatedStart: i.generatedStart,
      generatedEnd: i.generatedEnd,
      generatedExcerpt: i.generatedExcerpt,
      description: i.description,
      entityRefType: null,
      entityRefId: null,
      evidenceIds: [],
      suggestedFix: i.suggestedFix ?? null,
      resolutionStatus: 'open',
      createdAt: 't',
      updatedAt: 't',
    }));
    expect(shouldRunRepair(checks, 1, 0)).toBe(true);
    expect(shouldRunRepair(checks, 1, 1)).toBe(false);
    const repaired = tryDeterministicRepair(text, checks)!;
    expect(repaired).not.toContain('【未来揭示】');
  });

  test('deterministic state extraction from markers', () => {
    const text = '章节正文【状态:林逸负伤】然后【新人物:阿九】出场';
    const { proposals } = deterministicExtractFromText(text);
    expect(proposals.some(p => p.proposalType === 'character_state')).toBe(
      true,
    );
    expect(proposals.some(p => p.proposalType === 'new_character')).toBe(true);
    for (const p of proposals) {
      expect(p.evidenceEnd).toBeGreaterThan(p.evidenceStart);
      expect(p.evidenceEnd).toBeLessThanOrEqual(text.length);
    }
  });

  test('planner and writer receive continuation relationship, knowledge, experience and episodic memory', () => {
    const snapshot = miniSnapshot();
    (snapshot.bundles.effectiveState as any).relationships = [
      {
        source: { refType: 'canon_character', id: 1 },
        target: { refType: 'canon_character', id: 2 },
        summary: '互相试探',
      },
    ];
    (snapshot.bundles.effectiveState as any).experiences = [
      {
        ref: { refType: 'canon_character', id: 1 },
        title: '雨夜遇袭',
        summary: '留下旧伤',
      },
    ];
    snapshot.bundles.episodic = [
      { chapterId: 9, summary: '上一章：主角在渡口失去线索。' },
    ];
    const plan = {
      schemaVersion: 1 as const,
      chapterGoal: '推进',
      centralConflict: '冲突',
      beats: [],
      participatingCharacterIds: [],
      characterActions: [],
      plotAdvances: [],
      foreshadowingActions: [],
      proposedStateChanges: [],
      risks: [],
    };
    const planner = compilePlannerMessages(snapshot)[0].content;
    const writer = compileWriterMessages(snapshot, plan)[0].content;
    for (const message of [planner, writer]) {
      expect(message).toContain('互相试探');
      expect(message).toContain('皇位继承秘密');
      expect(message).toContain('雨夜遇袭');
      expect(message).toContain('主角在渡口失去线索');
    }
  });

  test('planner/writer user messages use boundary-aware display chapter numbers (§11.3)', () => {
    // boundary source position 19 → display source 20; targetPosition 0 → 第 21 章
    const snapshot = miniSnapshot({
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
    });
    const plan = {
      schemaVersion: 1 as const,
      chapterGoal: '推进',
      centralConflict: '冲突',
      beats: [],
      participatingCharacterIds: [],
      characterActions: [],
      plotAdvances: [],
      foreshadowingActions: [],
      proposedStateChanges: [],
      risks: [],
    };
    const plannerUser = compilePlannerMessages(snapshot)[1].content;
    const writerUser = compileWriterMessages(snapshot, plan)[1].content;
    expect(plannerUser).toContain('第 21 章');
    expect(writerUser).toContain('第 21 章');
    // Must not expose bare internal position as the chapter number.
    expect(plannerUser).not.toMatch(/第\s*position=/);
    expect(writerUser).not.toMatch(/position=\d+\s*章/);
  });

  test('summarizeTrace is compact and free of full prompts', () => {
    const trace: ContinuationContextTrace = {
      sourceId: 1,
      canonSnapshotId: 'snap-abcdefgh',
      canonRevision: 2,
      targetPosition: 21 as any,
      entityRefs: [],
      storyMemoryFingerprint: 'fp',
      freshness: {
        canonReady: true,
        storyMemoryStatus: 'ready',
        pendingStateExtractionCount: 0,
        pendingMajorProposalCount: 1,
      },
      categories: [
        {
          name: 'canon',
          candidates: 10,
          selected: 5,
          tokens: 120,
          omittedReasonCounts: {},
        },
      ],
      totalInputTokens: 200,
      reservedOutputTokens: 500,
      omittedCapabilities: [],
    };
    const s = summarizeTrace(trace);
    expect(s).toContain('pendingMajor=1');
    expect(s).not.toContain('system prompt');
  });
});
