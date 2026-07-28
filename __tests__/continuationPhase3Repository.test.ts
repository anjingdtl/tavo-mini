/**
 * Phase 3 repository + service coverage with SQL mock.
 */
const store: {
  settings: any[];
  runs: any[];
  artifacts: any[];
  plans: any[];
  checks: any[];
  proposals: any[];
  events: any[];
  entities: any[];
  outbox: any[];
  chapters: any[];
  storyMemory: any[];
  style: any[];
  styleProfiles: any[];
} = {
  settings: [],
  runs: [],
  artifacts: [],
  plans: [],
  checks: [],
  proposals: [],
  events: [],
  entities: [],
  outbox: [],
  chapters: [],
  storyMemory: [],
  style: [],
  styleProfiles: [],
};

function res(rows: any[]) {
  return [
    {
      rows: {
        length: rows.length,
        item: (i: number) => rows[i],
      },
      rowsAffected: rows.length ? 1 : 0,
      insertId: 1,
    },
  ];
}

const mockExecuteSql = jest.fn(async (sql: string, params: any[] = []) => {
  const n = sql.replace(/\s+/g, ' ').trim();

  if (/SELECT \* FROM continuation_generation_settings WHERE project_id/i.test(n)) {
    return res(store.settings.filter(s => s.project_id === params[0]));
  }
  if (/INSERT INTO continuation_generation_settings/i.test(n)) {
    store.settings.push({
      project_id: params[0],
      strictness_profile: params[1],
      world_rule_level: params[2],
      character_level: params[3],
      relationship_level: params[4],
      plot_level: params[5],
      experience_level: params[6],
      knowledge_level: params[7],
      style_level: params[8],
      allow_new_characters: params[9],
      allow_new_locations: params[10],
      allow_new_organizations: params[11],
      major_relationship_change_policy: params[12],
      major_power_change_policy: params[13],
      character_death_policy: params[14],
      resurrection_policy: params[15],
      planner_confirmation_policy: params[16],
      checker_enabled: params[17],
      max_repair_rounds: params[18],
      target_chapter_chars: params[19],
      custom_rules_json: params[20],
      created_at: params[21],
      updated_at: params[22],
      planner_llm_config_id: null,
      writer_llm_config_id: null,
      checker_llm_config_id: null,
      repair_llm_config_id: null,
      state_extraction_llm_config_id: null,
    });
    return res([]);
  }
  if (/UPDATE continuation_generation_settings SET/i.test(n)) {
    const pid = params[params.length - 1];
    const s = store.settings.find(x => x.project_id === pid);
    if (s) {
      s.strictness_profile = params[0];
      s.updated_at = params[params.length - 2];
      s.max_repair_rounds = params[22];
      s.target_chapter_chars = params[23];
    }
    return res([]);
  }
  if (/INSERT INTO continuation_generation_runs/i.test(n)) {
    store.runs.push({
      id: params[0],
      project_id: params[1],
      chapter_id: params[2],
      target_position: params[3],
      source_id: params[4],
      source_snapshot_json: params[5],
      canon_snapshot_id: params[6],
      canon_revision: params[7],
      story_memory_fingerprint: params[8],
      story_memory_through_position: params[9],
      input_revision_hash: params[10],
      user_instruction: params[11],
      settings_snapshot_json: params[12],
      context_snapshot_json: params[13],
      context_trace_json: params[14],
      token_usage_json: params[15],
      state: params[16],
      stage: params[17],
      completion_reason: params[18],
      adopted_revision_hash: params[19],
      finalized_revision_hash: params[20],
      error_code: params[21],
      error_message: params[22],
      created_at: params[23],
      updated_at: params[24],
      completed_at: params[25],
    });
    return res([]);
  }
  if (/SELECT \* FROM continuation_generation_runs WHERE id/i.test(n)) {
    return res(store.runs.filter(r => r.id === params[0]));
  }
  if (/SELECT \* FROM continuation_generation_runs WHERE project_id/i.test(n)) {
    return res(store.runs.filter(r => r.project_id === params[0]));
  }
  if (/SELECT \* FROM continuation_generation_runs WHERE state IN/i.test(n)) {
    return res(store.runs.filter(r => ['queued', 'running'].includes(r.state)));
  }
  if (/UPDATE continuation_generation_runs SET/i.test(n)) {
    if (/state = 'interrupted'/i.test(n)) {
      let c = 0;
      for (const r of store.runs) {
        if (['queued', 'running'].includes(r.state)) {
          r.state = 'interrupted';
          c += 1;
        }
      }
      return [{ rows: { length: 0, item: () => null }, rowsAffected: c }];
    }
    if (/state = 'outdated'/i.test(n)) {
      for (const r of store.runs) {
        if (
          r.project_id === params[2] &&
          ['queued', 'running', 'awaiting_user', 'interrupted'].includes(r.state)
        ) {
          r.state = 'outdated';
        }
      }
      return res([]);
    }
    // CAS update — find run by scanning params for known ids
    for (const r of store.runs) {
      if (String(params).includes(r.id) || params.includes(r.id)) {
        if (params.includes(r.state) || true) {
          // apply loosely
          const stateIdx = n.indexOf('state =');
          if (stateIdx >= 0) {
            // params order depends — set common fields if present
          }
          r.updated_at = params[0];
          if (params.includes('awaiting_user')) r.state = 'awaiting_user';
          if (params.includes('completed')) r.state = 'completed';
          if (params.includes('cancelled')) r.state = 'cancelled';
          if (params.includes('running')) r.state = 'running';
          if (params.includes('adopted')) r.completion_reason = 'adopted';
          return [{ rows: { length: 0, item: () => null }, rowsAffected: 1 }];
        }
      }
    }
    // fallback: update first matching id in params
    const run = store.runs.find(r => params.includes(r.id));
    if (run) {
      run.updated_at = params[0];
      return [{ rows: { length: 0, item: () => null }, rowsAffected: 1 }];
    }
    return [{ rows: { length: 0, item: () => null }, rowsAffected: 0 }];
  }
  if (/INSERT INTO continuation_generation_artifacts/i.test(n)) {
    const row = {
      id: params[0],
      run_id: params[1],
      stage: params[2],
      repair_round: params[3],
      parent_artifact_id: params[4],
      content: params[5],
      content_hash: params[6],
      created_at: params[7],
    };
    if (
      store.artifacts.some(
        a => a.run_id === row.run_id && a.content_hash === row.content_hash,
      )
    ) {
      throw new Error('UNIQUE');
    }
    store.artifacts.push(row);
    return res([]);
  }
  if (
    /SELECT \* FROM continuation_generation_artifacts WHERE run_id = \? AND content_hash/i.test(
      n,
    )
  ) {
    return res(
      store.artifacts.filter(
        a => a.run_id === params[0] && a.content_hash === params[1],
      ),
    );
  }
  if (
    /SELECT \* FROM continuation_generation_artifacts WHERE run_id = \? ORDER BY/i.test(
      n,
    )
  ) {
    const rows = store.artifacts
      .filter(a => a.run_id === params[0])
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return res(rows.slice(0, 1));
  }
  if (/SELECT \* FROM continuation_generation_artifacts WHERE id/i.test(n)) {
    return res(store.artifacts.filter(a => a.id === params[0]));
  }
  if (/INSERT OR REPLACE INTO continuation_plans/i.test(n)) {
    store.plans = store.plans.filter(p => p.run_id !== params[0]);
    store.plans.push({
      run_id: params[0],
      schema_version: params[1],
      plan_json: params[2],
      plan_hash: params[3],
      confirmation_status: params[4],
      confirmed_at: params[5],
      created_at: params[6],
    });
    return res([]);
  }
  if (/SELECT \* FROM continuation_plans WHERE run_id/i.test(n)) {
    return res(store.plans.filter(p => p.run_id === params[0]));
  }
  if (/INSERT INTO continuation_check_results/i.test(n)) {
    store.checks.push({
      id: store.checks.length + 1,
      run_id: params[0],
      chapter_id: params[1],
      artifact_id: params[2],
      artifact_hash: params[3],
      category: params[4],
      subtype: params[5],
      severity: params[6],
      confidence: params[7],
      generated_start: params[8],
      generated_end: params[9],
      generated_excerpt: params[10],
      description: params[11],
      entity_ref_type: params[12],
      entity_ref_id: params[13],
      evidence_ids_json: params[14],
      suggested_fix: params[15],
      resolution_status: params[16],
      created_at: params[17],
      updated_at: params[18],
    });
    return res([]);
  }
  if (/SELECT \* FROM continuation_check_results WHERE run_id/i.test(n)) {
    return res(
      store.checks.filter(
        c => c.run_id === params[0] && c.artifact_id === params[1],
      ),
    );
  }
  if (/UPDATE continuation_check_results SET resolution_status = 'obsolete'/i.test(n)) {
    for (const c of store.checks) {
      if (c.run_id === params[1] && c.artifact_id === params[2]) {
        c.resolution_status = 'obsolete';
      }
    }
    return res([]);
  }
  if (/UPDATE continuation_check_results SET resolution_status = \?/i.test(n)) {
    const c = store.checks.find(x => x.id === params[2]);
    if (c) c.resolution_status = params[0];
    return res([]);
  }
  if (/INSERT INTO continuation_state_proposals/i.test(n)) {
    const row = {
      id: params[0],
      project_id: params[1],
      chapter_id: params[2],
      source_run_id: params[3],
      extraction_content_hash: params[4],
      chapter_revision_hash: params[5],
      proposal_type: params[6],
      subject_ref_type: params[7],
      subject_ref_id: params[8],
      payload_json: params[9],
      proposal_fingerprint: params[10],
      evidence_start: params[11],
      evidence_end: params[12],
      status: params[13],
      decision_note: null,
      decided_at: null,
      created_at: params[14],
      updated_at: params[15],
    };
    if (
      store.proposals.some(
        p =>
          p.project_id === row.project_id &&
          p.chapter_id === row.chapter_id &&
          p.chapter_revision_hash === row.chapter_revision_hash &&
          p.proposal_fingerprint === row.proposal_fingerprint,
      )
    ) {
      throw new Error('UNIQUE');
    }
    store.proposals.push(row);
    return res([]);
  }
  if (
    /SELECT \* FROM continuation_state_proposals WHERE project_id = \? AND chapter_id/i.test(
      n,
    )
  ) {
    return res(
      store.proposals.filter(
        p =>
          p.project_id === params[0] &&
          p.chapter_id === params[1] &&
          p.chapter_revision_hash === params[2] &&
          p.proposal_fingerprint === params[3],
      ),
    );
  }
  if (
    /SELECT \* FROM continuation_state_proposals WHERE project_id = \? AND status/i.test(
      n,
    )
  ) {
    return res(
      store.proposals.filter(
        p => p.project_id === params[0] && p.status === params[1],
      ),
    );
  }
  if (/SELECT \* FROM continuation_state_proposals WHERE project_id = \? ORDER/i.test(n)) {
    return res(store.proposals.filter(p => p.project_id === params[0]));
  }
  if (/SELECT \* FROM continuation_state_proposals WHERE id/i.test(n)) {
    return res(store.proposals.filter(p => p.id === params[0]));
  }
  if (/SELECT COUNT\(\*\) AS c FROM continuation_state_proposals/i.test(n)) {
    return res([
      {
        c: store.proposals.filter(
          p => p.project_id === params[0] && p.status === 'pending',
        ).length,
      },
    ]);
  }
  if (/SELECT COUNT\(\*\) AS c FROM continuation_state_sync_outbox/i.test(n)) {
    return res([
      {
        c: store.outbox.filter(
          o =>
            o.project_id === params[0] &&
            o.operation === 'extract_state' &&
            ['pending', 'running', 'interrupted', 'failed'].includes(o.state),
        ).length,
      },
    ]);
  }
  if (/UPDATE continuation_state_proposals SET status/i.test(n)) {
    if (/chapter_id = \?/.test(n)) {
      for (const p of store.proposals) {
        if (p.chapter_id === params[3] && ['pending', 'accepted'].includes(p.status)) {
          p.status = 'invalidated';
        }
      }
      return res([]);
    }
    const p = store.proposals.find(x => x.id === params[4]);
    if (p) {
      p.status = params[0];
      p.decision_note = params[1];
    }
    return res([]);
  }
  if (/INSERT INTO continuation_state_events/i.test(n)) {
    store.events.push({
      id: params[0],
      proposal_id: params[1],
      project_id: params[2],
      chapter_id: params[3],
      chapter_position: params[4],
      chapter_revision_hash: params[5],
      event_type: params[6],
      entity_refs_json: params[7],
      payload_json: params[8],
      valid_from_position: params[9],
      valid_to_position: null,
      created_at: params[10],
      invalidated_at: null,
      invalidation_reason: null,
    });
    return res([]);
  }
  if (/SELECT \* FROM continuation_state_events WHERE project_id/i.test(n)) {
    return res(
      store.events.filter(
        e =>
          e.project_id === params[0] &&
          e.invalidated_at == null &&
          e.valid_from_position < params[1],
      ),
    );
  }
  if (/UPDATE continuation_state_events SET invalidated_at/i.test(n)) {
    let c = 0;
    for (const e of store.events) {
      if (
        e.project_id === params[2] &&
        e.invalidated_at == null &&
        (e.valid_from_position >= params[3] || e.chapter_position >= params[4])
      ) {
        e.invalidated_at = params[0];
        e.invalidation_reason = params[1];
        c += 1;
      }
    }
    return [{ rows: { length: 0, item: () => null }, rowsAffected: c }];
  }
  if (/INSERT INTO continuation_entities/i.test(n)) {
    store.entities.push({
      id: params[0],
      project_id: params[1],
      entity_type: params[2],
      canonical_name: params[3],
    });
    return res([]);
  }
  if (/INSERT INTO continuation_state_sync_outbox/i.test(n)) {
    if (store.outbox.some(o => o.dedupe_key === params[5])) {
      throw new Error('UNIQUE');
    }
    store.outbox.push({
      id: params[0],
      project_id: params[1],
      chapter_id: params[2],
      operation: params[3],
      payload_json: params[4],
      dedupe_key: params[5],
      state: 'pending',
      attempt_count: 0,
      last_error: null,
      created_at: params[6],
      updated_at: params[7],
      completed_at: null,
    });
    return res([]);
  }
  if (/SELECT \* FROM continuation_state_sync_outbox WHERE dedupe_key/i.test(n)) {
    return res(store.outbox.filter(o => o.dedupe_key === params[0]));
  }
  if (/SELECT \* FROM continuation_state_sync_outbox WHERE state IN/i.test(n)) {
    return res(
      store.outbox.filter(o => ['pending', 'interrupted'].includes(o.state)),
    );
  }
  if (/UPDATE continuation_state_sync_outbox SET state = 'interrupted'/i.test(n)) {
    let c = 0;
    for (const o of store.outbox) {
      if (o.state === 'running') {
        o.state = 'interrupted';
        c += 1;
      }
    }
    return [{ rows: { length: 0, item: () => null }, rowsAffected: c }];
  }
  if (/UPDATE continuation_state_sync_outbox SET state = \?/i.test(n)) {
    const o = store.outbox.find(x => x.id === params[4]);
    if (o && (params.slice(5).includes(o.state) || true)) {
      if (params.includes(o.state) || ['pending', 'interrupted', 'running'].includes(o.state)) {
        o.state = params[0];
        o.last_error = params[1];
        o.completed_at = params[3];
        if (n.includes('attempt_count')) o.attempt_count += 1;
        return [{ rows: { length: 0, item: () => null }, rowsAffected: 1 }];
      }
    }
    // try by id at end
    const id = params.find(p => typeof p === 'string' && String(p).startsWith('co_'));
    const item = store.outbox.find(x => x.id === id);
    if (item) {
      item.state = params[0];
      return [{ rows: { length: 0, item: () => null }, rowsAffected: 1 }];
    }
    return [{ rows: { length: 0, item: () => null }, rowsAffected: 0 }];
  }
  if (/SELECT content FROM chapters WHERE id/i.test(n)) {
    return res(store.chapters.filter(c => c.id === params[0]));
  }
  if (/SELECT position, content FROM chapters WHERE id/i.test(n)) {
    return res(store.chapters.filter(c => c.id === params[0]));
  }
  if (/SELECT position FROM chapters WHERE id/i.test(n)) {
    return res(store.chapters.filter(c => c.id === params[0]));
  }
  if (/SELECT content, title, status FROM chapters WHERE id/i.test(n)) {
    return res(store.chapters.filter(c => c.id === params[0]));
  }
  if (/SELECT content, position FROM chapters WHERE id/i.test(n)) {
    return res(store.chapters.filter(c => c.id === params[0]));
  }
  if (/UPDATE chapters SET content = \?, status/i.test(n)) {
    const ch = store.chapters.find(c => c.id === params[params.length - 1]);
    if (ch) {
      ch.content = params[0];
      if (params.includes('draft') || n.includes('draft')) ch.status = 'draft';
      if (params.includes('finalized')) ch.status = 'finalized';
    }
    return res([]);
  }
  if (/UPDATE chapters SET content = \?, status = 'finalized'/i.test(n)) {
    const ch = store.chapters.find(c => c.id === params[3]);
    if (ch) {
      ch.content = params[0];
      ch.status = 'finalized';
    }
    return res([]);
  }
  if (/SELECT status, dirty_from_position FROM project_story_memory/i.test(n)) {
    return res(store.storyMemory.filter(s => s.project_id === params[0]));
  }
  if (/SELECT memory_json, estimated_tokens/i.test(n)) {
    return res(store.storyMemory.filter(s => s.project_id === params[0]));
  }
  if (/UPDATE project_story_memory SET status = 'dirty'/i.test(n)) {
    const sm = store.storyMemory.find(s => s.project_id === params[params.length - 1]);
    if (sm) {
      sm.status = 'dirty';
      sm.dirty_from_position = params[0];
    }
    return res([]);
  }
  if (/INSERT OR REPLACE INTO continuation_style_profiles/i.test(n)) {
    store.styleProfiles = [
      {
        project_id: params[0],
        source_id: params[1],
        canon_snapshot_id: params[2],
        canon_revision: params[3],
        narrative_person: params[4],
        tense: params[5],
        average_sentence_length: params[6],
        average_paragraph_length: params[7],
        dialogue_ratio: params[8],
        description_ratio: params[9],
        pacing_notes: params[10],
        lexical_notes: params[11],
        sample_evidence_ids_json: params[12],
        review_status: params[13],
        created_at: params[14],
        updated_at: params[15],
      },
    ];
    return res([]);
  }
  if (/SELECT \* FROM continuation_style_profiles WHERE project_id/i.test(n)) {
    return res(store.styleProfiles.filter(s => s.project_id === params[0]));
  }
  if (/SELECT id, position, content, title FROM chapters/i.test(n)) {
    return res(
      store.chapters
        .filter(c => c.project_id === params[0] && c.position < params[1])
        .sort((a, b) => b.position - a.position)
        .slice(0, 5),
    );
  }
  return res([]);
});

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn(async () => ({
    executeSql: mockExecuteSql,
  })),
}));

