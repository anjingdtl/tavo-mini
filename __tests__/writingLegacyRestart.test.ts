import {
  fingerprintWritingSourceBundle,
  restartLegacyWritingTask,
} from '../src/services/writing';
import { WRITING_GOLDEN_FIXTURES } from '../src/services/writing/regression/writingGoldenFixtures';

describe('Writing Legacy Restart / Execution Compatibility = NO', () => {
  it('creates new run, trace and preserves only legacy task provenance', () => {
    const fixture = WRITING_GOLDEN_FIXTURES[0];
    const request = restartLegacyWritingTask({
      legacyTaskId: 'pt_legacy_1',
      projectId: 1,
      chapterId: 2,
      scenario: fixture.scenario,
      instruction: {
        title: '第一章',
        synopsis: '继续',
        userInstruction: '继续',
        currentContent: '',
        targetPosition: 0,
      },
      sourceBundle: fixture.bundle,
      model: {
        configId: 3,
        provider: 'openai_compatible',
        modelName: 'test-model',
        contextWindow: 128000,
        maxOutputTokens: 4096,
      },
      policy: {
        version: 1,
        reviewMode: 'full',
        strictness: 'balanced',
        values: {},
      },
    });
    expect(request.writingRunId).not.toBe('pt_legacy_1');
    expect(request.generationTraceId).toMatch(/^gt_/);
    expect(request.legacyRestart).toEqual({ restartedFromLegacyTaskId: 'pt_legacy_1' });
    expect((request as any).checkpoint).toBeUndefined();
    expect((request as any).frozenContext).toBeUndefined();
    expect(fingerprintWritingSourceBundle(request.sourceBundle)).toBe(fingerprintWritingSourceBundle(fixture.bundle));
  });
});
