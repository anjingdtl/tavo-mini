import type SQLite from 'react-native-sqlite-storage';
import { executeTransaction } from '../../database/transaction';
import {
  createWritingGovernorProfileStore,
  getWritingGovernorProfileStore,
  markWritingGovernorProfileStoreHydrated,
  setWritingGovernorProfilePersistenceSink,
  type WritingGovernorProfile,
} from './writingGovernor';
import { WRITING_GOVERNOR_VERSION } from './writingGovernor';

type GovernorProfileRow = Record<string, unknown>;

function rowsFromResult(result: any): GovernorProfileRow[] {
  const rows: GovernorProfileRow[] = [];
  for (let index = 0; index < result.rows.length; index += 1) {
    rows.push(result.rows.item(index) as GovernorProfileRow);
  }
  return rows;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function profileFromRow(row: GovernorProfileRow): WritingGovernorProfile | null {
  const profileKey = String(row.profile_key ?? '');
  if (!profileKey || String(row.policy_version ?? '') !== WRITING_GOVERNOR_VERSION) {
    return null;
  }
  const profile = {
    version: 2,
    profileKey,
    sampleCount: nonNegativeInteger(row.sample_count),
    knownResultCount: nonNegativeInteger(row.known_result_count),
    lowUtilizationCount: nonNegativeInteger(row.low_utilization_count),
    lengthSignalCount: nonNegativeInteger(row.length_signal_count),
    recommendedScale: Number(row.recommended_scale),
    averageCompletionRatio: nullableNumber(row.average_completion_ratio),
    averageLatencyMs: nullableNumber(row.average_latency_ms),
    reasoningSampleCount: nonNegativeInteger(row.reasoning_sample_count),
    reasoningRatioEwma: nullableNumber(row.reasoning_ratio_ewma),
    reasoningRatioHighWater: nullableNumber(row.reasoning_ratio_high_water),
    reasoningPromptRatioEwma: nullableNumber(row.reasoning_prompt_ratio_ewma),
    reasoningPromptRatioHighWater: nullableNumber(
      row.reasoning_prompt_ratio_high_water,
    ),
    lastFinishReason:
      row.last_finish_reason == null ? null : String(row.last_finish_reason),
    updatedAt: nonNegativeInteger(row.updated_at),
  } as WritingGovernorProfile;
  // Recompute the semantic counters/status from the durable scalar aggregate;
  // those fields are intentionally not duplicated as Schema 60 columns.
  return createWritingGovernorProfileStore({ [profileKey]: profile }).profiles[
    profileKey
  ] || null;
}

function profileParams(profile: WritingGovernorProfile): unknown[] {
  return [
    profile.profileKey,
    WRITING_GOVERNOR_VERSION,
    profile.sampleCount,
    profile.knownResultCount,
    profile.lowUtilizationCount,
    profile.lengthSignalCount,
    profile.recommendedScale,
    profile.averageCompletionRatio,
    profile.averageLatencyMs,
    profile.reasoningSampleCount,
    profile.reasoningRatioEwma,
    profile.reasoningRatioHighWater,
    profile.reasoningPromptRatioEwma,
    profile.reasoningPromptRatioHighWater,
    profile.lastFinishReason,
    profile.updatedAt,
  ];
}

/** Read only the aggregate columns required to restore Governor state. */
export async function loadWritingGovernorProfiles(
  database: SQLite.SQLiteDatabase,
): Promise<Record<string, WritingGovernorProfile>> {
  const [result] = await database.executeSql(
    `SELECT profile_key, policy_version, sample_count, known_result_count,
            low_utilization_count, length_signal_count, recommended_scale,
            average_completion_ratio, average_latency_ms,
            reasoning_sample_count, reasoning_ratio_ewma,
            reasoning_ratio_high_water, reasoning_prompt_ratio_ewma,
            reasoning_prompt_ratio_high_water, last_finish_reason, updated_at
       FROM writing_governor_profiles
      WHERE policy_version = ?
      ORDER BY profile_key`,
    [WRITING_GOVERNOR_VERSION],
  );
  const profiles: Record<string, WritingGovernorProfile> = {};
  for (const row of rowsFromResult(result)) {
    const profile = profileFromRow(row);
    if (profile) profiles[profile.profileKey] = profile;
  }
  return profiles;
}

/** Restore aggregate state into the in-memory Governor store after startup. */
export async function hydrateWritingGovernorProfiles(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  const profiles = await loadWritingGovernorProfiles(database);
  const hydrated = createWritingGovernorProfileStore(profiles);
  getWritingGovernorProfileStore().profiles = hydrated.profiles;
  markWritingGovernorProfileStoreHydrated(true);
}

/** Upsert a single bounded aggregate; never serializes a profile as JSON. */
export async function persistWritingGovernorProfile(
  database: SQLite.SQLiteDatabase,
  profile: WritingGovernorProfile,
): Promise<void> {
  await executeTransaction(
    database,
    [
      {
        sql: `INSERT INTO writing_governor_profiles (
                profile_key, policy_version, sample_count, known_result_count,
                low_utilization_count, length_signal_count, recommended_scale,
                average_completion_ratio, average_latency_ms,
                reasoning_sample_count, reasoning_ratio_ewma,
                reasoning_ratio_high_water, reasoning_prompt_ratio_ewma,
                reasoning_prompt_ratio_high_water, last_finish_reason, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(profile_key) DO UPDATE SET
                policy_version = excluded.policy_version,
                sample_count = excluded.sample_count,
                known_result_count = excluded.known_result_count,
                low_utilization_count = excluded.low_utilization_count,
                length_signal_count = excluded.length_signal_count,
                recommended_scale = excluded.recommended_scale,
                average_completion_ratio = excluded.average_completion_ratio,
                average_latency_ms = excluded.average_latency_ms,
                reasoning_sample_count = excluded.reasoning_sample_count,
                reasoning_ratio_ewma = excluded.reasoning_ratio_ewma,
                reasoning_ratio_high_water = excluded.reasoning_ratio_high_water,
                reasoning_prompt_ratio_ewma = excluded.reasoning_prompt_ratio_ewma,
                reasoning_prompt_ratio_high_water = excluded.reasoning_prompt_ratio_high_water,
                last_finish_reason = excluded.last_finish_reason,
                updated_at = excluded.updated_at`,
        params: profileParams(profile),
      },
    ],
  );
}

export interface WritingGovernorProfilePersistence {
  enqueue(profile: WritingGovernorProfile): void;
  flush(): Promise<void>;
}

/**
 * Serialize aggregate writes so a fast sequence of known results cannot make
 * an older profile overwrite a newer one. Failures are logged but do not alter
 * the already-established LLM outcome; the next startup hydrates only rows
 * that were durably committed.
 */
export function createWritingGovernorProfilePersistence(
  database: SQLite.SQLiteDatabase,
): WritingGovernorProfilePersistence {
  let pending = Promise.resolve();
  return {
    enqueue(profile) {
      pending = pending
        .then(() => persistWritingGovernorProfile(database, profile))
        .catch(error => {
          console.warn('[writing-governor] durable aggregate write failed', error);
        });
    },
    flush() {
      return pending;
    },
  };
}

/** Install the startup-bound queue used by the runtime Governor observer. */
export function attachWritingGovernorProfilePersistence(
  database: SQLite.SQLiteDatabase,
): WritingGovernorProfilePersistence {
  const persistence = createWritingGovernorProfilePersistence(database);
  setWritingGovernorProfilePersistenceSink(profile => {
    persistence.enqueue(profile);
  });
  return persistence;
}
