import type { PipelineConfig } from '../../types/pipeline';
import { execute } from '../connection/execute';
import { all } from '../connection/query';
import { openDatabase } from '../connection/openDatabase';
import { setSetting } from './settingsRepository';
import type { Row } from './shared';

export async function getPipelineConfig(): Promise<PipelineConfig> {
  // 11.9 优化：原实现每个字段独立 getSetting（最多 9 次独立 SQL），合并为单次 SELECT
  const keys = [
    'pipeline_mode',
    'pipeline_draft_preset_id',
    'pipeline_review_preset_id',
    'pipeline_factcheck_preset_id',
    'pipeline_proof_preset_id',
    'pipeline_draft_max_tokens',
    'pipeline_review_max_tokens',
    'pipeline_factcheck_max_tokens',
    'pipeline_proof_max_tokens',
  ];
  const rows = await all<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key IN (${keys
      .map(() => '?')
      .join(', ')})`,
    keys,
  );
  const settingsMap = new Map(rows.map(r => [r.key, r.value]));
  const get = (k: string): string | null => settingsMap.get(k) ?? null;

  const savedMode = get('pipeline_mode');
  const pipelineMode =
    savedMode === 'noReview' ||
    savedMode === 'conditional' ||
    savedMode === 'full' ||
    savedMode === 'twoStage'
      ? savedMode
      : 'twoStage';

  const presetId = (k: string): number | null => {
    const v = get(k);
    return v !== null ? Number(v) : null;
  };

  return {
    pipelineMode,
    draftPresetId: presetId('pipeline_draft_preset_id'),
    reviewPresetId: presetId('pipeline_review_preset_id'),
    factCheckPresetId: presetId('pipeline_factcheck_preset_id'),
    proofPresetId: presetId('pipeline_proof_preset_id'),
    draftMaxTokens: Number(get('pipeline_draft_max_tokens') || 4000),
    reviewMaxTokens: Number(get('pipeline_review_max_tokens') || 1500),
    factCheckMaxTokens: Number(get('pipeline_factcheck_max_tokens') || 1500),
    proofMaxTokens: Number(get('pipeline_proof_max_tokens') || 4000),
  };
}

export async function setPipelineConfig(config: PipelineConfig): Promise<void> {
  await setSetting('pipeline_mode', config.pipelineMode);
  await setSetting(
    'pipeline_draft_preset_id',
    config.draftPresetId !== null ? String(config.draftPresetId) : '',
  );
  await setSetting(
    'pipeline_review_preset_id',
    config.reviewPresetId !== null ? String(config.reviewPresetId) : '',
  );
  await setSetting(
    'pipeline_factcheck_preset_id',
    config.factCheckPresetId !== null ? String(config.factCheckPresetId) : '',
  );
  await setSetting(
    'pipeline_proof_preset_id',
    config.proofPresetId !== null ? String(config.proofPresetId) : '',
  );
  await setSetting('pipeline_draft_max_tokens', String(config.draftMaxTokens));
  await setSetting(
    'pipeline_review_max_tokens',
    String(config.reviewMaxTokens),
  );
  await setSetting(
    'pipeline_factcheck_max_tokens',
    String(config.factCheckMaxTokens),
  );
  await setSetting('pipeline_proof_max_tokens', String(config.proofMaxTokens));
}

export async function savePipelineTask(task: {
  id: string;
  targetType: string;
  targetId: number;
  status: string;
  stageResults: any[];
  finalText: string | null;
  error: string | null;
  inputFingerprint?: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  resolvedAction?: string | null;
}): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT OR REPLACE INTO pipeline_tasks (id, target_type, target_id, status, stage_results, final_text, error, input_fingerprint, created_at, updated_at, resolved_at, resolved_action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.targetType,
      task.targetId,
      task.status,
      JSON.stringify(task.stageResults),
      task.finalText,
      task.error,
      task.inputFingerprint ?? null,
      task.createdAt,
      task.updatedAt,
      task.resolvedAt,
      task.resolvedAction || null,
    ],
  );
}

export async function getUnresolvedPipelineTasks(): Promise<any[]> {
  const rows = await all<Row>(
    'SELECT * FROM pipeline_tasks WHERE resolved_at IS NULL ORDER BY created_at DESC',
  );
  return rows.map(row => ({
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    stageResults: (() => {
      try {
        return JSON.parse(row.stage_results);
      } catch {
        return [];
      }
    })(),
    finalText: row.final_text,
    error: row.error,
    inputFingerprint: row.input_fingerprint ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolvedAction: row.resolved_action,
  }));
}

export async function getAllPipelineTasks(): Promise<any[]> {
  const rows = await all<Row>(
    'SELECT * FROM pipeline_tasks ORDER BY created_at DESC',
  );
  return rows.map(row => ({
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    stageResults: (() => {
      try {
        return JSON.parse(row.stage_results);
      } catch {
        return [];
      }
    })(),
    finalText: row.final_text,
    error: row.error,
    inputFingerprint: row.input_fingerprint ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolvedAction: row.resolved_action,
  }));
}

export async function deletePipelineTask(id: string): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM pipeline_tasks WHERE id = ?',
    [id],
  );
}

export async function deleteResolvedPipelineTasks(): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM pipeline_tasks WHERE resolved_at IS NOT NULL',
  );
}
