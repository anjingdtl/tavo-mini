/**
 * Stability Phase 4 (layer 1) — generation stage contracts.
 *
 * Verifies the named-stage telemetry helpers and the freeze-time
 * future-source-leakage guard (plan §4.6) as pure units.
 */
import {
  GenerationStageStopwatch,
  assertNoFutureSourceLeakage,
  GENERATION_BUILDER_STAGES,
} from '../src/services/context/generationStageContracts';

describe('GenerationStageStopwatch', () => {
  test('records closed spans in order', async () => {
    const watch = new GenerationStageStopwatch();
    watch.mark('collect');
    await new Promise(resolve => setTimeout(resolve, 5));
    watch.close('collect', 'collect');
    watch.mark('render');
    await new Promise(resolve => setTimeout(resolve, 5));
    watch.close('render', 'render');
    const timings = watch.result();
    expect(timings.map(t => t.stage)).toEqual(['collect', 'render']);
    expect(timings[0].durationMs).toBeGreaterThanOrEqual(4);
    expect(timings[1].durationMs).toBeGreaterThanOrEqual(4);
  });

  test('closing an unmarked stage is a no-op', () => {
    const watch = new GenerationStageStopwatch();
    watch.close('plan', 'plan');
    expect(watch.result()).toEqual([]);
  });
});

describe('assertNoFutureSourceLeakage', () => {
  const chapter = (position: number) =>
    ({
      id: position,
      position,
      title: `c${position}`,
      project_id: 1,
      synopsis: '',
      content: '',
      status: 'draft',
      summary_json: null,
      created_at: '',
      updated_at: '',
    }) as any;

  test('strictly-previous chapters pass', () => {
    expect(() =>
      assertNoFutureSourceLeakage({
        currentPosition: 5,
        previousChapters: [chapter(1), chapter(4)],
        episodicCandidates: [{ position: 2 }, { position: 3 }],
      }),
    ).not.toThrow();
  });

  test('a previous-chapter at/after the current position throws', () => {
    expect(() =>
      assertNoFutureSourceLeakage({
        currentPosition: 5,
        previousChapters: [chapter(1), chapter(5)],
        episodicCandidates: [],
      }),
    ).toThrow('GENERATION_CONTEXT_FUTURE_SOURCE_LEAK');
    expect(() =>
      assertNoFutureSourceLeakage({
        currentPosition: 5,
        previousChapters: [chapter(6)],
        episodicCandidates: [],
      }),
    ).toThrow('GENERATION_CONTEXT_FUTURE_SOURCE_LEAK');
  });

  test('an episodic candidate at/after the current position throws', () => {
    expect(() =>
      assertNoFutureSourceLeakage({
        currentPosition: 5,
        previousChapters: [chapter(1)],
        episodicCandidates: [{ position: 7 }],
      }),
    ).toThrow('GENERATION_CONTEXT_FUTURE_SOURCE_LEAK');
  });

  test('non-finite current position is tolerated (freeform)', () => {
    expect(() =>
      assertNoFutureSourceLeakage({
        currentPosition: Number.NaN,
        previousChapters: [],
        episodicCandidates: [],
      }),
    ).not.toThrow();
  });
});

describe('stage vocabulary', () => {
  test('covers the six plan §4 stages', () => {
    expect(GENERATION_BUILDER_STAGES).toEqual([
      'collect',
      'normalize',
      'plan',
      'allocate',
      'render',
      'freeze',
    ]);
  });
});
