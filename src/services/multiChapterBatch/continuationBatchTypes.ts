/**
 * Shared lightweight types for the continuation batch adapter.
 *
 * Kept in a dedicated module so the adapter does not import the outline
 * reconciler (which imports the adapter) even for types.
 */
export interface ReconcileProgressSink {
  (info: {
    batchId: string;
    status: string;
    currentOrdinal: number;
    completedCount: number;
    chapterCount: number;
    stage?: string;
    message?: string;
  }): void;
}
