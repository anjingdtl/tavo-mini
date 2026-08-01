/**
 * Versioned continuation style profile persistence (Spec §6.1, §9).
 *
 * Data-access layer for the rebuilt `continuation_style_profiles` table. The
 * Context Builder reads cached profiles through here and must validate the
 * source fingerprint + boundary before injection (invariant: a stale profile
 * whose source/boundary drifted must never be injected). UI and generation go
 * through the analysis service / context builder, not this repository directly.
 */
import { openDatabase } from '../../../data/connection/openDatabase';
import { all, one } from '../../../data/connection/query';
import { execute } from '../../../data/connection/execute';
import { now, type Row } from '../../../data/repositories/shared';
import { STYLE_ANALYZER_VERSION } from './styleAnalysisPrompt';

export type StyleProfileState =
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'outdated';

export type StyleProfileReviewStatus = 'pending' | 'confirmed' | 'ignored';

/**
 * Fingerprint bundle that must match the live source snapshot before a profile
 * can be injected. Captured at analysis time and re-checked on every read so a
 * source/boundary change invalidates stale profiles (Spec §4, §9).
 */
export interface StyleProfileFingerprint {
  sourceId: number;
  sourceVersion: number;
  sourceSha256: string;
  parserVersion: string;
  normalizationVersion: string;
  boundaryChapterId: number;
  boundaryPosition: number;
  boundaryCharOffsetExclusive: number;
}

export interface ContinuationStyleProfileRow {
  id: string;
  projectId: number;
  sourceId: number;
  sourceVersion: number;
  sourceSha256: string;
  parserVersion: string;
  normalizationVersion: string;
  boundaryChapterId: number;
  boundaryPosition: number;
  boundaryCharOffsetExclusive: number;
  analysisRunId: string;
  canonSnapshotId: string;
  profileSchemaVersion: number;
  analyzerVersion: string;
  profileJson: Record<string, unknown>;
  metricsJson: Record<string, unknown>;
  sampleRefsJson: unknown[];
  userOverridesJson: Record<string, unknown>;
  profileHash: string;
  confidence: number;
  state: StyleProfileState;
  reviewStatus: StyleProfileReviewStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRow(r: Row): ContinuationStyleProfileRow {
  return {
    id: r.id,
    projectId: r.project_id,
    sourceId: r.source_id,
    sourceVersion: r.source_version,
    sourceSha256: r.source_sha256,
    parserVersion: r.parser_version,
    normalizationVersion: r.normalization_version,
    boundaryChapterId: r.boundary_chapter_id,
    boundaryPosition: r.boundary_position,
    boundaryCharOffsetExclusive: r.boundary_char_offset_exclusive,
    analysisRunId: r.analysis_run_id,
    canonSnapshotId: r.canon_snapshot_id,
    profileSchemaVersion: r.profile_schema_version,
    analyzerVersion: r.analyzer_version,
    profileJson: parseJson(r.profile_json, {}),
    metricsJson: parseJson(r.metrics_json, {}),
    sampleRefsJson: parseJson(r.sample_refs_json, []),
    userOverridesJson: parseJson(r.user_overrides_json, {}),
    profileHash: r.profile_hash,
    confidence: r.confidence,
    state: r.state,
    reviewStatus: r.review_status,
    errorCode: r.error_code ?? null,
    errorMessage: r.error_message ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at ?? null,
  };
}

export async function getStyleProfileById(
  id: string,
): Promise<ContinuationStyleProfileRow | null> {
  const row = await one<Row>(
    'SELECT * FROM continuation_style_profiles WHERE id = ?',
    [id],
  );
  return row ? mapRow(row) : null;
}

export async function listStyleProfilesForProject(
  projectId: number,
): Promise<ContinuationStyleProfileRow[]> {
  const rows = await all<Row>(
    `SELECT * FROM continuation_style_profiles
      WHERE project_id = ?
      ORDER BY updated_at DESC`,
    [projectId],
  );
  return rows.map(mapRow);
}

export interface InsertStyleProfileInput {
  id: string;
  projectId: number;
  fingerprint: StyleProfileFingerprint;
  analysisRunId: string;
  canonSnapshotId: string;
  profileSchemaVersion: number;
  analyzerVersion: string;
  profileHash: string;
  confidence: number;
  state: StyleProfileState;
  reviewStatus?: StyleProfileReviewStatus;
  /**
   * User overrides to carry into the new row (Spec §5.7). On re-analysis the
   * auto `profile_json` is replaced, but user overrides must survive — pass the
   * prior profile's overrides here. Defaults to empty when omitted.
   */
  userOverridesJson?: Record<string, unknown>;
}

export async function insertStyleProfile(
  input: InsertStyleProfileInput,
): Promise<void> {
  const ts = now();
  const db = await openDatabase();
  const userOverrides = JSON.stringify(input.userOverridesJson ?? {});
  await db.executeSql(
    `INSERT INTO continuation_style_profiles (
      id, project_id, source_id, source_version, source_sha256,
      parser_version, normalization_version,
      boundary_chapter_id, boundary_position, boundary_char_offset_exclusive,
      analysis_run_id, canon_snapshot_id,
      profile_schema_version, analyzer_version,
      profile_json, metrics_json, sample_refs_json, user_overrides_json,
      profile_hash, confidence, state, review_status,
      error_code, error_message, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', '[]', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
    [
      input.id,
      input.projectId,
      input.fingerprint.sourceId,
      input.fingerprint.sourceVersion,
      input.fingerprint.sourceSha256,
      input.fingerprint.parserVersion,
      input.fingerprint.normalizationVersion,
      input.fingerprint.boundaryChapterId,
      input.fingerprint.boundaryPosition,
      input.fingerprint.boundaryCharOffsetExclusive,
      input.analysisRunId,
      input.canonSnapshotId,
      input.profileSchemaVersion,
      input.analyzerVersion,
      userOverrides,
      input.profileHash,
      input.confidence,
      input.state,
      input.reviewStatus ?? 'pending',
      ts,
      ts,
    ],
  );
}

export interface UpdateStyleProfilePayloadInput {
  profileJson: Record<string, unknown>;
  metricsJson: Record<string, unknown>;
  sampleRefsJson: unknown[];
  profileHash: string;
  confidence: number;
}

export async function updateStyleProfilePayload(
  id: string,
  payload: UpdateStyleProfilePayloadInput,
  patch: {
    state?: StyleProfileState;
    completedAt?: string | null;
    analysisRunId?: string;
    canonSnapshotId?: string;
  } = {},
): Promise<void> {
  const ts = now();
  const db = await openDatabase();
  await db.executeSql(
    `UPDATE continuation_style_profiles SET
      profile_json = ?, metrics_json = ?, sample_refs_json = ?,
      profile_hash = ?, confidence = ?,
      ${patch.analysisRunId ? 'analysis_run_id = ?, ' : ''}
      ${patch.canonSnapshotId ? 'canon_snapshot_id = ?, ' : ''}
      ${patch.state ? 'state = ?, ' : ''}
      completed_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      JSON.stringify(payload.profileJson),
      JSON.stringify(payload.metricsJson),
      JSON.stringify(payload.sampleRefsJson),
      payload.profileHash,
      payload.confidence,
      ...(patch.analysisRunId ? [patch.analysisRunId] : []),
      ...(patch.canonSnapshotId ? [patch.canonSnapshotId] : []),
      ...(patch.state ? [patch.state] : []),
      patch.completedAt ?? null,
      ts,
      id,
    ],
  );
}

