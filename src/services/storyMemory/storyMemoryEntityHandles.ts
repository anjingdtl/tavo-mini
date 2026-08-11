import type { StoryMemoryState } from './storyMemoryTypes';

export interface StoryMemoryEntityHandleMap {
  characterByHandle: Map<string, string>;
  relationshipByHandle: Map<string, string>;
  conflictByHandle: Map<string, string>;
  threadByHandle: Map<string, string>;
  foreshadowingByHandle: Map<string, string>;
  arcHandle: string | null;

  reverseCharacter: Map<string, string>;
  reverseRelationship: Map<string, string>;
  reverseConflict: Map<string, string>;
  reverseThread: Map<string, string>;
  reverseForeshadowing: Map<string, string>;
}

export interface StoryMemoryChapterHandle {
  handle: string;
  chapterId: number;
  position: number;
  title: string;
}

export interface StoryMemoryEntityHandleEnvelope extends StoryMemoryEntityHandleMap {
  chapters: StoryMemoryChapterHandle[];
  chapterByHandle: Map<string, StoryMemoryChapterHandle>;
  chapterHandleById: Map<number, string>;
}

function sortedIds(values: string[]): string[] {
  return [...values].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function assignHandles(
  ids: string[],
  prefix: string,
): { forward: Map<string, string>; reverse: Map<string, string> } {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  sortedIds(ids).forEach((id, index) => {
    const handle = `${prefix}${String(index + 1).padStart(2, '0')}`;
    forward.set(handle, id);
    reverse.set(id, handle);
  });
  return { forward, reverse };
}

export function buildStoryMemoryEntityHandles(
  state: StoryMemoryState,
  chapters: Array<{ id: number; position: number; title: string }> = [],
): StoryMemoryEntityHandleEnvelope {
  const characters = assignHandles(Object.keys(state.characters), 'C');
  const relationships = assignHandles(Object.keys(state.relationships), 'R');
  const conflicts = assignHandles(Object.keys(state.mainline.activeConflicts), 'F');
  const threads = assignHandles(Object.keys(state.mainline.openThreads), 'T');
  const foreshadowing = assignHandles(
    Object.keys(state.mainline.foreshadowing),
    'P',
  );

  const orderedChapters = [...chapters].sort((left, right) => left.position - right.position);
  const chapterHandles: StoryMemoryChapterHandle[] = orderedChapters.map(
    (chapter, index) => ({
      handle: `CH${String(index + 1).padStart(2, '0')}`,
      chapterId: chapter.id,
      position: chapter.position,
      title: chapter.title,
    }),
  );
  const currentArcId = state.mainline.currentArc?.id || null;
  return {
    characterByHandle: characters.forward,
    relationshipByHandle: relationships.forward,
    conflictByHandle: conflicts.forward,
    threadByHandle: threads.forward,
    foreshadowingByHandle: foreshadowing.forward,
    arcHandle: currentArcId ? 'A01' : null,
    reverseCharacter: characters.reverse,
    reverseRelationship: relationships.reverse,
    reverseConflict: conflicts.reverse,
    reverseThread: threads.reverse,
    reverseForeshadowing: foreshadowing.reverse,
    chapters: chapterHandles,
    chapterByHandle: new Map(chapterHandles.map(chapter => [chapter.handle, chapter])),
    chapterHandleById: new Map(
      chapterHandles.map(chapter => [chapter.chapterId, chapter.handle]),
    ),
  };
}

export function resolveCharacterHandle(
  value: string,
  handles: StoryMemoryEntityHandleMap,
): string | null {
  return handles.characterByHandle.get(value.trim()) || null;
}

export function resolveRelationshipHandle(
  value: string,
  handles: StoryMemoryEntityHandleMap,
): string | null {
  return handles.relationshipByHandle.get(value.trim()) || null;
}

export function resolveConflictHandle(
  value: string,
  handles: StoryMemoryEntityHandleMap,
): string | null {
  return handles.conflictByHandle.get(value.trim()) || null;
}

export function resolveThreadHandle(
  value: string,
  handles: StoryMemoryEntityHandleMap,
): string | null {
  return handles.threadByHandle.get(value.trim()) || null;
}

export function resolveForeshadowingHandle(
  value: string,
  handles: StoryMemoryEntityHandleMap,
): string | null {
  return handles.foreshadowingByHandle.get(value.trim()) || null;
}
