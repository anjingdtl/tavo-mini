/**
 * Shared fixtures for Canon analysis integration tests.
 *
 * Provides:
 *  - `seedCanonBaseline(db, opts)` — inserts the minimal FK chain
 *    (project → source → chapter → snapshot) every Canon test needs.
 *  - `makeBoundedChapter(...)` — builds a BoundedSourceChapter with correct
 *    UTF-16 ranges for offset assertions.
 *  - `seedSourceTextChunk(...)` — inserts a continuation_source_text_chunks
 *    row so SourceReader.readTextRange can read it back.
 *  - `seedCanonFactWithEvidence(...)` — inserts a fact + evidence + link.
 */
import type { InMemorySqliteDb } from './canonInMemoryDb';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../../src/services/continuation/continuationSourceRepository';
import type { BoundedSourceChapter } from '../../src/services/continuation/types';

export interface CanonBaselineSeed {
  projectId: number;
  sourceId: number;
  chapterId: number;
  snapshotId: string;
  runId: string;
  /** boundary_char_offset_exclusive — set large enough that no test evidence
   * is treated as future leakage. */
  boundaryExclusive: number;
}

/**
 * Seed the minimal FK chain a Canon evidence/materialization test needs:
 * one project, one source, one chapter, one staging snapshot.
 */
