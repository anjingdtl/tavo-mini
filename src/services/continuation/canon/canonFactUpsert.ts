/**
 * Safe Canon fact upsert helpers.
 *
 * Never use `last_insert_rowid()` after conflict updates — evidence must bind
 * to the real business-key row id.
 *
 * Strategy (Android SQLite + sql.js safe):
 *   1. SELECT id by complete business key (non-superseded)
 *   2. If found → explicit UPDATE → return id
 *   3. If not → INSERT
 *   4. On UNIQUE race/constraint → SELECT again → UPDATE → return id
 *
 * INSERT OR IGNORE alone is insufficient on some Android SQLite bridges that
 * still surface SQLITE_CONSTRAINT_UNIQUE (code 2067) to the caller.
 */
import type SQLite from 'react-native-sqlite-storage';
import { execute } from '../../../data/connection/execute';
import { now } from '../../../data/repositories/shared';
import { EXTRACTION_VERSION } from './types';

export function normalizeBusinessKey(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\u200b-\u200d\ufeff]/g, '');
}

/**
 * Normalize title/event_type before write so near-duplicates collapse onto the
 * same business unique key (snapshot + character + event_type + title).
 */
export function normalizeFactTitle(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export interface FactUpsertContext {
  projectId: number;
  sourceId: number;
  snapshotId: string;
  runId: string;
  fromPos: number;
  toPos: number;
  extractionVersion?: string;
}

async function selectId(
  db: SQLite.SQLiteDatabase,
  sql: string,
  params: unknown[],
): Promise<number | null> {
  const [result] = await db.executeSql(sql, params);
  if (result.rows.length === 0) return null;
  return result.rows.item(0).id as number;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message?: unknown }).message ?? '')
          : String(error ?? '');
  return (
    /UNIQUE constraint failed/i.test(message) ||
    /SQLITE_CONSTRAINT_UNIQUE/i.test(message) ||
    /\b2067\b/.test(message) ||
    /constraint failed/i.test(message)
  );
}

/**
 * Merge rules shared by all fact upserts:
 * - confidence: max
 * - description: prefer longer non-empty
 * - last_observed_position: max
 * - first_observed_position: min
 * - review_status: never demote locked/confirmed to pending
 * - analysis_run_id: current run
 */
const REVIEW_PROTECT_SQL = `CASE
  WHEN review_status IN ('locked', 'confirmed') THEN review_status
  ELSE 'pending'
END`;

async function insertOrResolveId(
  db: SQLite.SQLiteDatabase,
  insertSql: string,
  insertParams: unknown[],
  selectSql: string,
  selectParams: unknown[],
  label: string,
): Promise<number> {
  const existing = await selectId(db, selectSql, selectParams);
  if (existing != null) return existing;

  try {
    await execute(db, insertSql, insertParams);
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // Concurrent/batch duplicate: fall through to SELECT.
  }

  const id = await selectId(db, selectSql, selectParams);
  if (id == null) {
    throw new Error(`${label}: failed to resolve id after insert`);
  }
  return id;
}

