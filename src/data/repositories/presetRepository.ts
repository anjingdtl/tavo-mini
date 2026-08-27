import type SQLite from 'react-native-sqlite-storage';
import type { Preset } from '../../types/novel';
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import {
  executeTransaction,
  type SqlStatement,
} from '../connection/transaction';
import { openDatabase } from '../connection/openDatabase';
import { linkResourceToProject, usageJoin } from './projectRepository';
import type { WriterStyleAssetFields } from '../../services/writerStyle/types';
import { resolveActiveWriterStyle } from '../../services/writerStyle/activeStyleResolver';

export async function getAllPresets(projectId?: number): Promise<Preset[]> {
  return all<Preset>(
    `SELECT p.*, ${usageJoin(
      'preset',
      'p',
      projectId,
    )} FROM presets p ORDER BY p.is_default DESC, p.id ASC`,
  );
}

export async function getPresetsByProject(
  projectId: number,
): Promise<Preset[]> {
  return all<Preset>(
    `SELECT p.* FROM presets p
     JOIN project_resources pr ON pr.resource_id = p.id AND pr.resource_type = 'preset'
     WHERE pr.project_id = ? AND pr.enabled = 1
     ORDER BY p.is_default DESC, p.id ASC`,
    [projectId],
  );
}

const PRESET_COLUMNS = new Set([
  'name',
  'is_default',
  'system_prompt',
  'writing_style',
  'temperature',
  'top_p',
  'max_tokens',
  'extra_instructions',
  'semantic_json',
  'compatibility_json',
  'source_format',
  'source_fingerprint',
  'compatibility_fingerprint',
  'asset_contract_version',
]);

export async function updatePreset(
  id: number,
  fields: Partial<Preset>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!PRESET_COLUMNS.has(key)) continue;
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return;

  const statements: SqlStatement[] = [];
  if (fields.is_default === 1) {
    // The target must exist before clearing another default. Otherwise an
    // invalid/deleted id would silently leave every preset non-default.
    statements.push({
      sql: 'UPDATE presets SET is_default = 0 WHERE id != ? AND EXISTS (SELECT 1 FROM presets WHERE id = ?)',
      params: [id, id],
    });
  }
  statements.push({
    sql: `UPDATE presets SET ${sets.join(', ')} WHERE id = ?`,
    params: [...values, id],
  });
  if (fields.is_default === 0) {
    statements.push({
      sql: 'UPDATE presets SET is_default = 1 WHERE NOT EXISTS(SELECT 1 FROM presets WHERE is_default = 1) AND id = (SELECT id FROM presets ORDER BY id ASC LIMIT 1)',
    });
  }
  await executeTransaction(await openDatabase(), statements);
}

export async function createPreset(
  projectId: number,
  name: string,
  isDefault = false,
): Promise<number> {
  const database = await openDatabase();
  const result = await execute(
    database,
    `INSERT INTO presets (project_id, name, is_default, system_prompt, writing_style, temperature, top_p, max_tokens, extra_instructions, source_format, source_fingerprint, asset_contract_version)
     VALUES (?, ?, ?, ?, ?, 0.8, 0.9, 0, ?, 'legacy_shinewriter', '', 1)`,
    [
      0,
      name,
      0,
      '你是一位经验丰富的中文小说作者。请保持人物一致、场景清晰、节奏自然，并承接上文继续创作。',
      '文学化叙事，注重氛围和人物心理。',
      '每次输出控制在 800-1500 字，结尾自然停在段落或情节转折处。',
    ],
  );
  const id = result.insertId!;
  if (isDefault) {
    await executeTransaction(database, [
      {
        sql: 'UPDATE presets SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END',
        params: [id],
      },
    ]);
  }
  await linkResourceToProject(projectId, 'preset', id);
  return id;
}

