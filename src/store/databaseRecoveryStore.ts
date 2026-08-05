/**
 * Database-recovery UI store.
 *
 * Surfaces the Schema 40 repair state to React screens so the UI can:
 *   - show a "repairing" banner while the drift fix runs;
 *   - show a "recovered" summary with before/after counts after success;
 *   - show a structured error (NOT an empty data list) when repair fails;
 *   - let the user retry or export the recovery backup.
 *
 * The store is populated by `main/index.tsx` after `openDatabase()` settles,
 * reading from the `lastSchemaRecovery` singleton set by `initializeDatabase`.
 */
import { create } from 'zustand';
import type { SchemaRecoveryState } from '../services/database';
import type { SchemaRecoveryErrorCode } from '../data/schema/schemaRecoveryError';

export type DatabaseLoadState =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'error'
  | 'repairing'
  | 'recovered';

interface DatabaseRecoveryStore {
  /** Coarse load state for resource screens. */
  loadState: DatabaseLoadState;
  /** The structured recovery result from the last init (null on clean run). */
  recovery: SchemaRecoveryState | null;
  /** Error code for structured UI messaging (null when no error). */
  errorCode: SchemaRecoveryErrorCode | null;
  /** Human-readable error message (non-sensitive). */
  errorMessage: string | null;

  /** Called by main/index.tsx after openDatabase() succeeds. */
  setRecovery: (recovery: SchemaRecoveryState | null) => void;
  /** Called by main/index.tsx when openDatabase() throws. */
  setError: (code: SchemaRecoveryErrorCode, message: string) => void;
  /** Mark the resource layer as loaded (empty or not). */
  setLoaded: () => void;
  /** Mark the resource layer as loading. */
  setLoading: () => void;
  /** Clear the recovery banner after the user dismisses it. */
  clear: () => void;
}

export const useDatabaseRecoveryStore = create<DatabaseRecoveryStore>(
  (set) => ({
    loadState: 'idle',
    recovery: null,
    errorCode: null,
    errorMessage: null,
    setRecovery: (recovery) =>
      set({
        recovery,
        loadState: recovery?.error
          ? 'error'
          : recovery && (recovery.repaired || recovery.backupCreated)
            ? 'recovered'
            : 'loaded',
        errorCode: recovery?.error?.code ?? null,
        errorMessage: recovery?.error?.message ?? null,
      }),
    setError: (code, message) =>
      set({
        loadState: 'error',
        errorCode: code,
        errorMessage: message,
      }),
    setLoaded: () => set({ loadState: 'loaded' }),
    setLoading: () => set({ loadState: 'loading' }),
    clear: () =>
      set({
        loadState: 'idle',
        recovery: null,
        errorCode: null,
        errorMessage: null,
      }),
  }),
);
