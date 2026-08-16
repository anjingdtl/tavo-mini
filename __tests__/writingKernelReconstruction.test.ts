import {
  WRITING_GOLDEN_FIXTURES,
  type WritingGoldenFixture,
} from '../src/services/writing/regression/writingGoldenFixtures';
import {
  replayWritingDecisionsX10,
} from '../src/services/writing/replay/writingReplay';
import {
  buildWritingKernelFreezeTrace,
  runWritingKernel,
} from '../src/services/writing/unifiedWritingKernel';
import type { WritingRequest } from '../src/services/writing/contracts/writingSource';

function requestForFixture(fixture: WritingGoldenFixture): WritingRequest {
  return {
    writingRunId: `wr_fixture_${fixture.id}`,
    generationTraceId: `gt_fixture_${fixture.id}`,
    projectId: 7,
    chapterId: 11,
    scenario: fixture.scenario,
    instruction: {
      title: 'Fixture chapter',
      synopsis: '推进本章并保持连续性。',
      userInstruction: '推进本章并保持连续性。',
      currentContent: '上一章正文。',
      targetPosition: 3,
    },
    sourceBundle: fixture.bundle,
    model: {
      configId: 3,
      provider: 'fixture',
      modelName: 'fixture-model',
      contextWindow: 1_500_000,
      maxOutputTokens: 4096,
    },
    policy: {
      version: 1,
      reviewMode: 'full',
      strictness: 'fail-closed',
      values: { fixture: true },
    },
  };
}

describe('Writing Kernel Reconstruction — Context / Replay / Golden', () => {
  test('all Golden fixtures build the same frozen contract shape', () => {
    for (const fixture of WRITING_GOLDEN_FIXTURES) {
      const request = requestForFixture(fixture);
      const replay = replayWritingDecisionsX10(request);
      expect(replay).toHaveLength(10);
      expect(new Set(replay.map(item => item.sourceFingerprint)).size).toBe(1);
      expect(new Set(replay.map(item => item.contextPlanFingerprint)).size).toBe(1);
      expect(new Set(replay.map(item => item.allocationFingerprint)).size).toBe(1);
      expect(new Set(replay.map(item => item.renderFingerprint)).size).toBe(1);
      expect(new Set(replay.map(item => item.freezeFingerprint)).size).toBe(1);
      expect(replay.every(item => item.fingerprintDiff.length === 0)).toBe(true);
    }
  });

  test('runWritingKernel drives the unified stage loop from one freeze binding', async () => {
    const request = requestForFixture(WRITING_GOLDEN_FIXTURES[0]);
    let persistedStages: string[] | null = null;
    const executed: string[] = [];
    const result = await runWritingKernel({
      createDriver: async () => {
        const frozen = buildWritingKernelFreezeTrace({ request });
        const stages = [
          'draft',
          'review',
          'audit',
          'revision',
          'finalValidate',
          'persist',
          'postWritingUpdate',
        ] as const;
        let i = 0;
        return {
          durableBinding: 'outline-pipeline-tasks' as const,
          async step() {
            if (i === 0) {
              i += 1;
              return { kind: 'freeze', ...frozen };
            }
            const idx = i - 1;
            i += 1;
            const stage = stages[Math.floor(idx / 2)];
            if (!stage) {
              return { kind: 'terminal' as const, reason: 'completed' as const, result: 'persisted' };
            }
            const status = idx % 2 === 0 ? ('started' as const) : ('completed' as const);
            executed.push(`${stage}:${status}`);
            return { kind: 'stage' as const, stage, action: 'test', status };
          },
          async finalize() {},
        };
      },
      persistTrace: async trace => {
        persistedStages = trace.events.map(event => event.stage);
      },
    });
    expect(result.result).toBe('persisted');
    expect(result.trace!.events.map(event => event.stage).slice(0, 6)).toEqual([
      'collect',
      'normalize',
      'plan',
      'allocate',
      'render',
      'freeze',
    ]);
    expect(result.trace!.silentContextLossCount).toBe(0);
    expect(result.trace!.unexpectedLiveReadCount).toBe(0);
    expect(persistedStages).toEqual(result.trace!.events.map(event => event.stage));
    expect(persistedStages).toContain('postWritingUpdate');
    expect(executed[0]).toBe('draft:started');
    expect(executed[executed.length - 1]).toBe('postWritingUpdate:completed');
  });

  test('runWritingKernel fail-closes on a second authoritative freeze', async () => {
    const request = requestForFixture(WRITING_GOLDEN_FIXTURES[0]);
    const frozen = buildWritingKernelFreezeTrace({ request });
    let freezes = 0;
    await expect(
      runWritingKernel({
        createDriver: async () => ({
          durableBinding: 'outline-pipeline-tasks' as const,
          async step() {
            freezes += 1;
            if (freezes <= 2) return { kind: 'freeze' as const, ...frozen };
            return { kind: 'terminal' as const, reason: 'completed' as const };
          },
          async finalize() {},
        }),
      }),
    ).rejects.toThrow(/second authoritative Freeze/);
  });

  test('runWritingKernel fail-closes on pre-freeze stage execution', async () => {
    await expect(
      runWritingKernel({
        createDriver: async () => ({
          durableBinding: 'outline-pipeline-tasks' as const,
          async step() {
            return { kind: 'stage' as const, stage: 'draft' as const, action: 'test', status: 'started' as const };
          },
          async finalize() {},
        }),
      }),
    ).rejects.toThrow(/before the authoritative Freeze/);
  });
});
