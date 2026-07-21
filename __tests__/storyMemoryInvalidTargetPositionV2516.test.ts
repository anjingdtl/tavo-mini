/**
 * V2.5.16 — illegal target chapter position must hard-block context prepare
 * BEFORE coverage planning / checkpoint advance / rebuild / LLM / Episodic /
 * Renderer.
 *
 * Illegal checkpoint through alone remains a safe degrade (no inject, coverage
 * from -1, generation allowed to continue via fallback).
 */

import type { Chapter } from '../src/types/novel';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import type { ProjectStoryMemoryRecord } from '../src/data/repositories/storyMemoryRepository';
import {
  describeCheckpointEligibility,
  buildContext,
  renderPreparedStoryMemoryContext,
} from '../src/services/contextBuilder';
import {
  resolveUsableCheckpointForTarget,
  isValidChapterPosition,
} from '../src/services/storyMemory/storyMemoryCheckpointEligibility';
import {
  prepareStoryMemoryForGeneration,
  INVALID_TARGET_CHAPTER_POSITION_MESSAGE,
} from '../src/services/storyMemory/storyMemoryPrepare';
import * as storyMemoryCoverage from '../src/services/storyMemory/storyMemoryCoverage';
import * as episodicMemoryRetriever from '../src/services/episodicMemoryRetriever';
import * as contextBuilder from '../src/services/contextBuilder';

const mockGetChapters = jest.fn();
const mockGetMemory = jest.fn();
const mockEnsure = jest.fn();
const mockWithLock = jest.fn();
const mockAdvance = jest.fn();
const mockRebuild = jest.fn();
const mockChatCompletion = jest.fn();

jest.mock('../src/services/database', () => ({
  getChaptersByProject: (...args: any[]) => mockGetChapters(...args),
  getProjectStoryMemory: (...args: any[]) => mockGetMemory(...args),
  ensureProjectStoryMemoryRow: (...args: any[]) => mockEnsure(...args),
  getCharactersByProject: jest.fn().mockResolvedValue([]),
  getWorldbookEntriesByProject: jest.fn().mockResolvedValue([]),
  getNotesByProject: jest.fn().mockResolvedValue([]),
  getActivePreset: jest.fn().mockResolvedValue(null),
  getProject: jest.fn().mockResolvedValue({ id: 1, title: 't', synopsis: '' }),
  getProjectNoteConfig: jest.fn().mockResolvedValue(null),
  getPlotlinesByProject: jest.fn().mockResolvedValue([]),
}));

// Dynamic imports inside prepare() generation hardDue path — intercept so we
// can prove invalid-target returns never load/advance/rebuild/LLM.
jest.mock('../src/services/storyMemory/storyMemoryService', () => ({
  withProjectMemoryLock: (...args: any[]) => mockWithLock(...args),
}));
jest.mock('../src/services/storyMemory/storyMemoryCheckpointService', () => ({
  advanceStoryMemoryCheckpointsUnlocked: (...args: any[]) =>
    mockAdvance(...args),
}));
jest.mock('../src/services/storyMemory/storyMemoryRebuild', () => ({
  rebuildStoryMemoryUnlocked: (...args: any[]) => mockRebuild(...args),
}));
jest.mock('../src/services/llm', () => ({
  chatCompletion: (...args: any[]) => mockChatCompletion(...args),
  streamChatCompletion: jest.fn(),
}));

function chapter(position: number, content = '正文'): Chapter {
  return {
    id: Number.isFinite(position) ? position + 1 : 99,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: '',
    content,
    status: 'final',
    summary_json: null,
    memory_summary: `摘要${position}`,
    created_at: '',
    updated_at: '',
  };
}

