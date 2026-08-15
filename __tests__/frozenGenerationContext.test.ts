/**
 * Stability Phase 2 — FrozenGenerationContext V1 + generationFingerprint.
 *
 * Gate P0-2: snapshot serialize/parse stable; fingerprint stable; resume
 * recoverable; fingerprint mismatch fail-closed.
 */
import {
  buildGenerationFingerprintInput,
  computeGenerationFingerprint,
  deriveFrozenGenerationContext,
} from '../src/services/pipeline/frozenGenerationContext';
import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
} from '../src/services/pipelineTaskContext';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';
import type { FrozenDraftRequest } from '../src/types/pipelineFrozen';
import type { FrozenGenerationContextContractV2 } from '../src/services/context/generation/generationContracts';
import { computeGenerationContractFingerprint } from '../src/services/context/generation/generationContractValidation';

function context(
  overrides: Partial<PipelineContextSnapshot> = {},
): PipelineContextSnapshot {
  return {
    presetText: 'preset',
    storyMemoryText: 'story-memory',
    characterText: 'character',
    noteText: '',
    worldbookText: 'worldbook',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '继续本章',
    retrievalUserPrompt: '',
    outlineText: '停在门前',
    outlineFingerprint: 'outline-fp',
    outlineIds: [1],
    outlineComplete: true,
    outlineEstimatedTokens: 10,
    projectId: 7,
    chapterId: 23,
    createdAt: 1700000000000,
    snapshotVersion: 1,
    ...overrides,
  };
}

function execution(
  overrides: Partial<PipelineExecutionSnapshot> = {},
): PipelineExecutionSnapshot {
  const stageReasoning = (
    ['draft', 'review', 'factCheck', 'brief', 'proof'] as const
  ).reduce(
    (acc, stage) => ({
      ...acc,
      [stage]: {
        stage,
        requestedTier: 'high',
        effectiveTier: stage === 'factCheck' ? 'low' : 'high',
        thinking: 'enabled',
        effort: stage === 'factCheck' ? 'low' : 'high',
        supported: true,
      },
    }),
    {} as PipelineExecutionSnapshot['stageReasoning'],
  );
  return {
    pipelineMode: 'full',
    outlineWorkflowVersion: 4,
    contextBudgetVersion: 5,
    finalReviserReasoningPolicyVersion: 3,
    reasoningEffort: 'high',
    reasoningProfileVersion: 5,
    requestedReasoningTier: 'high',
    stageReasoning,
    briefPolicyVersion: 4,
    briefVisibleOutputFloor: 1200,
    briefReasoningHeadroom: 1200,
    briefMaxTokens: 4096,
    draftMaxTokens: 4000,
    reviewMaxTokens: 1500,
    factCheckMaxTokens: 1500,
    proofMaxTokens: 4000,
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
      name: 'Model',
      provider: 'openai_compatible',
      modelName: 'model-a',
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
    createdAt: 1700000000000,
    ...overrides,
  } as PipelineExecutionSnapshot;
}

function frozenRequest(
  overrides: Partial<FrozenDraftRequest> = {},
): FrozenDraftRequest {
  return {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'write' },
    ],
    estimatedInputTokens: 42100,
    reservedOutputTokens: 4000,
    safetyMargin: 2000,
    contextWindow: 128000,
    allocations: [{ id: 'outline', requested: 100, allocated: 100, truncated: false }],
    requestFingerprint: 'req-fp-1',
    chapterTitle: '第23章',
    prevEnding: '……',
    userPrompt: '继续',
    ...overrides,
  };
}

function generationContract(): FrozenGenerationContextContractV2 {
  const payload = {
    version: 2 as const,
    projectId: 7,
    chapterId: 23,
    currentPosition: 3,
    candidates: [
      {
        candidateId: 'character:1',
        sourceType: 'character' as const,
        sourceId: 1,
        sourceRevision: 'rev-1',
        contentHash: 'a'.repeat(64),
        activation: 'automatic' as const,
        selected: true,
        selectedReason: 'project_character',
        rejectedReason: null,
        requirement: 'preferred' as const,
        relevance: 0.9,
        priority: 7,
        selectionBoost: 1,
        demandTokens: 12,
      },
    ],
    budget: [
      {
        candidateId: 'character:1',
        demandTokens: 12,
        requestedTokens: 12,
        minTokens: 0,
        targetTokens: 12,
        maxTokens: 12,
        allocatedTokens: 12,
        allocationReason: 'preferred',
        waterLevel: 'soft' as const,
        budgetClipped: false,
        clippedByBudget: false,
      },
    ],
    rendered: [
      {
        candidateId: 'character:1',
        allocatedTokens: 12,
        actualTokens: 8,
        included: true,
        clipped: true,
        clippingReason: 'allocation_limit',
        renderedHash: 'b'.repeat(64),
      },
    ],
    messages: [{ role: 'system' as const, content: '角色资料' }],
    diagnostics: [],
  };
  const contract = { ...payload, fingerprint: '' } as FrozenGenerationContextContractV2;
  return {
    ...contract,
    fingerprint: computeGenerationContractFingerprint(contract),
  };
}

