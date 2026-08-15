import type { Preset } from '../../types/novel';
import { one } from '../../data/connection/query';
import { OutlineContextError } from '../outlineContextBuilder';
import {
  freezeDefaultWriterStyleBaseline,
  freezeWriterStyle,
} from './compiler';
import type {
  FrozenWriterStyleV1,
  WriterStyleAsset,
} from './types';

export const ACTIVE_WRITER_STYLE_ERROR_CODE = 'ACTIVE_WRITER_STYLE_MISSING';
export const ACTIVE_WRITER_STYLE_MISSING_MESSAGE =
  '当前项目绑定的作家风格不存在或已失去项目归属，已阻断新任务。';

export interface ActiveWriterStyleResolution {
  activeStyleId: number | null;
  writerStyle: FrozenWriterStyleV1;
  draftPreset: Preset | null;
}

function missingActiveWriterStyle(): never {
  throw new OutlineContextError(
    ACTIVE_WRITER_STYLE_ERROR_CODE,
    ACTIVE_WRITER_STYLE_MISSING_MESSAGE,
    'open_writer_style',
  );
}

function draftPresetFromWriterStyle(
  projectId: number,
  writerStyle: FrozenWriterStyleV1,
): Preset | null {
  if (!(Number(writerStyle.assetId) > 0)) return null;
  return {
    id: Number(writerStyle.assetId),
    project_id: projectId,
    name: writerStyle.assetName,
    is_default: 0,
    system_prompt: writerStyle.stageProjections.draft.text,
    writing_style: '',
    extra_instructions: '',
    temperature: writerStyle.samplerResolution.temperature ?? 0.7,
    top_p: writerStyle.samplerResolution.topP ?? 1,
    max_tokens: 0,
  };
}

/** Pure single-source decision used by every active-style entry point. */
export function resolveWriterStyleSelection(params: {
  projectId: number;
  activeStyleId: number | null;
  asset: WriterStyleAsset | null;
}): ActiveWriterStyleResolution {
  const activeStyleId =
    params.activeStyleId == null ? null : Number(params.activeStyleId);
  if (activeStyleId == null) {
    const writerStyle = freezeDefaultWriterStyleBaseline();
    return { activeStyleId: null, writerStyle, draftPreset: null };
  }
  if (
    !Number.isInteger(activeStyleId) ||
    activeStyleId <= 0 ||
    !params.asset ||
    Number(params.asset.id) !== activeStyleId ||
    Number(params.asset.project_id) !== Number(params.projectId)
  ) {
    throw missingActiveWriterStyle();
  }
  const writerStyle = freezeWriterStyle(params.asset);
  return {
    activeStyleId,
    writerStyle,
    draftPreset: draftPresetFromWriterStyle(params.projectId, writerStyle),
  };
}

/** Resolve the current project binding, or an explicit candidate while saving. */
export async function resolveActiveWriterStyle(
  projectId: number,
  explicitStyleId?: number | null,
): Promise<ActiveWriterStyleResolution> {
  const activeStyleId =
    explicitStyleId !== undefined
      ? explicitStyleId == null
        ? null
        : Number(explicitStyleId)
      : (
          await one<{ active_writer_style_id: number | null }>(
            'SELECT active_writer_style_id FROM projects WHERE id = ? LIMIT 1',
            [projectId],
          )
        )?.active_writer_style_id ?? null;
  const asset =
    activeStyleId == null
      ? null
      : await one<WriterStyleAsset>(
          `SELECT p.* FROM presets p
           JOIN project_resources pr ON pr.resource_type = 'preset'
             AND pr.resource_id = p.id AND pr.project_id = ? AND pr.enabled = 1
           WHERE p.id = ? LIMIT 1`,
          [projectId, activeStyleId],
        );
  return resolveWriterStyleSelection({ projectId, activeStyleId, asset });
}