export async function seedCanonBaseline(
  db: InMemorySqliteDb,
  opts: Partial<CanonBaselineSeed> = {},
): Promise<CanonBaselineSeed> {
  const projectId = opts.projectId ?? 1;
  const sourceId = opts.sourceId ?? 1;
  const chapterId = opts.chapterId ?? 1;
  const snapshotId = opts.snapshotId ?? 'snap-test';
  const runId = opts.runId ?? 'run-test';
  const boundaryExclusive = opts.boundaryExclusive ?? 1_000_000;

  await db.executeSql(
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (?, 'test', 'continuation', 't', 't')`,
    [projectId],
  );
  await db.executeSql(
    `INSERT INTO continuation_sources
      (id, project_id, version, status, display_name, original_file_name,
       detected_encoding, raw_sha256, normalized_sha256,
       normalized_char_count, normalized_byte_count, file_size_bytes,
       parser_version, normalization_version, created_at, updated_at)
     VALUES (?, ?, 1, 'ready', 'src', 'src.txt', 'UTF-8', 'x', 'y', ?, ?, ?,
             'v1', 'v1', 't', 't')`,
    [sourceId, projectId, boundaryExclusive, boundaryExclusive * 2, boundaryExclusive * 2],
  );
  await db.executeSql(
    `INSERT INTO continuation_source_chapters
      (id, source_id, position, detected_title, title, content_sha256,
       char_count, paragraph_count, source_start_offset,
       content_start_offset, source_end_offset, created_at, updated_at)
     VALUES (?, ?, 0, '第一章', '第一章', 'ch', ?, 1, 0, 0, ?, 't', 't')`,
    [chapterId, sourceId, boundaryExclusive, boundaryExclusive],
  );
  await db.executeSql(
    `INSERT INTO continuation_canon_snapshots
      (id, project_id, source_id, analysis_run_id, source_version,
       source_sha256, parser_version, normalization_version,
       boundary_chapter_id, boundary_position, boundary_char_offset_exclusive,
       extraction_version, profile, status, revision,
       capabilities_json, coverage_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 'y', 'v1', 'v1', ?, 0, ?,
             'v1', 'standard', 'staging', 1, '{}', '{}', 't', 't')`,
    [snapshotId, projectId, sourceId, runId, chapterId, boundaryExclusive],
  );
  return {
    projectId,
    sourceId,
    chapterId,
    snapshotId,
    runId,
    boundaryExclusive,
  };
}

/**
 * Build a BoundedSourceChapter for unit/integration tests. `range.start`/`end`
 * are UTF-16 offsets; the caller controls them so offset arithmetic can be
 * asserted precisely.
 */
export function makeBoundedChapter(input: {
  id: number;
  sourceId?: number;
  position: number;
  title: string;
  content: string;
  rangeStart: number;
  clippedByBoundary?: boolean;
}): BoundedSourceChapter {
  const start = input.rangeStart;
  const end = start + input.content.length;
  return {
    id: input.id,
    sourceId: input.sourceId ?? 1,
    position: asSourcePosition(input.position),
    title: input.title,
    content: input.content,
    range: {
      start: asUtf16Offset(start),
      end: asUtf16Offset(end),
    },
    clippedByBoundary: input.clippedByBoundary ?? false,
  };
}

/**
 * Insert one continuation_source_text_chunks row. SourceReader.readTextRange
 * reads the canon text authority from this table, so evidence read-back tests
 * seed it here.
 */
export async function seedSourceTextChunk(
  db: InMemorySqliteDb,
  sourceId: number,
  chunkIndex: number,
  charStart: number,
  content: string,
): Promise<void> {
  await db.executeSql(
    `INSERT INTO continuation_source_text_chunks
      (source_id, chunk_index, char_start_offset, char_end_offset,
       content, content_sha256, file_index)
     VALUES (?, ?, ?, ?, ?, 'sha', 0)`,
    [sourceId, chunkIndex, charStart, charStart + content.length, content],
  );
}

/**
 * Insert a continuation_analysis_runs row so the governance FK
 * `analysis_run_id REFERENCES continuation_analysis_runs(id)` is satisfied for
 * any canon fact row. Must be called after {@link seedCanonBaseline}.
 */
export async function seedAnalysisRun(
  db: InMemorySqliteDb,
  base: CanonBaselineSeed,
  opts: { profile?: 'quick' | 'standard' | 'deep' } = {},
): Promise<void> {
  await db.executeSql(
    `INSERT INTO continuation_analysis_runs
      (id, project_id, source_id, source_version, source_sha256,
       parser_version, normalization_version, boundary_chapter_id,
       boundary_position, boundary_char_offset_exclusive, canon_snapshot_id,
       profile, model_config_id, state, stage, progress_current,
       progress_total, extraction_version, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'y', 'v1', 'v1', ?, 0, ?, ?, ?, NULL, 'running',
       'chapter_extraction', 0, 0, 'v1', 't', 't')`,
    [
      base.runId,
      base.projectId,
      base.sourceId,
      base.chapterId,
      base.boundaryExclusive,
      base.snapshotId,
      opts.profile ?? 'standard',
    ],
  );
}

/**
 * Insert a canon fact row + an evidence row + an evidence_link row, returning
 * the inserted ids. Used to set up "existing data that must not be touched by a
 * targeted rescan" scenarios. Each fact table has its own column layout.
 *
 * Requires {@link seedAnalysisRun} to have been called first (governance FK).
 */
export async function seedCanonFactWithEvidence(
  db: InMemorySqliteDb,
  input: {
    projectId: number;
    sourceId: number;
    snapshotId: string;
    runId: string;
    chapterId: number;
    boundaryExclusive: number;
    table: 'canon_world_rules' | 'canon_plot_threads' | 'canon_character_experiences';
    title: string;
    charStart: number;
    charEnd: number;
    quotePreview: string;
    validFromPosition?: number;
  },
): Promise<{ factId: number; evidenceId: number }> {
  const ts = 't';
  const fromPos = input.validFromPosition ?? 0;
  const ownerType =
    input.table === 'canon_world_rules'
      ? 'world_rule'
      : input.table === 'canon_plot_threads'
        ? 'plot_thread'
        : 'experience';

  let factId: number;
  if (input.table === 'canon_world_rules') {
    const [res] = await db.executeSql(
      `INSERT INTO canon_world_rules
        (project_id, source_id, snapshot_id, analysis_run_id,
         valid_from_position, first_observed_position, last_observed_position,
         confidence, review_status, origin, extraction_version, revision,
         created_at, updated_at,
         category, title, description, constraint_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'ai', 'v1', 1, ?, ?,
         'other', ?, ?, 'reference')`,
      [
        input.projectId,
        input.sourceId,
        input.snapshotId,
        input.runId,
        fromPos,
        fromPos,
        fromPos,
        0.9,
        ts,
        ts,
        input.title,
        input.title,
      ],
    );
    factId = res.insertId!;
  } else if (input.table === 'canon_plot_threads') {
    const [res] = await db.executeSql(
      `INSERT INTO canon_plot_threads
        (project_id, source_id, snapshot_id, analysis_run_id,
         valid_from_position, first_observed_position, last_observed_position,
         confidence, review_status, origin, extraction_version, revision,
         created_at, updated_at,
         title, description, level, status, importance, start_position,
         last_advanced_position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'ai', 'v1', 1, ?, ?,
         ?, ?, 'subplot', 'ongoing', 'normal', ?, ?)`,
      [
        input.projectId,
        input.sourceId,
        input.snapshotId,
        input.runId,
        fromPos,
        fromPos,
        fromPos,
        0.9,
        ts,
        ts,
        input.title,
        input.title,
        fromPos,
        fromPos,
      ],
    );
    factId = res.insertId!;
  } else {
    // canon_character_experiences requires a character_id FK. Seed a minimal
    // character first so the experience has a valid owner.
    const [charRes] = await db.executeSql(
      `INSERT INTO canon_characters
        (project_id, source_id, snapshot_id, analysis_run_id,
         valid_from_position, first_observed_position, last_observed_position,
         confidence, review_status, origin, extraction_version, revision,
         created_at, updated_at, canonical_name, importance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'ai', 'v1', 1, ?, ?,
         ?, 'supporting')`,
      [
        input.projectId,
        input.sourceId,
        input.snapshotId,
        input.runId,
        fromPos,
        fromPos,
        fromPos,
        0.9,
        ts,
        ts,
        input.title,
      ],
    );
    const charId = charRes.insertId!;
    const [res] = await db.executeSql(
      `INSERT INTO canon_character_experiences
        (project_id, source_id, snapshot_id, analysis_run_id,
         valid_from_position, first_observed_position, last_observed_position,
         confidence, review_status, origin, extraction_version, revision,
         created_at, updated_at,
         character_id, chapter_position, event_type, title, description, importance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'ai', 'v1', 1, ?, ?,
         ?, ?, 'event', ?, ?, 'normal')`,
      [
        input.projectId,
        input.sourceId,
        input.snapshotId,
        input.runId,
        fromPos,
        fromPos,
        fromPos,
        0.9,
        ts,
        ts,
        charId,
        fromPos,
        input.title,
        input.title,
      ],
    );
    factId = res.insertId!;
  }

  const [evRes] = await db.executeSql(
    `INSERT INTO canon_evidence
      (project_id, source_id, snapshot_id, chapter_id, chapter_position,
       paragraph_start, paragraph_end, char_start, char_end, quote_preview,
       quote_sha256, analysis_run_id, created_at)
     VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, 'sha', ?, ?)`,
    [
      input.projectId,
      input.sourceId,
      input.snapshotId,
      input.chapterId,
      input.charStart,
      input.charEnd,
      input.quotePreview,
      input.runId,
      ts,
    ],
  );
  const evidenceId = evRes.insertId!;
  await db.executeSql(
    `INSERT INTO canon_evidence_links
      (evidence_id, snapshot_id, owner_type, owner_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [evidenceId, input.snapshotId, ownerType, factId, ts],
  );
  return { factId, evidenceId };
}