function cleanRecord(
  through: number,
  status: ProjectStoryMemoryRecord['status'] = 'clean',
): ProjectStoryMemoryRecord {
  const state = createEmptyStoryMemory(1);
  state.throughChapterPosition = through;
  state.throughChapterId = through >= 0 ? through + 1 : null;
  state.characters.future_leak = {
    id: 'future_leak',
    canonicalName: '未来角色',
    aliases: [],
    role: '',
    immutableProfile: { identity: '', stableTraits: [], affiliations: [] },
    currentState: {
      location: '',
      physicalState: '',
      emotionalState: '',
      currentGoal: '',
      knowledge: ['未来秘密'],
      possessions: [],
      secrets: ['未来秘密'],
    },
    status: 'active',
    firstSeenChapterId: 1,
    firstSeenPosition: 0,
    lastChangedChapterId: 1,
    lastChangedPosition: 0,
    evidenceChapterIds: [1],
  };
  return {
    state,
    status,
    dirtyFromPosition: status === 'dirty' ? 0 : null,
    lastError: '',
    updatedAt: '',
  };
}

/** Narrow helper: only unusable results may carry invalidPositionSource. */
function sourceOf(
  result: ReturnType<typeof resolveUsableCheckpointForTarget>,
): 'target' | 'checkpoint' | undefined {
  return result.usable ? undefined : result.invalidPositionSource;
}

const INVALID_TARGETS: Array<{ label: string; value: number }> = [
  { label: '-1', value: -1 },
  { label: '2.5', value: 2.5 },
  { label: 'NaN', value: Number.NaN },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
];

function expectDownstreamNeverCalled(planSpy: jest.SpyInstance) {
  expect(planSpy).not.toHaveBeenCalled();
  expect(mockWithLock).not.toHaveBeenCalled();
  expect(mockAdvance).not.toHaveBeenCalled();
  expect(mockRebuild).not.toHaveBeenCalled();
  expect(mockChatCompletion).not.toHaveBeenCalled();
  expect(mockEnsure).not.toHaveBeenCalled();
}

describe('V2.5.16 invalidPositionSource discrimination', () => {
  it.each(INVALID_TARGETS)(
    'target=$label → invalidPositionSource=target',
    ({ value }) => {
      const result = resolveUsableCheckpointForTarget(cleanRecord(1), value);
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('invalid_position');
      expect(sourceOf(result)).toBe('target');
      expect(result.checkpoint).toBeNull();
      expect(result.checkpointThroughPosition).toBe(-1);
    },
  );

  it('through=-1 → invalidPositionSource=checkpoint', () => {
    const result = resolveUsableCheckpointForTarget(cleanRecord(-1), 5);
    expect(result.usable).toBe(false);
    expect(result.reason).toBe('invalid_position');
    expect(sourceOf(result)).toBe('checkpoint');
    expect(result.checkpoint).toBeNull();
    expect(result.checkpointThroughPosition).toBe(-1);
  });

  it('through=2.5 → invalidPositionSource=checkpoint', () => {
    const cp = cleanRecord(2);
    (cp.state as any).throughChapterPosition = 2.5;
    const result = resolveUsableCheckpointForTarget(cp, 5);
    expect(result.reason).toBe('invalid_position');
    expect(sourceOf(result)).toBe('checkpoint');
  });

  it('other reasons do not set invalidPositionSource', () => {
    expect(sourceOf(resolveUsableCheckpointForTarget(null, 5))).toBeUndefined();
    expect(
      sourceOf(resolveUsableCheckpointForTarget(cleanRecord(1, 'dirty'), 5)),
    ).toBeUndefined();
    expect(
      sourceOf(resolveUsableCheckpointForTarget(cleanRecord(8), 5)),
    ).toBeUndefined();
    expect(
      sourceOf(resolveUsableCheckpointForTarget(cleanRecord(1), 5)),
    ).toBeUndefined();
  });
});