export async function updateStyleProfileState(
  id: string,
  state: StyleProfileState,
  patch: {
    errorCode?: string | null;
    errorMessage?: string | null;
    completedAt?: string | null;
  } = {},
): Promise<void> {
  const ts = now();
  const db = await openDatabase();
  await db.executeSql(
    `UPDATE continuation_style_profiles SET
      state = ?, error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      state,
      patch.errorCode ?? null,
      patch.errorMessage ?? null,
      patch.completedAt ?? null,
      ts,
      id,
    ],
  );
}

export async function updateStyleProfileReviewStatus(
  id: string,
  reviewStatus: StyleProfileReviewStatus,
): Promise<void> {
  const ts = now();
  const db = await openDatabase();
  await db.executeSql(
    `UPDATE continuation_style_profiles SET review_status = ?, updated_at = ?
      WHERE id = ?`,
    [reviewStatus, ts, id],
  );
}

export async function saveStyleProfileUserOverrides(
  id: string,
  userOverridesJson: Record<string, unknown>,
): Promise<void> {
  const ts = now();
  const db = await openDatabase();
  await db.executeSql(
    `UPDATE continuation_style_profiles SET user_overrides_json = ?, updated_at = ?
      WHERE id = ?`,
    [JSON.stringify(userOverridesJson), ts, id],
  );
}

/**
 * Remove a style profile row that matches the given fingerprint but is in a
 * non-ready state (running / failed / interrupted / cancelled / outdated).
 *
 * Used by retryStyleAnalysis to free the UNIQUE fingerprint slot before
 * runStyleAnalysis INSERTs a fresh profile row. Without this, retrying a
 * failed style analysis hits SQLite UNIQUE constraint
 * (idx_continuation_style_profiles_fingerprint) and silently fails — see
 * BUG-007.
 *
 * A running row can be left behind by process death or a paused request, so it
 * is also stale when a new attempt is explicitly starting. Ready and active
 * profiles are NEVER touched here; only retry attempts are.
 *
 * Returns the number of rows removed.
 */
export async function deleteStyleProfileByFingerprint(
  projectId: number,
  fingerprint: StyleProfileFingerprint,
): Promise<number> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `DELETE FROM continuation_style_profiles
       WHERE project_id = ?
         AND source_id = ?
         AND source_version = ?
         AND source_sha256 = ?
         AND parser_version = ?
         AND normalization_version = ?
         AND boundary_chapter_id = ?
         AND boundary_position = ?
         AND boundary_char_offset_exclusive = ?
         AND analyzer_version = ?
         AND state IN ('running', 'failed', 'interrupted', 'cancelled', 'outdated')`,
    [
      projectId,
      fingerprint.sourceId,
      fingerprint.sourceVersion,
      fingerprint.sourceSha256,
      fingerprint.parserVersion,
      fingerprint.normalizationVersion,
      fingerprint.boundaryChapterId,
      fingerprint.boundaryPosition,
      fingerprint.boundaryCharOffsetExclusive,
      STYLE_ANALYZER_VERSION,
    ],
  );
  return res.rowsAffected ?? 0;
}

/**
 * Mark profiles whose fingerprint no longer matches the live source/boundary as
 * outdated. Used by the invalidation chain when source or boundary changes
 * (Spec §12). Returns the count of invalidated profiles.
 */
export async function invalidateStyleProfilesForProject(
  projectId: number,
  exceptFingerprint: StyleProfileFingerprint | null,
): Promise<number> {
  const ts = now();
  const db = await openDatabase();
  if (!exceptFingerprint) {
    const [res] = await db.executeSql(
      `UPDATE continuation_style_profiles SET state = 'outdated', updated_at = ?
        WHERE project_id = ? AND state NOT IN ('outdated', 'cancelled')`,
      [ts, projectId],
    );
    return res.rowsAffected;
  }
  const [res] = await db.executeSql(
    `UPDATE continuation_style_profiles SET state = 'outdated', updated_at = ?
      WHERE project_id = ?
        AND state NOT IN ('outdated', 'cancelled')
        AND NOT (
          source_id = ? AND source_version = ? AND source_sha256 = ?
          AND boundary_chapter_id = ? AND boundary_position = ?
          AND boundary_char_offset_exclusive = ?
        )`,
    [
      ts,
      projectId,
      exceptFingerprint.sourceId,
      exceptFingerprint.sourceVersion,
      exceptFingerprint.sourceSha256,
      exceptFingerprint.boundaryChapterId,
      exceptFingerprint.boundaryPosition,
      exceptFingerprint.boundaryCharOffsetExclusive,
    ],
  );
  return res.rowsAffected;
}

/**
 * Read the active style profile for a project and validate it against the live
 * source fingerprint + boundary. Returns null when there is no active profile,
 * the profile is not ready, has been ignored, or its fingerprint/boundary has
 * drifted (Spec §9). This is the single injection-safe read the Context Builder
 * must use — never read the table directly.
 */
export async function getInjectableStyleProfile(
  projectId: number,
  fingerprint: StyleProfileFingerprint,
): Promise<ContinuationStyleProfileRow | null> {
  const db = await openDatabase();
  await db.executeSql(
    `UPDATE continuation_style_profiles
       SET state = 'outdated', updated_at = ?
     WHERE project_id = ?
       AND state = 'ready'
       AND analyzer_version != ?`,
    [now(), projectId, STYLE_ANALYZER_VERSION],
  );
  const [res] = await db.executeSql(
    `SELECT s.* FROM continuation_style_profiles s
      JOIN continuation_settings st ON st.project_id = s.project_id
      WHERE s.project_id = ?
        AND st.active_style_profile_id = s.id
        AND s.state = 'ready'
        AND s.review_status != 'ignored'
        AND s.analyzer_version = ?
        AND s.source_id = ? AND s.source_version = ? AND s.source_sha256 = ?
        AND s.parser_version = ? AND s.normalization_version = ?
        AND s.boundary_chapter_id = ? AND s.boundary_position = ?
        AND s.boundary_char_offset_exclusive = ?
      LIMIT 1`,
    [
      projectId,
      STYLE_ANALYZER_VERSION,
      fingerprint.sourceId,
      fingerprint.sourceVersion,
      fingerprint.sourceSha256,
      fingerprint.parserVersion,
      fingerprint.normalizationVersion,
      fingerprint.boundaryChapterId,
      fingerprint.boundaryPosition,
      fingerprint.boundaryCharOffsetExclusive,
    ],
  );
  if (res.rows.length === 0) return null;
  return mapRow(res.rows.item(0));
}

/**
 * Set the active style profile pointer inside a transaction (callers wrap in
 * executeTransaction together with the Canon activation). allowNull clears the
 * pointer (explicit user skip).
 */
export async function setActiveStyleProfileId(
  projectId: number,
  styleProfileId: string | null,
): Promise<void> {
  const ts = now();
  await execute(
    await openDatabase(),
    `UPDATE continuation_settings SET active_style_profile_id = ?, updated_at = ?
      WHERE project_id = ?`,
    [styleProfileId, ts, projectId],
  );
}

export async function getActiveStyleProfileId(
  projectId: number,
): Promise<string | null> {
  const row = await one<Row>(
    'SELECT active_style_profile_id AS id FROM continuation_settings WHERE project_id = ?',
    [projectId],
  );
  return (row?.id as string) ?? null;
}
