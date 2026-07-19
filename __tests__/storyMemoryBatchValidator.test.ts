import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import { validateStoryMemoryBatchPatch } from '../src/services/storyMemory/storyMemoryBatchValidator';
import type { Chapter } from '../src/types/novel';

function chapter(position: number, content: string): Chapter {
  return {
    id: position + 1,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: '',
    content,
    status: 'final',
    summary_json: null,
    created_at: '',
    updated_at: '',
  };
}

describe('validateStoryMemoryBatchPatch', () => {
  const chapters = [
    chapter(0, '林岚推开暗门走进钟楼。'),
    chapter(1, '林岚在钟楼找到银钥匙。'),
    chapter(2, '林岚带着银钥匙离开钟楼。'),
  ];

  function validRaw() {
    return {
      schemaVersion: 2,
      rangeRef: {
        fromChapterId: 1,
        fromPosition: 0,
        throughChapterId: 3,
        throughPosition: 2,
      },
      chapterSummaries: chapters.map(item => ({
        chapterId: item.id,
        chapterPosition: item.position,
        brief: `事件${item.position + 1}`,
        keywords: [],
        events: [],
        characterChanges: [],
        relationshipChanges: [],
        mainlineChanges: [],
        newThreads: [],
        resolvedThreads: [],
      })),
      newCharacters: [
        {
          tempRef: 'new_char_lan',
          canonicalName: '林岚',
          aliases: [],
          role: '调查员',
          identity: '',
          stableTraits: [],
          initialState: { location: '钟楼外' },
          status: 'active',
          evidence: [{ chapterId: 1, quote: '林岚推开暗门' }],
        },
      ],
      characterUpdates: [],
      newRelationships: [],
      relationshipUpdates: [],
      mainlinePatch: {
        currentArcUpdate: {
          action: 'none',
          arcRef: '',
          name: '',
          summary: '',
          evidence: [],
        },
        conflictUpserts: [],
        threadOpens: [],
        threadUpdates: [],
        threadResolutions: [],
        foreshadowingUpserts: [],
        timelineAnchors: [],
        completedBeats: [],
      },
    };
  }

  it('accepts a well-formed 3-chapter batch patch', () => {
    const draft = validateStoryMemoryBatchPatch(
      validRaw(),
      createEmptyStoryMemory(1),
      chapters,
    );
    expect(draft.schemaVersion).toBe(2);
    expect(draft.chapterSummaries).toHaveLength(3);
    expect(draft.newCharacters[0].canonicalName).toBe('林岚');
  });

  it('rejects range mismatch and empty brief', () => {
    const badRange = validRaw();
    badRange.rangeRef.throughPosition = 99;
    expect(() =>
      validateStoryMemoryBatchPatch(
        badRange,
        createEmptyStoryMemory(1),
        chapters,
      ),
    ).toThrow(/range/);

    const badBrief = validRaw();
    badBrief.chapterSummaries[0].brief = '';
    expect(() =>
      validateStoryMemoryBatchPatch(
        badBrief,
        createEmptyStoryMemory(1),
        chapters,
      ),
    ).toThrow(/brief/);
  });

  it('rejects evidence outside batch chapters or not in body', () => {
    const bad = validRaw();
    bad.newCharacters[0].evidence = [
      { chapterId: 1, quote: '这段原文并不存在于任何章节' },
    ];
    expect(() =>
      validateStoryMemoryBatchPatch(bad, createEmptyStoryMemory(1), chapters),
    ).toThrow(/证据/);
  });

  it('rejects non-object payloads and wrong schema version', () => {
    expect(() =>
      validateStoryMemoryBatchPatch(null, createEmptyStoryMemory(1), chapters),
    ).toThrow(/JSON 对象/);
    const bad = validRaw() as any;
    bad.schemaVersion = 1;
    expect(() =>
      validateStoryMemoryBatchPatch(bad, createEmptyStoryMemory(1), chapters),
    ).toThrow(/schemaVersion/);
  });
});