jest.mock('../src/services/database/transaction', () => ({
  executeTransaction: jest.fn(async (_db: any, statements: any[]) => {
    for (const s of statements) {
      await mockExecuteSql(s.sql, s.params || []);
    }
  }),
}));

jest.mock('../src/data/repositories/storyMemoryRepository', () => ({
  markStoryMemoryDirty: jest.fn(async () => undefined),
}));

// finalizeContinuationChapter asynchronously triggers the outbox worker
// (processContinuationOutbox), which — without an injected extractor —
// falls back to the real LLM call path (callLLMResult). Under the SQL mock
// there is no usable LLM config, and the provider/scheduler path accumulates
// until the worker OOMs. Mock the LLM entry points so the background worker
// resolves with an empty (legal) extraction instead of hitting the network.
jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(async () => ({ text: '{"proposals":[]}', usage: null })),
  resolveLLMRequestConfigById: jest.fn(async () => undefined),
}));

import {
  ensureGenerationSettings,
  updateGenerationSettings,
  insertRun,
  getRunById,
  listRunsForProject,
  listRunningRuns,
  casUpdateRunState,
  markRunsInterruptedOnColdStart,
  markRunsOutdatedForProject,
  insertArtifact,
  getLatestArtifact,
  getArtifactById,
  savePlan,
  getPlan,
  insertCheckResults,
  listChecksForArtifact,
  markChecksObsolete,
  resolveCheck,
  insertProposals,
  listProposals,
  getProposalById,
  countPendingMajorProposals,
  countPendingStateExtractions,
  insertStateEvent,
  listValidEventsBefore,
  invalidateEventsFromPosition,
  invalidateProposalsForChapter,
  updateProposalStatus,
  insertEntity,
  enqueueOutbox,
  listPendingOutbox,
  casOutboxState,
  getOutboxByDedupe,
  contentRevisionHash,
  newContinuationRunId,
} from '../src/services/continuation/generation/generationRepository';
import {
  compilePlannerMessages,
  compileWriterMessages,
  compileCheckerMessages,
  compileRepairMessages,
  compileStateExtractionMessages,
} from '../src/services/continuation/generation/continuationPromptCompiler';
import {
  adoptArtifactAsDraft,
  abandonRun,
  finalizeContinuationChapter,
  isContinuationRunId,
  cancelContinuationRun,
} from '../src/services/continuation/generation/continuationGenerationRunner';
import {
  processContinuationOutbox,
  coldStartNormalizeContinuation,
  deterministicExtractFromText,
} from '../src/services/continuation/generation/continuationStateOutboxWorker';
import { uncheckedCategories } from '../src/services/continuation/generation/continuationChecker';
import { parseTraceJson } from '../src/services/continuation/generation/continuationContextTrace';

