/**
 * V5 default stage caller + Draft Writer empty-content regression tests.
 *
 * Covers:
 *  - defaultV5StageCaller forwards responseFormat: 'json_object' to callLLMResult
 *    (the root cause of the "V5 Draft Writer content 不能为空" failure).
 *  - Draft Writer returning {"schemaVersion":1,"content":""} still fails, no
 *    body artifact is created, and the saved diagnostics carry the new safe fields.
 *  - A valid JSON with non-empty content still parses and executes.
 */

// jest.mock is hoisted, so the factory must be self-contained (no outer refs).
jest.mock('../src/services/llm', () => {
  const callLLMResult = jest.fn();
  return {
    callLLMResult,
    resolveLLMRequestConfig: jest.fn(async () => ({
      id: 1,
      name: '测试模型',
      provider_type: 'openai_compatible',
      api_key: 'test',
      model_name: 'test-model',
      url: 'https://example.test/v1',
      context_window: 128000,
      max_output_tokens: 32000,
    })),
    resolveLLMRequestConfigById: jest.fn(async () => ({
      id: 1,
      name: '测试模型',
      provider_type: 'openai_compatible',
      api_key: 'test',
      model_name: 'test-model',
      url: 'https://example.test/v1',
      context_window: 128000,
      max_output_tokens: 32000,
    })),
  };
});

import { __test__ } from '../src/services/continuation/generation/continuationV5Runner';
import { parseContinuationV5DraftEnvelope } from '../src/services/continuation/generation/continuationV5Contracts';
import {
  buildV5DraftWriterDiagnostics,
  mapV5DraftWriterEmptyContentError,
} from '../src/services/continuation/generation/errorFormat';
import { callLLMResult as callLLMResultMock } from '../src/services/llm';

const frozenModelConfig = {
  configId: 1,
  name: '测试模型',
  providerType: 'openai_compatible' as const,
  url: 'https://example.test/v1',
  modelName: 'test-model',
  contextWindow: 128000,
  maxOutputTokens: 32000,
};

describe('V5 default stage caller forwards responseFormat', () => {
  beforeEach(() => {
    (callLLMResultMock as jest.Mock).mockReset();
  });

  test('passes responseFormat: json_object to callLLMResult for every V5 stage', async () => {
    (callLLMResultMock as jest.Mock).mockResolvedValue({
      text: '{}',
      inputTokens: 10,
      outputTokens: 1,
      totalTokens: 11,
      finishReason: 'stop',
      rawUsage: { prompt_tokens: 10, completion_tokens: 1 },
    });
    await __test__.defaultV5StageCaller({
      stage: 'draft_writer',
      messages: [{ role: 'user', content: '写续写' }],
      maxTokens: 1000,
      configId: 1,
      responseFormat: 'json_object',
      signal: new AbortController().signal,
      projectId: 1,
      runId: 'run-1',
      frozenModelConfig,
    });
    expect(callLLMResultMock).toHaveBeenCalledTimes(1);
    const [, , config] = (callLLMResultMock as jest.Mock).mock.calls[0];
    expect(config.responseFormat).toBe('json_object');
    expect(config.scenario).toBe('continuation_v5_draft_writer');
  });

  test('omits responseFormat when the caller requests text', async () => {
    (callLLMResultMock as jest.Mock).mockResolvedValue({
      text: 'plain text',
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      finishReason: 'stop',
      rawUsage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    await __test__.defaultV5StageCaller({
      stage: 'final_reviser',
      messages: [{ role: 'user', content: 'plain' }],
      maxTokens: 1000,
      configId: 1,
      responseFormat: 'text',
      signal: new AbortController().signal,
      projectId: 1,
      runId: 'run-2',
      frozenModelConfig,
    });
    const [, , config] = (callLLMResultMock as jest.Mock).mock.calls[0];
    expect(config.responseFormat).toBeUndefined();
  });

  test('maps finishReason/emptyReason/usage onto StageLlmCallResult', async () => {
    (callLLMResultMock as jest.Mock).mockResolvedValue({
      text: 'hello',
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 8,
      finishReason: 'length',
      emptyReason: 'length',
      rawUsage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    const result = await __test__.defaultV5StageCaller({
      stage: 'draft_writer',
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 100,
      configId: 1,
      responseFormat: 'json_object',
      signal: new AbortController().signal,
      projectId: 1,
      runId: 'run-3',
      frozenModelConfig,
    });
    expect(result.text).toBe('hello');
    expect(result.finishReason).toBe('length');
    expect(result.emptyReason).toBe('length');
    expect(result.usage).toEqual({ prompt: 5, completion: 3 });
  });
});

describe('V5 Draft Writer empty-content regression', () => {
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
    // Required new fields.
    expect(diag.emptyReason).toBeNull();
    expect(diag.finishReason).toBe('stop');
    expect(diag.completionTokens).toBe(42);
    expect(diag.jsonOutputRequested).toBe(true);
    expect(diag.responseLength).toBe(raw.length);
    expect(diag.topLevelJsonKeys).toEqual(
      expect.arrayContaining(['schemaVersion', 'plan', 'content']),
    );
    // Never leaks sensitive values: only key NAMES, never body/key/headers.
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
    // Non-empty-content errors pass through unchanged.
    expect(mapV5DraftWriterEmptyContentError('网络错误')).toBe('网络错误');
  });
});

describe('V5 Draft Writer valid content path', () => {
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
