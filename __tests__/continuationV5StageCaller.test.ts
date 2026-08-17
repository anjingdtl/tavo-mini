/**
 * Historical V5 contract/diagnostic regression tests.
 *
 * The retired V5 Writer and its stage caller are intentionally not imported.
 * New continuation execution is covered by the shared Writing Kernel and
 * production call-graph gates.
 */
import { parseContinuationV5DraftEnvelope } from '../src/services/continuation/generation/continuationV5Contracts';
import {
  buildV5DraftWriterDiagnostics,
  mapV5DraftWriterEmptyContentError,
} from '../src/services/continuation/generation/errorFormat';

describe('historical V5 empty-content diagnostics', () => {
  test('parseable JSON with empty content still throws (no artifact)', () => {
    const emptyContentJson = JSON.stringify({
      schemaVersion: 1,
      plan: {
        chapterGoal: '推进',
        centralConflict: '冲突',
        beats: [{ id: 'b1', summary: '承接' }],
      },
      content: '',
    });
    expect(() => parseContinuationV5DraftEnvelope(emptyContentJson)).toThrow(
      /content 不能为空/,
    );
  });

  test('diagnostics object captures the required safe fields', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      plan: { chapterGoal: '推进', centralConflict: '冲突', beats: [] },
      content: '',
    });
    const diag = buildV5DraftWriterDiagnostics({
      rawText: raw,
      result: {
        finishReason: 'stop',
        emptyReason: null,
        completionTokens: 42,
      },
      jsonOutputRequested: true,
    });
    expect(diag.emptyReason).toBeNull();
    expect(diag.finishReason).toBe('stop');
    expect(diag.completionTokens).toBe(42);
    expect(diag.jsonOutputRequested).toBe(true);
    expect(diag.responseLength).toBe(raw.length);
    expect(diag.topLevelJsonKeys).toEqual(
      expect.arrayContaining(['schemaVersion', 'plan', 'content']),
    );
    expect(JSON.stringify(diag)).not.toContain('api_key');
    expect(JSON.stringify(diag)).not.toContain('Bearer');
  });

  test('diagnostics do not store the novel body, only key names', () => {
    const secretBody =
      '这是机密正文片段，不应进入诊断：主角真正的身世与绝密计划全盘托出。';
    const raw = JSON.stringify({
      schemaVersion: 1,
      content: secretBody + secretBody,
      notes: 'should_not_appear_either',
    });
    const diag = buildV5DraftWriterDiagnostics({
      rawText: raw,
      result: { finishReason: 'stop', completionTokens: 1 },
      jsonOutputRequested: true,
    });
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain(secretBody);
    expect(serialized).not.toContain('should_not_appear_either');
    expect(diag.topLevelJsonKeys).toEqual(
      expect.arrayContaining(['schemaVersion', 'content', 'notes']),
    );
  });

  test('error message is remapped to an actionable Chinese hint', () => {
    const internal = 'V5 Draft Writer content 不能为空。';
    const userFacing = mapV5DraftWriterEmptyContentError(internal);
    expect(userFacing).not.toBe(internal);
    expect(userFacing).toContain('模型返回了空正文');
    expect(userFacing).toContain('重试');
    expect(mapV5DraftWriterEmptyContentError('网络错误')).toBe('网络错误');
  });
});

describe('historical V5 valid content contract', () => {
  test('valid JSON still parses into a usable envelope', () => {
    const validJson = JSON.stringify({
      schemaVersion: 1,
      plan: {
        chapterGoal: '推进',
        centralConflict: '冲突',
        beats: [{ id: 'b1', summary: '行动', stateChange: '变化' }],
      },
      content:
        '完整的 V1 初稿正文，事件已展开并形成自然章末，长度足够通过校验。',
    });
    const draft = parseContinuationV5DraftEnvelope(validJson);
    expect(draft.content).toContain('完整的 V1 初稿正文');
    expect(draft.plan.beats).toHaveLength(1);
    expect(draft.schemaVersion).toBe(1);
  });
});
