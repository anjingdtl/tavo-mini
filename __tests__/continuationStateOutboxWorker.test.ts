/**
 * Regression tests for the state-extraction outbox worker.
 *
 * Covers the malformed-LLM-output failure modes that used to surface as a bare
 * "State extraction JSON 解析失败" and now produce actionable, privacy-safe
 * diagnostics:
 *   - markdown code fences wrapping valid JSON
 *   - leading prose ("Here is the JSON:") + trailing usage text
 *   - truncated output (finish_reason=length)
 *   - empty response (text=null / emptyReason=length|reasoning_only|empty)
 *   - completely unparseable text
 *   - evidence offset out of range
 *   - valid proposals parsed from a fenced block
 *   - backward compatibility: callExtract returning a bare string still works
 *   - callExtract returning { text, finishReason } exercises the meta path
 */
import {
  parseExtraction,
  processContinuationOutbox,
} from '../src/services/continuation/generation/continuationStateOutboxWorker';
import { contentRevisionHash } from '../src/services/continuation/generation/generationRepository';

// ---- parseExtraction unit tests (no DB, no LLM) ----

describe('parseExtraction: malformed LLM output recovery', () => {
  const textLen = 1000;

  test('parses valid JSON object with proposals array', () => {
    const raw = JSON.stringify({
      proposals: [
        {
          proposalType: 'character_state',
          payload: { summary: '主角受伤' },
          evidenceStart: 10,
          evidenceEnd: 20,
        },
      ],
    });
    const result = parseExtraction(raw, textLen);
    expect(result).toHaveLength(1);
    expect(result[0].proposalType).toBe('character_state');
    expect(result[0].evidenceStart).toBe(10);
    expect(result[0].evidenceEnd).toBe(20);
  });

  test('parses bare JSON array (no proposals wrapper)', () => {
    const raw = JSON.stringify([
      {
        proposalType: 'new_character',
        payload: { name: '张三' },
        evidenceStart: 0,
        evidenceEnd: 5,
      },
    ]);
    const result = parseExtraction(raw, textLen);
    expect(result).toHaveLength(1);
    expect(result[0].proposalType).toBe('new_character');
  });

  test('parses markdown-fenced JSON (```json ... ```)', () => {
    const inner = JSON.stringify({
      proposals: [
        {
          proposalType: 'plot_advance',
          payload: { summary: '剧情推进' },
          evidenceStart: 0,
          evidenceEnd: 10,
        },
      ],
    });
    const raw = '```json\n' + inner + '\n```';
    const result = parseExtraction(raw, textLen);
    expect(result).toHaveLength(1);
    expect(result[0].proposalType).toBe('plot_advance');
  });

  test('parses JSON with leading prose and trailing usage text', () => {
    const inner = JSON.stringify({
      proposals: [
        {
          proposalType: 'foreshadowing',
          payload: { summary: '伏笔' },
          evidenceStart: 5,
          evidenceEnd: 15,
        },
      ],
    });
    const raw =
      '以下是提取的状态 JSON：\n' + inner + '\n\n本次调用消耗 123 tokens。';
    const result = parseExtraction(raw, textLen);
    expect(result).toHaveLength(1);
    expect(result[0].proposalType).toBe('foreshadowing');
  });

  test('returns empty array for empty proposals list', () => {
    const raw = JSON.stringify({ proposals: [] });
    const result = parseExtraction(raw, textLen);
    expect(result).toEqual([]);
  });

  test('returns empty array for empty object', () => {
    const raw = '{}';
    const result = parseExtraction(raw, textLen);
    expect(result).toEqual([]);
  });

  test('skips items with unknown proposalType', () => {
    const raw = JSON.stringify({
      proposals: [
        {
          proposalType: 'totally_unknown_type',
          payload: {},
          evidenceStart: 0,
          evidenceEnd: 10,
        },
        {
          proposalType: 'character_state',
          payload: { summary: '有效' },
          evidenceStart: 0,
          evidenceEnd: 10,
        },
      ],
    });
    const result = parseExtraction(raw, textLen);
    expect(result).toHaveLength(1);
    expect(result[0].proposalType).toBe('character_state');
  });

  test('uses summary fallback when payload missing', () => {
    const raw = JSON.stringify({
      proposals: [
        {
          proposalType: 'character_state',
          summary: '从 summary 兜底',
          evidenceStart: 0,
          evidenceEnd: 10,
        },
      ],
    });
    const result = parseExtraction(raw, textLen);
    expect(result[0].payload).toEqual({ summary: '从 summary 兜底' });
  });
});

