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
  ctSettings: any[]; // continuation_settings (active source/canon)
  canonSnapshots: any[];
  contentRevisions: any[];
  sqlLog: Array<{ sql: string; params: any[] }>;
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
  ctSettings: [],
  canonSnapshots: [],
  contentRevisions: [],
  sqlLog: [],
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

  if (/UPDATE continuation_generation_runs SET/i.test(n)) {
    store.sqlLog.push({ sql: n, params });
  }

  if (
    /SELECT \* FROM continuation_generation_settings WHERE project_id/i.test(n)
  ) {
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
  if (/FROM continuation_generation_runs WHERE id/i.test(n)) {
    if (/SELECT length\(context_snapshot_json\)/i.test(n)) {
      const row = store.runs.find(r => r.id === params[0]);
      return res(
        row ? [{ len: String(row.context_snapshot_json ?? '').length }] : [],
      );
    }
    if (/SELECT substr\(context_snapshot_json/i.test(n)) {
      const row = store.runs.find(r => r.id === params[2]);
      const body = String(row?.context_snapshot_json ?? '');
      return res([{ piece: body.substr(Number(params[0]) - 1, Number(params[1])) }]);
    }
    if (/^SELECT json_extract\(context_snapshot_json/i.test(n)) {
      const row = store.runs.find(r => r.id === params[0]);
      let workflowVersion: number | null = null;
      try {
        workflowVersion = JSON.parse(row?.context_snapshot_json ?? '{}')
          ?.workflowVersion;
      } catch {
        workflowVersion = null;
      }
      return res([{ workflow_version: workflowVersion, tid: null, fallback: null }]);
    }
    return res(store.runs.filter(r => r.id === params[0]));
  }
  if (
    /FROM continuation_generation_runs WHERE project_id = \? AND chapter_id = \?/i.test(
      n,
    )
  ) {
    return res(
      store.runs
        .filter(
          r =>
            r.project_id === params[0] &&
            r.chapter_id === params[1] &&
            r.state === 'completed' &&
            r.completion_reason === 'adopted',
        )
        .sort(
          (a, b) =>
            String(b.completed_at ?? '').localeCompare(
              String(a.completed_at ?? ''),
            ) ||
            String(b.created_at ?? '').localeCompare(
              String(a.created_at ?? ''),
            ),
        )
        .slice(0, 1),
    );
  }
  if (/FROM continuation_generation_runs WHERE project_id/i.test(n)) {
    return res(store.runs.filter(r => r.project_id === params[0]));
  }
  if (/FROM continuation_generation_runs WHERE state IN/i.test(n)) {
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
          ['queued', 'running', 'awaiting_user', 'interrupted'].includes(
            r.state,
          )
        ) {
          r.state = 'outdated';
        }
      }
      return res([]);
    }
    // CAS update — find run by scanning params for known ids.
    // params layout: [updated_at(nowIso), <SET values...>, runId, ...expectedStates]
    // The TARGET state is the SET value bound right after updated_at (params[1]
    // when state is set). The expected states are the trailing WHERE-IN values.
    // We must read the target from the SET position, not scan all params (which
    // would conflate target + expected and mis-apply transitions like failed).
    for (const r of store.runs) {
      if (String(params).includes(r.id) || params.includes(r.id)) {
        // Parse the SET clause to map each assignment to its value. Supports
        // both bind params (`col = ?`) and SQL literals (`col = 'completed'`),
        // since adopt/finalize use literals while casUpdateRunState uses binds.
        const setMatch = n.match(/SET (.+?) WHERE /i);
        if (setMatch) {
          const setClause = setMatch[1];
          let paramIdx = 0;
          const assignRegex = /(\w+)\s*=\s*(\?|'[^']*')/g;
          let am: RegExpExecArray | null;
          while ((am = assignRegex.exec(setClause)) !== null) {
            const col = am[1];
            const isLiteral = am[2] !== '?';
            const val = isLiteral ? am[2].slice(1, -1) : params[paramIdx];
            if (am[2] === '?') paramIdx += 1;
            if (val === undefined) continue;
            switch (col) {
              case 'updated_at':
                r.updated_at = val;
                break;
              case 'state':
                if (typeof val === 'string') r.state = val;
                break;
              case 'stage':
                if (typeof val === 'string') r.stage = val;
                break;
              case 'error_code':
                r.error_code = val;
                break;
              case 'error_message':
                r.error_message = val;
                break;
              case 'completion_reason':
                r.completion_reason = val;
                break;
              case 'completed_at':
                r.completed_at = val;
                break;
              case 'finalized_revision_hash':
                r.finalized_revision_hash = val;
                break;
              case 'adopted_revision_hash':
                r.adopted_revision_hash = val;
                break;
              default:
                break;
            }
          }
        } else {
          r.updated_at = params[0];
        }
        return [{ rows: { length: 0, item: () => null }, rowsAffected: 1 }];
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
      eligibility_status: params[7],
      rejection_code: params[8],
      created_at: params[9],
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
  // P2: getArtifactForRun matches BOTH id AND run_id (ownership check)
  if (
    /SELECT \* FROM continuation_generation_artifacts WHERE id = \? AND run_id = \?/i.test(
      n,
    )
  ) {
    return res(
      store.artifacts.filter(a => a.id === params[0] && a.run_id === params[1]),
    );
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
  if (
    /UPDATE continuation_check_results SET resolution_status = 'obsolete'/i.test(
      n,
    )
  ) {
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
  // H8-Generation: INSERT OR IGNORE INTO continuation_state_proposals
  if (
    /INSERT(?:\s+OR\s+IGNORE)?\s+INTO continuation_state_proposals/i.test(n)
  ) {
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
      // INSERT OR IGNORE: UNIQUE 冲突时静默跳过，不抛错。
      return res([]);
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
  if (
    /SELECT \* FROM continuation_state_proposals WHERE project_id = \? ORDER/i.test(
      n,
    )
  ) {
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
  if (
    /SELECT COUNT\(\*\) AS c.*FROM continuation_state_sync_outbox WHERE project_id/i.test(
      n,
    )
  ) {
    // getOutboxSummary: pending/failed counts plus latest failure timestamp.
    let rows = store.outbox.filter(o => o.project_id === params[0]);
    if (/state IN/i.test(n)) {
      const states = /'pending', 'interrupted', 'running'/.test(n)
        ? ['pending', 'interrupted', 'running']
        : ['failed'];
      rows = rows.filter(o => states.includes(o.state));
    } else if (/state = 'failed'/.test(n)) {
      rows = rows.filter(o => o.state === 'failed');
    }
    const latest = rows.length
      ? rows.slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0]
          .updated_at
      : null;
    return res([{ c: rows.length, latest }]);
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
        if (
          p.chapter_id === params[3] &&
          ['pending', 'accepted'].includes(p.status)
        ) {
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
  if (
    /INSERT(?:\s+OR\s+IGNORE)?\s+INTO continuation_state_sync_outbox/i.test(n)
  ) {
    // INSERT OR IGNORE emulates the real UNIQUE(dedupe_key) constraint: a
    // second enqueue with the same dedupe key is a no-op (rowsAffected 0)
    // rather than a throw, so the repository's dedupe path returns the
    // existing row. A genuine insert reports rowsAffected 1.
    if (store.outbox.some(o => o.dedupe_key === params[5])) {
      return [
        { rows: { length: 0, item: () => null }, rowsAffected: 0, insertId: 0 },
      ];
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
    return [
      { rows: { length: 0, item: () => null }, rowsAffected: 1, insertId: 1 },
    ];
  }
  if (
    /SELECT \* FROM continuation_state_sync_outbox WHERE dedupe_key/i.test(n)
  ) {
    return res(store.outbox.filter(o => o.dedupe_key === params[0]));
  }
  if (/SELECT \* FROM continuation_state_sync_outbox WHERE id = \?/i.test(n)) {
    return res(store.outbox.filter(o => o.id === params[0]));
  }
  if (
    /SELECT \* FROM continuation_state_sync_outbox WHERE project_id/i.test(n)
  ) {
    let rows = store.outbox.filter(o => o.project_id === params[0]);
    if (/state = \?/i.test(n)) {
      rows = rows.filter(o => o.state === params[1]);
    }
    return res(rows);
  }
  if (
    /SELECT last_error, dedupe_key FROM continuation_state_sync_outbox/i.test(n)
  ) {
    const rows = store.outbox
      .filter(
        o =>
          o.project_id === params[0] &&
          o.state === 'failed' &&
          o.updated_at === params[1],
      )
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return res(rows);
  }
  if (
    /UPDATE continuation_state_sync_outbox\s+SET state = 'pending', (attempt_count = 0, )?last_error = NULL/i.test(
      n,
    )
  ) {
    // retryContinuationOutbox / retryFailedContinuationOutbox
    let affected = 0;
    for (const o of store.outbox) {
      const matchesProject =
        o.project_id === params[1] || String(params).includes(o.id);
      const eligible = ['failed', 'interrupted'].includes(o.state);
      if (matchesProject && eligible) {
        o.state = 'pending';
        if (/attempt_count = 0/i.test(n)) o.attempt_count = 0;
        o.last_error = null;
        affected += 1;
      }
    }
    return [{ rows: { length: 0, item: () => null }, rowsAffected: affected }];
  }
  if (/SELECT \* FROM continuation_state_sync_outbox WHERE state IN/i.test(n)) {
    return res(
      store.outbox.filter(o => ['pending', 'interrupted'].includes(o.state)),
    );
  }
  if (
    /UPDATE continuation_state_sync_outbox SET state = 'interrupted'/i.test(n)
  ) {
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
      if (
        params.includes(o.state) ||
        ['pending', 'interrupted', 'running'].includes(o.state)
      ) {
        o.state = params[0];
        o.last_error = params[1];
        o.completed_at = params[3];
        if (n.includes('attempt_count')) o.attempt_count += 1;
        return [{ rows: { length: 0, item: () => null }, rowsAffected: 1 }];
      }
    }
    // try by id at end
    const id = params.find(
      p => typeof p === 'string' && String(p).startsWith('co_'),
    );
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
  // P2: adopt reads content + title + status + updated_at for optimistic locking
  if (
    /SELECT content, title, status, updated_at FROM chapters WHERE id/i.test(n)
  ) {
    return res(store.chapters.filter(c => c.id === params[0]));
  }
  if (/SELECT content, position FROM chapters WHERE id/i.test(n)) {
    return res(store.chapters.filter(c => c.id === params[0]));
  }
  // P1-E: continuation_settings (active source / canon) for context-freshness checks
  if (
    /SELECT active_source_id, active_canon_snapshot_id FROM continuation_settings WHERE project_id/i.test(
      n,
    )
  ) {
    return res(store.ctSettings.filter(s => s.project_id === params[0]));
  }
  // P1-E: continuation_canon_snapshots revision lookup
  if (/SELECT revision FROM continuation_canon_snapshots WHERE id/i.test(n)) {
    return res(store.canonSnapshots.filter(s => s.id === params[0]));
  }
  // P1-E: content_revisions insert (before_pipeline_accept snapshot on adopt)
  if (/INSERT INTO content_revisions/i.test(n)) {
    store.contentRevisions.push({
      project_id: params[0],
      target_id: params[2],
      title: params[3],
      content: params[4],
      source: params[5],
      source_ref: params[6],
      created_at: params[7],
    });
    return res([]);
  }
  if (/UPDATE chapters SET content = \?, status/i.test(n)) {
    // Fix-plan §7.3: the adopt UPDATE carries `WHERE id = ? AND updated_at = ?`
    // for optimistic concurrency. Detect the extra predicate and apply it.
    const hasOptimisticLock = /AND updated_at = \?/i.test(n);
    let ch: any;
    let rowsAffected = 0;
    if (hasOptimisticLock) {
      // params: [content, ts, chapterId, expectedUpdatedAt]
      const chapterId = params[params.length - 2];
      const expectedUpdatedAt = params[params.length - 1];
      ch = store.chapters.find(c => c.id === chapterId);
      if (ch && String(ch.updated_at ?? '') === String(expectedUpdatedAt)) {
        ch.content = params[0];
        if (n.includes("'finalized'")) ch.status = 'finalized';
        else if (n.includes("'draft'")) ch.status = 'draft';
        ch.updated_at = params[1];
        rowsAffected = 1;
      }
      // mismatch → 0 rows affected (concurrent edit)
      return [
        { rows: { length: 0, item: () => null }, rowsAffected, insertId: 0 },
      ];
    }
    ch = store.chapters.find(c => c.id === params[params.length - 1]);
    if (ch) {
      ch.content = params[0];
      if (n.includes("'finalized'")) ch.status = 'finalized';
      else if (n.includes("'draft'")) ch.status = 'draft';
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
    const sm = store.storyMemory.find(
      s => s.project_id === params[params.length - 1],
    );
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
  // Emulate SQLite transaction atomicity: snapshot the in-memory store before
  // the batch, run each statement, and on any throw restore the snapshot so a
  // failed multi-statement commit leaves no partial writes. This lets the
  // fix-plan §2 rollback assertion observe true all-or-nothing semantics.
  // Supports the onStatementComplete callback for optimistic-concurrency
  // rows-affected accounting (fix-plan §7).
  executeTransaction: jest.fn(
    async (_db: any, statements: any[], options: any = {}) => {
      const snapshot = JSON.parse(JSON.stringify(store));
      try {
        for (let i = 0; i < statements.length; i++) {
          const s = statements[i];
          const result: any = await mockExecuteSql(s.sql, s.params || []);
          if (options.onStatementComplete && result && result[0]) {
            options.onStatementComplete(i + 1, result[0].rowsAffected ?? 0);
          }
        }
      } catch (e) {
        Object.assign(store, JSON.parse(JSON.stringify(snapshot)));
        throw e;
      }
    },
  ),
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
  callLLMResult: jest.fn(async () => ({
    text: '{"proposals":[]}',
    usage: null,
  })),
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
  getArtifactForRun,
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
  retryContinuationOutbox,
  retryFailedContinuationOutbox,
  getOutboxSummary,
  getOutboxById,
  listOutboxForProject,
  MAX_OUTBOX_AUTO_RETRY_ATTEMPTS,
  contentRevisionHash,
  newContinuationRunId,
} from '../src/services/continuation/generation/generationRepository';
import {
  compilePlannerMessages,
  compileWriterMessages,
  compileCheckerMessages,
  compileRepairMessages,
  compileStateExtractionMessages,
} from '../src/services/continuation/generation/legacy/continuationPromptCompiler';
import {
  adoptArtifactAsDraft,
  abandonRun,
  finalizeContinuationChapter,
  isContinuationRunId,
  cancelContinuationRun,
  resumeInterruptedRun,
  confirmPlanAndContinue,
} from '../src/services/continuation/generation/legacy/continuationGenerationRunner';
import { ContinuationOutdatedError } from '../src/services/continuation/generation/types';
import {
  processContinuationOutbox,
  coldStartNormalizeContinuation,
  deterministicExtractFromText,
} from '../src/services/continuation/generation/continuationStateOutboxWorker';
import { confirmProposal } from '../src/services/continuation/generation/continuationStateService';
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
  store.sqlLog = [];
  store.chapters = [
    {
      id: 10,
      project_id: 1,
      position: 21,
      content: '',
      title: '续写一',
      status: 'planned',
      updated_at: 't0',
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
  store.ctSettings = [];
  store.canonSnapshots = [];
  store.contentRevisions = [];
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

    // Regression: revision_1 must get its own artifact even when V2 content
    // hashes collide with the draft. Without requireStageMatch the insert
    // silently returns the draft row, collapsing V1→V2→C2→V3 into V1-only.
    const draftArtifact = await insertArtifact({
      runId,
      stage: 'draft',
      content: '完全相同的 V2 正文。',
    });
    const revisionArtifact = await insertArtifact({
      runId,
      stage: 'revision_1',
      content: '完全相同的 V2 正文。',
      requireStageMatch: true,
    });
    expect(revisionArtifact.id).not.toBe(draftArtifact.id);
    expect(revisionArtifact.stage).toBe('revision_1');
    expect(revisionArtifact.contentHash).not.toBe(draftArtifact.contentHash);
    // The revision_1 row must be independently retrievable by id, with the
    // correct stage and a distinct body from the draft.
    const fetched = await getArtifactById(revisionArtifact.id);
    expect(fetched?.stage).toBe('revision_1');
    expect(fetched?.id).toBe(revisionArtifact.id);

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

  test('confirming a later proposal still enqueues Story Memory rebuild after an older rebuild completed', async () => {
    const props = await insertProposals([
      {
        projectId: 1,
        chapterId: 10,
        sourceRunId: 'ct_bulk',
        extractionContentHash: 'h',
        chapterRevisionHash: 'h',
        proposalType: 'character_state',
        payloadJson: JSON.stringify({ summary: '状态一' }),
        evidenceStart: 0,
        evidenceEnd: 2,
      },
      {
        projectId: 1,
        chapterId: 10,
        sourceRunId: 'ct_bulk',
        extractionContentHash: 'h',
        chapterRevisionHash: 'h',
        proposalType: 'plot_advance',
        payloadJson: JSON.stringify({ summary: '推进二' }),
        evidenceStart: 3,
        evidenceEnd: 5,
      },
    ]);
    expect(props).toHaveLength(2);

    await confirmProposal({ proposalId: props[0].id, processOutbox: false });
    const firstRebuild = store.outbox.find(
      o => o.operation === 'rebuild_story_memory',
    );
    expect(firstRebuild).toBeDefined();
    firstRebuild!.state = 'completed';

    await confirmProposal({ proposalId: props[1].id, processOutbox: false });

    // A completed rebuild for the same chapter/revision must not absorb the
    // second accepted event. Each event needs a durable rebuild task so the
    // memory cannot remain dirty with an all-completed outbox.
    expect(
      store.outbox.filter(o => o.operation === 'rebuild_story_memory'),
    ).toHaveLength(2);
    expect(store.storyMemory[0].status).toBe('dirty');
    expect(
      store.outbox.filter(
        o => o.operation === 'rebuild_story_memory' && o.state !== 'completed',
      ),
    ).toHaveLength(1);
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

  test('abandonRun can clear a failed run (result screen renders 放弃 for failed)', async () => {
    const runId = 'ct_failed_abandon';
    store.runs.push({
      id: runId,
      project_id: 1,
      chapter_id: 10,
      state: 'failed',
      stage: 'awaiting_user',
      input_revision_hash: 'x',
      source_snapshot_json: '{}',
      settings_snapshot_json: '{}',
      token_usage_json: '{}',
      target_position: 21,
      canon_revision: 1,
      story_memory_fingerprint: 'fp',
      story_memory_through_position: -1,
      user_instruction: '',
      created_at: 't',
      updated_at: 't',
      completion_reason: null,
      adopted_revision_hash: null,
      finalized_revision_hash: null,
      error_code: 'network_error',
      error_message: 'Network request failed',
    });

    await expect(abandonRun(runId)).resolves.toBeUndefined();

    const run = store.runs.find(r => r.id === runId);
    expect(run?.state).toBe('completed');
    expect(run?.completion_reason).toBe('abandoned');

    // The mock applies SET unconditionally, so the real regression guard is
    // the CAS contract itself: the WHERE state IN list must accept 'failed'
    // as a source state, otherwise the real DB returns rowsAffected=0 and
    // abandonRun throws '无法放弃该 run' (UI dead-end on failed results).
    const cas = store.sqlLog.find(
      e =>
        /UPDATE continuation_generation_runs SET/i.test(e.sql) &&
        e.params.includes(runId),
    );
    expect(cas).toBeTruthy();
    const expectedStates = cas!.params.slice(cas!.params.indexOf(runId) + 1);
    expect(expectedStates).toContain('failed');

    // Abandoning an already-completed run stays idempotent (no throw).
    await expect(abandonRun(runId)).resolves.toBeUndefined();
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
    const { proposals } = deterministicExtractFromText(
      store.chapters[0].content,
    );
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

  test('dependent memory rebuild waits for extraction, then runs in order', async () => {
    store.chapters[0].content = '有状态的定稿正文';
    const hash = contentRevisionHash(store.chapters[0].content);
    store.outbox.push(
      {
        id: 'co_dep_extract',
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
        created_at: 't1',
        updated_at: 't1',
        completed_at: null,
      },
      {
        id: 'co_dep_rebuild',
        project_id: 1,
        chapter_id: 10,
        operation: 'rebuild_story_memory',
        payload_json: JSON.stringify({
          fromPosition: 21,
          dependsOnDedupeKey: `extract_state:10:${hash}`,
        }),
        dedupe_key: `rebuild_story_memory:1:21:${hash}`,
        state: 'pending',
        attempt_count: 0,
        last_error: null,
        created_at: 't2',
        updated_at: 't2',
        completed_at: null,
      },
    );
    const rebuilt: number[] = [];
    const result = await processContinuationOutbox({
      limit: 2,
      callExtract: async () => JSON.stringify({ proposals: [] }),
      rebuildStoryMemory: async (_projectId, fromPosition) => {
        rebuilt.push(fromPosition);
      },
    });
    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(rebuilt).toEqual([21]);
    expect((await getOutboxById('co_dep_rebuild'))!.state).toBe('completed');
  });

  // ---- P1-A: finalize atomicity / idempotency / frozen config (fix-plan §2, §5.1) ----
  describe('finalize atomic transaction + outbox idempotency', () => {
    const frozenRun = (overrides: Partial<any> = {}) => ({
      id: 'ct_fin1',
      project_id: 1,
      chapter_id: 10,
      state: 'awaiting_user',
      stage: 'awaiting_user',
      input_revision_hash: contentRevisionHash(''),
      source_snapshot_json: '{}',
      // Fix-plan §5.1: authoritative frozen field is resolvedModelConfigIds.
      settings_snapshot_json: JSON.stringify({
        resolvedModelConfigIds: { stateExtraction: 77 },
      }),
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
      ...overrides,
    });

    test('finalize commits chapter + SM dirty + run linkage + outbox in one tx', async () => {
      store.runs.push(frozenRun());
      store.chapters[0].content = '定稿正文A';
      store.chapters[0].status = 'draft';

      const fin = await finalizeContinuationChapter({
        projectId: 1,
        chapterId: 10,
        content: '定稿正文A',
        sourceRunId: 'ct_fin1',
      });

      // Chapter finalized
      expect(store.chapters[0].status).toBe('finalized');
      // Story Memory marked dirty from the chapter position
      expect(store.storyMemory[0].status).toBe('dirty');
      expect(store.storyMemory[0].dirty_from_position).toBe(21);
      // Exactly one extract_state outbox row, keyed by the new hash
      const extractRows = store.outbox.filter(
        o => o.operation === 'extract_state',
      );
      expect(extractRows).toHaveLength(1);
      expect(extractRows[0].dedupe_key).toBe(fin.outboxDedupeKey);
      const payload = JSON.parse(extractRows[0].payload_json);
      // Fix-plan §5.1: frozen stateExtraction config id captured from the
      // resolvedModelConfigIds snapshot, not the legacy resolvedLlmConfigIds.
      expect(payload.llmConfigId).toBe(77);
      // Story Memory reflects finalized prose and therefore is not held back
      // by Canon proposal review; it runs only after extraction completes.
      const rebuildRows = store.outbox.filter(
        o => o.operation === 'rebuild_story_memory',
      );
      expect(rebuildRows).toHaveLength(1);
      expect(JSON.parse(rebuildRows[0].payload_json).dependsOnDedupeKey).toBe(
        fin.outboxDedupeKey,
      );
    });

    test('re-finalizing the same chapter content is idempotent (one outbox)', async () => {
      store.runs.push(frozenRun());
      store.chapters[0].content = '定稿正文B';
      await finalizeContinuationChapter({
        projectId: 1,
        chapterId: 10,
        content: '定稿正文B',
        sourceRunId: 'ct_fin1',
      });
      await finalizeContinuationChapter({
        projectId: 1,
        chapterId: 10,
        content: '定稿正文B',
        sourceRunId: 'ct_fin1',
      });
      const extractRows = store.outbox.filter(
        o => o.operation === 'extract_state',
      );
      expect(extractRows).toHaveLength(1);
    });

    test('outbox insert failure rolls back chapter + SM dirty + run linkage', async () => {
      store.runs.push(frozenRun());
      store.chapters[0].content = '定稿正文C';
      store.chapters[0].status = 'draft';
      store.storyMemory[0].status = 'ready';
      store.storyMemory[0].dirty_from_position = null;

      // Inject a failure when the transaction tries to INSERT the outbox row.
      const original = mockExecuteSql.getMockImplementation();
      mockExecuteSql.mockImplementation(
        async (sql: string, params: any[] = []) => {
          if (
            /INSERT(?:\s+OR\s+IGNORE)?\s+INTO continuation_state_sync_outbox/i.test(
              sql,
            )
          ) {
            throw new Error('FAULT_INJECTION: outbox insert');
          }
          return original!(sql, params);
        },
      );

      await expect(
        finalizeContinuationChapter({
          projectId: 1,
          chapterId: 10,
          content: '定稿正文C',
          sourceRunId: 'ct_fin1',
        }),
      ).rejects.toThrow('outbox insert');

      mockExecuteSql.mockImplementation(original);

      // Nothing committed: chapter still draft, SM still ready, no outbox, no
      // run linkage. This is the core data-safety guarantee of fix-plan §2.
      expect(store.chapters[0].status).toBe('draft');
      expect(store.storyMemory[0].status).toBe('ready');
      expect(store.storyMemory[0].dirty_from_position).toBeNull();
      expect(
        store.outbox.filter(o => o.operation === 'extract_state'),
      ).toHaveLength(0);
      // run linkage not advanced
      expect(store.runs[0].finalized_revision_hash).toBeNull();
    });

    test('finalized chapter is discoverable for cold-start recovery', async () => {
      store.runs.push(frozenRun());
      store.chapters[0].content = '定稿正文D';
      await finalizeContinuationChapter({
        projectId: 1,
        chapterId: 10,
        content: '定稿正文D',
        sourceRunId: 'ct_fin1',
      });
      // A pending extract_state outbox row must exist so cold-start processing
      // can pick it up even if the app was killed right after the commit.
      const pending = store.outbox.filter(
        o =>
          o.operation === 'extract_state' &&
          (o.state === 'pending' || o.state === 'interrupted'),
      );
      expect(pending.length).toBeGreaterThanOrEqual(1);
    });

    test('missing/corrupt snapshot falls back to null config with audit note', async () => {
      store.runs.push(frozenRun({ settings_snapshot_json: '{not json' }));
      store.chapters[0].content = '定稿正文E';
      await finalizeContinuationChapter({
        projectId: 1,
        chapterId: 10,
        content: '定稿正文E',
        sourceRunId: 'ct_fin1',
      });
      const row = store.outbox.find(o => o.operation === 'extract_state')!;
      const payload = JSON.parse(row.payload_json);
      expect(payload.llmConfigId).toBeNull();
      // Audit reason present, but never the prompt or chapter body.
      expect(payload.configNote).toBeTruthy();
      expect(JSON.stringify(payload)).not.toContain('定稿正文E');
    });

    test('adopt then finalize without sourceRunId recovers frozen run/config', async () => {
      const run = frozenRun({
        state: 'awaiting_user',
        settings_snapshot_json: JSON.stringify({
          resolvedModelConfigIds: { stateExtraction: 88 },
        }),
        completed_at: null,
      });
      store.runs.push(run);
      store.chapters[0].content = '';
      store.chapters[0].updated_at = 't0';
      const content = '采纳后作者补充的定稿正文';
      store.artifacts.push({
        id: 'artifact-auto-link',
        run_id: run.id,
        stage: 'writer',
        repair_round: 0,
        parent_artifact_id: null,
        content,
        content_hash: contentRevisionHash(content),
        created_at: 't1',
      });

      await adoptArtifactAsDraft({ runId: run.id });
      store.chapters[0].content = `${content}（人工编辑）`;
      store.chapters[0].updated_at = 't2';
      const finalized = `${content}（人工编辑）`;
      await finalizeContinuationChapter({
        projectId: 1,
        chapterId: 10,
        content: finalized,
      });

      const row = store.outbox.find(o => o.operation === 'extract_state')!;
      const payload = JSON.parse(row.payload_json);
      expect(payload.sourceRunId).toBe(run.id);
      expect(payload.llmConfigId).toBe(88);
      expect(payload.configNote).toBeNull();
      expect(run.finalized_revision_hash).toBe(contentRevisionHash(finalized));
    });

    test('manual finalize uses explicit safe fallback payload', async () => {
      store.chapters[0].content = '手写章节';
      await finalizeContinuationChapter({
        projectId: 1,
        chapterId: 10,
        content: '手写章节',
      });
      const row = store.outbox.find(o => o.operation === 'extract_state')!;
      const payload = JSON.parse(row.payload_json);
      expect(payload.sourceRunId).toBeNull();
      expect(payload.llmConfigId).toBeNull();
      expect(payload.configNote).toBe('manual_or_unknown_source_run');
    });

    test('explicit sourceRunId from another project/chapter is rejected before writes', async () => {
      store.runs.push(
        frozenRun({ id: 'ct_foreign', project_id: 99, chapter_id: 999 }),
      );
      store.chapters[0].content = '保持不变';
      await expect(
        finalizeContinuationChapter({
          projectId: 1,
          chapterId: 10,
          content: '不应写入',
          sourceRunId: 'ct_foreign',
        }),
      ).rejects.toThrow('不属于当前项目或章节');
      expect(store.chapters[0].status).toBe('planned');
      expect(store.outbox).toHaveLength(0);
      expect(store.storyMemory[0].status).toBe('ready');
    });
  });

  // ---- P1-B: outbox failed retry + visibility (fix-plan §3) ----
  describe('outbox retry + visibility', () => {
    const seedOutbox = (overrides: Partial<any> = {}) => ({
      id: 'co_retry1',
      project_id: 1,
      chapter_id: 10,
      operation: 'extract_state',
      payload_json: JSON.stringify({ chapterId: 10, chapterRevisionHash: 'h' }),
      dedupe_key: 'extract_state:10:h',
      state: 'failed',
      attempt_count: 1,
      last_error: '网络错误',
      created_at: 't1',
      updated_at: 't1',
      completed_at: null,
      ...overrides,
    });

    test('retryContinuationOutbox resets failed/interrupted to pending, clears error', async () => {
      store.outbox.push(seedOutbox());
      const ok = await retryContinuationOutbox('co_retry1');
      expect(ok).toBe(true);
      const row = await getOutboxById('co_retry1');
      expect(row!.state).toBe('pending');
      expect(row!.lastError).toBeNull();
      // Manual recovery starts a fresh automatic retry streak.
      expect(row!.attemptCount).toBe(0);
    });

    test('retryContinuationOutbox rejects non-eligible states', async () => {
      store.outbox.push(seedOutbox({ id: 'co_done', state: 'completed' }));
      const ok = await retryContinuationOutbox('co_done');
      expect(ok).toBe(false);
      expect((await getOutboxById('co_done'))!.state).toBe('completed');
    });

    test('retryFailedContinuationOutbox resets only failed rows for the project', async () => {
      store.outbox.push(seedOutbox({ id: 'co_a' }));
      store.outbox.push(
        seedOutbox({
          id: 'co_b',
          dedupe_key: 'extract_state:10:h2',
          state: 'failed',
        }),
      );
      store.outbox.push(
        seedOutbox({
          id: 'co_c',
          dedupe_key: 'extract_state:10:h3',
          state: 'pending',
        }),
      );
      store.outbox.push(
        seedOutbox({
          id: 'co_other',
          project_id: 2,
          dedupe_key: 'extract_state:11:h',
        }),
      );
      const n = await retryFailedContinuationOutbox(1);
      expect(n).toBe(2);
      expect((await getOutboxById('co_a'))!.state).toBe('pending');
      expect((await getOutboxById('co_b'))!.state).toBe('pending');
      // pending row untouched
      expect((await getOutboxById('co_c'))!.state).toBe('pending');
      // other project untouched
      expect((await getOutboxById('co_other'))!.state).toBe('failed');
    });

    test('getOutboxSummary reports pending/failed counts and last error without body', async () => {
      store.outbox.push(
        seedOutbox({ id: 'co_p', state: 'pending', last_error: null }),
      );
      store.outbox.push(
        seedOutbox({ id: 'co_f1', last_error: '网络错误', updated_at: 't2' }),
      );
      store.outbox.push(
        seedOutbox({
          id: 'co_f2',
          dedupe_key: 'extract_state:10:h2',
          last_error: 'State extraction JSON 解析失败',
          updated_at: 't3',
        }),
      );
      const summary = await getOutboxSummary(1);
      expect(summary.pendingCount).toBe(1);
      expect(summary.failedCount).toBe(2);
      expect(summary.lastError).toBeTruthy();
      // dedupe key present, but never the chapter body / prompt / credentials
      expect(summary.lastFailedDedupeKey).toContain('extract_state');
    });

    test('worker stops auto-claiming past MAX_OUTBOX_AUTO_RETRY_ATTEMPTS', async () => {
      // A pending row whose current automatic streak already exceeds the
      // budget is skipped until a user explicitly retries it.
      store.outbox.push(
        seedOutbox({
          id: 'co_exhausted',
          state: 'pending',
          attempt_count: MAX_OUTBOX_AUTO_RETRY_ATTEMPTS + 1,
          last_error: null,
        }),
      );
      const result = await processContinuationOutbox({
        limit: 5,
        callExtract: async () => JSON.stringify({ proposals: [] }),
      });
      expect(result.processed).toBe(0);
      // untouched
      expect((await getOutboxById('co_exhausted'))!.state).toBe('pending');
    });

    test('manual retry restarts an exhausted row so the worker can process it', async () => {
      store.chapters[0].content = '人工恢复正文';
      store.chapters[0].position = 21;
      const hash = contentRevisionHash('人工恢复正文');
      store.outbox.push(
        seedOutbox({
          id: 'co_manual_exhausted',
          dedupe_key: `extract_state:10:${hash}`,
          payload_json: JSON.stringify({
            projectId: 1,
            chapterId: 10,
            chapterRevisionHash: hash,
          }),
          attempt_count: MAX_OUTBOX_AUTO_RETRY_ATTEMPTS,
        }),
      );
      await retryContinuationOutbox('co_manual_exhausted');
      expect((await getOutboxById('co_manual_exhausted'))!.attemptCount).toBe(
        0,
      );
      await expect(
        processContinuationOutbox({
          limit: 5,
          callExtract: async () => JSON.stringify({ proposals: [] }),
        }),
      ).resolves.toMatchObject({ processed: 1, failed: 0 });
    });

    test('failed extract_state can recover to completed after manual retry', async () => {
      store.chapters[0].content = '恢复正文';
      store.chapters[0].position = 21;
      const hash = contentRevisionHash('恢复正文');
      store.outbox.push(
        seedOutbox({
          id: 'co_recover',
          dedupe_key: `extract_state:10:${hash}`,
          payload_json: JSON.stringify({
            projectId: 1,
            chapterId: 10,
            chapterRevisionHash: hash,
          }),
          state: 'failed',
          attempt_count: 1,
          last_error: '网络错误',
        }),
      );
      // Manual retry surfaces it for the worker.
      await retryContinuationOutbox('co_recover');
      const result = await processContinuationOutbox({
        limit: 5,
        callExtract: async () => JSON.stringify({ proposals: [] }),
      });
      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);
      expect((await getOutboxById('co_recover'))!.state).toBe('completed');
    });

    test('listOutboxForProject filters by state for the sync card', async () => {
      store.outbox.push(seedOutbox({ id: 'co_l1', state: 'failed' }));
      store.outbox.push(
        seedOutbox({
          id: 'co_l2',
          dedupe_key: 'extract_state:10:h2',
          state: 'pending',
        }),
      );
      store.outbox.push(
        seedOutbox({
          id: 'co_l3',
          project_id: 2,
          dedupe_key: 'extract_state:11:h',
        }),
      );
      const failed = await listOutboxForProject(1, 'failed');
      expect(failed.map(o => o.id)).toEqual(['co_l1']);
      const all = await listOutboxForProject(1);
      expect(all.length).toBe(2);
    });
  });

  // ---- P1-D: model freeze + interrupted resume state machine (fix-plan §5) ----
  describe('confirm + resume state machine', () => {
    const baseSnapshot = {
      schemaVersion: 1,
      projectId: 1,
      targetChapterId: 10,
      targetPosition: 21,
      source: { sourceId: 1 },
      canon: {
        snapshotId: 'snap1',
        revision: 1,
        boundaryGlobalCharOffset: 100,
        capabilities: {},
      },
      storyMemory: {
        stateFingerprint: 'fp',
        throughPosition: -1,
        status: 'ready',
      },
      inputRevisionHash: 'h',
      // Fix-plan §5.1: frozen config ids used by every stage
      settingsSnapshot: {
        schemaVersion: 1,
        values: {
          plannerConfirmationPolicy: 'never',
          checkerEnabled: false,
          maxRepairRounds: 0,
          targetChapterChars: 100,
        },
        resolvedModelConfigIds: {
          planner: 11,
          writer: 22,
          checker: 33,
          repair: 44,
          stateExtraction: 55,
        },
      },
      bundles: {
        lockedRules: [],
        canon: {
          worldRules: [],
          characters: [],
          evidenceRefs: [],
          plotThreads: [],
        },
        effectiveState: {
          characterStates: [],
          plotThreads: [],
          targetPosition: 21,
        },
        seam: { summary: 's', excerpt: 'e' },
        recentChapters: [],
        storyMemory: { summary: 'm' },
        episodic: [],
        style: null,
        userInstruction: '续写',
      },
      createdAt: 't',
    };

    const seedRun = (overrides: Partial<any> = {}) => ({
      id: 'ct_resume1',
      project_id: 1,
      chapter_id: 10,
      state: 'awaiting_user',
      stage: 'awaiting_user',
      input_revision_hash: 'h',
      source_snapshot_json: '{}',
      settings_snapshot_json: JSON.stringify(baseSnapshot.settingsSnapshot),
      context_snapshot_json: JSON.stringify(baseSnapshot),
      context_trace_json: '{}',
      token_usage_json: '{}',
      target_position: 21,
      source_id: 1,
      canon_snapshot_id: 'snap1',
      canon_revision: 1,
      story_memory_fingerprint: 'fp',
      story_memory_through_position: -1,
      user_instruction: '续写',
      created_at: 't',
      updated_at: 't',
      completion_reason: null,
      adopted_revision_hash: null,
      finalized_revision_hash: null,
      error_code: null,
      error_message: null,
      ...overrides,
    });

    const seedPlan = (runId: string, status = 'pending') => {
      store.plans.push({
        run_id: runId,
        schema_version: 1,
        plan_json: JSON.stringify({
          schemaVersion: 1,
          chapterGoal: '目标',
          centralConflict: '冲突',
          beats: [],
          participatingCharacterIds: [],
          characterActions: [],
          plotAdvances: [],
          foreshadowingActions: [],
          proposedStateChanges: [],
          risks: [],
        }),
        plan_hash: 'ph',
        confirmation_status: status,
        confirmed_at: null,
        created_at: 't',
      });
    };

    test('confirmPlanAndContinue runs Writer and reaches awaiting_user', async () => {
      store.runs.push(seedRun());
      seedPlan('ct_resume1', 'pending');
      const callStage = jest.fn(async (input: any) => {
        if (input.stage === 'writer')
          return { text: '生成的正文内容', usage: {} };
        return { text: '', usage: {} };
      });
      await confirmPlanAndContinue('ct_resume1', callStage as any, true);
      // Writer was called with the FROZEN writer config id (22), not live.
      expect(callStage).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'writer', configId: 22 }),
      );
      const run = store.runs.find(r => r.id === 'ct_resume1')!;
      expect(run.state).toBe('awaiting_user');
      // plan marked confirmed
      expect(store.plans[0].confirmation_status).toBe('confirmed');
    });

    test('Writer retries once with its frozen retry budget after reasoning-only output', async () => {
      const snapshot = {
        ...baseSnapshot,
        contextBudget: {
          modelContextLimit: 32_768,
          inputBudget: 20_000,
          reservedOutputTokens: 8_000,
          writerInitialOutputTokens: 4_000,
          writerMaxOutputTokens: 8_000,
        },
      };
      store.runs.push(
        seedRun({ context_snapshot_json: JSON.stringify(snapshot) }),
      );
      seedPlan('ct_resume1', 'pending');
      const callStage = jest.fn(async (input: any) => {
        if (input.stage !== 'writer') return { text: '', usage: {} };
        if (input.maxTokens === 4_000) {
          return {
            text: '',
            emptyReason: 'reasoning_only',
            finishReason: 'length',
            usage: {},
          };
        }
        return { text: '重试后的正文', usage: {} };
      });

      await confirmPlanAndContinue('ct_resume1', callStage as any, true);

      const writerCalls = callStage.mock.calls
        .map(([input]) => input)
        .filter((input: any) => input.stage === 'writer');
      expect(writerCalls.map((input: any) => input.maxTokens)).toEqual([
        4_000, 8_000,
      ]);
      expect(store.runs.find(r => r.id === 'ct_resume1')!.state).toBe(
        'awaiting_user',
      );
    });

    test('confirmPlanAndContinue terminalizes to failed when Writer throws', async () => {
      store.runs.push(seedRun());
      seedPlan('ct_resume1', 'pending');
      const callStage = jest.fn(async () => {
        throw new Error('Writer 网络错误');
      });
      await expect(
        confirmPlanAndContinue('ct_resume1', callStage as any, true),
      ).rejects.toThrow('Writer 网络错误');
      // Fix-plan §5.2: run must NOT be left in running
      const run = store.runs.find(r => r.id === 'ct_resume1')!;
      expect(run.state).toBe('failed');
      expect(run.error_message).toContain('Writer 网络错误');
    });

    test('resume from planner re-runs the pipeline and reaches awaiting_user', async () => {
      store.runs.push(
        seedRun({ id: 'ct_r_planner', state: 'interrupted', stage: 'planner' }),
      );
      seedPlan('ct_r_planner', 'not_required');
      const callStage = jest.fn(async (input: any) => {
        if (input.stage === 'planner') {
          return {
            text: JSON.stringify({
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
            }),
            usage: {},
          };
        }
        if (input.stage === 'writer')
          return { text: '恢复后的正文', usage: {} };
        return { text: '', usage: {} };
      });
      await resumeInterruptedRun('ct_r_planner', callStage as any, true);
      const run = store.runs.find(r => r.id === 'ct_r_planner')!;
      expect(run.state).toBe('awaiting_user');
    });

    test('resume from writer (no artifact) continues directly from Writer', async () => {
      // Fix-plan §5.2: the old code called confirmPlanAndContinue which only
      // accepts awaiting_user and always threw here. We now resume the Writer.
      store.runs.push(
        seedRun({ id: 'ct_r_writer', state: 'interrupted', stage: 'writer' }),
      );
      seedPlan('ct_r_writer', 'confirmed');
      const callStage = jest.fn(async (input: any) => {
        if (input.stage === 'writer') return { text: '恢复正文', usage: {} };
        return { text: '', usage: {} };
      });
      await resumeInterruptedRun('ct_r_writer', callStage as any, true);
      const run = store.runs.find(r => r.id === 'ct_r_writer')!;
      expect(run.state).toBe('awaiting_user');
      expect(callStage).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'writer', configId: 22 }),
      );
    });

    test('resume from checker with artifact re-checks without regenerating', async () => {
      store.runs.push(
        seedRun({ id: 'ct_r_checker', state: 'interrupted', stage: 'checker' }),
      );
      seedPlan('ct_r_checker', 'confirmed');
      store.artifacts.push({
        id: 'ca_existing',
        run_id: 'ct_r_checker',
        stage: 'writer',
        repair_round: 0,
        parent_artifact_id: null,
        content: '已有正文',
        content_hash: contentRevisionHash('已有正文'),
        created_at: 't',
      });
      const callStage = jest.fn(async (input: any) => {
        // Writer must NOT be called when resuming checker with existing artifact
        if (input.stage === 'writer') throw new Error('writer should not run');
        return { text: '', usage: {} };
      });
      await resumeInterruptedRun('ct_r_checker', callStage as any, true);
      const run = store.runs.find(r => r.id === 'ct_r_checker')!;
      expect(run.state).toBe('awaiting_user');
      expect(callStage).not.toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'writer' }),
      );
    });

    test('resume from awaiting_user with artifact hands back without model', async () => {
      store.runs.push(
        seedRun({
          id: 'ct_r_au',
          state: 'interrupted',
          stage: 'awaiting_user',
        }),
      );
      store.artifacts.push({
        id: 'ca_au',
        run_id: 'ct_r_au',
        stage: 'writer',
        repair_round: 0,
        parent_artifact_id: null,
        content: '正文',
        content_hash: contentRevisionHash('正文'),
        created_at: 't',
      });
      const callStage = jest.fn(async () => ({ text: '', usage: {} }));
      await resumeInterruptedRun('ct_r_au', callStage as any, true);
      const run = store.runs.find(r => r.id === 'ct_r_au')!;
      expect(run.state).toBe('awaiting_user');
      // no model call at all
      expect(callStage).not.toHaveBeenCalled();
    });

    test('resume that throws terminalizes to failed, not stuck running', async () => {
      store.runs.push(
        seedRun({ id: 'ct_r_fail', state: 'interrupted', stage: 'writer' }),
      );
      seedPlan('ct_r_fail', 'confirmed');
      const callStage = jest.fn(async () => {
        throw new Error('恢复时网络断开');
      });
      await expect(
        resumeInterruptedRun('ct_r_fail', callStage as any, true),
      ).rejects.toThrow('恢复时网络断开');
      const run = store.runs.find(r => r.id === 'ct_r_fail')!;
      expect(run.state).toBe('failed');
    });
  });

  // ---- P1-E: Source/Canon freshness check on adopt (fix-plan §6.1) ----
  describe('adopt context freshness', () => {
    const seedAdoptRun = (overrides: Partial<any> = {}) => ({
      id: 'ct_adopt_fresh',
      project_id: 1,
      chapter_id: 10,
      state: 'awaiting_user',
      stage: 'awaiting_user',
      input_revision_hash: contentRevisionHash(''),
      source_snapshot_json: '{}',
      settings_snapshot_json: '{}',
      context_snapshot_json: '{}',
      context_trace_json: '{}',
      token_usage_json: '{}',
      target_position: 21,
      source_id: 5,
      canon_snapshot_id: 'snap1',
      canon_revision: 3,
      story_memory_fingerprint: 'fp',
      story_memory_through_position: -1,
      user_instruction: 'x',
      created_at: 't',
      updated_at: 't',
      completion_reason: null,
      adopted_revision_hash: null,
      finalized_revision_hash: null,
      error_code: null,
      error_message: null,
      ...overrides,
    });

    const seedArtifact = () => {
      store.artifacts.push({
        id: 'ca_fresh',
        run_id: 'ct_adopt_fresh',
        stage: 'writer',
        repair_round: 0,
        parent_artifact_id: null,
        content: '采纳正文',
        content_hash: contentRevisionHash('采纳正文'),
        created_at: 't',
      });
    };

    test('adopts when source + canon snapshot + revision all match', async () => {
      store.runs.push(seedAdoptRun());
      seedArtifact();
      store.ctSettings.push({
        project_id: 1,
        active_source_id: 5,
        active_canon_snapshot_id: 'snap1',
      });
      store.canonSnapshots.push({ id: 'snap1', revision: 3 });
      const result = await adoptArtifactAsDraft({ runId: 'ct_adopt_fresh' });
      expect(result.contentHash).toBe(contentRevisionHash('采纳正文'));
      const run = store.runs.find(r => r.id === 'ct_adopt_fresh')!;
      expect(run.state).toBe('completed');
    });

    test('rejects adopt and marks outdated when active source changed', async () => {
      store.runs.push(seedAdoptRun());
      seedArtifact();
      // active source is now 9, run froze source 5
      store.ctSettings.push({
        project_id: 1,
        active_source_id: 9,
        active_canon_snapshot_id: 'snap1',
      });
      store.canonSnapshots.push({ id: 'snap1', revision: 3 });
      await expect(
        adoptArtifactAsDraft({ runId: 'ct_adopt_fresh' }),
      ).rejects.toThrow();
      const run = store.runs.find(r => r.id === 'ct_adopt_fresh')!;
      expect(run.state).toBe('outdated');
      expect(run.error_code).toBe('outdated');
    });

    test('rejects adopt when canon snapshot id changed', async () => {
      store.runs.push(seedAdoptRun());
      seedArtifact();
      store.ctSettings.push({
        project_id: 1,
        active_source_id: 5,
        active_canon_snapshot_id: 'snap2',
      });
      store.canonSnapshots.push({ id: 'snap2', revision: 3 });
      await expect(
        adoptArtifactAsDraft({ runId: 'ct_adopt_fresh' }),
      ).rejects.toBeInstanceOf(ContinuationOutdatedError);
      const run = store.runs.find(r => r.id === 'ct_adopt_fresh')!;
      expect(run.state).toBe('outdated');
    });

    test('rejects adopt when canon revision bumped (review edit)', async () => {
      store.runs.push(seedAdoptRun());
      seedArtifact();
      store.ctSettings.push({
        project_id: 1,
        active_source_id: 5,
        active_canon_snapshot_id: 'snap1',
      });
      // same snapshot id but revision bumped from 3 to 4
      store.canonSnapshots.push({ id: 'snap1', revision: 4 });
      await expect(
        adoptArtifactAsDraft({ runId: 'ct_adopt_fresh' }),
      ).rejects.toBeInstanceOf(ContinuationOutdatedError);
      const run = store.runs.find(r => r.id === 'ct_adopt_fresh')!;
      expect(run.state).toBe('outdated');
      expect(run.error_message).toBe('canon_revision_changed');
    });

    test('rejects adopt when settings row is missing (source deleted)', async () => {
      store.runs.push(seedAdoptRun());
      seedArtifact();
      // no ctSettings row
      await expect(
        adoptArtifactAsDraft({ runId: 'ct_adopt_fresh' }),
      ).rejects.toBeInstanceOf(ContinuationOutdatedError);
      const run = store.runs.find(r => r.id === 'ct_adopt_fresh')!;
      expect(run.state).toBe('outdated');
    });
  });

  // ---- P2: artifact ownership + concurrent adopt (fix-plan §7) ----
  describe('artifact ownership + concurrent adopt', () => {
    const seedTwoRuns = () => {
      // Two runs, each with its own artifact sharing the same content hash.
      store.runs.push({
        id: 'ct_own1',
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
      store.runs.push({
        id: 'ct_own2',
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
      store.artifacts.push({
        id: 'ca_own1',
        run_id: 'ct_own1',
        stage: 'writer',
        repair_round: 0,
        parent_artifact_id: null,
        content: '正文A',
        content_hash: contentRevisionHash('正文A'),
        created_at: 't',
      });
      store.artifacts.push({
        id: 'ca_own2',
        run_id: 'ct_own2',
        stage: 'writer',
        repair_round: 0,
        parent_artifact_id: null,
        content: '正文B',
        content_hash: contentRevisionHash('正文B'),
        created_at: 't',
      });
    };

    test('getArtifactForRun rejects an artifact belonging to another run', async () => {
      seedTwoRuns();
      // ca_own2 belongs to ct_own2; asking for it under ct_own1 must return null
      const foreign = await getArtifactForRun('ct_own1', 'ca_own2');
      expect(foreign).toBeNull();
      const own = await getArtifactForRun('ct_own1', 'ca_own1');
      expect(own).not.toBeNull();
      expect(own!.runId).toBe('ct_own1');
    });

    test("adopt with another run's artifactId is refused (ownership never relaxed)", async () => {
      seedTwoRuns();
      await expect(
        adoptArtifactAsDraft({ runId: 'ct_own1', artifactId: 'ca_own2' }),
      ).rejects.toThrow('不属于本次续写');
      // Neither run's chapter content was written.
      expect(store.chapters[0].content).toBe('');
    });

    test('adopt refuses when the run was concurrently moved out of adoptable state', async () => {
      seedTwoRuns();
      // Simulate a concurrent cancel/abandon moving ct_own1 to completed before
      // the adopt CAS runs.
      store.runs[0].state = 'completed';
      await expect(
        adoptArtifactAsDraft({ runId: 'ct_own1', artifactId: 'ca_own1' }),
      ).rejects.toThrow();
      // Chapter content not overwritten
      expect(store.chapters[0].content).toBe('');
    });

    test('adopt detects concurrent chapter edit via optimistic lock and does not overwrite', async () => {
      seedTwoRuns();
      // Simulate the chapter being edited between the read and the transaction:
      // bump updated_at so the WHERE updated_at = ? predicate misses.
      store.chapters[0].updated_at = 't0';
      // The adopt reads updated_at='t0', but we flip it right before the tx by
      // patching the handler to change updated_at on read. Easier: set the
      // chapter updated_at to a value the run won't see. We simulate by making
      // the chapter's updated_at differ from what the read returns.
      // To make this deterministic, override mockExecuteSql for the adopt read
      // to return 't0' but keep the stored value as 't1'.
      store.chapters[0].updated_at = 't1';
      const original = mockExecuteSql.getMockImplementation();
      mockExecuteSql.mockImplementation(
        async (sql: string, params: any[] = []) => {
          if (
            /SELECT content, title, status, updated_at FROM chapters WHERE id/i.test(
              sql,
            )
          ) {
            // Return a stale updated_at so the optimistic lock misses
            return res([{ ...store.chapters[0], updated_at: 't0' }]);
          }
          return original!(sql, params);
        },
      );
      await expect(
        adoptArtifactAsDraft({ runId: 'ct_own1', artifactId: 'ca_own1' }),
      ).rejects.toThrow('并发编辑');
      mockExecuteSql.mockImplementation(original);
      // The stored chapter content was NOT overwritten (rowsAffected 0).
      expect(store.chapters[0].content).toBe('');
      // A failed optimistic write must remain retryable, not falsely adopted.
      expect(store.runs[0].state).toBe('awaiting_user');
    });
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
    const stateExtractionMessages = compileStateExtractionMessages('正文', '[]');
    expect(stateExtractionMessages.length).toBe(2);
    expect(stateExtractionMessages[0].content).toContain('UTF-16 长度为 2');
    expect(stateExtractionMessages[0].content).toContain('可以返回 {"proposals":[]}');
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
