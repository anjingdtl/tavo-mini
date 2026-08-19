/**
 * One-Shot formal-skip semantics gates (极速档最终封口 P1).
 *
 * A policy-skipped stage must surface `skipped` with its frozen provenance
 * (skipReason + policyRuleId) consistently across the three observation
 * surfaces used later by pipeline governance / performance analysis:
 *   1. Shared Stage Result          — the runner contract
 *   2. Continuation Durable Ledger  — continuation_generation_stage_results
 *      (reuses the existing schema-32 `skipped` status; no fake artifact,
 *      no queued-forever row, no extra model request)
 *   3. Kernel Trace events          — WritingKernelTrace.events
 *
 * skipped ≠ completed / failed / queued. The Standard profile keeps its
 * historical ledger / trace behavior (no skip records at all).
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __setDatabaseForTest,
  __resetForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { all } from '../src/data/connection/query';
import {
  ensureContinuationV5StageResults,
  insertRun,
  listStageResults,
} from '../src/services/continuation/generation/generationRepository';
import { runWritingStages } from '../src/services/writing/stages/writingStageRunner';
import { createContinuationDurableAdapter } from '../src/services/writing/persistence/continuationDurableAdapter';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { runWritingKernel } from '../src/services/writing/unifiedWritingKernel';
import type { WritingStageDriver } from '../src/services/writing/contracts/writingStage';
import { continuationRequest } from './helpers/oneShotFixtures';

let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
}

afterEach(async () => {
  __resetForTest();
  if (testDb) {
    try {
      testDb.close();
    } catch {
      // ignore
    }
    testDb = null;
  }
});

function oneShotContinuationFreeze() {
  return buildWritingKernelFreezeTrace({
    request: continuationRequest({ executionProfile: 'one_shot' }),
  });
}

function standardContinuationFreeze() {
  return buildWritingKernelFreezeTrace({
    request: continuationRequest({}),
  });
}

/** Adoptable structured report for a standard-profile audit stage. */
const ADOPTABLE_REPORT = JSON.stringify({
  content: '审阅完成，无阻塞问题。',
  verdict: 'needs_revision',
  findings: [],
});

// ---------------------------------------------------------------------------
// 1. Shared Stage Result → adapter contract
// ---------------------------------------------------------------------------

