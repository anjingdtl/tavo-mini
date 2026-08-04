import {
  compileContinuationV5FinalReviserMessages,
  compileContinuationV5RevisionWriterMessages,
} from '../src/services/continuation/generation/continuationV5PromptCompiler';
import {
  buildFallbackArchitecture,
  buildFallbackAuditContract,
  hashArchitectureEnvelope,
  hashAuditEnvelope,
} from '../src/services/continuation/generation/continuationV5Contracts';

function baseView(overrides: Record<string, unknown> = {}) {
  return {
    stage: 'revision_writer' as const,
    projectId: 1,
    targetChapterId: 1,
    targetPosition: 0 as any,
    targetChapterChars: 5000,
    preferredMinHan: 4500,
    preferredMaxHan: 5500,
    severeUnderHan: 3250,
    userInstruction: '推进本章',
    lockedRules: [],
    canon: {
      hardFacts: [],
      softFacts: [],
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
    recentBridgeSummary: '',
    style: {
      profileId: null,
      profileHash: null,
      rendererVersion: null,
      renderLevel: null,
      text: '',
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
      stage: 'revision_writer' as const,
      configId: 1,
      contextWindow: 128000,
      effectiveWindow: 120000,
      declaredMaxOutputTokens: 16000,
      compiledPromptTokens: 2000,
      protocolSkeletonTokens: 200,
      promptReserveTokens: 100,
      safetyReserveTokens: 100,
      hardContextTokens: 0,
      inputBudget: 100000,
      availableOutputTokens: 16000,
      demandTokens: 18000,
      minimumOutputTokens: 10000,
      maximumOutputTokens: 16000,
      targetChapterChars: 5000,
      pressure: 0.2,
      blockedReason: null,
    },
    snapshotRefs: {
      canonSnapshotId: 'cs',
      canonRevision: 1,
      inputRevisionHash: 'ir',
      styleProfileHash: null,
      styleRendererVersion: null,
    },
    ...overrides,
  };
}

describe('V5 prompt roles: V2 expands length, V3 polishes', () => {
  test('Revision Writer owns target band and forbids early stop under preferredMin', () => {
    const architecture = buildFallbackArchitecture({ userInstruction: '推进' });
    const architectureHash = hashArchitectureEnvelope(architecture);
    const compiled = compileContinuationV5RevisionWriterMessages({
      view: baseView({ stage: 'revision_writer' }) as any,
      draftContent: '初稿正文。',
      draftHan: 1800,
      draftArtifactHash: 'a'.repeat(64),
      architecture,
      architectureHash,
    });
    const system = compiled.messages.find(m => m.role === 'system')?.content ?? '';
    const user = compiled.messages.find(m => m.role === 'user')?.content ?? '';
    expect(system).toMatch(/主扩写稿/);
    expect(system).toMatch(/4500/);
    expect(system).toMatch(/5500/);
    expect(system).toMatch(/不得提前收束/);
    expect(system).toMatch(/V3 只做润色/);
    expect(user).toMatch(/篇幅自检/);
    expect(user).toMatch(/≥ 4500/);
  });

  test('Final Reviser is polish-first when V2 already in band', () => {
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
      lockedRules: [],
      hardCanonFacts: [],
    });
    const compiled = compileContinuationV5FinalReviserMessages({
      view: {
        ...baseView({ stage: 'final_reviser' }),
        budget: {
          ...baseView().budget,
          stage: 'final_reviser' as const,
        },
      } as any,
      revisionContent: '完整 V2。'.repeat(100),
      revisionHan: 4800,
      revisionArtifactHash: 'r'.repeat(64),
      architecture,
      architectureHash,
      audit,
      auditContractHash: hashAuditEnvelope(audit),
    });
    const system = compiled.messages.find(m => m.role === 'system')?.content ?? '';
    expect(system).toMatch(/润色与 C2 合同履约/);
    expect(system).toMatch(/不要把 V3 当成主要加长环节/);
    expect(system).toMatch(/已在目标区间内/);
    expect(system).toMatch(/±10%/);
  });

  test('Final Reviser allows length fallback only when V2 is still short', () => {
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
      lockedRules: [],
      hardCanonFacts: [],
    });
    const compiled = compileContinuationV5FinalReviserMessages({
      view: {
        ...baseView({ stage: 'final_reviser' }),
        budget: {
          ...baseView().budget,
          stage: 'final_reviser' as const,
        },
      } as any,
      revisionContent: '短 V2。',
      revisionHan: 2000,
      revisionArtifactHash: 'r'.repeat(64),
      architecture,
      architectureHash,
      audit,
      auditContractHash: hashAuditEnvelope(audit),
    });
    const system = compiled.messages.find(m => m.role === 'system')?.content ?? '';
    expect(system).toMatch(/仍低于首选下限/);
    expect(system).toMatch(/兜底补写/);
  });
});
