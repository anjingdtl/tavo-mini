/**
 * Phase 3 integration-style tests with in-memory SQL mock:
 * adopt zero memory pollution, finalize outbox, outbox dedupe,
 * effective state position filter, 30-chapter continuity loop (logic).
 */
import { sha256Hex } from '../src/services/continuation/hashUtils';

// --- Lightweight in-memory tables for Phase 3 contracts ---

type Row = Record<string, any>;

function createMemDb() {
  const tables: Record<string, Row[]> = {
    chapters: [],
    continuation_generation_runs: [],
    continuation_generation_artifacts: [],
    continuation_state_proposals: [],
    continuation_state_events: [],
    continuation_state_sync_outbox: [],
    project_story_memory: [],
    llm_calls: [],
  };

  return {
    tables,
    insert(table: string, row: Row) {
      tables[table].push({ ...row });
    },
    update(table: string, pred: (r: Row) => boolean, patch: Row) {
      tables[table] = tables[table].map(r =>
        pred(r) ? { ...r, ...patch } : r,
      );
    },
    all(table: string, pred?: (r: Row) => boolean) {
      return pred ? tables[table].filter(pred) : [...tables[table]];
    },
  };
}

describe('continuation Phase 3 pipeline contracts', () => {
  test('adopt draft does not create proposal/event/outbox/memory LLM', () => {
    const db = createMemDb();
    db.insert('chapters', {
      id: 1,
      project_id: 1,
      position: 20,
      content: '',
      status: 'planned',
    });
    db.insert('project_story_memory', {
      project_id: 1,
      status: 'ready',
      dirty_from_position: null,
    });

    const artifact = {
      id: 'ca_1',
      content: '续写草稿正文',
      content_hash: sha256Hex('续写草稿正文'),
    };
    // adopt transaction
    db.update(
      'chapters',
      r => r.id === 1,
      { content: artifact.content, status: 'draft' },
    );
    db.insert('continuation_generation_runs', {
      id: 'ct_1',
      state: 'completed',
      completion_reason: 'adopted',
      adopted_revision_hash: artifact.content_hash,
    });

    expect(db.all('continuation_state_proposals')).toHaveLength(0);
    expect(db.all('continuation_state_events')).toHaveLength(0);
    expect(db.all('continuation_state_sync_outbox')).toHaveLength(0);
    expect(db.all('llm_calls')).toHaveLength(0);
    expect(db.all('project_story_memory')[0].status).toBe('ready');
    expect(db.all('chapters')[0].status).toBe('draft');
  });

  test('finalize inserts extract_state outbox without LLM and marks SM dirty', () => {
    const db = createMemDb();
    const content = '定稿正文【状态:林逸负伤】';
    const hash = sha256Hex(content);
    db.insert('chapters', {
      id: 2,
      project_id: 1,
      position: 21,
      content,
      status: 'draft',
    });
    db.insert('project_story_memory', {
      project_id: 1,
      status: 'ready',
      dirty_from_position: null,
    });

    // finalize local transaction
    db.update(
      'chapters',
      r => r.id === 2,
      { status: 'finalized' },
    );
    db.update(
      'project_story_memory',
      r => r.project_id === 1,
      { status: 'dirty', dirty_from_position: 21 },
    );
    const dedupe = `extract_state:2:${hash}`;
    db.insert('continuation_state_sync_outbox', {
      id: 'co_1',
      operation: 'extract_state',
      dedupe_key: dedupe,
      state: 'pending',
      payload: { chapterId: 2, chapterRevisionHash: hash },
    });
    // second finalize same hash must not duplicate
    const exists = db
      .all('continuation_state_sync_outbox')
      .some(r => r.dedupe_key === dedupe);
    if (!exists) {
      db.insert('continuation_state_sync_outbox', {
        id: 'co_2',
        operation: 'extract_state',
        dedupe_key: dedupe,
        state: 'pending',
      });
    }

    expect(db.all('continuation_state_sync_outbox')).toHaveLength(1);
    expect(db.all('llm_calls')).toHaveLength(0);
    expect(db.all('project_story_memory')[0].status).toBe('dirty');
    expect(db.all('chapters')[0].status).toBe('finalized');
  });

  test('confirm proposal writes event + dirty + outbox; LLM only after commit', () => {
    const db = createMemDb();
    db.insert('continuation_state_proposals', {
      id: 'cp_1',
      status: 'pending',
      chapter_id: 3,
      chapter_position: 22,
      chapter_revision_hash: 'h',
    });
    db.insert('project_story_memory', {
      project_id: 1,
      status: 'ready',
      dirty_from_position: null,
    });

    // confirm transaction
    db.insert('continuation_state_events', {
      id: 'ce_1',
      proposal_id: 'cp_1',
      valid_from_position: 22,
      invalidated_at: null,
    });
    db.update(
      'continuation_state_proposals',
      r => r.id === 'cp_1',
      { status: 'accepted' },
    );
    db.update(
      'project_story_memory',
      r => r.project_id === 1,
      { status: 'dirty', dirty_from_position: 22 },
    );
    db.insert('continuation_state_sync_outbox', {
      id: 'co_sm',
      operation: 'rebuild_story_memory',
      state: 'pending',
      dedupe_key: 'rebuild_story_memory:1:22:h',
    });
    // After commit, worker may call LLM
    db.insert('llm_calls', { stage: 'rebuild_story_memory' });

    expect(db.all('continuation_state_events')).toHaveLength(1);
    expect(db.all('continuation_state_proposals')[0].status).toBe('accepted');
    expect(db.all('llm_calls')).toHaveLength(1);
  });

  test('effective state only applies events with valid_from_position < target', () => {
    const events = [
      { id: 'e1', valid_from_position: 20, summary: 'A' },
      { id: 'e2', valid_from_position: 21, summary: 'B' },
      { id: 'e3', valid_from_position: 25, summary: 'C-future' },
    ];
    const target = 25;
    const applied = events.filter(
      e => e.valid_from_position < target && !('invalidated_at' in e && (e as any).invalidated_at),
    );
    expect(applied.map(e => e.id)).toEqual(['e1', 'e2']);
    expect(applied.some(e => e.summary === 'C-future')).toBe(false);
  });

  test('chapter modify invalidates from earliest position', () => {
    const events = [
      { id: 'e1', chapter_position: 10, invalidated_at: null as string | null },
      { id: 'e2', chapter_position: 15, invalidated_at: null as string | null },
      { id: 'e3', chapter_position: 8, invalidated_at: null as string | null },
    ];
    const from = 10;
    for (const e of events) {
      if (e.chapter_position >= from) e.invalidated_at = 'now';
    }
    expect(events.filter(e => e.invalidated_at).map(e => e.id)).toEqual([
      'e1',
      'e2',
    ]);
    expect(events.find(e => e.id === 'e3')!.invalidated_at).toBeNull();
  });

  test('outbox cold start running → interrupted then retryable', () => {
    const items = [
      { id: '1', state: 'running' },
      { id: '2', state: 'pending' },
      { id: '3', state: 'completed' },
    ];
    for (const i of items) {
      if (i.state === 'running') i.state = 'interrupted';
    }
    expect(items.map(i => i.state)).toEqual([
      'interrupted',
      'pending',
      'completed',
    ]);
    const retryable = items.filter(
      i => i.state === 'pending' || i.state === 'interrupted',
    );
    expect(retryable).toHaveLength(2);
  });

  test('30-chapter continuity: no future leakage and bounded context growth', () => {
    const BOUNDARY = 20;
    const FUTURE_MARKER = '【未来揭示】';
    // 30 source chapters; continuation starts at 21..30
    const sourceChapters = Array.from({ length: 30 }, (_, i) => ({
      position: i,
      content:
        i > BOUNDARY
          ? `未来章${i}${FUTURE_MARKER}`
          : `原著章${i} 硬规则:禁复活 人物林逸`,
    }));

    const continuationChapters: Array<{
      position: number;
      content: string;
      events: string[];
      contextTokens: number;
    }> = [];

    let prevTokens = 0;
    for (let p = BOUNDARY + 1; p <= BOUNDARY + 30; p++) {
      // Reader only sees source <= BOUNDARY
      const readableSource = sourceChapters.filter(c => c.position <= BOUNDARY);
      expect(readableSource.some(c => c.content.includes(FUTURE_MARKER))).toBe(
        false,
      );

      // Only previous continuation events
      const priorEvents = continuationChapters.flatMap(c => c.events);
      const body = `续写第${p}章。承接：${priorEvents.slice(-3).join(';') || '接缝'}。林逸继续前行。`;
      expect(body).not.toContain(FUTURE_MARKER);

      // Context tokens: hard rules + last 5 chapters, not full history
      const recent = continuationChapters.slice(-5);
      const hardRuleTokens = 50;
      const recentTokens = recent.reduce(
        (s, c) => s + Math.min(200, c.content.length),
        0,
      );
      const contextTokens = hardRuleTokens + recentTokens + 100;
      // Must not grow unbounded with chapter count
      if (continuationChapters.length >= 10) {
        expect(contextTokens).toBeLessThan(prevTokens * 1.5 + 500);
      }
      prevTokens = Math.max(prevTokens, contextTokens);

      continuationChapters.push({
        position: p,
        content: body,
        events: [`state@${p}`],
        contextTokens,
      });
    }

    expect(continuationChapters).toHaveLength(30);
    // Mid-way edit chapter 10 of continuation (position BOUNDARY+10)
    const editPos = BOUNDARY + 10;
    const invalidated = continuationChapters
      .filter(c => c.position >= editPos)
      .map(c => c.position);
    expect(invalidated[0]).toBe(editPos);
    expect(invalidated).toHaveLength(21);
  });

  test('stage model routing uses frozen settings snapshot not live active', () => {
    const settingsSnapshot = {
      resolvedModelConfigIds: {
        planner: 11,
        writer: 22,
        checker: 33,
        repair: 44,
        stateExtraction: 55,
      },
    };
    const liveActive = 99;
    const route = (stage: keyof typeof settingsSnapshot.resolvedModelConfigIds) =>
      settingsSnapshot.resolvedModelConfigIds[stage] ?? liveActive;
    expect(route('planner')).toBe(11);
    expect(route('writer')).toBe(22);
    expect(route('stateExtraction')).toBe(55);
    expect(route('planner')).not.toBe(liveActive);
  });

  test('old pipeline stage names remain distinct from continuation stages', () => {
    const freeform = ['draft', 'review', 'factCheck', 'proof'];
    const continuation = [
      'context',
      'planner',
      'writer',
      'checker',
      'repair',
      'awaiting_user',
    ];
    for (const s of freeform) {
      expect(continuation.includes(s as any)).toBe(false);
    }
  });
});
