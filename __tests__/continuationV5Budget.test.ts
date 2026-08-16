import {
  preflightContinuationV5StageBudget,
  resolveContinuationV5StageBudget,
  resolveContinuationV5BudgetPreview,
} from '../src/services/continuation/generation/continuationV5Budget';
import { CONTINUATION_V5_LENGTH_POLICY } from '../src/services/continuation/generation/continuationV5Contracts';
import {
  compileContinuationV5FinalReviserWithinBudget,
} from '../src/services/continuation/generation/continuationV5PromptCompiler';
import { buildFallbackArchitecture, buildFallbackAuditContract, hashArchitectureEnvelope, hashAuditEnvelope } from '../src/services/continuation/generation/continuationV5Contracts';

const policy = {
  schemaVersion: 2,
  allocatorVersion: 'test',
  continuation: {
    hanDemand: {
      estimatedTokensPerHan: 1.6,
      minimumCompletionCoverageRatio: 0.55,
    },
  },
} as any;

const model = {
  configId: 1,
  contextWindow: 32000,
  maxOutputTokens: 8192,
};

describe('Continuation V5 budget', () => {
  test('full-text nodes reserve headroom; preflight requires fit', () => {
    const budget = resolveContinuationV5StageBudget({
      stage: 'draft_writer',
      frozenModelConfig: model,
      frozenPolicy: policy,
      compiledPromptTokens: 2000,
      protocolSkeletonTokens: 280,
      targetChapterChars: 3000,
      lengthPolicy: CONTINUATION_V5_LENGTH_POLICY,
    });
    expect(budget.maximumOutputTokens).toBeGreaterThan(0);
    expect(budget.minimumOutputTokens).toBeGreaterThan(0);
    expect(budget.maximumOutputTokens).toBeGreaterThanOrEqual(
      Math.min(budget.minimumOutputTokens, budget.availableOutputTokens),
    );
    const ok = preflightContinuationV5StageBudget({
      stage: 'draft_writer',
      frozenModelConfig: model,
      frozenPolicy: policy,
      compiledPromptTokens: 2000,
      protocolSkeletonTokens: 280,
      targetChapterChars: 3000,
    });
    expect(ok.ok).toBe(true);
  });

  test('full-text nodes retain enough adaptive headroom for a complete JSON draft', () => {
    const budget = resolveContinuationV5StageBudget({
      stage: 'draft_writer',
      frozenModelConfig: {
        configId: 1,
        contextWindow: 1_000_000,
        maxOutputTokens: 200_000,
      },
      frozenPolicy: {
        ...policy,
        continuation: {
          ...policy.continuation,
          hanDemand: {
            estimatedTokensPerHan: 3,
            minimumCompletionCoverageRatio: 0.72,
          },
        },
      },
      compiledPromptTokens: 10_000,
      protocolSkeletonTokens: 280,
      targetChapterChars: 3_000,
    });
    expect(budget.maximumOutputTokens).toBeGreaterThan(14_000);
  });

  test('prompt budget exceeded fails preflight without sending', () => {
    const tiny = {
      configId: 2,
      contextWindow: 1024,
      maxOutputTokens: 256,
    };
    const bad = preflightContinuationV5StageBudget({
      stage: 'final_reviser',
      frozenModelConfig: tiny,
      frozenPolicy: policy,
      compiledPromptTokens: 900,
      protocolSkeletonTokens: 200,
      targetChapterChars: 3000,
    });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/budget|exceeded|insufficient/);
  });

  test('budget preview covers all five physical nodes', () => {
    const stages = {
      draft_writer: model,
      narrative_architect: model,
      revision_writer: model,
      adversarial_auditor: model,
      final_reviser: model,
    };
    const preview = resolveContinuationV5BudgetPreview({
      frozenPolicy: policy,
      stages,
      targetChapterChars: 3000,
    });
    expect(Object.keys(preview).sort()).toEqual(
      [
        'adversarial_auditor',
        'draft_writer',
        'final_reviser',
        'narrative_architect',
        'revision_writer',
      ].sort(),
    );
  });

  test('Final Reviser prompt compression never truncates V2 body', () => {
    const architecture = buildFallbackArchitecture({ userInstruction: '推进' });
    const architectureHash = hashArchitectureEnvelope(architecture);
    const audit = buildFallbackAuditContract({
      draftArtifactHash: 'd'.repeat(64),
      architectureHash,
      canonSnapshotId: 'cs',
      canonRevision: 1,
      inputRevisionHash: 'ir',
      styleProfileHash: null,
      styleRendererVersion: null,
      lockedRules: ['锁定'],
      hardCanonFacts: ['硬事实'],
    });
    const auditHash = hashAuditEnvelope(audit);
    const revisionContent = '完整 V2 正文标记 UNIQUE_V2_BODY_MARKER。'.repeat(80);
    const view = {
      stage: 'final_reviser' as const,
      projectId: 1,
      targetChapterId: 1,
      targetPosition: 0 as any,
      targetChapterChars: 3000,
      preferredMinHan: 2700,
      preferredMaxHan: 3300,
      severeUnderHan: 1950,
      userInstruction: '推进',
      lockedRules: ['锁定'],
      canon: {
        hardFacts: [{ ownerType: 'world', ownerId: 1, text: '硬事实', evidenceIds: [] }],
        softFacts: Array.from({ length: 20 }, (_, i) => ({
          ownerType: 'world',
          ownerId: i,
          text: `软事实${i}`,
          evidenceIds: [],
        })),
        evidenceIds: [],
      },
      effectiveState: {
        characterStates: [],
        relationships: [],
        plotThreads: [],
        knowledge: [],
        experiences: [],
      },
      primaryAnchorSummary: '',
      primaryAnchorSeamText: '',
      recentBridgeSummary: '',
      style: {
        profileId: null,
        profileHash: null,
        rendererVersion: null,
        renderLevel: null,
        text: '风格摘要',
        quantitative: {
          averageSentenceLength: 0,
          averageParagraphLength: 0,
          dialogueRatio: 0,
          descriptionRatio: 0,
          narrativePerson: '',
          tense: '',
        },
        omittedReason: null,
      },
      supplements: {
        text: '',
        selected: [],
        omitted: [],
        contentHashes: [],
        wrapper: '',
      },
      budget: {
        stage: 'final_reviser' as const,
        configId: 1,
        contextWindow: 8000,
        effectiveWindow: 7800,
        declaredMaxOutputTokens: 4000,
        compiledPromptTokens: 1000,
        protocolSkeletonTokens: 400,
        promptReserveTokens: 100,
        safetyReserveTokens: 100,
        hardContextTokens: 0,
        inputBudget: 6000,
        availableOutputTokens: 4000,
        demandTokens: 5000,
        minimumOutputTokens: 2000,
        maximumOutputTokens: 4000,
        targetChapterChars: 3000,
        pressure: 0.5,
        blockedReason: null,
      },
      snapshotRefs: {
        canonSnapshotId: 'cs',
        canonRevision: 1,
        inputRevisionHash: 'ir',
        styleProfileHash: null,
        styleRendererVersion: null,
      },
    };
    const compiled = compileContinuationV5FinalReviserWithinBudget({
      view,
      revisionContent,
      revisionHan: 1200,
      revisionArtifactHash: 'r'.repeat(64),
      architecture,
      architectureHash,
      audit,
      auditContractHash: auditHash,
      contextWindow: 12000,
      maximumOutputTokens: 3000,
    });
    expect(compiled.ok).toBe(true);
    const user = compiled.messages.find(m => m.role === 'user')?.content ?? '';
    expect(user).toContain('UNIQUE_V2_BODY_MARKER');
    expect(compiled.compressionLevel).toBeGreaterThanOrEqual(0);
  });
});
