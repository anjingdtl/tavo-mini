/**
 * Stability Phase 5 — silent fallback governance (plan §9).
 *
 * Verifies: semantic degradations stay non-blocking but leave structured
 * diagnostics frozen into the snapshot; audit pool capture failures leave
 * warnings; diagnostics survive the envelope round-trip.
 */
import { createGenerationDiagnosticCollector } from '../src/services/context/generationDiagnostics';
import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
} from '../src/services/pipelineTaskContext';
import { captureFrozenAuditCandidates } from '../src/services/postDraftRetrieval';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import { execute } from '../src/data/connection/execute';
import { openDatabase } from '../src/data/connection/openDatabase';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';
import type { ContextConfig } from '../src/types/novel';

describe('generationDiagnosticCollector', () => {
  test('collects and derives overall status', () => {
    const collector = createGenerationDiagnosticCollector();
    expect(collector.overall()).toBe('OK');
    collector.push({
      code: 'RESOURCE_RETRIEVAL_FAILED',
      severity: 'warning',
      message: 'x',
    });
    expect(collector.overall()).toBe('DEGRADED');
    collector.push({
      code: 'BUDGET_MANDATORY_OVERFLOW',
      severity: 'blocking',
      message: 'y',
    });
    expect(collector.overall()).toBe('BLOCKED');
    expect(collector.list()).toHaveLength(2);
  });
});

describe('stabilityDiagnostics envelope round-trip', () => {
  function context(
    diagnostics?: PipelineContextSnapshot['stabilityDiagnostics'],
  ): PipelineContextSnapshot {
    return {
      presetText: 'preset',
      storyMemoryText: '',
      characterText: '',
      noteText: '',
      worldbookText: '',
      episodicMemoryText: '',
      recentBridgeText: '',
      currentInstructionText: '',
      retrievalUserPrompt: '',
      outlineText: '',
      outlineFingerprint: 'fp',
      outlineIds: [],
      outlineComplete: true,
      outlineEstimatedTokens: 0,
      projectId: 1,
      chapterId: 2,
      createdAt: 1,
      snapshotVersion: 1,
      stabilityDiagnostics: diagnostics,
    };
  }

  function execution(): PipelineExecutionSnapshot {
    const tier = () => ({
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
        draft: { stage: 'draft', ...tier() },
        review: { stage: 'review', ...tier() },
        factCheck: { stage: 'factCheck', ...tier() },
        brief: { stage: 'brief', ...tier() },
        proof: { stage: 'proof', ...tier() },
      },
      briefPolicyVersion: 4,
      draftMaxTokens: 1000,
      reviewMaxTokens: 1000,
      factCheckMaxTokens: 1000,
      proofMaxTokens: 1000,
      draftPresetId: null,
      reviewPresetId: null,
      factCheckPresetId: null,
      proofPresetId: null,
      draftPreset: null,
      reviewPreset: null,
      factCheckPreset: null,
      proofPreset: null,
      model: { llmConfigId: 1, modelName: 'm', contextWindow: 32000 },
      createdAt: 1,
    } as PipelineExecutionSnapshot;
  }

  test('diagnostics survive serialize → parse', () => {
    const diagnostics = [
      {
        code: 'RESOURCE_RETRIEVAL_FAILED',
        severity: 'warning' as const,
        message: '资料候选收集失败',
        stage: 'collect',
        source: 'contextBuilder.v3ResourceCandidates',
        detail: { reason: 'db locked' },
      },
    ];
    const serialized = serializePipelineTaskContext({
      draftContext: context(diagnostics),
      execution: execution(),
    });
    const parsed = parsePersistedPipelineTaskContext(serialized);
    expect(parsed.draftContext.stabilityDiagnostics).toEqual(diagnostics);
  });

  test('historical snapshots without diagnostics parse to undefined', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
    });
    const parsed = parsePersistedPipelineTaskContext(serialized);
    expect(parsed.draftContext.stabilityDiagnostics).toBeUndefined();
  });

  test('malformed diagnostics entries are filtered, never block resume', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
    });
    const raw = JSON.parse(serialized.pipelineContextJson);
    raw.draftContext.stabilityDiagnostics = [
      { code: 'OK_ONE', severity: 'warning', message: 'keep' },
      { code: '', severity: 'warning', message: 'no code' },
      { severity: 'warning', message: 'missing code' },
      { code: 'BAD_SEVERITY', severity: 'fatal', message: 'bad severity' },
      'not-an-object',
    ];
    const parsed = parsePersistedPipelineTaskContext({
      pipelineContextJson: JSON.stringify(raw),
      pipelineContextVersion: serialized.pipelineContextVersion,
      pipelineContextHash: null,
    });
    expect(parsed.draftContext.stabilityDiagnostics).toEqual([
      { code: 'OK_ONE', severity: 'warning', message: 'keep' },
    ]);
  });
});

describe('captureFrozenAuditCandidates pool warnings', () => {
  afterEach(() => {
    __resetForTest();
  });

  test('chapter read failure leaves an observable warning, pool degrades to empty', async () => {
    const db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
    // Drop the chapters table to force the read failure path.
    await execute(await openDatabase(), 'DROP TABLE chapters');

    const config: ContextConfig = {
      strategy: 'sliding',
      slidingWindowSize: 3,
      customRangeStart: 0,
      customRangeEnd: -1,
      resourceBudget: 1000,
      includeResources: true,
    };
    const chapter = {
      id: 1,
      project_id: 1,
      position: 2,
      title: '第3章',
      synopsis: '',
      content: '',
      status: 'draft',
      summary_json: null,
      created_at: '',
      updated_at: '',
    } as any;

    const pool = await captureFrozenAuditCandidates(chapter, 1, config, {
      contextBudgetVersion: 5,
    });
    expect(pool.episodicCandidates).toEqual([]);
    expect(pool.captureWarnings).toBeDefined();
    expect(pool.captureWarnings!.join('\n')).toContain('章节读取失败');
  });
});
