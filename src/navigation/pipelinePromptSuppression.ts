const suppressedTaskIds = new Set<string>();

export function suppressGlobalPipelinePrompt(taskId: string): void {
  suppressedTaskIds.add(taskId);
}

export function consumeSuppressedPipelinePrompt(taskId: string): boolean {
  if (!suppressedTaskIds.has(taskId)) return false;
  suppressedTaskIds.delete(taskId);
  return true;
}
