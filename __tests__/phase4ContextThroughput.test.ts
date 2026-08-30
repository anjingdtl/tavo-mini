import { normalizeWritingMaterials } from '../src/services/writing/context/normalizeWritingMaterials';
import { projectFrozenContextForStage } from '../src/services/writing/context/stageContextProjection';
import { buildWritingRequestReceipt } from '../src/services/writing/contracts/writingRequestReceipt';
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
): WritingSource {
  return {
    candidateId,
    kind,
    sourceId: candidateId,
    revision: '1',
    content,
    contentHash: sha256Hex(content),
    requirement,
    activation: 'explicit',
  };
}

function context(materials: WritingMaterialCandidate[]): FrozenWritingContext {
  const renderedText = materials
    .map(item => `【${item.source.kind}:${item.source.candidateId}】\n${item.source.content}`)
    .join('\n\n');
  return {
    version: 1,
    writingRunId: 'wr-phase4-context',
    generationTraceId: 'gt-phase4-context',
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
    allocation: { version: 1, inputTokenLimit: 90000, reservedOutputTokens: 10000, totalAllocatedTokens: 0, items: [], fingerprint: 'allocation' },
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

describe('Phase IV-4 Context throughput contract', () => {
  test('QA keeps all Mandatory sources but drops unrelated Optional sources', () => {
    const materials = [
      { source: source('canon-1', 'canon', 'Mandatory Canon 真相', 'mandatory'), sourceOrder: 0, demandTokens: 10 },
      { source: source('style-1', 'writer_style', 'Preferred style', 'preferred'), sourceOrder: 1, demandTokens: 10 },
      { source: source('note-1', 'note', 'Unrelated optional note', 'optional'), sourceOrder: 2, demandTokens: 10 },
    ];
    const projection = projectFrozenContextForStage({
      frozenContext: context(materials),
      stage: 'qa',
    });
    expect(projection.text).toContain('Mandatory Canon 真相');
    expect(projection.text).toContain('Preferred style');
    expect(projection.text).not.toContain('Unrelated optional note');
    expect(projection.carriesFullFrozenContext).toBe(false);
    expect(projection.composition?.droppedOptionalCandidateIds).toContain('note-1');
  });

  test('normalization removes exact duplicate optional content without removing Mandatory Truth', () => {
    const duplicate = '相同但只需要一份的辅助资料';
    const candidates: WritingMaterialCandidate[] = [
      { source: source('canon-1', 'canon', 'Mandatory Truth', 'mandatory'), sourceOrder: 0, demandTokens: 5 },
      { source: source('note-1', 'note', duplicate, 'optional'), sourceOrder: 1, demandTokens: 10 },
      { source: source('note-2', 'note', duplicate, 'optional'), sourceOrder: 2, demandTokens: 10 },
    ];
    const normalized = normalizeWritingMaterials({
      sources: candidates.map(item => item.source),
      candidates,
    });
    expect(normalized.candidates.map(item => item.source.candidateId)).toEqual([
      'canon-1',
      'note-1',
    ]);
    expect(normalized.rejectedCandidateIds).toContain('note-2');
  });

  test('request Receipt carries the deterministic Phase IV composition', () => {
    const receipt = buildWritingRequestReceipt({
      generationTraceId: 'gt-phase4-receipt',
      stage: 'qa',
      frozenContext: context([
        { source: source('canon-1', 'canon', 'Mandatory Canon', 'mandatory'), sourceOrder: 0, demandTokens: 10 },
        { source: source('style-1', 'writer_style', 'Preferred style', 'preferred'), sourceOrder: 1, demandTokens: 10 },
        { source: source('note-1', 'note', 'Dropped note', 'optional'), sourceOrder: 2, demandTokens: 10 },
      ]),
      compiled: {
        messages: [{ role: 'user', content: 'qa' }],
        maxTokens: 1000,
        responseFormat: 'json_object',
      },
      thinking: { type: 'enabled' },
      reasoningEffort: 'high',
    });
    expect(receipt.contextComposition?.droppedOptionalCandidateIds).toContain('note-1');
  });
});
