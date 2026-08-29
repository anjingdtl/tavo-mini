import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import {
  buildWritingGovernorProfilesCreateSql,
  migrateV59ToV60,
} from '../src/services/migrations/v59-to-v60';
import {
  createWritingGovernorProfileStore,
  completeWritingGovernorShadow,
  decideWritingGovernorWire,
  getWritingGovernorProfileStore,
  markWritingGovernorProfileStoreHydrated,
  readWritingGovernorProfile,
  resetWritingGovernorProfileStore,
  resolveWritingGovernorShadow,
} from '../src/services/writing/governor/writingGovernor';
import {
  hydrateWritingGovernorProfiles,
  persistWritingGovernorProfile,
  createWritingGovernorProfilePersistence,
} from '../src/services/writing/governor/writingGovernorProfileRepository';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { createCurrentSchemaStatements } from '../src/data/schema/createCurrentSchema';
import { executeSharedWriterStage } from '../src/services/writing/stages/writerCore';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import { outlineRequest } from './helpers/oneShotFixtures';

const SHADOW_INPUT = {
  stage: 'draft',
  messages: [{ role: 'user' as const, content: 'durable aggregate test' }],
  legacyWireMax: 131072,
  contextWindow: 128000,
  completionCapability: 131072,
  providerWireCeiling: 131072,
  providerAdapterId: 'test-adapter',
  modelName: 'test-model',
  targetChars: 1000,
  outputContract: 'prose' as const,
  qualityProfile: 'standard',
  executionProfile: 'standard',
  thinking: { type: 'enabled' as const },
  reasoningEffort: 'high' as const,
};