describe('V2.5.16 describeCheckpointEligibility copy', () => {
  it.each(INVALID_TARGETS)(
    'target=$label copy points at target, not checkpoint',
    ({ value }) => {
      const eligibility = resolveUsableCheckpointForTarget(cleanRecord(1), value);
      const text = describeCheckpointEligibility(eligibility);
      expect(text).toBe('目标章节位置无效，无法安全构建故事上下文');
      expect(text).not.toContain('检查点位置无效');
      expect(text).not.toContain('未注入长期故事状态');
    },
  );

  it('checkpoint through illegal copy points at checkpoint', () => {
    const eligibility = resolveUsableCheckpointForTarget(cleanRecord(-1), 5);
    const text = describeCheckpointEligibility(eligibility);
    expect(text).toBe(
      '故事记忆检查点位置无效，本次未注入长期故事状态',
    );
    expect(text).not.toContain('目标章节位置无效');
  });

  it('through=2.5 copy points at checkpoint', () => {
    const cp = cleanRecord(2);
    (cp.state as any).throughChapterPosition = 2.5;
    const text = describeCheckpointEligibility(
      resolveUsableCheckpointForTarget(cp, 5),
    );
    expect(text).toContain('检查点位置无效');
    expect(text).not.toContain('目标章节位置无效');
  });

  it('target vs checkpoint copy strings are distinct', () => {
    const targetText = describeCheckpointEligibility(
      resolveUsableCheckpointForTarget(cleanRecord(1), -1),
    );
    const checkpointText = describeCheckpointEligibility(
      resolveUsableCheckpointForTarget(cleanRecord(-1), 5),
    );
    expect(targetText).not.toBe(checkpointText);
  });
});

describe('V2.5.16 prepareStoryMemoryForGeneration — invalid target hard-blocks', () => {
  let planSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    planSpy = jest.spyOn(storyMemoryCoverage, 'planStoryMemoryCoverage');
    mockGetChapters.mockResolvedValue([chapter(0), chapter(1)]);
    mockGetMemory.mockResolvedValue(cleanRecord(0));
    mockWithLock.mockImplementation(async (_id: number, fn: () => Promise<void>) =>
      fn(),
    );
    mockAdvance.mockResolvedValue(undefined);
    mockRebuild.mockResolvedValue(undefined);
    mockChatCompletion.mockResolvedValue({ content: 'should-not-run' });
  });

  afterEach(() => {
    planSpy.mockRestore();
  });

  it.each(INVALID_TARGETS)(
    'preview mode target=$label: blocked; no coverage/advance/rebuild/LLM',
    async ({ value }) => {
      const result = await prepareStoryMemoryForGeneration(
        1,
        chapter(value),
        { slidingWindowSize: 4000 } as any,
        { mode: 'preview' },
      );
      expect(result.blocked).toBe(true);
      expect(result.blockReason).toBe(INVALID_TARGET_CHAPTER_POSITION_MESSAGE);
      expect(result.checkpoint).toBeNull();
      expect(result.checkpointUpdated).toBe(false);
      expect(result.checkpointEligibility.reason).toBe('invalid_position');
      expect(sourceOf(result.checkpointEligibility)).toBe('target');
      expect(result.coverage.reason).toBe('invalid_target_position');
      expect(result.coverage.hardDue).toBe(false);
      expect(result.coverage.checkpointThroughPosition).toBe(-1);
      expectDownstreamNeverCalled(planSpy);
    },
  );

  it.each(INVALID_TARGETS)(
    'generation mode target=$label: blocked; no coverage/advance/rebuild/LLM',
    async ({ value }) => {
      const result = await prepareStoryMemoryForGeneration(
        1,
        chapter(value),
        { slidingWindowSize: 4000 } as any,
        { mode: 'generation' },
      );
      expect(result.blocked).toBe(true);
      expect(result.blockReason).toContain('目标章节位置无效');
      expectDownstreamNeverCalled(planSpy);
    },
  );

  it('legal target + illegal checkpoint through: NOT blocked, plans from -1', async () => {
    mockGetMemory.mockResolvedValue(cleanRecord(-1));
    const chapters = [chapter(0), chapter(1), chapter(2)];
    mockGetChapters.mockResolvedValue(chapters);
    const result = await prepareStoryMemoryForGeneration(
      1,
      chapters[2],
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );
    expect(result.blocked).toBe(false);
    expect(result.checkpoint).toBeNull();
    expect(sourceOf(result.checkpointEligibility)).toBe('checkpoint');
    expect(result.coverage.checkpointThroughPosition).toBe(-1);
    expect(planSpy).toHaveBeenCalled();
    expect(planSpy.mock.calls[0][0].checkpointThroughPosition).toBe(-1);
    // Fallback path must not hard-block generation solely for illegal through.
    expect(result.blockReason).toBe('');
    expect(mockAdvance).not.toHaveBeenCalled();
    expect(mockRebuild).not.toHaveBeenCalled();
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });
});

