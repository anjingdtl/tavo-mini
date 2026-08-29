/**
 * C2-CORRECTION regression: a continuation batch item's targetWords must
 * survive the adapter -> targetChapterChars -> settingsOverride -> Freeze
 * boundary. The project default is intentionally 3000 in this fixture.
 */
jest.mock('../src/services/writing/scenario/continuationSourceCollection', () => ({
  buildContinuationV5Context: jest.fn(),
}));

jest.mock('../src/services/writing/scenario/continuationWritingAdapter', () => ({
  adaptContinuationWritingSources: jest.fn(({ userInstruction }: any) => ({
    bundle: {},
    trace: { userInstruction },
  })),
}));

jest.mock('../src/services/continuation/generation/generationRepository', () => ({
  ensureGenerationSettings: jest.fn(async () => ({
    targetChapterChars: 3_000,
    strictnessProfile: 'balanced',
  })),
}));

jest.mock('../src/services/contextAutoAllocator', () => ({
  ensureContextAutomationPolicy: jest.fn(async () => ({
    schemaVersion: 2,
    allocatorVersion: 'test',
  })),
}));

jest.mock('../src/services/continuation/generation/continuationV5Models', () => ({
  freezeContinuationThinking: jest.fn((_modelName: string, thinking: any) => thinking),
  resolveV5StageModels: jest.fn(),
}));

jest.mock('../src/services/writing/unifiedWritingKernel', () => ({
  buildWritingKernelFreezeTrace: jest.fn(({ request }: any) => ({
    frozenContext: { targetChars: request.targetChars },
    trace: { freezeFingerprint: `freeze-${request.targetChars}` },
  })),
}));

import { prepareContinuationRun } from '../src/services/writing/scenario/continuationRunPreparation';

const sourceCollectionMock = jest.requireMock(
  '../src/services/writing/scenario/continuationSourceCollection',
) as { buildContinuationV5Context: jest.Mock };
const modelsMock = jest.requireMock(
  '../src/services/continuation/generation/continuationV5Models',
) as { resolveV5StageModels: jest.Mock };

function model() {
  return {
    configId: 1,
    name: 'GLM fixture',
    providerType: 'openai_compatible' as const,
    providerAdapterId: 'open.bigmodel.cn-v4',
    url: 'https://example.invalid/v1',
    modelName: 'GLM-5.3-Flash',
    contextWindow: 1_000_000,
    maxOutputTokens: 200_000,
    thinking: { type: 'enabled' as const },
  };
}

function fakeStageBudget() {
  return { maximumOutputTokens: 200_000 };
}

function fakeSnapshot(targetChapterChars: number, userInstruction: string) {
  const frozen = model();
  return {
    projectId: 1,
    targetChapterId: 2,
    targetPosition: 0,
    inputRevisionHash: `input-${targetChapterChars}`,
    generationTraceId: `generation-${targetChapterChars}`,
    settingsSnapshot: {
      values: { targetChapterChars },
      frozenModelConfigs: {
        writer: frozen,
        draftWriter: frozen,
        finalReviser: frozen,
      },
    },
    bundles: {
      userInstruction,
      seam: { excerpt: '边界尾部' },
    },
    contextBudget: {
      modelContextLimit: 1_000_000,
      reservedOutputTokens: 200_000,
    },
    stageBudgets: {
      draft_writer: fakeStageBudget(),
      unified_qa: fakeStageBudget(),
      narrative_architect: fakeStageBudget(),
      revision_writer: fakeStageBudget(),
      adversarial_auditor: fakeStageBudget(),
      final_reviser: fakeStageBudget(),
    },
  } as any;
}

describe('C2-CORRECTION batch target demand plumbing', () => {
  beforeEach(() => {
    sourceCollectionMock.buildContinuationV5Context.mockImplementation(
      async (input: any) => {
        const target = Number(
          input.settingsOverride?.targetChapterChars ?? 3_000,
        );
        return {
          snapshot: fakeSnapshot(target, input.userInstruction),
          trace: {},
        };
      },
    );
    modelsMock.resolveV5StageModels.mockResolvedValue({
      activeConfigId: 1,
      stageModels: {
        draft_writer: model(),
        narrative_architect: model(),
        revision_writer: model(),
        adversarial_auditor: model(),
        unified_qa: model(),
        final_reviser: model(),
      },
      frozenModelConfigs: {
        writer: model(),
        draftWriter: model(),
        finalReviser: model(),
      },
    });
  });

  test.each([500, 1_000, 3_000])(
    'freezes %s instead of silently using project default 3000',
    async targetChapterChars => {
      const prepared = await prepareContinuationRun({
        projectId: 1,
        chapterId: 2,
        targetPosition: 0,
        targetChapterChars,
        userInstruction: `批次目标-${targetChapterChars}`,
        currentChapterContent: '',
        executionProfile: 'standard',
      });

      expect(sourceCollectionMock.buildContinuationV5Context).toHaveBeenCalledWith(
        expect.objectContaining({
          settingsOverride: { targetChapterChars },
        }),
      );
      expect(prepared.snapshot.settingsSnapshot.values.targetChapterChars).toBe(
        targetChapterChars,
      );
      expect(prepared.kernelRequest.targetChars).toBe(targetChapterChars);
      expect(prepared.kernelFreeze.frozenContext.targetChars).toBe(
        targetChapterChars,
      );
      if (targetChapterChars !== 3_000) {
        expect(prepared.kernelRequest.targetChars).not.toBe(3_000);
      }
    },
  );
});
