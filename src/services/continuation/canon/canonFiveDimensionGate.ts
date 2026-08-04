/**
 * Five-dimension hard acceptance gate for Canon analysis (original-analysis
 * quality spec 2026-08-03, §7 / §12).
 *
 * The two analysis modes (full / quick) must each independently pass a hard
 * five-dimension gate before their snapshot may be activated:
 *
 *   characters    >= 1
 *   world_rules   >= 1
 *   relationships >= 1
 *   plot_threads  >= 1
 *   experiences   >= 1
 *
 * Counts MUST come from the CURRENT run + CURRENT snapshot, after Schema
 * validation, evidence resolution, dedup, materialisation and a fresh DB
 * re-read. They exclude superseded / invalid / deleted / evidence-invalid rows
 * and any data belonging to another snapshot, run or analysis mode.
 *
 * The LLM raw JSON array length, other runs' data, the other mode's data, or
 * previously-filtered rows are NOT valid counts.
 */
import type SQLite from 'react-native-sqlite-storage';

/**
 * The five user-facing dimensions subject to the hard minimum. These map to
 * the five CanonCategoryListScreen tabs.
 */
export const REQUIRED_CANON_DIMENSIONS = [
  'characters',
  'worldRules',
  'relationships',
  'plotThreads',
  'experiences',
] as const;

export type RequiredCanonDimension = (typeof REQUIRED_CANON_DIMENSIONS)[number];

/**
 * Minimum valid rows per dimension after the full pipeline (Schema + evidence
 * + dedup + materialise + re-read).
 *
 * Kept at 1 so short novels with a single protagonist (or sparse world rules)
 * can still pass; zero remains a hard fail so empty dimensions never activate.
 */
export const REQUIRED_MIN_COUNT = 1;

/**
 * Maximum number of targeted-rescan rounds per missing dimension. Spec §12.3
 * suggests at most 2 rounds to avoid unbounded API calls.
 */
export const MAX_TARGETED_RESCAN_ROUNDS = 2;

export interface FiveDimensionCounts {
  characters: number;
  worldRules: number;
  relationships: number;
  plotThreads: number;
  experiences: number;
}

export interface FiveDimensionGateResult {
  passed: boolean;
  counts: FiveDimensionCounts;
  /** Dimensions below REQUIRED_MIN_COUNT, in declared order. */
  missingDimensions: RequiredCanonDimension[];
}

/**
 * Map a required dimension to its Canon table, the evidence owner_type that
 * backs its facts, and the review-status filter used by the five-dimension UI /
 * continuation read path.
 *
 * Counts exclude superseded / ignored rows exactly like the UI browse pages,
 * so the gate number matches what the user actually sees.
 */
const DIMENSION_TABLE: Record<
  RequiredCanonDimension,
  { table: string; ownerType: string }
> = {
  characters: { table: 'canon_characters', ownerType: 'character' },
  worldRules: { table: 'canon_world_rules', ownerType: 'world_rule' },
  relationships: { table: 'canon_relationships', ownerType: 'relationship' },
  plotThreads: { table: 'canon_plot_threads', ownerType: 'plot_thread' },
  experiences: { table: 'canon_character_experiences', ownerType: 'experience' },
};

/**
 * Count valid rows for each required dimension, scoped to the current run +
 * snapshot. Rows are excluded when:
 *   - they belong to a different snapshot or analysis run;
 *   - review_status is superseded (no longer effective) or ignored
 *     (user-discarded), matching the UI browse filter;
 *   - **they have no valid evidence link** (2026-08-04 修复：extra-check #4).
 *     A fact must be backed by at least one evidence row in the same snapshot
 *     + run with a matching owner_type, otherwise it is not counted. This
 *     prevents orphan facts (e.g. materialized but evidence-resolution-dropped)
 *     from inflating the gate count.
 *
 * This is the single source of truth for the five-dimension gate.
 */
export async function countValidCanonRowsForGate(
  db: SQLite.SQLiteDatabase,
  snapshotId: string,
  runId: string,
): Promise<FiveDimensionCounts> {
  const count = async (table: string, ownerType: string) => {
    const [r] = await db.executeSql(
      `SELECT COUNT(*) AS c FROM ${table} f
        WHERE f.snapshot_id = ?
          AND f.analysis_run_id = ?
          AND f.review_status NOT IN ('superseded', 'ignored')
          AND EXISTS (
            SELECT 1 FROM canon_evidence_links l
            JOIN canon_evidence e ON e.id = l.evidence_id
            WHERE l.snapshot_id = f.snapshot_id
              AND l.owner_type = ?
              AND l.owner_id = f.id
              AND e.snapshot_id = f.snapshot_id
              AND e.analysis_run_id = f.analysis_run_id
          )`,
      [snapshotId, runId, ownerType],
    );
    return r.rows.item(0).c as number;
  };
  return {
    characters: await count(DIMENSION_TABLE.characters.table, DIMENSION_TABLE.characters.ownerType),
    worldRules: await count(DIMENSION_TABLE.worldRules.table, DIMENSION_TABLE.worldRules.ownerType),
    relationships: await count(DIMENSION_TABLE.relationships.table, DIMENSION_TABLE.relationships.ownerType),
    plotThreads: await count(DIMENSION_TABLE.plotThreads.table, DIMENSION_TABLE.plotThreads.ownerType),
    experiences: await count(DIMENSION_TABLE.experiences.table, DIMENSION_TABLE.experiences.ownerType),
  };
}

/**
 * Evaluate the five-dimension hard gate against freshly re-read counts.
 */
export function evaluateFiveDimensionGate(
  counts: FiveDimensionCounts,
): FiveDimensionGateResult {
  const missingDimensions = REQUIRED_CANON_DIMENSIONS.filter(
    dimension => counts[dimension] < REQUIRED_MIN_COUNT,
  );
  return {
    passed: missingDimensions.length === 0,
    counts,
    missingDimensions,
  };
}

/**
 * Human-readable summary of the gate result for error messages / UI.
 */
export function describeGateResult(result: FiveDimensionGateResult): string {
  const dimensionLabels: Record<RequiredCanonDimension, string> = {
    characters: '人物资料',
    worldRules: '世界观规则',
    relationships: '人物关系',
    plotThreads: '剧情线',
    experiences: '人物经历',
  };
  const parts = REQUIRED_CANON_DIMENSIONS.map(
    dim => `${dimensionLabels[dim]} ${result.counts[dim]} 条`,
  );
  const head = `五维验收：${parts.join('、')}（每维至少 ${REQUIRED_MIN_COUNT} 条）`;
  if (result.passed) return `${head}——通过`;
  const missing = result.missingDimensions
    .map(dim => `${dimensionLabels[dim]}(${result.counts[dim]})`)
    .join('、');
  return `${head}——不足维度：${missing}`;
}

/**
 * Dimensions owned by each v3.1 request group. Used by the targeted rescan to
 * map a missing dimension back to the request group that produces it.
 */
export const DIMENSION_TO_REQUEST_GROUP: Record<
  RequiredCanonDimension,
  'character_state' | 'world_plot'
> = {
  characters: 'character_state',
  relationships: 'character_state',
  experiences: 'character_state',
  worldRules: 'world_plot',
  plotThreads: 'world_plot',
};
