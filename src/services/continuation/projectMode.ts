import type { ProjectMode } from '../../types/novel';

/**
 * Persisted project mode whitelist (Schema 19+).
 *
 * `freeform` is retained for backward compatibility with historical projects
 * but is no longer offered as a new-project option. Unknown strings must never
 * reach the database; the import path rejects them with a localized error.
 */
export const PERSISTED_PROJECT_MODES: readonly ProjectMode[] = [
  'outline',
  'continuation',
  'freeform',
];

/**
 * Exhaustive Chinese labels for every project mode. UI code must look up
 * through this map rather than branching on `mode === '...'`, so that adding a
 * future mode is a single-point edit (Spec §8.1).
 */
export const PROJECT_MODE_LABELS: Readonly<Record<ProjectMode, string>> = {
  outline: '大纲创作',
  continuation: '原著续写',
  freeform: '自由写作',
};

/**
 * Modes offered on the new-project screen. `freeform` is intentionally absent:
 * historical freeform projects remain openable, but new users only see
 * `outline` and `continuation` (Spec §8.1).
 */
export const NEW_PROJECT_MODE_OPTIONS: readonly {
  value: ProjectMode;
  label: string;
}[] = [
  { value: 'outline', label: PROJECT_MODE_LABELS.outline },
  { value: 'continuation', label: PROJECT_MODE_LABELS.continuation },
];

/**
 * Normalize an untrusted project-mode value into a valid {@link ProjectMode}.
 *
 * Rules (Spec §8.1):
 *  - `outline`, `freeform`, `continuation` are returned as-is.
 *  - `undefined` / `null` / `''` fall back to `outline` (the historical default
 *    for v1/v2 project packages that predate the mode field).
 *  - Any other value is rejected: callers that already have a known-good mode
 *    pass `defaultValue` to absorb legacy blanks; project-package import must
 *    instead surface a localized error and block the import.
 *
 * The function never silently coerces an unknown string to a real mode — when
 * no `defaultValue` is supplied it throws so the import path can surface
 * 「不支持的项目模式」to the user (Spec §8.1, §15).
 */
export function normalizeProjectMode(
  value: unknown,
  defaultValue: ProjectMode = 'outline',
): ProjectMode {
  if (value === 'outline' || value === 'continuation' || value === 'freeform') {
    return value;
  }
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  throw new Error(
    `不支持的项目模式：${String(value)}（仅支持 outline / continuation / freeform）`,
  );
}

/**
 * Strict guard used by the project-package importer. Returns `true` only for
 * the three whitelisted literals; everything else is rejected so the importer
 * can show a precise Chinese error instead of writing an unknown string to
 * `projects.mode` (Spec §8.1, §15).
 */
export function isValidProjectMode(value: unknown): value is ProjectMode {
  return (
    value === 'outline' || value === 'continuation' || value === 'freeform'
  );
}
