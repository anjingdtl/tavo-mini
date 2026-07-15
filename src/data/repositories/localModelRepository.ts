import type { LocalModel } from '../../types/localModel';
import { execute } from '../connection/execute';
import { openDatabase } from '../connection/openDatabase';
import { now } from './shared';

export async function listLocalModels(): Promise<LocalModel[]> {
  const database = await openDatabase();
  const result = await execute(
    database,
    'SELECT * FROM local_llm_models ORDER BY imported_at DESC',
  );
  const models: LocalModel[] = [];
  for (let i = 0; i < result.rows.length; i += 1) {
    models.push(result.rows.item(i) as LocalModel);
  }
  return models;
}

export async function getLocalModelById(
  id: string,
): Promise<LocalModel | null> {
  const database = await openDatabase();
  const result = await execute(
    database,
    'SELECT * FROM local_llm_models WHERE id = ?',
    [id],
  );
  return result.rows.length > 0 ? (result.rows.item(0) as LocalModel) : null;
}

export async function getLocalModelBySha256(
  sha256: string,
): Promise<LocalModel | null> {
  const database = await openDatabase();
  const result = await execute(
    database,
    'SELECT * FROM local_llm_models WHERE sha256 = ?',
    [sha256],
  );
  return result.rows.length > 0 ? (result.rows.item(0) as LocalModel) : null;
}

export async function createLocalModel(
  model: Omit<LocalModel, 'imported_at'> & { imported_at?: string },
): Promise<void> {
  const database = await openDatabase();
  await execute(
    database,
    `INSERT INTO local_llm_models (
      id, display_name, original_filename, relative_path, file_size, sha256,
      status, backend_preference, validated_backend,
      context_length, max_output_tokens,
      load_time_ms, first_token_ms, tokens_per_second,
      imported_at, last_used_at, last_validated_at, error_code, error_message,
      prompt_template, actual_backend
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      model.id,
      model.display_name,
      model.original_filename,
      model.relative_path,
      model.file_size,
      model.sha256,
      model.status,
      model.backend_preference,
      model.validated_backend,
      model.context_length,
      model.max_output_tokens,
      model.load_time_ms,
      model.first_token_ms,
      model.tokens_per_second,
      model.imported_at || now(),
      model.last_used_at,
      model.last_validated_at,
      model.error_code,
      model.error_message,
      model.prompt_template,
      model.actual_backend,
    ],
  );
}

export async function updateLocalModel(
  id: string,
  fields: Partial<Omit<LocalModel, 'id' | 'sha256'>>,
): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => (fields as Record<string, any>)[k]);
  const database = await openDatabase();
  await execute(database, `UPDATE local_llm_models SET ${sets} WHERE id = ?`, [
    ...values,
    id,
  ]);
}

export async function deleteLocalModelRecord(id: string): Promise<void> {
  const database = await openDatabase();
  await execute(database, 'DELETE FROM local_llm_models WHERE id = ?', [id]);
}

export async function countLLMConfigsUsingModel(
  modelId: string,
): Promise<number> {
  const database = await openDatabase();
  const result = await execute(
    database,
    'SELECT COUNT(*) AS cnt FROM llm_config WHERE local_model_id = ?',
    [modelId],
  );
  return result.rows.length > 0 ? Number(result.rows.item(0).cnt || 0) : 0;
}
