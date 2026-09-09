import {
  effectiveNoteIds,
  encodeNoteIdsForStorage,
  toggleNoteSelection,
} from '../src/services/noteSelection';

describe('project note selection', () => {
  it.each([49, 50, 51, 100, 200])(
    'toggles stable note ids correctly for %d eligible notes',
    count => {
      const eligible = Array.from({ length: count }, (_, index) => index + 1);

      const afterRemovingLast = toggleNoteSelection([], eligible, count);
      expect(afterRemovingLast.selectedIds).toHaveLength(count - 1);
      expect(afterRemovingLast.selectedIds).not.toContain(count);
      expect(afterRemovingLast.storedIds).toHaveLength(count - 1);

      const afterRestoringLast = toggleNoteSelection(
        afterRemovingLast.storedIds,
        eligible,
        count,
      );
      expect(afterRestoringLast.selectedIds).toEqual(eligible);
      // Preserve the legacy compact representation: [] means all eligible.
      expect(afterRestoringLast.storedIds).toEqual([]);
    },
  );

  it('treats a legacy empty list as all eligible notes, including newly imported notes', () => {
    expect(effectiveNoteIds([], [1, 2, 3])).toEqual([1, 2, 3]);
    expect(effectiveNoteIds([1], [1, 2, 3])).toEqual([1]);
    expect(encodeNoteIdsForStorage([1, 2, 3], [1, 2, 3])).toEqual([]);
  });

  it('filters stale ids without using array indexes and keeps project collection filtering separate', () => {
    expect(effectiveNoteIds([51, 100, 999], [51, 100, 200])).toEqual([51, 100]);
    expect(toggleNoteSelection([51, 100], [51, 100, 200], 200)).toEqual({
      selectedIds: [51, 100, 200],
      storedIds: [],
      wasSelected: false,
    });
  });

  it('allows the note-mode none state to expose an empty effective context', () => {
    expect(effectiveNoteIds([], [1, 2, 3], 'none')).toEqual([]);
  });
});
