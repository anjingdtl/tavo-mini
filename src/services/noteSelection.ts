/**
 * Stable, project-local note selection semantics.
 *
 * The persisted V1 shape uses an empty array to mean "all eligible notes".
 * Keep that legacy representation for compatibility, but normalize it at the
 * boundary so callers never confuse it with the effective selected set.
 * Explicitly disabling notes is represented by note mode = "none".
 */

export type NoteSelectionMode = 'all' | 'explicit';

export function normalizeNoteIds(values: readonly unknown[] | null | undefined): number[] {
  const unique = new Set<number>();
  for (const value of values || []) {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) unique.add(id);
  }
  return Array.from(unique);
}
export function effectiveNoteIds(
  storedIds: readonly unknown[] | null | undefined,
  eligibleIds: readonly unknown[],
  noteMode: 'none' | 'style' | 'retrieval' | 'original' = 'style',
): number[] {
  const eligible = normalizeNoteIds(eligibleIds);
  if (noteMode === 'none') return [];

  const stored = normalizeNoteIds(storedIds);
  if (stored.length === 0) return eligible;

  const eligibleSet = new Set(eligible);
  const selected = new Set(stored.filter(id => eligibleSet.has(id)));
  return eligible.filter(id => selected.has(id));
}

/** Convert an effective selection back to the legacy persisted representation. */
export function encodeNoteIdsForStorage(
  selectedIds: readonly unknown[],
  eligibleIds: readonly unknown[],
): number[] {
  const eligible = normalizeNoteIds(eligibleIds);
  const selected = normalizeNoteIds(selectedIds).filter(id =>
    eligible.includes(id),
  );
  if (eligible.length > 0 && selected.length === eligible.length) return [];
  return selected;
}

export function toggleNoteSelection(
  storedIds: readonly unknown[] | null | undefined,
  eligibleIds: readonly unknown[],
  noteId: unknown,
): { selectedIds: number[]; storedIds: number[]; wasSelected: boolean } {
  const normalizedNoteId = Number(noteId);
  const eligible = normalizeNoteIds(eligibleIds);
  const selected = effectiveNoteIds(storedIds, eligible);
  const wasSelected = selected.includes(normalizedNoteId);
  const nextSelected = wasSelected
    ? selected.filter(id => id !== normalizedNoteId)
    : [...selected, normalizedNoteId];
  return {
    selectedIds: nextSelected,
    storedIds: encodeNoteIdsForStorage(nextSelected, eligible),
    wasSelected,
  };
}