describe('generationFingerprint determinism', () => {
  test('same semantic input → same fingerprint (regardless of trace/createdAt)', () => {
    const a = computeGenerationFingerprint(
      buildGenerationFingerprintInput(context(), execution(), frozenRequest()),
    );
    const b = computeGenerationFingerprint(
      buildGenerationFingerprintInput(
        context({ createdAt: 9999999999999 }),
        execution(),
        frozenRequest(),
      ),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('semantic drift changes the fingerprint', () => {
    const base = () =>
      computeGenerationFingerprint(
        buildGenerationFingerprintInput(context(), execution(), frozenRequest()),
      );
    const original = base();
    // outline text changed
    expect(
      computeGenerationFingerprint(
        buildGenerationFingerprintInput(
          context({ outlineText: '停在门外' }),
          execution(),
          frozenRequest(),
        ),
      ),
    ).not.toBe(original);
    // story memory changed
    expect(
      computeGenerationFingerprint(
        buildGenerationFingerprintInput(
          context({ storyMemoryText: 'dirty' }),
          execution(),
          frozenRequest(),
        ),
      ),
    ).not.toBe(original);
    // model window changed
    expect(
      computeGenerationFingerprint(
        buildGenerationFingerprintInput(
          context(),
          execution({
            model: {
              llmConfigId: 1,
              name: 'Model',
              provider: 'openai_compatible',
              modelName: 'model-a',
              contextWindow: 65536,
              maxOutputTokens: 8192,
            },
          }),
          frozenRequest(),
        ),
      ),
    ).not.toBe(original);
    // request fingerprint changed (budget/render drift)
    expect(
      computeGenerationFingerprint(
        buildGenerationFingerprintInput(
          context(),
          execution(),
          frozenRequest({ estimatedInputTokens: 50000 }),
        ),
      ),
    ).not.toBe(original);
  });
});

describe('envelope fingerprint embed & verify', () => {
  test('round-trip keeps stored == recomputed fingerprint', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
      frozenDraftRequest: frozenRequest(),
    });
    const parsed = parsePersistedPipelineTaskContext(serialized);
    expect(parsed.generationFingerprint).toBe(
      computeGenerationFingerprint(
        buildGenerationFingerprintInput(
          parsed.draftContext,
          parsed.execution!,
          parsed.frozenDraftRequest,
        ),
      ),
    );
  });

  test('re-serialization after draft completion keeps the fingerprint stable', () => {
    const first = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
      frozenDraftRequest: frozenRequest(),
    });
    const parsedFirst = parsePersistedPipelineTaskContext(first);
    // Simulate actionBuildAuditContext re-serialization (adds audit fields).
    const second = serializePipelineTaskContext({
      draftContext: parsedFirst.draftContext,
      auditContext: context({ presetText: 'audit-preset' }),
      execution: parsedFirst.execution!,
      frozenDraftRequest: parsedFirst.frozenDraftRequest,
      draftCompletedAt: 1700000005000,
      auditFellBack: false,
    });
    const parsedSecond = parsePersistedPipelineTaskContext(second);
    expect(parsedSecond.generationFingerprint).toBe(
      parsedFirst.generationFingerprint,
    );
  });

  test('historical envelope without fingerprint parses tolerantly', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
    });
    const raw = JSON.parse(serialized.pipelineContextJson);
    delete raw.generationFingerprint;
    const parsed = parsePersistedPipelineTaskContext({
      ...serialized,
      pipelineContextJson: JSON.stringify(raw),
      pipelineContextHash: null,
    });
    expect(parsed.generationFingerprint).toBeNull();
  });

  test('semantic tamper with fixed byte hash → SNAPSHOT_FINGERPRINT_MISMATCH', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
      frozenDraftRequest: frozenRequest(),
    });
    const raw = JSON.parse(serialized.pipelineContextJson);
    raw.draftContext.outlineText = '被篡改的大纲';
    const json = JSON.stringify(raw);
    expect(() =>
      parsePersistedPipelineTaskContext({
        pipelineContextJson: json,
        pipelineContextVersion: serialized.pipelineContextVersion,
        pipelineContextHash: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'SNAPSHOT_FINGERPRINT_MISMATCH' }));
  });

  test('candidate contract round-trips and participates in the snapshot fingerprint', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context({ generationContract: generationContract() }),
      execution: execution(),
      frozenDraftRequest: frozenRequest(),
    });
    const parsed = parsePersistedPipelineTaskContext(serialized);
    expect(parsed.draftContext.generationContract?.candidates[0]).toEqual(
      expect.objectContaining({
        candidateId: 'character:1',
        selected: true,
        selectedReason: 'project_character',
        demandTokens: 12,
      }),
    );
    expect(parsed.generationFingerprint).toBe(serialized.generationFingerprint);

    const raw = JSON.parse(serialized.pipelineContextJson);
    raw.draftContext.generationContract.candidates[0].selected = false;
    expect(() =>
      parsePersistedPipelineTaskContext({
        pipelineContextJson: JSON.stringify(raw),
        pipelineContextVersion: serialized.pipelineContextVersion,
        pipelineContextHash: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'SNAPSHOT_FINGERPRINT_MISMATCH' }));
  });

  test('tampered contract fingerprint fails closed even before envelope verification', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context({ generationContract: generationContract() }),
      execution: execution(),
      frozenDraftRequest: frozenRequest(),
    });
    const raw = JSON.parse(serialized.pipelineContextJson);
    raw.draftContext.generationContract.candidates[0].priority = 99;
    expect(() =>
      parsePersistedPipelineTaskContext({
        pipelineContextJson: JSON.stringify(raw),
        pipelineContextVersion: serialized.pipelineContextVersion,
        pipelineContextHash: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'SNAPSHOT_FINGERPRINT_MISMATCH' }));
  });
});