describe('parseExtraction: error diagnostics', () => {
  const textLen = 1000;

  test('empty response with finishReason=length reports reasoning-only hint', () => {
    expect(() =>
      parseExtraction('', textLen, {
        finishReason: 'length',
        emptyReason: 'reasoning_only',
      }),
    ).toThrow(/空响应.*finishReason=length.*reasoning_only.*思维链/);
  });

  test('empty response with emptyReason=empty reports generic empty', () => {
    expect(() =>
      parseExtraction('', textLen, {
        finishReason: 'stop',
        emptyReason: 'empty',
      }),
    ).toThrow(/空响应.*finishReason=stop.*emptyReason=empty/);
  });

  test('truncated output (finishReason=length) reports max_tokens hint', () => {
    const truncated = '{"proposals":[{"proposalType":"character_state","eviden';
    expect(() =>
      parseExtraction(truncated, textLen, {
        finishReason: 'length',
        emptyReason: null,
      }),
    ).toThrow(/max_tokens 截断.*finishReason=length/);
  });

  test('unparseable text reports rawLength and finishReason without preview', () => {
    const raw = '这不是 JSON，也没有任何大括号';
    const err = (() => {
      try {
        parseExtraction(raw, textLen, {
          finishReason: 'stop',
          emptyReason: null,
        });
        throw new Error('should have thrown');
      } catch (e: any) {
        return e;
      }
    })();
    expect(err.message).toMatch(/JSON 解析失败/);
    expect(err.message).toMatch(/rawLength=\d+/);
    expect(err.message).toMatch(/finishReason=stop/);
    // Privacy: error message must NOT contain the raw response preview
    expect(err.message).not.toContain('这不是 JSON');
  });

  test('evidence offset out of range reports proposal count', () => {
    const raw = JSON.stringify({
      proposals: [
        {
          proposalType: 'character_state',
          payload: {},
          evidenceStart: 0,
          evidenceEnd: 99999, // exceeds textLen
        },
      ],
    });
    expect(() => parseExtraction(raw, textLen)).toThrow(
      /evidence offset 越界.*proposals=1/,
    );
  });

  test('default meta (undefined) treats as unknown finishReason', () => {
    expect(() => parseExtraction('not json at all', textLen)).toThrow(
      /finishReason=unknown/,
    );
  });
});

// ---- Worker-level integration via processContinuationOutbox ----
//
// Uses the same in-memory SQL mock pattern as
// continuationPhase3Repository.test.ts. Variables referenced inside jest.mock
// factories must be prefixed with `mock` per Jest's out-of-scope guard.

const mockStore: {
  chapters: any[];
  outbox: any[];
  proposals: any[];
  settings: any[];
} = {
  chapters: [],
  outbox: [],
  proposals: [],
  settings: [],
};

