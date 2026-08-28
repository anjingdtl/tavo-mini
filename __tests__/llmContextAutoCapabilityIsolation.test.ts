/**
 * C0-A Red/contract tests: model capability has one persisted authority.
 *
 * The automatic-context entry may target the active (or explicitly selected
 * saved) model, but it must never create a second runtime capability. The
 * max_output_tokens=0 sentinel remains AUTO and is resolved only at runtime.
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
  setActiveLLMConfig,
  updateLLMCapabilityWindow,
} from '../src/data/repositories/llmConfigRepository';
import { getContextAutoInput } from '../src/data/repositories/contextAutoRepository';
import {
  applyContextAutoAllocationV3,
  restoreContextAutoDefaults,
} from '../src/services/contextAutoAllocator';
import { resolveLLMRequestConfig } from '../src/services/llm';
import { freezeWritingModelConfig } from '../src/services/writing/contracts/freezeModelConfig';

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

describe('C0-A model capability single source of truth', () => {
  test('Auto Context 1M writes the active model context_window only', async () => {
    await resetDb();
    const idA = await seedModel({
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 16_000,
      is_active: 1,
    });
    const idB = await seedModel({
      name: 'B',
      context_window: 256_000,
      max_output_tokens: 8_000,
      is_active: 0,
    });

    const record = await applyContextAutoAllocationV3(1_000_000);
    expect(record.syncedContextWindow).toEqual({
      configId: idA,
      contextWindow: 1_000_000,
      maxOutputTokens: 16_000,
    });
    expect(await snapshotCapabilities()).toEqual([
      {
        id: idA,
        name: 'A',
        is_active: 1,
        context_window: 1_000_000,
        max_output_tokens: 16_000,
      },
      {
        id: idB,
        name: 'B',
        is_active: 0,
        context_window: 256_000,
        max_output_tokens: 8_000,
      },
    ]);
    expect(await getContextAutoInput()).toBe(1_000_000);
    const live = await resolveLLMRequestConfig();
    expect(live.context_window).toBe(1_000_000);
    expect(live.max_output_tokens).toBe(16_000);
  });

  test('an explicit saved model can be configured without mutating another model', async () => {
    await resetDb();
    const idA = await seedModel({
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 16_000,
      is_active: 1,
    });
    const idB = await seedModel({
      name: 'B',
      context_window: 256_000,
      max_output_tokens: 8_000,
      is_active: 0,
    });

    await applyContextAutoAllocationV3(1_000_000, { llmConfigId: idB });
    const rows = await snapshotCapabilities();
    expect(rows.find(row => row.id === idA)).toMatchObject({
      context_window: 128_000,
      max_output_tokens: 16_000,
    });
    expect(rows.find(row => row.id === idB)).toMatchObject({
      context_window: 1_000_000,
      max_output_tokens: 8_000,
    });
  });

  test('max_output_tokens=0 remains AUTO and is never replaced by a derived value', async () => {
    await resetDb();
    const id = await seedModel({
      name: 'AUTO',
      context_window: 128_000,
      max_output_tokens: 0,
      is_active: 1,
    });

    await applyContextAutoAllocationV3(1_000_000);
    const stored = await all<any>(
      'SELECT context_window, max_output_tokens FROM llm_config WHERE id = ?',
      [id],
    );
    expect(stored[0]).toEqual({
      context_window: 1_000_000,
      max_output_tokens: 0,
    });
    const live = await resolveLLMRequestConfig();
    expect(live.context_window).toBe(1_000_000);
    expect(live.max_output_tokens).toBe(200_000);
  });

  test('LLM Settings save and active-model switch update the automatic-context mirror', async () => {
    await resetDb();
    const idA = await seedModel({
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 0,
      is_active: 1,
    });
    const idB = await seedModel({
      name: 'B',
      context_window: 256_000,
      max_output_tokens: 8_000,
      is_active: 0,
    });

    await saveLLMConfig({
      id: idA,
      name: 'A',
      base_url: 'https://example.test/v1',
      model_name: 'A',
      context_window: 512_000,
      max_output_tokens: 0,
    });
    expect(await getContextAutoInput()).toBe(512_000);

    await setActiveLLMConfig(idB);
    expect(await getContextAutoInput()).toBe(256_000);
  });

  test('old Frozen model capability does not drift after a later model update', async () => {
    await resetDb();
    const id = await seedModel({
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 0,
      is_active: 1,
    });
    await applyContextAutoAllocationV3(1_000_000);
    const live = await resolveLLMRequestConfig();
    const frozen = freezeWritingModelConfig({
      configId: live.id ?? null,
      provider: live.provider_type,
      modelName: live.model_name,
      url: live.url,
      contextWindow: live.context_window,
      maxOutputTokens: live.max_output_tokens,
    });

    await updateLLMCapabilityWindow(id, 256_000, 0);
    expect(frozen.contextWindow).toBe(1_000_000);
    expect(frozen.maxOutputTokens).toBe(200_000);
    expect((await resolveLLMRequestConfig()).context_window).toBe(256_000);
    expect((await resolveLLMRequestConfig()).max_output_tokens).toBe(51_200);
  });

  test('restore defaults keeps the saved model capability and mirrors it', async () => {
    await resetDb();
    await seedModel({
      name: 'A',
      context_window: 256_000,
      max_output_tokens: 0,
      is_active: 1,
    });
    await applyContextAutoAllocationV3(1_000_000);
    await restoreContextAutoDefaults();
    expect(await snapshotCapabilities()).toMatchObject([
      expect.objectContaining({
        context_window: 1_000_000,
        max_output_tokens: 0,
      }),
    ]);
    expect(await getContextAutoInput()).toBe(1_000_000);
  });

  test('unknown or unsaved target fails closed without touching capabilities', async () => {
    await resetDb();
    await seedModel({
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 16_000,
      is_active: 1,
    });
    const before = await snapshotCapabilities();
    await expect(
      applyContextAutoAllocationV3(1_000_000, { llmConfigId: 99 }),
    ).rejects.toThrow(/不存在|保存/);
    await expect(updateLLMCapabilityWindow(99, 1_000_000, 0)).rejects.toThrow(
      /不存在/,
    );
    expect(await snapshotCapabilities()).toEqual(before);
  });
});
