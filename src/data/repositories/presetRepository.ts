import type SQLite from 'react-native-sqlite-storage';
import type { Preset } from '../../types/novel';
import { execute } from '../connection/execute';
import { all } from '../connection/query';
import { openDatabase } from '../connection/openDatabase';
import {
  deleteProjectResourceLinks,
  linkResourceToProject,
  usageJoin,
} from './projectRepository';
import { updateColumns } from './shared';

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
]);

export async function updatePreset(
  id: number,
  fields: Partial<Preset>,
): Promise<void> {
  if (fields.is_default === 1) {
    await execute(
      await openDatabase(),
      'UPDATE presets SET is_default = 0 WHERE id != ?',
      [id],
    );
  }
  await updateColumns('presets', id, PRESET_COLUMNS, fields);
}

export async function createPreset(
  projectId: number,
  name: string,
  isDefault = false,
): Promise<number> {
  if (isDefault) {
    await execute(await openDatabase(), 'UPDATE presets SET is_default = 0');
  }
  const result = await execute(
    await openDatabase(),
    `INSERT INTO presets (project_id, name, is_default, system_prompt, writing_style, temperature, top_p, max_tokens, extra_instructions)
     VALUES (?, ?, ?, ?, ?, 0.8, 0.9, 4000, ?)`,
    [
      0,
      name,
      isDefault ? 1 : 0,
      '你是一位经验丰富的中文小说作者。请保持人物一致、场景清晰、节奏自然，并承接上文继续创作。',
      '文学化叙事，注重氛围和人物心理。',
      '每次输出控制在 800-1500 字，结尾自然停在段落或情节转折处。',
    ],
  );
  const id = result.insertId!;
  await linkResourceToProject(projectId, 'preset', id);
  return id;
}

export async function deletePreset(id: number): Promise<void> {
  await deleteProjectResourceLinks('preset', id);
  await execute(await openDatabase(), 'DELETE FROM presets WHERE id = ?', [id]);
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

  // If user already has presets (e.g. from a previous version), respect them —
  // do NOT create a duplicate default preset during upgrades.
  const anyPreset = await execute(
    target,
    'SELECT id FROM presets ORDER BY id ASC LIMIT 1',
  );
  if (anyPreset.rows.length > 0) return anyPreset.rows.item(0).id;

  const result = await execute(
    target,
    `INSERT INTO presets (project_id, name, is_default, system_prompt, writing_style, temperature, top_p, max_tokens, extra_instructions)
     VALUES (?, ?, 1, ?, ?, 0.8, 0.9, 4000, ?)`,
    [
      0,
      '默认写作预设',
      '你是一位经验丰富的中文小说作者。请保持人物一致、场景清晰、节奏自然，并承接上文继续创作。',
      '文学化叙事，注重氛围和人物心理。',
      '每次输出控制在 800-1500 字，结尾自然停在段落或情节转折处。',
    ],
  );
  return result.insertId!;
}