describe('One-Shot skip semantics: runner → durable adapter contract', () => {
  test('one_shot rounds persist a FORMAL skip (never artifact, never reserve, never extra call)', async () => {
    const kernelFreeze = oneShotContinuationFreeze();
    const calls: string[] = [];
    const callStage = jest.fn(async (input: { stage: string }) => {
      calls.push(input.stage);
      return { text: '{"content":"极速续写正文。"}', inputTokens: 1, outputTokens: 1 };
    });
    const persistedArtifacts = new Map<string, { stage: string; body: string }>();
    const persistStageSkip = jest.fn();
    const persistAdapter = {
      binding: 'continuation-generation-ledger' as const,
      loadExisting: async (stage: string) =>
        (persistedArtifacts.get(stage) as any) || null,
      reserve: jest.fn(),
      persistStageArtifact: jest.fn(
        async (stage: string, artifact: { body: string }) => {
          persistedArtifacts.set(stage, { stage, body: artifact.body });
        },
      ),
      persistStageFailure: jest.fn(),
      persistStageSkip,
    } as any;

    for (const stages of [
      ['draft', 'review'],
      ['revision', 'audit', 'factCheck'],
      ['proof', 'finalValidate', 'persist'],
    ] as const) {
      await runWritingStages({
        frozenContext: kernelFreeze.frozenContext,
        trace: kernelFreeze.trace,
        stages: [...stages],
        persistAdapter,
        callStage: callStage as any,
        semanticApply: {
          beforeRevisionBody: '',
          finalBody: '极速续写正文。',
          appliedRequirementIds: [],
        },
      });
    }

    // THE gate: every policy-skipped paid stage is reported as a formal skip
    // with its frozen provenance — and never as an executed artifact.
    const skippedStages = persistStageSkip.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(skippedStages.sort()).toEqual(
      ['audit', 'factCheck', 'proof', 'review', 'revision'].sort(),
    );
    for (const call of persistStageSkip.mock.calls) {
      const result = call[1] as {
        status: string;
        skipReason?: string;
        policyRuleId?: string;
      };
      expect(result.status).toBe('skipped');
      expect(result.skipReason).toEqual(expect.any(String));
      expect(result.policyRuleId).toMatch(/^profile\.one_shot\.skip_/);
    }
    // No skipped stage persisted an artifact or reserved a request.
    for (const call of persistStageSkip.mock.calls) {
      expect(persistedArtifacts.has(call[0] as string)).toBe(false);
    }
    expect(persistStageSkip).not.toHaveBeenCalledWith(
      'draft',
      expect.anything(),
    );
    expect(persistStageSkip).not.toHaveBeenCalledWith(
      'finalValidate',
      expect.anything(),
    );
    expect(persistStageSkip).not.toHaveBeenCalledWith(
      'persist',
      expect.anything(),
    );
    // Exactly one physical call (draft) and one reservation — unchanged.
    expect(calls).toEqual(['draft']);
    expect(persistAdapter.reserve).toHaveBeenCalledTimes(1);
    expect((persistAdapter.reserve as jest.Mock).mock.calls[0][0]).toBe('draft');
  });

  test('standard profile never records a formal skip', async () => {
    const kernelFreeze = standardContinuationFreeze();
    const callStage = jest.fn(async (input: { stage: string }) => {
      if (input.stage === 'draft') {
        return { text: '标准档正文。', inputTokens: 1, outputTokens: 1 };
      }
      return { text: ADOPTABLE_REPORT, inputTokens: 1, outputTokens: 1 };
    });
    const persistStageSkip = jest.fn();
    const persistStageArtifact = jest.fn();
    const persistAdapter = {
      binding: 'continuation-generation-ledger' as const,
      loadExisting: async () => null,
      reserve: jest.fn(),
      persistStageArtifact,
      persistStageFailure: jest.fn(),
      persistStageSkip,
    } as any;

    const results = await runWritingStages({
      frozenContext: kernelFreeze.frozenContext,
      trace: kernelFreeze.trace,
      stages: ['draft', 'review'],
      persistAdapter,
      callStage: callStage as any,
    });

    expect(results.map(result => result.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(persistStageSkip).not.toHaveBeenCalled();
    expect(persistStageArtifact).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Continuation durable ledger (real SQLite)
// ---------------------------------------------------------------------------

describe('One-Shot skip semantics: continuation durable ledger', () => {
  test('policy-skipped paid nodes settle as skipped with provenance; no queued-forever, no fake artifact', async () => {
    await resetDb();
    const kernelFreeze = oneShotContinuationFreeze();
    await execute(
      await openDatabase(),
      `INSERT INTO projects (id, name, mode, created_at, updated_at)
       VALUES (1, 'p', 'continuation', 't', 't')`,
    );
    await execute(
      await openDatabase(),
      `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (2, 1, 2, '第3章', '续写', '', 'draft', 't', 't')`,
    );
    await execute(
      await openDatabase(),
      `INSERT INTO llm_config
         (id, name, base_url, api_key, model_name, is_active, provider_type,
          context_window, max_output_tokens)
       VALUES (7, 'm', 'http://127.0.0.1:9/v1', 'k', 'mm', 1,
               'openai_compatible', 8000, 4000)`,
    );
    const run = await insertRun({
      id: 'ct_one_shot_skip_ledger',
      projectId: 1,
      chapterId: 2,
      targetPosition: 3 as any,
      sourceId: null,
      sourceSnapshotJson: '{}',
      canonSnapshotId: null,
      canonRevision: 1,
      storyMemoryFingerprint: 'fp',
      storyMemoryThroughPosition: 2,
      inputRevisionHash: 'hash',
      userInstruction: '续写本章',
      settingsSnapshotJson: '{}',
      contextSnapshotJson: null,
      contextTraceJson: null,
      tokenUsageJson: '{}',
      state: 'running',
      stage: 'round1',
      completionReason: null,
      adoptedRevisionHash: null,
      finalizedRevisionHash: null,
      errorCode: null,
      errorMessage: null,
    });
    const budget = {
      configId: 7,
      compiledPromptTokens: 100,
      minimumOutputTokens: 64,
      maximumOutputTokens: 1024,
    };
    await ensureContinuationV5StageResults({
      runId: run.id,
      stages: {
        draft_writer: budget,
        narrative_architect: budget,
        revision_writer: budget,
        adversarial_auditor: budget,
        // Phase 4 §7.2: legacy resume pre-creates the unified_qa ledger row
        // so the compact Standard path can find it after a topology flip.
        unified_qa: budget,
        final_reviser: budget,
      },
    });

    const persistAdapter = createContinuationDurableAdapter({
      run,
      snapshot: {
        stageBudgets: {
          draft_writer: budget,
          narrative_architect: budget,
          revision_writer: budget,
          adversarial_auditor: budget,
          unified_qa: budget,
          final_reviser: budget,
        },
      } as any,
    });
    const callStage = jest.fn(async () => ({
      text: '{"content":"极速续写正文。"}',
      inputTokens: 1,
      outputTokens: 1,
    }));

    for (const stages of [
      ['draft', 'review'],
      ['revision', 'audit', 'factCheck'],
      ['proof', 'finalValidate', 'persist'],
    ] as const) {
      await runWritingStages({
        frozenContext: kernelFreeze.frozenContext,
        trace: kernelFreeze.trace,
        stages: [...stages],
        persistAdapter,
        callStage: callStage as any,
        semanticApply: {
          beforeRevisionBody: '',
          finalBody: '极速续写正文。',
          appliedRequirementIds: [],
        },
      });
    }

    const ledger = await listStageResults(run.id);
    const byStage = new Map(
      ledger.map(row => [row.stage as string, row]),
    );

    // Draft executed: exactly one reserved request, settled as success.
    expect(byStage.get('draft_writer')).toMatchObject({
      status: 'success',
      requestCount: 1,
    });

    // Every policy-skipped paid node: skipped + provenance, ZERO requests.
    const expectedSkips: Record<string, string> = {
      narrative_architect: 'profile.one_shot.skip_review',
      revision_writer: 'profile.one_shot.skip_revision',
      adversarial_auditor: 'profile.one_shot.skip_audit',
      final_reviser: 'profile.one_shot.skip_proof',
    };
    for (const [node, policyRuleId] of Object.entries(expectedSkips)) {
      const row = byStage.get(node);
      expect(row).toBeTruthy();
      expect(row!.status).toBe('skipped');
      expect(row!.requestCount).toBe(0);
      expect(row!.requestReserved).toBeFalsy();
      const parsed = JSON.parse(row!.outputJson || '{}');
      expect(parsed.envelope).toMatchObject({
        skipped: true,
        policyRuleId,
      });
      expect(parsed.envelope.skipReason).toEqual(expect.any(String));
    }

    // No empty/fake artifact rows for skipped stages: only draft + final.
    const artifactStages = await all(
      `SELECT DISTINCT stage FROM continuation_generation_artifacts WHERE run_id = ?`,
      [run.id],
    );
    expect(artifactStages.map(row => String(row.stage)).sort()).toEqual([
      'draft',
      'final',
    ]);

    // Exactly one physical LLM call for the whole chapter.
    expect(callStage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Kernel trace events
// ---------------------------------------------------------------------------

describe('One-Shot skip semantics: kernel trace events', () => {
  function driverWithOutcomes(outcomes: any[]): WritingStageDriver {
    let i = 0;
    return {
      durableBinding: 'continuation-generation-ledger',
      step: async () => {
        if (i === 0) {
          i += 1;
          const freeze = oneShotContinuationFreeze();
          return { kind: 'freeze', ...freeze } as any;
        }
        if (i - 1 < outcomes.length) {
          const outcome = outcomes[i - 1];
          i += 1;
          return outcome;
        }
        return { kind: 'terminal', reason: 'completed' } as any;
      },
      finalize: async () => {},
    };
  }

  test('a skipped stage outcome lands in the trace with skipReason + policyRuleId', async () => {
    const result = await runWritingKernel({
      createDriver: async () =>
        driverWithOutcomes([
          {
            kind: 'stage',
            stage: 'draft',
            action: 'round1',
            status: 'completed',
          },
          {
            kind: 'stage',
            stage: 'review',
            action: 'round1',
            status: 'skipped',
            skipReason: 'One-Shot profile skips AI review',
            policyRuleId: 'profile.one_shot.skip_review',
          },
          {
            kind: 'stage',
            stage: 'revision',
            action: 'round2',
            status: 'skipped',
            skipReason: 'One-Shot profile skips AI revision',
            policyRuleId: 'profile.one_shot.skip_revision',
          },
        ]),
    });
    expect(result.terminal).toBe('completed');
    const events = result.trace!.events;
    const reviewEvent = events.find(
      event => event.stage === 'review' && event.status === 'skipped',
    );
    expect(reviewEvent).toMatchObject({
      stage: 'review',
      status: 'skipped',
      skipReason: 'One-Shot profile skips AI review',
      policyRuleId: 'profile.one_shot.skip_review',
    });
    const revisionEvent = events.find(
      event => event.stage === 'revision' && event.status === 'skipped',
    );
    expect(revisionEvent).toMatchObject({
      policyRuleId: 'profile.one_shot.skip_revision',
    });
    // Completed stages carry no skip provenance (standard behavior intact).
    const draftEvent = events.find(event => event.stage === 'draft');
    expect(draftEvent).toMatchObject({ status: 'completed' });
    expect(draftEvent!.skipReason).toBeUndefined();
    expect(draftEvent!.policyRuleId).toBeUndefined();
  });
});
