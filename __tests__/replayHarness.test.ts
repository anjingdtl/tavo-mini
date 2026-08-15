/**
 * Stability Phase 6 — Generation Replay Harness (plan §7).
 *
 * Gate P0-6: same fixture replayed 10 times → identical fingerprint; all
 * deterministic derivations (semantic fingerprint, frozen request
 * fingerprint) replay to their frozen values; tampered content is detected.
 */
import {
  replayFrozenGeneration,
  replayDeterminism,
} from '../src/services/pipeline/replayHarness';
import {
  serializePipelineTaskContext,
  computeFrozenDraftRequestFingerprint,
} from '../src/services/pipelineTaskContext';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';
import type { FrozenDraftRequest } from '../src/types/pipelineFrozen';

function context(): PipelineContextSnapshot {
  return {
    presetText: 'preset',
    storyMemoryText: 'story',
    characterText: 'char',
    noteText: 'note',
    worldbookText: 'wb',
    episodicMemoryText: 'episodic',
    recentBridgeText: 'bridge',
    currentInstructionText: 'instruction',
    retrievalUserPrompt: 'prompt',
    outlineText: 'outline',
    outlineFingerprint: 'outline-fp',
    outlineIds: [1],
    outlineComplete: true,
    outlineEstimatedTokens: 12,
    projectId: 7,
    chapterId: 23,
    createdAt: 1700000000000,
    snapshotVersion: 1,
    stabilityDiagnostics: [
      {
        code: 'RESOURCE_RETRIEVAL_FAILED',
        severity: 'warning',
        message: 'demo',
      },
    ],
  };
}

function execution(): PipelineExecutionSnapshot {
  const tier = (stage: string) => ({
    stage,
    requestedTier: 'low' as const,
    effectiveTier: 'low' as const,
    thinking: 'enabled' as const,
    effort: 'low' as const,
  });
  return {
    pipelineMode: 'full',
    outlineWorkflowVersion: 4,
    contextBudgetVersion: 5,
    finalReviserReasoningPolicyVersion: 3,
    reasoningEffort: 'low',
    reasoningProfileVersion: 5,
    requestedReasoningTier: 'low',
    stageReasoning: {
      draft: tier('draft'),
      review: tier('review'),
      factCheck: tier('factCheck'),
      brief: tier('brief'),
      proof: tier('proof'),
    },
    briefPolicyVersion: 4,
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
  } as PipelineExecutionSnapshot;
}

function frozenRequest(): FrozenDraftRequest {
  const meta = {
    estimatedInputTokens: 42100,
    reservedOutputTokens: 4000,
    safetyMargin: 2000,
    contextWindow: 128000,
  };
  const messages = [
    { role: 'system' as const, content: 'sys prompt' },
    { role: 'user' as const, content: '请写第23章' },
  ];
  return {
    messages,
    ...meta,
    allocations: [
      { id: 'outline', requested: 100, allocated: 100, truncated: false },
    ],
    requestFingerprint: computeFrozenDraftRequestFingerprint(messages, meta),
    chapterTitle: '第23章',
    prevEnding: '……',
    userPrompt: '请写第23章',
  };
}

function fixture() {
  return serializePipelineTaskContext({
    draftContext: context(),
    execution: execution(),
    frozenDraftRequest: frozenRequest(),
    trace: {
      version: 1,
      generationTraceId: 'gt-replay00-a1b2c3d4',
      createdAt: 1700000000000,
    },
  });
}

describe('replayFrozenGeneration', () => {
  test('all deterministic checks pass on a healthy fixture', () => {
    const result = replayFrozenGeneration(fixture());
    expect(result.ok).toBe(true);
    expect(result.parsed).toBe(true);
    expect(result.generationTraceId).toBe('gt-replay00-a1b2c3d4');
    expect(result.generationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.diagnostics.map(d => d.code)).toEqual([
      'RESOURCE_RETRIEVAL_FAILED',
    ]);
    expect(
      result.checks.map(c => ({ name: c.name, passed: c.passed })),
    ).toEqual([
      { name: 'envelope_parse', passed: true },
      { name: 'generation_fingerprint_matches_stored', passed: true },
      { name: 'frozen_draft_request_fingerprint_replay', passed: true },
    ]);
  });

  test('semantic tamper fails the fingerprint check', () => {
    const serialized = fixture();
    const raw = JSON.parse(serialized.pipelineContextJson);
    raw.draftContext.outlineText = '被篡改的大纲';
    const result = replayFrozenGeneration({
      pipelineContextJson: JSON.stringify(raw),
      pipelineContextVersion: serialized.pipelineContextVersion,
      pipelineContextHash: null,
    });
    expect(result.ok).toBe(false);
    const failed = result.checks.find(c => !c.passed);
    expect(failed?.name).toBe('generation_fingerprint_matches_stored');
  });

  test('message tamper fails the frozen request fingerprint replay', () => {
    const serialized = fixture();
    const raw = JSON.parse(serialized.pipelineContextJson);
    raw.frozenDraftRequest.messages[1].content = '被篡改的指令';
    // Repair the byte-level integrity so the SEMANTIC check is what fires.
    const json = JSON.stringify(raw);
    const result = replayFrozenGeneration({
      pipelineContextJson: json,
      pipelineContextVersion: serialized.pipelineContextVersion,
      pipelineContextHash: null,
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.find(c => !c.passed)?.name,
    ).toBe('frozen_draft_request_fingerprint_replay');
  });

  test('corrupt envelope reports parse failure without throwing', () => {
    const result = replayFrozenGeneration({
      pipelineContextJson: '{not json',
      pipelineContextHash: null,
    });
    expect(result.parsed).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.checks[0].name).toBe('envelope_parse');
  });
});

describe('replayDeterminism (Phase 6 gate)', () => {
  test('same fixture × 10 → identical fingerprints', () => {
    const serialized = fixture();
    const result = replayDeterminism({
      pipelineContextJson: serialized.pipelineContextJson,
      pipelineContextVersion: serialized.pipelineContextVersion,
      pipelineContextHash: serialized.pipelineContextHash,
    });
    expect(result.iterations).toBe(10);
    expect(result.allIdentical).toBe(true);
    expect(new Set(result.fingerprints).size).toBe(1);
  });
});
