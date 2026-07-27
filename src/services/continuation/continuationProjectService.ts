/**
 * Continuation project service (Spec §13, §8.1).
 *
 * Thin facade over projectStore/projectRepository that creates a continuation
 * project and ensures the continuation_settings row exists. The heavy import
 * work lives in continuationImportService.
 */
import { createProject } from '../../data/repositories/projectRepository';
import { openDatabase } from '../../data/connection/openDatabase';
import { ensureSettingsRow } from './continuationSourceRepository';
import type { Project } from '../../types/novel';

export interface CreateContinuationProjectInput {
  name: string;
}

/**
 * Create a continuation project (Spec §8.1, §13).
 *
 * Reuses the existing project-creation transaction (which seeds the first
 * continuation chapter at position 0) and then ensures the
 * continuation_settings row exists so the import UI has a place to write the
 * active source pointer.
 */
export async function createContinuationProject(
  input: CreateContinuationProjectInput,
): Promise<Project> {
  const name = input.name.trim();
  if (!name) {
    throw new Error('项目名称不能为空。');
  }
  const projectId = await createProject(name, 'continuation');
  const db = await openDatabase();
  await ensureSettingsRow(db, projectId);
  // Return a minimal Project; callers that need timestamps reload via store.
  return {
    id: projectId,
    name,
    mode: 'continuation',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