describe('V2.5.16 buildContext — invalid target fails before assembly', () => {
  let planSpy: jest.SpyInstance;
  let scoreSpy: jest.SpyInstance;
  let selectSpy: jest.SpyInstance;
  let renderSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChapters.mockResolvedValue([chapter(0)]);
    mockGetMemory.mockResolvedValue(cleanRecord(0));
    planSpy = jest.spyOn(storyMemoryCoverage, 'planStoryMemoryCoverage');
    scoreSpy = jest.spyOn(episodicMemoryRetriever, 'scoreMemoryCandidates');
    selectSpy = jest.spyOn(episodicMemoryRetriever, 'selectMemoryCandidates');
    renderSpy = jest.spyOn(contextBuilder, 'renderPreparedStoryMemoryContext');
  });

  afterEach(() => {
    planSpy.mockRestore();
    scoreSpy.mockRestore();
    selectSpy.mockRestore();
    renderSpy.mockRestore();
  });

  it.each(INVALID_TARGETS)(
    'buildContext preview target=$label: throw; no coverage/episodic/renderer/LLM',
    async ({ value }) => {
      await expect(
        buildContext(
          chapter(value),
          { slidingWindowSize: 4000, strategy: 'sliding' } as any,
          1,
          undefined,
          { storyMemoryMode: 'preview' },
        ),
      ).rejects.toThrow(/目标章节位置无效/);
      expectDownstreamNeverCalled(planSpy);
      expect(scoreSpy).not.toHaveBeenCalled();
      expect(selectSpy).not.toHaveBeenCalled();
      expect(renderSpy).not.toHaveBeenCalled();
    },
  );

  it.each(INVALID_TARGETS)(
    'buildContext generation target=$label: throw; no coverage/episodic/renderer/LLM',
    async ({ value }) => {
      await expect(
        buildContext(
          chapter(value),
          { slidingWindowSize: 4000, strategy: 'sliding' } as any,
          1,
          undefined,
          { storyMemoryMode: 'generation' },
        ),
      ).rejects.toThrow(INVALID_TARGET_CHAPTER_POSITION_MESSAGE);
      expectDownstreamNeverCalled(planSpy);
      expect(scoreSpy).not.toHaveBeenCalled();
      expect(selectSpy).not.toHaveBeenCalled();
      expect(renderSpy).not.toHaveBeenCalled();
    },
  );

  it('legal target + illegal through does not hard-fail solely for checkpoint', async () => {
    expect(isValidChapterPosition(2.5)).toBe(false);
    const cp = cleanRecord(0);
    (cp.state as any).throughChapterPosition = 2.5;
    mockGetMemory.mockResolvedValue(cp);
    const chapters = [chapter(0), chapter(1)];
    mockGetChapters.mockResolvedValue(chapters);
    const prepared = await prepareStoryMemoryForGeneration(
      1,
      chapters[1],
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );
    expect(prepared.blocked).toBe(false);
    expect(prepared.checkpoint).toBeNull();
    expect(prepared.coverage.checkpointThroughPosition).toBe(-1);
    expect(sourceOf(prepared.checkpointEligibility)).toBe('checkpoint');
  });

  it('renderPreparedStoryMemoryContext is not reached when target is illegal', async () => {
    // Direct sanity: the Renderer entry used by buildContext is never invoked
    // after the blocked prepare throw (spy already asserts call count above).
    // Keep an explicit call-count assertion for the shared export.
    await expect(
      buildContext(
        chapter(Number.NaN),
        { slidingWindowSize: 4000, strategy: 'sliding' } as any,
        1,
        undefined,
        { storyMemoryMode: 'generation' },
      ),
    ).rejects.toThrow(/目标章节位置无效/);
    expect(renderPreparedStoryMemoryContext).toBe(
      contextBuilder.renderPreparedStoryMemoryContext,
    );
    expect(renderSpy).not.toHaveBeenCalled();
  });
});