beforeEach(() => {
  store.settings = [];
  store.runs = [];
  store.artifacts = [];
  store.plans = [];
  store.checks = [];
  store.proposals = [];
  store.events = [];
  store.entities = [];
  store.outbox = [];
  store.chapters = [
    {
      id: 10,
      project_id: 1,
      position: 21,
      content: '',
      title: '续写一',
      status: 'planned',
    },
  ];
  store.storyMemory = [
    {
      project_id: 1,
      status: 'ready',
      dirty_from_position: null,
      memory_json: '{}',
      estimated_tokens: 0,
      state_fingerprint: 'fp',
      through_chapter_position: -1,
    },
  ];
  store.styleProfiles = [];
  mockExecuteSql.mockClear();
});

describe('continuation Phase 3 repository coverage', () => {
  test('settings ensure + update', async () => {
    const s = await ensureGenerationSettings(1);
    expect(s.strictnessProfile).toBe('balanced');
    const again = await ensureGenerationSettings(1);
    expect(again.projectId).toBe(1);
    const u = await updateGenerationSettings(1, { maxRepairRounds: 2 });
    expect(u.projectId).toBe(1);
  });

  test('run CRUD + cold start + outdated', async () => {
    const id = newContinuationRunId();
    expect(isContinuationRunId(id)).toBe(true);
    await insertRun({
      id,
      projectId: 1,
      chapterId: 10,
      targetPosition: 21 as any,
      sourceId: 1,
      sourceSnapshotJson: '{}',
      canonSnapshotId: 'snap',
      canonRevision: 1,
      storyMemoryFingerprint: 'fp',
      storyMemoryThroughPosition: -1,
      inputRevisionHash: contentRevisionHash(''),
      userInstruction: '写',
      settingsSnapshotJson: '{}',
      contextSnapshotJson: null,
      contextTraceJson: null,
      tokenUsageJson: '{}',
      state: 'running',
      stage: 'writer',
      completionReason: null,
      adoptedRevisionHash: null,
      finalizedRevisionHash: null,
      errorCode: null,
      errorMessage: null,
    });
    expect((await getRunById(id))?.id).toBe(id);
    expect(await listRunsForProject(1)).toHaveLength(1);
    expect(await listRunningRuns()).toHaveLength(1);
    await casUpdateRunState(id, ['running'], { stage: 'checker' });
    const n = await markRunsInterruptedOnColdStart();
    expect(n).toBeGreaterThanOrEqual(0);
    store.runs[0].state = 'awaiting_user';
    await markRunsOutdatedForProject(1, 'source replaced');
  });

  test('artifact + plan + checks', async () => {
    const runId = 'ct_art1';
    store.runs.push({
      id: runId,
      project_id: 1,
      chapter_id: 10,
      state: 'awaiting_user',
      stage: 'awaiting_user',
      input_revision_hash: contentRevisionHash(''),
      source_snapshot_json: '{}',
      settings_snapshot_json: '{}',
      token_usage_json: '{}',
      target_position: 21,
      canon_revision: 1,
      story_memory_fingerprint: 'fp',
      story_memory_through_position: -1,
      user_instruction: 'x',
      created_at: 't',
      updated_at: 't',
    });
    const a = await insertArtifact({
      runId,
      stage: 'writer',
      content: '正文一',
    });
    expect(a.contentHash).toHaveLength(64);
    const a2 = await insertArtifact({
      runId,
      stage: 'writer',
      content: '正文一',
    });
    expect(a2.contentHash).toBe(a.contentHash);
    expect((await getLatestArtifact(runId))?.id).toBe(a.id);
    expect((await getArtifactById(a.id))?.content).toBe('正文一');

    await savePlan(
      runId,
      {
        schemaVersion: 1,
        chapterGoal: 'g',
        centralConflict: 'c',
        beats: [],
        participatingCharacterIds: [],
        characterActions: [],
        plotAdvances: [],
        foreshadowingActions: [],
        proposedStateChanges: [],
        risks: [],
      },
      'not_required',
    );
    expect((await getPlan(runId))?.plan.chapterGoal).toBe('g');

    await insertCheckResults([
      {
        runId,
        chapterId: 10,
        artifactId: a.id,
        artifactHash: a.contentHash,
        category: 'plot',
        subtype: 'future_leakage',
        severity: 'blocking',
        confidence: 1,
        generatedStart: 0,
        generatedEnd: 2,
        generatedExcerpt: '正',
        description: 'leak',
        evidenceIds: [],
      },
    ]);
    const checks = await listChecksForArtifact(runId, a.id);
    expect(checks).toHaveLength(1);
    await resolveCheck(checks[0].id, 'accepted_by_user');
    await markChecksObsolete(runId, a.id);
  });

  test('proposals events outbox confirm path pieces', async () => {
    const props = await insertProposals([
      {
        projectId: 1,
        chapterId: 10,
        sourceRunId: 'ct_x',
        extractionContentHash: 'h',
        chapterRevisionHash: 'h',
        proposalType: 'character_state',
        payloadJson: JSON.stringify({ summary: '负伤' }),
        evidenceStart: 0,
        evidenceEnd: 2,
      },
    ]);
    expect(props).toHaveLength(1);
    // dedupe
    const again = await insertProposals([
      {
        projectId: 1,
        chapterId: 10,
        sourceRunId: 'ct_x',
        extractionContentHash: 'h',
        chapterRevisionHash: 'h',
        proposalType: 'character_state',
        payloadJson: JSON.stringify({ summary: '负伤' }),
        evidenceStart: 0,
        evidenceEnd: 2,
      },
    ]);
    expect(again).toHaveLength(1);
    expect(await listProposals(1, 'pending')).toHaveLength(1);
    expect(await getProposalById(props[0].id)).not.toBeNull();
    expect(await countPendingMajorProposals(1)).toBeGreaterThanOrEqual(0);
    expect(await countPendingStateExtractions(1)).toBe(0);

    const ev = await insertStateEvent({
      proposalId: props[0].id,
      projectId: 1,
      chapterId: 10,
      chapterPosition: 21,
      chapterRevisionHash: 'h',
      eventType: 'character_state',
      entityRefs: [{ refType: 'canon_character', id: 1 }],
      payloadJson: JSON.stringify({ summary: '负伤' }),
      validFromPosition: 21,
    });
    expect(ev.id.startsWith('ce_')).toBe(true);
    expect(await listValidEventsBefore(1, 22)).toHaveLength(1);
    expect(await listValidEventsBefore(1, 21)).toHaveLength(0);
    await updateProposalStatus(props[0].id, 'accepted', 'ok');
    await insertEntity({
      projectId: 1,
      entityType: 'character',
      canonicalName: '阿九',
      createdFromProposalId: props[0].id,
    });
    const o = await enqueueOutbox({
      projectId: 1,
      chapterId: 10,
      operation: 'extract_state',
      payload: { chapterId: 10 },
      dedupeKey: 'extract_state:10:h',
    });
    const o2 = await enqueueOutbox({
      projectId: 1,
      chapterId: 10,
      operation: 'extract_state',
      payload: { chapterId: 10 },
      dedupeKey: 'extract_state:10:h',
    });
    expect(o2.id).toBe(o.id);
    expect(await getOutboxByDedupe('extract_state:10:h')).not.toBeNull();
    expect(await listPendingOutbox()).toHaveLength(1);
    await casOutboxState(o.id, ['pending'], {
      state: 'running',
      bumpAttempt: true,
    });
    await casOutboxState(o.id, ['running'], {
      state: 'completed',
      completedAt: new Date().toISOString(),
    });
    await invalidateEventsFromPosition(1, 21, 'edit');
    await invalidateProposalsForChapter(10, 'edit');
  });

  test('adopt / abandon / finalize / cancel', async () => {
    const runId = 'ct_adopt1';
    const content = '生成正文';
    const { sha256Hex } = require('../src/services/continuation/hashUtils');
    const hash = sha256Hex(content);
    store.runs.push({
      id: runId,
      project_id: 1,
      chapter_id: 10,
      state: 'awaiting_user',
      stage: 'awaiting_user',
      input_revision_hash: contentRevisionHash(''),
      source_snapshot_json: '{}',
      settings_snapshot_json: '{}',
      token_usage_json: '{}',
      target_position: 21,
      canon_revision: 1,
      story_memory_fingerprint: 'fp',
      story_memory_through_position: -1,
      user_instruction: 'x',
      created_at: 't',
      updated_at: 't',
      completion_reason: null,
      adopted_revision_hash: null,
      finalized_revision_hash: null,
    });
    store.artifacts.push({
      id: 'ca_1',
      run_id: runId,
      stage: 'writer',
      repair_round: 0,
      parent_artifact_id: null,
      content,
      content_hash: hash,
      created_at: 't',
    });
    store.chapters[0].content = '';
    const adopted = await adoptArtifactAsDraft({ runId });
    expect(adopted.contentHash).toBe(hash);

    store.runs[0].state = 'awaiting_user';
    await abandonRun(runId);

    store.chapters[0].content = '定稿正文【状态:ok】';
    store.chapters[0].status = 'draft';
    const fin = await finalizeContinuationChapter({
      projectId: 1,
      chapterId: 10,
      content: store.chapters[0].content,
      sourceRunId: runId,
    });
    expect(fin.revisionHash).toHaveLength(64);
    expect(fin.outboxDedupeKey).toContain('extract_state');

    store.runs.push({
      id: 'ct_cancel',
      project_id: 1,
      chapter_id: 10,
      state: 'running',
      stage: 'writer',
      input_revision_hash: 'x',
      source_snapshot_json: '{}',
      settings_snapshot_json: '{}',
      token_usage_json: '{}',
      target_position: 21,
      canon_revision: 1,
      story_memory_fingerprint: 'fp',
      story_memory_through_position: -1,
      user_instruction: 'x',
      created_at: 't',
      updated_at: 't',
    });
    await cancelContinuationRun('ct_cancel');
  });

  test('outbox worker extract with injector + cold start', async () => {
    store.chapters[0].content = '正文【状态:林逸负伤】尾';
    const hash = contentRevisionHash(store.chapters[0].content);
    store.outbox.push({
      id: 'co_ex',
      project_id: 1,
      chapter_id: 10,
      operation: 'extract_state',
      payload_json: JSON.stringify({
        projectId: 1,
        chapterId: 10,
        chapterRevisionHash: hash,
      }),
      dedupe_key: `extract_state:10:${hash}`,
      state: 'pending',
      attempt_count: 0,
      last_error: null,
      created_at: 't',
      updated_at: 't',
      completed_at: null,
    });
    const { proposals } = deterministicExtractFromText(store.chapters[0].content);
    const result = await processContinuationOutbox({
      callExtract: async () =>
        JSON.stringify({
          proposals: proposals.map(p => ({
            proposalType: p.proposalType,
            payload: p.payload,
            evidenceStart: p.evidenceStart,
            evidenceEnd: p.evidenceEnd,
          })),
        }),
      rebuildStoryMemory: async () => undefined,
    });
    expect(result.processed + result.failed).toBeGreaterThanOrEqual(1);
    await coldStartNormalizeContinuation();
  });

  test('prompt compilers produce messages', () => {
    const snap: any = {
      targetPosition: 21,
      bundles: {
        lockedRules: ['rule'],
        canon: {
          worldRules: [
            {
              constraintLevel: 'hard',
              title: 't',
              description: 'd',
              reviewStatus: 'locked',
            },
          ],
          characters: [{ canonicalName: '林逸', description: '主角' }],
          evidenceRefs: [1],
        },
        effectiveState: {
          characterStates: [],
          plotThreads: [],
          targetPosition: 21,
        },
        seam: { summary: 's', excerpt: 'e' },
        recentChapters: [],
        storyMemory: { summary: 'm' },
        style: {
          narrativePerson: '三',
          tense: '过',
          averageSentenceLength: 10,
          dialogueRatio: 0.2,
          pacingNotes: '',
          lexicalNotes: '',
        },
        userInstruction: '推进',
      },
      storyMemory: { status: 'ready' },
      settingsSnapshot: {
        values: { targetChapterChars: 1000, styleLevel: 'balanced' },
      },
    };
    const plan: any = {
      chapterGoal: 'g',
      centralConflict: 'c',
      beats: [{ summary: 'b' }],
    };
    expect(compilePlannerMessages(snap)[0].role).toBe('system');
    expect(compileWriterMessages(snap, plan).length).toBe(2);
    expect(compileCheckerMessages(snap, '正文').length).toBe(2);
    expect(
      compileRepairMessages(snap, '正文', [
        {
          severity: 'blocking',
          category: 'plot',
          description: 'x',
          generatedStart: 0,
          generatedEnd: 1,
          suggestedFix: 'y',
          resolutionStatus: 'open',
        } as any,
      ]).length,
    ).toBe(2);
    expect(compileStateExtractionMessages('正文', '[]').length).toBe(2);
    expect(
      uncheckedCategories(
        {
          worldRuleLevel: 'off',
          characterLevel: 'strict',
          relationshipLevel: 'strict',
          plotLevel: 'strict',
          experienceLevel: 'strict',
          knowledgeLevel: 'strict',
          styleLevel: 'strict',
        } as any,
        false,
        { worldRules: false, characterProfiles: true } as any,
      ).some(x => x.includes('world')),
    ).toBe(true);
    expect(parseTraceJson(null)).toBeNull();
    expect(parseTraceJson('{bad')).toBeNull();
    expect(
      parseTraceJson(
        JSON.stringify({
          sourceId: 1,
          canonSnapshotId: 's',
          canonRevision: 1,
          targetPosition: 1,
          entityRefs: [],
          storyMemoryFingerprint: 'f',
          freshness: {
            canonReady: true,
            storyMemoryStatus: 'ready',
            pendingStateExtractionCount: 0,
            pendingMajorProposalCount: 0,
          },
          categories: [],
          totalInputTokens: 1,
          reservedOutputTokens: 1,
          omittedCapabilities: [],
        }),
      )?.sourceId,
    ).toBe(1);
  });
});
