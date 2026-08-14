/**
 * Fault-injection A–F: Context Auto simulation must never overwrite
 * llm_config.context_window / max_output_tokens.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __resetForTest,
  __setDatabaseForTest,
} from '../src/data/connection/openDatabase';
import { all } from '../src/data/connection/query';
import {
  saveLLMConfig,
  updateLLMCapabilityWindow,
  resolveLLMConfigIdForContextSync,
} from '../src/data/repositories/llmConfigRepository';
import { getContextAutoInput } from '../src/data/repositories/contextAutoRepository';
import {
  applyContextAutoAllocationV3,
  restoreContextAutoDefaults,
} from '../src/services/contextAutoAllocator';
import { resolveLLMRequestConfig } from '../src/services/llm';

let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
}

async function snapshotCapabilities() {
  const rows = await all<{
    id: number;
    name: string;
    is_active: number;
    context_window: number;
    max_output_tokens: number;
  }>(
    'SELECT id, name, is_active, context_window, max_output_tokens FROM llm_config ORDER BY id',
  );
  return rows.map(row => ({
    id: Number(row.id),
    name: String(row.name),
    is_active: Number(row.is_active),
    context_window: Number(row.context_window),
    max_output_tokens: Number(row.max_output_tokens),
  }));
}

async function seedModel(input: {
  name: string;
  context_window: number;
  max_output_tokens: number;
  is_active: number;
}) {
  return saveLLMConfig({
    name: input.name,
    base_url: 'https://example.test/v1',
    api_key: '',
    model_name: input.name,
    is_active: input.is_active,
    context_window: input.context_window,
    max_output_tokens: input.max_output_tokens,
  });
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

describe('Context Auto must not write LLM capability (NG-LLM-01 / NG-LLM-02)', () => {
  test('A — simulate 1M then apply; saved 128K/16K stays 128K/16K', async () => {
    await resetDb();
    await seedModel({
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 16_000,
      is_active: 1,
    });
    const before = await snapshotCapabilities();
    await applyContextAutoAllocationV3(1_000_000);
    expect(await getContextAutoInput()).toBe(1_000_000);
    expect(await snapshotCapabilities()).toEqual(before);
  });

  test('B — applying 32K from model B leaves A and B capability unchanged', async () => {
    await resetDb();
    const idA = await seedModel({
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 16_000,
      is_active: 1,
    });
    const idB = await seedModel({
      name: 'B',
      context_window: 1_000_000,
      max_output_tokens: 64_000,
      is_active: 0,
    });
    const before = await snapshotCapabilities();
    await applyContextAutoAllocationV3(32_000);
    expect(await snapshotCapabilities()).toEqual(before);
    expect(resolveLLMConfigIdForContextSync(before, idB)).toBe(idB);
    expect(resolveLLMConfigIdForContextSync(before, idA)).toBe(idA);
  });

  test('C — unsaved draft id=0 apply does not mutate any saved LLM', async () => {
    await resetDb();
    await seedModel({
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 16_000,
      is_active: 1,
    });
    await seedModel({
      name: 'B',
      context_window: 1_000_000,
      max_output_tokens: 64_000,
      is_active: 0,
    });
    const before = await snapshotCapabilities();
    expect(resolveLLMConfigIdForContextSync(before, 0)).toBeNull();
    await expect(
      updateLLMCapabilityWindow(0, 32_000, 6400),
    ).rejects.toThrow(/尚未保存/);
    await applyContextAutoAllocationV3(512_000);
    expect(await snapshotCapabilities()).toEqual(before);
  });

  test('D — restore defaults leaves every llm_config capability identical', async () => {
    await resetDb();
    await seedModel({
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 16_000,
      is_active: 1,
    });
    await seedModel({
      name: 'B',
      context_window: 256_000,
      max_output_tokens: 8_000,
      is_active: 0,
    });
    await applyContextAutoAllocationV3(1_000_000);
    const before = await snapshotCapabilities();
    await restoreContextAutoDefaults();
    expect(await snapshotCapabilities()).toEqual(before);
    expect(await getContextAutoInput()).toBe(1_000_000);
  });

  test('E — changing context_auto_input does not change resolveLLMRequestConfig or a frozen snapshot', async () => {
    await resetDb();
    await seedModel({
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 16_000,
      is_active: 1,
    });
    const liveBefore = await resolveLLMRequestConfig();
    expect(liveBefore.context_window).toBe(128_000);
    expect(liveBefore.max_output_tokens).toBe(16_000);
    const frozen = {
      llmConfigId: liveBefore.id,
      contextWindow: liveBefore.context_window,
      maxOutputTokens: liveBefore.max_output_tokens,
    };
    await applyContextAutoAllocationV3(1_000_000);
    const liveAfter = await resolveLLMRequestConfig();
    expect(liveAfter.context_window).toBe(128_000);
    expect(liveAfter.max_output_tokens).toBe(16_000);
    expect(liveAfter.context_window).toBe(liveBefore.context_window);
    expect(liveAfter.max_output_tokens).toBe(liveBefore.max_output_tokens);
    expect(frozen.contextWindow).toBe(128_000);
    expect(frozen.maxOutputTokens).toBe(16_000);
    expect(await getContextAutoInput()).toBe(1_000_000);
  });

  test('F — only an explicit LLM Settings save changes capability and live resolve', async () => {
    await resetDb();
    const id = await seedModel({
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 16_000,
      is_active: 1,
    });
    await applyContextAutoAllocationV3(1_000_000);
    expect((await resolveLLMRequestConfig()).context_window).toBe(128_000);

    await saveLLMConfig({
      id,
      name: 'A',
      base_url: 'https://example.test/v1',
      api_key: '',
      model_name: 'A',
      context_window: 256_000,
      max_output_tokens: 32_000,
    });
    const live = await resolveLLMRequestConfig();
    expect(live.context_window).toBe(256_000);
    expect(live.max_output_tokens).toBe(32_000);
    const rows = await snapshotCapabilities();
    expect(rows).toEqual([
      {
        id,
        name: 'A',
        is_active: 1,
        context_window: 256_000,
        max_output_tokens: 32_000,
      },
    ]);
  });

  test('capability write without a saved row fails closed', async () => {
    await resetDb();
    await seedModel({
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 16_000,
      is_active: 1,
    });
    const before = await snapshotCapabilities();
    await expect(
      updateLLMCapabilityWindow(99, 32_000, 6400),
    ).rejects.toThrow(/不存在/);
    expect(await snapshotCapabilities()).toEqual(before);
  });
});
