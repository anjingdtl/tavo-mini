/**
 * Phase IV Pre-Seal Correction (Red-first).
 *
 * 1. QA finishReason=length / invalid contract must stay Advisory (no hard
 *    block, no extra LLM call), but the Revision skip must never claim a
 *    clean QA outcome while Mandatory / Canon / State Safety checks are
 *    unresolved.
 * 2. A high-value Optional source (explicit activation or preferred
 *    requirement) must not be dropped by the Phase IV elastic projection
 *    merely because its kind is not on the stage allowlist. Mandatory
 *    sources are always kept; low-relevance automatic Optional sources are
 *    trimmed first. No second context builder is introduced.
 */
import { evaluateRuntimeStageSkip } from '../src/services/writing/stages/evaluateRuntimeStageSkip';
import { isPhase4QaLengthAdvisory } from '../src/services/writing/stages/writerCore';
import { projectFrozenContextForStage } from '../src/services/writing/context/stageContextProjection';
import type {
  FrozenWritingContext,
  WritingMaterialCandidate,
} from '../src/services/writing/contracts/frozenWritingContext';
import type { WritingSource } from '../src/services/writing/contracts/writingSource';
import { sha256Hex } from '../src/services/continuation/hashUtils';

function source(
  candidateId: string,
  kind: WritingSource['kind'],
  content: string,
  requirement: WritingSource['requirement'],
  activation: WritingSource['activation'] = 'automatic',
): WritingSource {
  return {
    candidateId,
    kind,
    sourceId: candidateId,
    revision: '1',
    content,
    contentHash: sha256Hex(content),
    requirement,
    activation,
  };
}

function context(materials: WritingMaterialCandidate[]): FrozenWritingContext {
  const renderedText = materials
    .map(item => `【${item.source.kind}:${item.source.candidateId}】\n${item.source.content}`)
    .join('\n\n');
  return {
    version: 1,
    writingRunId: 'wr-preseal',
    generationTraceId: 'gt-preseal',
    projectId: 1,
    chapterId: 1,
    targetChars: 1000,
    instruction: {
      title: '测试章',
      synopsis: '测试',
      userInstruction: '完成测试',
      currentContent: '',
      targetPosition: 1,
    },
    sourceBundle: { mandatory: [], preferred: [], optional: [] },
    model: {
      configId: 1,
      name: 'test',
      provider: 'openai_compatible',
      providerAdapterId: 'test',
      url: 'https://example.test',
      modelName: 'test',
      contextWindow: 100000,
      maxOutputTokens: 10000,
    },
    policy: { version: 1, reviewMode: 'continuation-v5', strictness: 'fail-closed', values: {} },
    requirements: { version: 1, items: [], fingerprint: 'requirements' },
    stagePolicy: {
      version: 1,
      reviewMode: 'continuation-v5',
      strictness: 'fail-closed',
      semanticApplyRequired: true,
      stageOrder: ['draft', 'qa', 'revision', 'finalValidate', 'persist'],
      outputContract: 'json_envelope',
      skipRules: {},
      values: { phase4GatePolicyVersion: 'phase4-gates-v1' },
      requirementsFingerprint: 'requirements',
    },
    materials,
    plan: { version: 1, items: [], fingerprint: 'plan' },
    allocation: {
      version: 1,
      inputTokenLimit: 90000,
      reservedOutputTokens: 10000,
      totalAllocatedTokens: 0,
      items: [],
      fingerprint: 'allocation',
    },
    rendered: {
      version: 1,
      text: renderedText,
      items: materials.map(item => ({
        candidateId: item.source.candidateId,
        allocatedTokens: item.demandTokens,
        actualTokens: item.demandTokens,
        included: true,
        clipped: false,
        renderedHash: sha256Hex(item.source.content),
      })),
      estimatedInputTokens: renderedText.length,
      fingerprint: 'rendered',
    },
    sourceFingerprint: 'source',
    freezeFingerprint: 'freeze',
  };
}

