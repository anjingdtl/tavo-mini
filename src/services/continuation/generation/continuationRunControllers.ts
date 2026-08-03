/**
 * Process-local AbortController registry shared by the historical continuation
 * runner and the V4 runner. The database remains the authority for run and
 * stage state; this registry only gives an in-process cancel action a signal to
 * abort the current provider call.
 */
export const activeContinuationControllers = new Map<
  string,
  AbortController
>();

export function registerContinuationController(
  runId: string,
  controller: AbortController,
): void {
  activeContinuationControllers.set(runId, controller);
}

export function getContinuationController(
  runId: string,
): AbortController | undefined {
  return activeContinuationControllers.get(runId);
}

export function unregisterContinuationController(runId: string): void {
  activeContinuationControllers.delete(runId);
}