describe('Phase III-C C3 durable Governor aggregate', () => {
  afterEach(() => {
    resetWritingGovernorProfileStore();
  });

  it('creates a narrow aggregate table without content-shaped columns', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await migrateV59ToV60(db as any);
      const [result] = await db.executeSql(
        'PRAGMA table_info(writing_governor_profiles)',
      );
      const columns = Array.from({ length: result.rows.length }, (_, index) =>
        String(result.rows.item(index).name),
      );
      expect(columns).toEqual([
        'profile_key',
        'policy_version',
        'sample_count',
        'known_result_count',
        'low_utilization_count',
        'length_signal_count',
        'recommended_scale',
        'average_completion_ratio',
        'average_latency_ms',
        'reasoning_sample_count',
        'reasoning_ratio_ewma',
        'reasoning_ratio_high_water',
        'reasoning_prompt_ratio_ewma',
        'reasoning_prompt_ratio_high_water',
        'last_finish_reason',
        'updated_at',
      ]);
      expect(columns).not.toEqual(
        expect.arrayContaining([
          'prompt',
          'messages',
          'body',
          'canon',
          'story_memory',
          'payload_json',
        ]),
      );

      await migrateV59ToV60(db as any);
      const [again] = await db.executeSql(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'writing_governor_profiles'",
      );
      expect(Number(again.rows.item(0).count)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('round-trips only aggregate state and hydrates it after a process restart', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await migrateV59ToV60(db as any);
      const coldStore = createWritingGovernorProfileStore();
      const shadow = resolveWritingGovernorShadow(SHADOW_INPUT, coldStore);
      completeWritingGovernorShadow(
        shadow,
        {
          actualCompletionUsage: 4200,
          visibleOutput: 2400,
          reasoningUsage: 1800,
          finishReason: 'stop',
          latencyMs: 1200,
          businessResultValid: true,
          failureClass: null,
        },
        coldStore,
      );
      const profile = readWritingGovernorProfile(coldStore, shadow.profileKey);
      expect(profile).not.toBeNull();

      await persistWritingGovernorProfile(db as any, profile!);
      const persistence = createWritingGovernorProfilePersistence(db as any);
      await persistence.flush();
      const [stored] = await db.executeSql(
        'SELECT * FROM writing_governor_profiles WHERE profile_key = ?',
        [shadow.profileKey],
      );
      const storedJson = JSON.stringify(stored.rows.item(0));
      expect(storedJson).not.toContain('durable aggregate test');

      resetWritingGovernorProfileStore();
      await hydrateWritingGovernorProfiles(db as any);
      const restored = resolveWritingGovernorShadow(SHADOW_INPUT, getWritingGovernorProfileStore());
      expect(restored.profileKey).toBe(shadow.profileKey);
      expect(restored.profileSampleCount).toBe(1);
      expect(restored.reasoningEnvelope).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('exposes the same table in fresh schema and backup manifest', () => {
    expect(createCurrentSchemaStatements()).toContain(
      buildWritingGovernorProfilesCreateSql(),
    );
    const manifest = SCHEMA_MANIFEST.find(
      table => table.name === 'writing_governor_profiles',
    );
    expect(manifest?.backup).toBe(false);
    expect(manifest?.columns).toContain('profile_key');
  });

  it('uses the bounded recommendation only when it still satisfies Demand Floor', () => {
    const shadow = resolveWritingGovernorShadow(SHADOW_INPUT);
    const enabled = decideWritingGovernorWire(shadow, true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.blocked).toBe(false);
    expect(enabled.wireMax).toBeLessThan(SHADOW_INPUT.legacyWireMax);
    expect(enabled.wireMax).toBeGreaterThanOrEqual(shadow.demandFloor);

    const blockedShadow = resolveWritingGovernorShadow({
      ...SHADOW_INPUT,
      contextWindow: 100,
      completionCapability: 100,
      providerWireCeiling: 100,
      targetChars: 3000,
    });
    const blocked = decideWritingGovernorWire(blockedShadow, true);
    expect(blocked.blocked).toBe(true);
    expect(blocked.wireMax).toBeNull();
    expect(blocked.reason).toBe('demand_exceeds_hard_ceiling');
  });

  it('takes over Draft wire budget after hydration while retaining legacy shadow metadata', async () => {
    const { frozenContext, trace } = buildWritingKernelFreezeTrace({
      request: outlineRequest({
        pipelineTopologyVersion: 'compact_standard',
        qualityProfile: 'standard',
        targetChapterChars: 500,
      }),
    });
    const stageInput = {
      frozenContext,
      artifacts: {},
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
      trace,
      modelConfig: {
        configId: frozenContext.model.configId,
        name: frozenContext.model.name || 'cfg',
        providerType: frozenContext.model.provider,
        providerAdapterId: frozenContext.model.providerAdapterId,
        url: frozenContext.model.url || '',
        modelName: frozenContext.model.modelName,
        contextWindow: frozenContext.model.contextWindow,
        maxOutputTokens: frozenContext.model.maxOutputTokens,
      },
      callStage: jest.fn(async () => ({
        text: 'C3 Draft 正文。',
        inputTokens: 12,
        outputTokens: 6,
        totalTokens: 18,
        visibleOutputTokens: 6,
        finishReason: 'stop',
      })),
    } as any;
    const compiled = compileSharedWritingPrompt({
      stage: 'draft',
      frozenContext,
      artifacts: {},
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
    });
    const legacy = Math.min(
      compiled.maxTokens,
      Math.max(256, stageInput.modelConfig.maxOutputTokens || compiled.maxTokens),
    );
    markWritingGovernorProfileStoreHydrated(true);

    const artifact = await executeSharedWriterStage({
      stage: 'draft',
      stageInput,
    });
    const receipt = artifact.requestReceipts?.[0] as any;
    const wire = stageInput.callStage.mock.calls[0][0].maxTokens;

    expect(wire).toBeLessThan(legacy);
    expect(wire).toBe(receipt.governorShadow.recommendedWireMax);
    expect(receipt.governorShadow.legacyWireMax).toBe(legacy);
    expect(receipt.governorShadow.thinkingEnabled).toBe(true);
  });
});