describe('Phase IV pre-seal correction: QA incomplete must not be silently Clean', () => {
  const truncatedQaArtifacts = {
    draft: { stage: 'draft' as const, body: '完整正文。' },
    qa: {
      stage: 'qa' as const,
      body: '',
      diagnostics: ['qa_truncated_advisory'],
    },
  };
  const invalidContractQaArtifacts = {
    draft: { stage: 'draft' as const, body: '完整正文。' },
    qa: {
      stage: 'qa' as const,
      body: '',
      diagnostics: ['qa_contract_advisory'],
    },
  };

  test('RED: truncated QA (finishReason=length) never yields the clean skip rule', () => {
    const outcome = evaluateRuntimeStageSkip({
      stage: 'revision',
      artifacts: truncatedQaArtifacts,
      pipelineTopologyVersion: 'compact_standard',
    });
    expect(outcome.skip).toBe(true);
    expect(outcome.skip && outcome.policyRuleId).toBe(
      'policy.phase4.qa_incomplete_not_clean',
    );
  });

  test('RED: contract-invalid QA never yields the clean skip rule either', () => {
    const outcome = evaluateRuntimeStageSkip({
      stage: 'revision',
      artifacts: invalidContractQaArtifacts,
      pipelineTopologyVersion: 'compact_standard',
    });
    expect(outcome.skip).toBe(true);
    expect(outcome.skip && outcome.policyRuleId).toBe(
      'policy.phase4.qa_incomplete_not_clean',
    );
  });

  test('a genuinely clean QA keeps the ordinary conditional-revision rule', () => {
    const outcome = evaluateRuntimeStageSkip({
      stage: 'revision',
      artifacts: {
        draft: { stage: 'draft' as const, body: '完整正文。' },
        qa: {
          stage: 'qa' as const,
          body: JSON.stringify({ decision: 'clean' }),
        },
      },
      pipelineTopologyVersion: 'compact_standard',
    });
    expect(outcome.skip).toBe(true);
    expect(outcome.skip && outcome.policyRuleId).toBe(
      'policy.one_pipeline.conditional_revision_no_findings',
    );
  });

  test('truncated QA stays Advisory: it must not dispatch a revision with no findings', () => {
    // No executable findings exist in the truncated artifact, so the compact
    // pipeline must not spend an extra paid LLM call on an empty revision;
    // the correction is classification-only (explicit non-clean rule id).
    const outcome = evaluateRuntimeStageSkip({
      stage: 'revision',
      artifacts: truncatedQaArtifacts,
      pipelineTopologyVersion: 'compact_standard',
    });
    expect(outcome.skip).toBe(true);
    expect(outcome.skip && outcome.skipReason).toContain('不得记为 Clean');
  });

  test('RED (real-device regression 2026-08-30): primary QA call with finishReason=length stays Advisory under the Phase IV gate policy', () => {
    // The 5-chapter real run failed at writerCore's UNCONDITIONAL primary
    // assertWriterFinishReason before the finalize advisory was reachable.
    const values = { phase4GatePolicyVersion: 'phase4-gates-v1' };
    expect(
      isPhase4QaLengthAdvisory({
        stage: 'qa',
        stagePolicyValues: values,
        finishReason: 'length',
      }),
    ).toBe(true);
    // Draft / Revision truncation still hard-fails.
    expect(
      isPhase4QaLengthAdvisory({
        stage: 'draft',
        stagePolicyValues: values,
        finishReason: 'length',
      }),
    ).toBe(false);
    expect(
      isPhase4QaLengthAdvisory({
        stage: 'revision',
        stagePolicyValues: values,
        finishReason: 'length',
      }),
    ).toBe(false);
    // Without the Phase IV marker the historical hard gate still applies.
    expect(
      isPhase4QaLengthAdvisory({
        stage: 'qa',
        stagePolicyValues: {},
        finishReason: 'length',
      }),
    ).toBe(false);
  });
});

describe('Phase IV pre-seal correction: elastic projection keeps high-value Optional', () => {
  test('RED: explicit-activated Optional is not dropped merely by kind', () => {
    const materials = [
      { source: source('canon-1', 'canon', 'Mandatory Canon 真相', 'mandatory'), sourceOrder: 0, demandTokens: 10 },
      {
        source: source('char-1', 'character', '用户显式钉选的角色卡', 'optional', 'explicit'),
        sourceOrder: 1,
        demandTokens: 10,
      },
      {
        source: source('note-1', 'note', '低相关自动附带笔记', 'optional', 'automatic'),
        sourceOrder: 2,
        demandTokens: 10,
      },
    ];
    const projection = projectFrozenContextForStage({
      frozenContext: context(materials),
      stage: 'qa',
    });
    expect(projection.text).toContain('Mandatory Canon 真相');
    expect(projection.text).toContain('用户显式钉选的角色卡');
    expect(projection.text).not.toContain('低相关自动附带笔记');
    expect(projection.composition?.droppedOptionalCandidateIds).toEqual(['note-1']);
    expect(projection.composition?.includedOptionalCandidateIds).toContain('char-1');
  });

  test('RED: preferred Optional is not dropped merely by kind', () => {
    const materials = [
      { source: source('canon-1', 'canon', 'Mandatory Canon', 'mandatory'), sourceOrder: 0, demandTokens: 10 },
      {
        source: source('pref-char-1', 'character', 'Preferred 角色资料', 'preferred'),
        sourceOrder: 1,
        demandTokens: 10,
      },
    ];
    const projection = projectFrozenContextForStage({
      frozenContext: context(materials),
      stage: 'qa',
    });
    expect(projection.text).toContain('Preferred 角色资料');
    expect(projection.composition?.includedPreferredCandidateIds).toContain('pref-char-1');
    expect(projection.composition?.droppedPreferredCandidateIds).toEqual([]);
  });

  test('Mandatory sources are always kept even when their kind is not allowlisted', () => {
    const materials = [
      {
        source: source('state-1', 'structured_continuity_state', 'Mandatory 状态安全', 'mandatory'),
        sourceOrder: 0,
        demandTokens: 10,
      },
    ];
    const projection = projectFrozenContextForStage({
      frozenContext: context(materials),
      stage: 'qa',
    });
    expect(projection.text).toContain('Mandatory 状态安全');
    expect(projection.composition?.mandatoryCandidateIds).toContain('state-1');
  });

  test('low-relevance automatic Optional is still trimmed first for throughput', () => {
    const materials = [
      { source: source('canon-1', 'canon', 'Mandatory Canon', 'mandatory'), sourceOrder: 0, demandTokens: 10 },
      { source: source('char-1', 'character', '自动附带角色', 'optional', 'automatic'), sourceOrder: 1, demandTokens: 10 },
    ];
    const projection = projectFrozenContextForStage({
      frozenContext: context(materials),
      stage: 'qa',
    });
    expect(projection.text).not.toContain('自动附带角色');
    expect(projection.composition?.droppedOptionalCandidateIds).toContain('char-1');
  });
});