function mockRes(rows: any[]) {
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
  const s = sql.replace(/\s+/g, ' ').trim().toUpperCase();

  // SELECT chapter content for state extraction
  if (/SELECT CONTENT, POSITION FROM CHAPTERS WHERE ID = \?/i.test(
    sql.replace(/\s+/g, ' '),
  )) {
    const chapterId = params[0];
    const ch = mockStore.chapters.find(c => c.id === chapterId);
    return mockRes(ch ? [ch] : []);
  }
  // INSERT proposals (H8-Generation: INSERT OR IGNORE, params 顺序变化)
  if (s.startsWith('INSERT') && s.includes('CONTINUATION_STATE_PROPOSALS')) {
    mockStore.proposals.push({
      proposalType: params[6],
      evidenceStart: params[11],
      evidenceEnd: params[12],
    });
    return mockRes([]);
  }
  // SELECT proposals after insert (insertProposals 末尾统一查询)
  if (s.startsWith('SELECT') && s.includes('FROM CONTINUATION_STATE_PROPOSALS')) {
    return mockRes(
      mockStore.proposals.map(p => ({
        proposal_type: p.proposalType,
        evidence_start: p.evidenceStart,
        evidence_end: p.evidenceEnd,
        status: 'pending',
      })),
    );
  }
  // Outbox: list pending
  if (s.startsWith('SELECT * FROM CONTINUATION_STATE_SYNC_OUTBOX')) {
    const normalized = sql.replace(/\s+/g, ' ');
    if (/STATE IN \('pending'/i.test(normalized)) {
      return mockRes(mockStore.outbox.filter(o => o.state === 'pending'));
    }
    if (/DEDUPE_KEY = \?/i.test(normalized)) {
      return mockRes(
        mockStore.outbox.filter(o => o.dedupe_key === params[0]),
      );
    }
    return mockRes(mockStore.outbox);
  }
  // CAS state transitions. casOutboxState param order is:
  //   [state, lastError, nowIso, completedAt, id, ...expectedStates]
  // so id is always at index 4. SQL is parameterized (SET state = ?), so we
  // read the target state from params[0] rather than parsing the SQL text.
  if (s.startsWith('UPDATE CONTINUATION_STATE_SYNC_OUTBOX')) {
    const id = params[4];
    const row = mockStore.outbox.find(o => o.id === id);
    if (row) {
      const targetState = params[0];
      row.state = targetState;
      if (targetState === 'running') {
        row.attempt_count = (row.attempt_count ?? 0) + 1;
      } else if (targetState === 'completed') {
        row.completed_at = params[2];
      } else if (targetState === 'failed') {
        row.last_error = params[1];
      }
    }
    return mockRes([{ __affected: 1 }]);
  }
  // ensureGenerationSettings SELECT
  if (
    s.startsWith('SELECT') &&
    s.includes('CONTINUATION_GENERATION_SETTINGS')
  ) {
    return mockRes(
      mockStore.settings.length
        ? mockStore.settings
        : [{ project_id: 1, state_extraction_llm_config_id: null }],
    );
  }
  return mockRes([]);
});

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn(async () => ({
    executeSql: mockExecuteSql,
    // H8-Generation: insertProposals 改用 executeTransaction 批量插入，
    // 走 db.transaction(scope) → tx.executeSql。让 tx.executeSql 复用
    // mockExecuteSql，使 INSERT INTO continuation_state_proposals 仍能
    // 被 mock 捕获并 push 到 mockStore.proposals。
    transaction: jest.fn(async (fn: any) =>
      fn({ executeSql: mockExecuteSql }),
    ),
  })),
}));

// Stub LLM resolution so the worker never hits the real provider when
// callExtract is injected.
jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(),
  resolveLLMRequestConfigById: jest.fn(),
}));

jest.mock('../src/services/storyMemory/storyMemoryRebuild', () => ({
  rebuildStoryMemory: jest.fn(),
}));

beforeEach(() => {
  mockStore.chapters = [];
  mockStore.outbox = [];
  mockStore.proposals = [];
  mockStore.settings = [];
  mockExecuteSql.mockClear();
});

