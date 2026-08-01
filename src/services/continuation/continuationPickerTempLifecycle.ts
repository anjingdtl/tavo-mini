/**
 * Lifecycle for document-picker cache copies used by continuation import.
 *
 * Multi-file flow copies selected TXT files into the app caches directory,
 * then navigates to ContinuationSourceOrdering with those paths. The ordering
 * screen still needs the files for sampling and for startContinuationImport
 * (which copies them into the durable job directory).
 *
 * Therefore: when handing off to ordering, picker copies MUST be retained.
 * Cleanup is the ordering screen's responsibility after durable copy or cancel.
 *
 * Single-file flow calls startContinuationImport before returning, so the
 * picker-stage screen may unlink caches immediately afterwards.
 */
import RNFS from 'react-native-fs';

export type PickerTempCleanupDecision =
  | { action: 'unlink_now'; paths: string[] }
  | { action: 'retain_for_ordering'; paths: string[] };

export function decidePickerTempCleanup(input: {
  handedOffToOrdering: boolean;
  localPaths: string[];
}): PickerTempCleanupDecision {
  const paths = input.localPaths.filter(Boolean);
  if (input.handedOffToOrdering) {
    return { action: 'retain_for_ordering', paths };
  }
  return { action: 'unlink_now', paths };
}

/** Best-effort unlink of picker cache copies. Never throws. */
export async function unlinkPickerTempCopies(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(p =>
      RNFS.unlink(p).catch(() => {
        // best-effort; file may already be gone
      }),
    ),
  );
}

/**
 * Clean a failed keepLocalCopy result. The picker may create
 * `CachesDirectoryPath/<uuid>/<fileName>` even when status is `error` and
 * sometimes omits `localUri` — scan cache for the original name as fallback.
 */
export async function cleanupFailedPickerCopy(input: {
  localUri?: string | null;
  originalFileName: string;
}): Promise<void> {
  const paths: string[] = [];
  if (input.localUri) {
    const path = input.localUri.replace(/^file:\/\//i, '');
    try {
      paths.push(decodeURIComponent(path));
    } catch {
      paths.push(path);
    }
  }
  await unlinkPickerTempCopies(paths);

  const name = input.originalFileName;
  if (!name) return;
  try {
    const root = RNFS.CachesDirectoryPath;
    if (!root) return;
    const entries = await RNFS.readDir(root);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = `${entry.path}/${name}`;
      // eslint-disable-next-line no-await-in-loop
      const exists = await RNFS.exists(candidate);
      if (!exists) continue;
      // eslint-disable-next-line no-await-in-loop
      await unlinkPickerTempCopies([candidate]);
      // Drop empty uuid dir when possible
      // eslint-disable-next-line no-await-in-loop
      await RNFS.unlink(entry.path).catch(() => {
        // not empty or not removable — ignore
      });
    }
  } catch {
    // best-effort
  }
}