export async function upsertWorldRule(
  db: SQLite.SQLiteDatabase,
  ctx: FactUpsertContext,
  rule: {
    category: string;
    title: string;
    description: string;
    constraintLevel: string;
    confidence: number;
  },
): Promise<number> {
  const ts = now();
  const extractionVersion = ctx.extractionVersion ?? EXTRACTION_VERSION;
  const title = normalizeFactTitle(rule.title);
  const selectSql = `SELECT id FROM canon_world_rules
      WHERE snapshot_id = ? AND title = ? AND review_status != 'superseded'
      LIMIT 1`;
  const selectParams = [ctx.snapshotId, title];
  const id = await insertOrResolveId(
    db,
    `INSERT INTO canon_world_rules (
      project_id, source_id, snapshot_id, analysis_run_id,
      valid_from_position, valid_to_position, first_observed_position, last_observed_position,
      confidence, review_status, origin, extraction_version, revision, supersedes_id,
      user_reviewed_at, created_at, updated_at,
      category, title, description, constraint_level
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
      ?, ?, ?, ?)`,
    [
      ctx.projectId,
      ctx.sourceId,
      ctx.snapshotId,
      ctx.runId,
      ctx.fromPos,
      ctx.fromPos,
      ctx.toPos,
      rule.confidence,
      extractionVersion,
      ts,
      ts,
      rule.category,
      title,
      rule.description,
      rule.constraintLevel,
    ],
    selectSql,
    selectParams,
    `upsertWorldRule(${title})`,
  );
  await execute(
    db,
    `UPDATE canon_world_rules SET
      analysis_run_id = ?,
      confidence = MAX(confidence, ?),
      description = CASE
        WHEN length(?) > length(COALESCE(description, '')) THEN ?
        ELSE description
      END,
      category = ?,
      constraint_level = ?,
      first_observed_position = MIN(first_observed_position, ?),
      last_observed_position = MAX(last_observed_position, ?),
      review_status = ${REVIEW_PROTECT_SQL},
      updated_at = ?
      WHERE id = ?`,
    [
      ctx.runId,
      rule.confidence,
      rule.description,
      rule.description,
      rule.category,
      rule.constraintLevel,
      ctx.fromPos,
      ctx.toPos,
      ts,
      id,
    ],
  );
  return id;
}

export async function upsertCharacter(
  db: SQLite.SQLiteDatabase,
  ctx: FactUpsertContext,
  ch: {
    canonicalName: string;
    description: string;
    importance: string;
    confidence: number;
  },
): Promise<number> {
  const ts = now();
  const extractionVersion = ctx.extractionVersion ?? EXTRACTION_VERSION;
  const canonicalName = normalizeFactTitle(ch.canonicalName);
  const selectSql = `SELECT id FROM canon_characters
      WHERE snapshot_id = ? AND canonical_name = ? AND review_status != 'superseded'
      LIMIT 1`;
  const selectParams = [ctx.snapshotId, canonicalName];
  const id = await insertOrResolveId(
    db,
    `INSERT INTO canon_characters (
      project_id, source_id, snapshot_id, analysis_run_id,
      valid_from_position, valid_to_position, first_observed_position, last_observed_position,
      confidence, review_status, origin, extraction_version, revision, supersedes_id,
      user_reviewed_at, created_at, updated_at,
      canonical_name, description, background, appearance_json, personality_json,
      values_json, behavior_patterns_json, speech_style_json, abilities_json,
      weaknesses_json, goals_json, fears_json, secrets_json,
      first_appearance_position, importance
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
      ?, ?, '', '{}', '{}', '[]', '[]', '{}', '[]', '[]', '[]', '[]', '[]', ?, ?)`,
    [
      ctx.projectId,
      ctx.sourceId,
      ctx.snapshotId,
      ctx.runId,
      ctx.fromPos,
      ctx.fromPos,
      ctx.toPos,
      ch.confidence,
      extractionVersion,
      ts,
      ts,
      canonicalName,
      ch.description,
      ctx.fromPos,
      ch.importance,
    ],
    selectSql,
    selectParams,
    `upsertCharacter(${canonicalName})`,
  );
  await execute(
    db,
    `UPDATE canon_characters SET
      analysis_run_id = ?,
      confidence = MAX(confidence, ?),
      description = CASE
        WHEN length(?) > length(COALESCE(description, '')) THEN ?
        ELSE description
      END,
      importance = ?,
      first_observed_position = MIN(first_observed_position, ?),
      last_observed_position = MAX(last_observed_position, ?),
      first_appearance_position = MIN(first_appearance_position, ?),
      review_status = ${REVIEW_PROTECT_SQL},
      updated_at = ?
      WHERE id = ?`,
    [
      ctx.runId,
      ch.confidence,
      ch.description,
      ch.description,
      ch.importance,
      ctx.fromPos,
      ctx.toPos,
      ctx.fromPos,
      ts,
      id,
    ],
  );
  return id;
}