describe('deriveFrozenGenerationContext view', () => {
  test('projects identity, digests and fingerprints from the envelope', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
      frozenDraftRequest: frozenRequest(),
      trace: {
        version: 1,
        generationTraceId: 'gt-abc12345-x1y2z3w4',
        createdAt: 1700000000000,
      },
    });
    const parsed = parsePersistedPipelineTaskContext(serialized);
    const view = deriveFrozenGenerationContext({
      pipelineTaskId: 'task-1',
      parsed,
    });
    expect(view).not.toBeNull();
    expect(view!.version).toBe(1);
    expect(view!.generationTraceId).toBe('gt-abc12345-x1y2z3w4');
    expect(view!.identity.projectId).toBe(7);
    expect(view!.identity.chapterId).toBe(23);
    expect(view!.identity.outlineWorkflowVersion).toBe(4);
    expect(view!.identity.contextBudgetVersion).toBe(5);
    expect(view!.resolvedSettings.modelId).toBe('model-a');
    expect(view!.request?.requestFingerprint).toBe('req-fp-1');
    expect(view!.storedGenerationFingerprint).toBe(
      view!.computedGenerationFingerprint,
    );
    expect(view!.sourceSnapshot.outlineFingerprint).toBe('outline-fp');
  });

  test('returns null when nothing semantic was frozen (V1/no execution)', () => {
    expect(
      deriveFrozenGenerationContext({ pipelineTaskId: 't', parsed: null }),
    ).toBeNull();
  });

  test('historical V1 bare snapshots remain readable without a candidate contract', () => {
    const historical = context();
    const parsed = parsePersistedPipelineTaskContext({
      pipelineContextJson: JSON.stringify(historical),
      pipelineContextVersion: 1,
      pipelineContextHash: null,
    });
    expect(parsed.version).toBe(1);
    expect(parsed.generationFingerprint).toBeNull();
    expect(parsed.draftContext.generationContract).toBeUndefined();
    expect(deriveFrozenGenerationContext({ pipelineTaskId: 'legacy', parsed })).toBeNull();
  });

  test('current contract envelopes expose the V2 frozen view', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context({ generationContract: generationContract() }),
      execution: execution(),
      frozenDraftRequest: frozenRequest(),
    });
    const parsed = parsePersistedPipelineTaskContext(serialized);
    const view = deriveFrozenGenerationContext({
      pipelineTaskId: 'task-v2',
      parsed,
    });
    expect(view?.version).toBe(2);
    expect((view as any).generationContract.candidates[0].candidateId).toBe(
      'character:1',
    );
  });
});