describe('processContinuationOutbox: malformed LLM output', () => {
  function seedChapter(content: string) {
    const ch = {
      id: 10,
      project_id: 1,
      position: 21,
      content,
      title: '续写一',
      status: 'finalized',
      updated_at: 't0',
    };
    mockStore.chapters = [ch];
    return ch;
  }

  function seedOutbox(content: string) {
    const hash = contentRevisionHash(content);
    mockStore.outbox = [
      {
        id: 'co_test',
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
    ];
    return hash;
  }

  test('markdown-fenced JSON is accepted (was: JSON 解析失败)', async () => {
    const content = '主角走在路上。';
    seedChapter(content);
    seedOutbox(content);
    const inner = JSON.stringify({
      proposals: [
        {
          proposalType: 'character_state',
          payload: { summary: '走路' },
          evidenceStart: 0,
          evidenceEnd: content.length,
        },
      ],
    });
    const result = await processContinuationOutbox({
      limit: 5,
      callExtract: async () => '```json\n' + inner + '\n```',
    });
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockStore.proposals).toHaveLength(1);
    expect(mockStore.outbox[0].state).toBe('completed');
  });

  test('truncated output (finishReason=length) fails with actionable error', async () => {
    const content = '主角走在路上。';
    seedChapter(content);
    seedOutbox(content);
    const result = await processContinuationOutbox({
      limit: 5,
      callExtract: async () => ({
        text: '{"proposals":[{"proposalType":"character_state","eviden',
        finishReason: 'length',
      }),
    });
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockStore.outbox[0].state).toBe('failed');
    expect(mockStore.outbox[0].last_error).toMatch(/max_tokens 截断/);
    expect(mockStore.outbox[0].last_error).toMatch(/finishReason=length/);
  });

  test('empty response (reasoning_only) fails with reasoning hint', async () => {
    const content = '主角走在路上。';
    seedChapter(content);
    seedOutbox(content);
    const result = await processContinuationOutbox({
      limit: 5,
      callExtract: async () => ({
        text: '',
        finishReason: 'length',
        emptyReason: 'reasoning_only',
      }),
    });
    expect(result.failed).toBe(1);
    expect(mockStore.outbox[0].last_error).toMatch(/空响应/);
    expect(mockStore.outbox[0].last_error).toMatch(/reasoning_only/);
    expect(mockStore.outbox[0].last_error).toMatch(/思维链/);
  });

  test('completely unparseable text fails with rawLength but no preview', async () => {
    const content = '主角走在路上。';
    seedChapter(content);
    seedOutbox(content);
    const result = await processContinuationOutbox({
      limit: 5,
      callExtract: async () => ({
        text: '抱歉，我无法完成这个任务。',
        finishReason: 'stop',
      }),
    });
    expect(result.failed).toBe(1);
    const err = mockStore.outbox[0].last_error as string;
    expect(err).toMatch(/JSON 解析失败/);
    expect(err).toMatch(/rawLength=\d+/);
    // Privacy: the raw response text must not leak into last_error
    expect(err).not.toContain('抱歉');
    expect(err).not.toContain('无法完成');
  });

  test('backward compat: callExtract returning bare string still works', async () => {
    const content = '主角走在路上。';
    seedChapter(content);
    seedOutbox(content);
    const result = await processContinuationOutbox({
      limit: 5,
      callExtract: async () => JSON.stringify({ proposals: [] }),
    });
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockStore.proposals).toHaveLength(0);
  });

  test('evidence offset out of range rejects batch with count', async () => {
    const content = '主角走在路上。';
    seedChapter(content);
    seedOutbox(content);
    const result = await processContinuationOutbox({
      limit: 5,
      callExtract: async () =>
        JSON.stringify({
          proposals: [
            {
              proposalType: 'character_state',
              payload: {},
              evidenceStart: 0,
              evidenceEnd: 999999,
            },
          ],
        }),
    });
    expect(result.failed).toBe(1);
    expect(mockStore.outbox[0].last_error).toMatch(/evidence offset 越界/);
    expect(mockStore.outbox[0].last_error).toMatch(/proposals=1/);
  });

  test('chapter content changed since finalize fails with hash mismatch', async () => {
    const content = '原始定稿正文';
    seedChapter(content);
    seedOutbox(content);
    // Mutate chapter content after enqueue — hash no longer matches
    mockStore.chapters[0].content = '被改过的正文';
    const result = await processContinuationOutbox({
      limit: 5,
      callExtract: async () => JSON.stringify({ proposals: [] }),
    });
    expect(result.failed).toBe(1);
    expect(mockStore.outbox[0].last_error).toMatch(/hash 不一致/);
  });
});