export async function upsertRelationship(
  db: SQLite.SQLiteDatabase,
  ctx: FactUpsertContext,
  rel: {
    sourceCharacterId: number;
    targetCharacterId: number;
    relationType: string;
    attitude: string;
    publicStatus: string;
    description: string;
    confidence: number;
  },
): Promise<number> {
  const ts = now();
  const extractionVersion = ctx.extractionVersion ?? EXTRACTION_VERSION;
  const relationType = normalizeFactTitle(rel.relationType);
  const selectSql = `SELECT id FROM canon_relationships
      WHERE snapshot_id = ?
        AND source_character_id = ?
        AND target_character_id = ?
        AND relation_type = ?
        AND review_status != 'superseded'
      LIMIT 1`;
  const selectParams = [
    ctx.snapshotId,
    rel.sourceCharacterId,
    rel.targetCharacterId,
    relationType,
  ];
  const id = await insertOrResolveId(
    db,
    `INSERT INTO canon_relationships (
      project_id, source_id, snapshot_id, analysis_run_id,
      valid_from_position, valid_to_position, first_observed_position, last_observed_position,
      confidence, review_status, origin, extraction_version, revision, supersedes_id,
      user_reviewed_at, created_at, updated_at,
      source_character_id, target_character_id, relation_type, attitude,
      public_status, description, causes_json
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
      ?, ?, ?, ?, ?, ?, '[]')`,
    [
      ctx.projectId,
      ctx.sourceId,
      ctx.snapshotId,
      ctx.runId,
      ctx.fromPos,
      ctx.fromPos,
      ctx.toPos,
      rel.confidence,
      extractionVersion,
      ts,
      ts,
      rel.sourceCharacterId,
      rel.targetCharacterId,
      relationType,
      rel.attitude,
      rel.publicStatus,
      rel.description,
    ],
    selectSql,
    selectParams,
    'upsertRelationship',
  );
  await execute(
    db,
    `UPDATE canon_relationships SET
      analysis_run_id = ?,
      confidence = MAX(confidence, ?),
      description = CASE
        WHEN length(?) > length(COALESCE(description, '')) THEN ?
        ELSE description
      END,
      attitude = ?,
      public_status = ?,
      first_observed_position = MIN(first_observed_position, ?),
      last_observed_position = MAX(last_observed_position, ?),
      review_status = ${REVIEW_PROTECT_SQL},
      updated_at = ?
      WHERE id = ?`,
    [
      ctx.runId,
      rel.confidence,
      rel.description,
      rel.description,
      rel.attitude,
      rel.publicStatus,
      ctx.fromPos,
      ctx.toPos,
      ts,
      id,
    ],
  );
  return id;
}

export async function upsertPlotThread(
  db: SQLite.SQLiteDatabase,
  ctx: FactUpsertContext,
  plot: {
    title: string;
    description: string;
    level: string;
    status: string;
    confidence: number;
    establishedFactsJson: string;
  },
): Promise<number> {
  const ts = now();
  const extractionVersion = ctx.extractionVersion ?? EXTRACTION_VERSION;
  const title = normalizeFactTitle(plot.title);
  const selectSql = `SELECT id FROM canon_plot_threads
      WHERE snapshot_id = ? AND title = ? AND review_status != 'superseded'
      LIMIT 1`;
  const selectParams = [ctx.snapshotId, title];
  const id = await insertOrResolveId(
    db,
    `INSERT INTO canon_plot_threads (
      project_id, source_id, snapshot_id, analysis_run_id,
      valid_from_position, valid_to_position, first_observed_position, last_observed_position,
      confidence, review_status, origin, extraction_version, revision, supersedes_id,
      user_reviewed_at, created_at, updated_at,
      title, description, level, status, importance, start_position,
      last_advanced_position, resolved_position, established_facts_json,
      unresolved_questions_json, expected_directions_json
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
      ?, ?, ?, ?, 0, ?, ?, NULL, ?, '[]', '[]')`,
    [
      ctx.projectId,
      ctx.sourceId,
      ctx.snapshotId,
      ctx.runId,
      ctx.fromPos,
      ctx.fromPos,
      ctx.toPos,
      plot.confidence,
      extractionVersion,
      ts,
      ts,
      title,
      plot.description,
      plot.level,
      plot.status,
      ctx.fromPos,
      ctx.toPos,
      plot.establishedFactsJson,
    ],
    selectSql,
    selectParams,
    `upsertPlotThread(${title})`,
  );
  await execute(
    db,
    `UPDATE canon_plot_threads SET
      analysis_run_id = ?,
      confidence = MAX(confidence, ?),
      description = CASE
        WHEN length(?) > length(COALESCE(description, '')) THEN ?
        ELSE description
      END,
      level = ?,
      status = ?,
      first_observed_position = MIN(first_observed_position, ?),
      last_observed_position = MAX(last_observed_position, ?),
      last_advanced_position = MAX(last_advanced_position, ?),
      start_position = MIN(start_position, ?),
      review_status = ${REVIEW_PROTECT_SQL},
      updated_at = ?
      WHERE id = ?`,
    [
      ctx.runId,
      plot.confidence,
      plot.description,
      plot.description,
      plot.level,
      plot.status,
      ctx.fromPos,
      ctx.toPos,
      ctx.toPos,
      ctx.fromPos,
      ts,
      id,
    ],
  );
  return id;
}