export async function deletePreset(id: number): Promise<void> {
  const database = await openDatabase();
  const existing = await execute(
    database,
    'SELECT id FROM presets WHERE id = ? LIMIT 1',
    [id],
  );
  if (existing.rows.length === 0) return;

  const replacement = await execute(
    database,
    'SELECT id FROM presets WHERE id != ? ORDER BY is_default DESC, id ASC LIMIT 1',
    [id],
  );
  if (replacement.rows.length === 0) {
    throw new Error('至少需要保留一个作家风格。');
  }
  const replacementId = replacement.rows.item(0).id;

  await executeTransaction(database, [
    // Presets are shared resources. Move every consuming project to a real
    // replacement before removing the old row, preserving each enabled flag.
    {
      sql: `INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled)
            SELECT project_id, ?, ?, enabled
            FROM project_resources
            WHERE resource_type = ? AND resource_id = ?`,
      params: ['preset', replacementId, 'preset', id],
    },
    {
      sql: 'DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?',
      params: ['preset', id],
    },
    {
      sql: 'DELETE FROM continuation_resource_bindings WHERE resource_kind = ? AND resource_id = ?',
      params: ['preset', id],
    },
    { sql: 'DELETE FROM presets WHERE id = ?', params: [id] },
    {
      sql: 'UPDATE presets SET is_default = 1 WHERE NOT EXISTS(SELECT 1 FROM presets WHERE is_default = 1) AND id = (SELECT id FROM presets ORDER BY id ASC LIMIT 1)',
    },
  ]);
}

export async function ensureDefaultPreset(
  database?: SQLite.SQLiteDatabase,
): Promise<number> {
  const target = database || (await openDatabase());
  const existing = await execute(
    target,
    'SELECT id FROM presets WHERE is_default = 1 ORDER BY id ASC LIMIT 1',
  );
  if (existing.rows.length > 0) return existing.rows.item(0).id;

  // Repair legacy data with presets but no marker instead of returning a row
  // that the rest of the writing pipeline cannot identify as the default.
  const anyPreset = await execute(
    target,
    'SELECT id FROM presets ORDER BY id ASC LIMIT 1',
  );
  if (anyPreset.rows.length > 0) {
    const id = anyPreset.rows.item(0).id;
    await execute(target, 'UPDATE presets SET is_default = 1 WHERE id = ?', [
      id,
    ]);
    return id;
  }

  const result = await execute(
    target,
    `INSERT INTO presets (project_id, name, is_default, system_prompt, writing_style, temperature, top_p, max_tokens, extra_instructions, source_format, source_fingerprint, asset_contract_version)
     VALUES (?, ?, 1, ?, ?, 0.8, 0.9, 0, ?, 'legacy_shinewriter', '', 1)`,
    [
      0,
      '默认作家风格',
      '你是一位经验丰富的中文小说作者。请保持人物一致、场景清晰、节奏自然，并承接上文继续创作。',
      '文学化叙事，注重氛围和人物心理。',
      '每次输出控制在 800-1500 字，结尾自然停在段落或情节转折处。',
    ],
  );
  return result.insertId!;
}

export async function getWriterStyleAssetById(
  projectId: number,
  styleId: number,
): Promise<import('../../services/writerStyle/types').WriterStyleAsset | null> {
  return one<import('../../services/writerStyle/types').WriterStyleAsset>(
    `SELECT p.* FROM presets p
     JOIN project_resources pr ON pr.resource_type = 'preset'
       AND pr.resource_id = p.id AND pr.project_id = ? AND pr.enabled = 1
     WHERE p.id = ? LIMIT 1`,
    [projectId, styleId],
  );
}

export async function setProjectActiveWriterStyle(
  projectId: number,
  styleId: number | null,
): Promise<void> {
  await resolveActiveWriterStyle(projectId, styleId);
  await execute(
    await openDatabase(),
    'UPDATE projects SET active_writer_style_id = ?, updated_at = ? WHERE id = ?',
    [styleId, new Date().toISOString(), projectId],
  );
}

export async function getProjectActiveWriterStyleId(
  projectId: number,
): Promise<number | null> {
  const row = await one<{ active_writer_style_id: number | null }>(
    'SELECT active_writer_style_id FROM projects WHERE id = ? LIMIT 1',
    [projectId],
  );
  return row?.active_writer_style_id == null
    ? null
    : Number(row.active_writer_style_id);
}

export async function updateWriterStyleAsset(
  id: number,
  fields: Partial<WriterStyleAssetFields> & Partial<import('../../types/novel').Preset>,
): Promise<void> {
  await updatePreset(id, fields);
}
