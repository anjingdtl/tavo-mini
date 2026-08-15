import {
  WRITING_GOLDEN_FIXTURES,
  type WritingGoldenFixture,
} from '../src/services/writing/regression/writingGoldenFixtures';
import {
  replayWritingDecisionsX10,
} from '../src/services/writing/replay/writingReplay';
import { runWritingKernel } from '../src/services/writing/unifiedWritingKernel';
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

  test('runWritingKernel records one pre-freeze chain and delegates a frozen contract', async () => {
    const request = requestForFixture(WRITING_GOLDEN_FIXTURES[0]);
    const result = await runWritingKernel({
      request,
      execution: {
        execute: async ({ frozenContext, emitStage }) => {
          expect(frozenContext.freezeFingerprint).toMatch(/^[a-f0-9]{64}$/);
          expect(frozenContext.rendered.text).toContain('【');
          emitStage('draft', 'started');
          emitStage('draft', 'completed');
          emitStage('review', 'completed');
          emitStage('audit', 'completed');
          emitStage('revision', 'completed');
          emitStage('finalValidate', 'completed');
          emitStage('persist', 'completed');
          emitStage('postWritingUpdate', 'completed');
          return 'persisted';
        },
      },
    });
    expect(result.result).toBe('persisted');
    expect(result.trace.events.map(event => event.stage).slice(0, 6)).toEqual([
      'collect',
      'normalize',
      'plan',
      'allocate',
      'render',
      'freeze',
    ]);
    expect(result.trace.silentContextLossCount).toBe(0);
    expect(result.trace.unexpectedLiveReadCount).toBe(0);
  });
});