export async function upsertExperience(
  db: SQLite.SQLiteDatabase,
  ctx: FactUpsertContext,
  exp: {
    characterId: number;
    eventType: string;
    title: string;
    description: string;
    importance: number;
    confidence: number;
    chapterPosition: number;
  },
): Promise<number> {
  const ts = now();
  const extractionVersion = ctx.extractionVersion ?? EXTRACTION_VERSION;
  // Normalize business-key fields so cross-batch / model near-duplicates hit
  // the same UNIQUE index entry instead of throwing SQLITE_CONSTRAINT_UNIQUE.
  const eventType = normalizeFactTitle(exp.eventType);
  const title = normalizeFactTitle(exp.title);
  const selectSql = `SELECT id FROM canon_character_experiences
      WHERE snapshot_id = ?
        AND character_id = ?
        AND event_type = ?
        AND title = ?
        AND review_status != 'superseded'
      LIMIT 1`;
  const selectParams = [ctx.snapshotId, exp.characterId, eventType, title];
  const id = await insertOrResolveId(
    db,
    `INSERT INTO canon_character_experiences (
      project_id, source_id, snapshot_id, analysis_run_id,
      valid_from_position, valid_to_position, first_observed_position, last_observed_position,
      confidence, review_status, origin, extraction_version, revision, supersedes_id,
      user_reviewed_at, created_at, updated_at,
      character_id, chapter_position, event_type, title, description,
      involved_character_ids_json, impact_on_personality, impact_on_goal,
      impact_on_relationship, knowledge_gained_json, secrets_learned_json, importance
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
      ?, ?, ?, ?, ?, '[]', NULL, NULL, NULL, '[]', '[]', ?)`,
    [
      ctx.projectId,
      ctx.sourceId,
      ctx.snapshotId,
      ctx.runId,
      exp.chapterPosition,
      exp.chapterPosition,
      exp.chapterPosition,
      exp.confidence,
      extractionVersion,
      ts,
      ts,
      exp.characterId,
      exp.chapterPosition,
      eventType,
      title,
      exp.description,
      exp.importance,
    ],
    selectSql,
    selectParams,
    `upsertExperience(${title})`,
  );
  await execute(
    db,
    `UPDATE canon_character_experiences SET
      analysis_run_id = ?,
      confidence = MAX(confidence, ?),
      description = CASE
        WHEN length(?) > length(COALESCE(description, '')) THEN ?
        ELSE description
      END,
      importance = MAX(importance, ?),
      first_observed_position = MIN(first_observed_position, ?),
      last_observed_position = MAX(last_observed_position, ?),
      review_status = ${REVIEW_PROTECT_SQL},
      updated_at = ?
      WHERE id = ?`,
    [
      ctx.runId,
      exp.confidence,
      exp.description,
      exp.description,
      exp.importance,
      exp.chapterPosition,
      exp.chapterPosition,
      ts,
      id,
    ],
  );
  return id;
}
