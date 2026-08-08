/**
 * Maintenance-only feature flags.
 *
 * The three default-capability switches (elastic budget V2 / multi-chapter
 * batch / outline workflow V2) are GONE: those are now default product
 * capabilities, frozen per task/batch row (Schema 44) — runtime code never
 * reads a live settings flag for them. The remaining flag below has real
 * data-mutation behavior and stays explicitly behind a maintenance switch.
 */
import {
  getSetting,
  setSetting,
} from '../data/repositories/settingsRepository';

export const FEATURE_FLAG_KEYS = {
  // RB-16 fix (V2.11.34): `repairOversizedNotes` is destructive (it
  // deletes the original note and replaces it with chunks). It must
  // never run on a normal cold start. The default is OFF; the Settings
  // experimental toggles surface a "数据维护 → 优化超大笔记" button
  // that flips this flag, creates a safety backup, then performs the
  // repair inside a single transaction.
  startupNoteRepair: 'startup_note_repair_enabled',
} as const;

/**
 * RB-16 fix (V2.11.34): explicit maintenance switch for the destructive
 * oversized-note repair. Default OFF; the Settings → 数据维护 surface
 * flips it before invoking `runNoteMaintenance()`. The startup main path
 * never reads this flag — the gate lives in initializeDatabase.ts as
 * defense-in-depth.
 */
export async function isStartupNoteRepairEnabled(): Promise<boolean> {
  const v = await getSetting(FEATURE_FLAG_KEYS.startupNoteRepair);
  return v === 'true';
}

export async function setStartupNoteRepairEnabled(enabled: boolean): Promise<void> {
  await setSetting(FEATURE_FLAG_KEYS.startupNoteRepair, String(enabled));
}
