import RNFS from 'react-native-fs';
import {
  errorCodes,
  isErrorWithCode,
  saveDocuments,
  types,
} from '@react-native-documents/picker';
import * as db from './database';
import {
  importCharacterFromJSON,
  importWorldBookFromJSON,
  pickSourceFile,
} from './fileImport';
import {
  parseShineWriterPresetV1,
} from './construction/presetDraftAdapter';
import {
  isSillyTavernOpenAIPreset,
  parseSillyTavernOpenAIPreset,
} from './writerStyle/tavernAdapter';
import { normalizeWriterStyleSemantic } from './writerStyle/semantic';
import type {
  CharacterArtifact,
  ConstructionArtifact,
  PresetArtifact,
  ShineWriterPresetV1,
  WorldbookArtifact,
} from './construction/targets';

/**
 * 「构建」模块的文件序列化、系统保存与直接导入资料库封装。
 *
 * 保存到手机：复用 Android Storage Access Framework（saveDocuments），不申请宽泛
 * 存储权限、不假定可写入固定公共目录。用户取消保存窗口时返回 cancelled —— 调用方
 * 不得据此显示「保存成功」。
 *
 * 导入资料库：序列化为与资料库相同的 chara_card_v3 / lorebook_v3 JSON，再走既有
 * 导入解析链路写入 SQLite，并按当前项目启用（project_resources / 合集开关）。
 */

const ARTIFACT_MIME_TYPE = 'application/json';

/** 文件名非法字符清理（与 exportService 同口径，但本服务需独立使用）。 */
function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (name || 'shinewriter').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_');
  const trimmed = cleaned.trim() || 'shinewriter';
  return trimmed.length > 96 ? trimmed.slice(0, 96) : trimmed;
}

/** 序列化产物为两空格缩进的 UTF-8 JSON 字符串。 */
export function serializeArtifact(artifact: ConstructionArtifact): string {
  const payload =
    artifact.kind === 'character'
      ? artifact.card
      : artifact.kind === 'worldbook'
        ? artifact.lorebook
        : artifact.preset;
  return JSON.stringify(payload, null, 2);
}

export function buildConstructionFileName(artifact: ConstructionArtifact): string {
  const base = safeFileName(artifact.name);
  if (artifact.kind === 'character') return `${base}-角色卡.json`;
  if (artifact.kind === 'worldbook') return `${base}-世界书.json`;
  return `${base}-预设.json`;
}

export interface SaveArtifactSuccess {
  saved: true;
  uri: string;
  fileName: string;
}
export interface SaveArtifactCancelled {
  saved: false;
  reason: 'cancelled';
}
export type SaveArtifactResult = SaveArtifactSuccess | SaveArtifactCancelled;

/**
 * 把构建产物通过系统保存窗口写入用户选择的目录。
 * - 成功：返回 { saved: true, uri, fileName }
 * - 用户取消：返回 { saved: false, reason: 'cancelled' }（不抛错、不写库）
 * - 真实写入失败：抛出错误（调用方显示错误 Toast）
 */
export async function saveConstructionArtifact(
  artifact: ConstructionArtifact,
): Promise<SaveArtifactResult> {
  const fileName = buildConstructionFileName(artifact);
  const content = serializeArtifact(artifact);
  const cachePath = `${RNFS.CachesDirectoryPath}/${Date.now()}-${fileName}`;

  try {
    await RNFS.writeFile(cachePath, content, 'utf8');
    let results: Awaited<ReturnType<typeof saveDocuments>>;
    try {
      results = await saveDocuments({
        sourceUris: [`file://${cachePath}`],
        fileName,
        mimeType: ARTIFACT_MIME_TYPE,
      });
    } catch (error) {
      // 用户在系统保存窗口取消时，picker 会抛出 OPERATION_CANCELED。
      if (isErrorWithCode(error) && error.code === errorCodes.OPERATION_CANCELED) {
        return { saved: false, reason: 'cancelled' };
      }
      throw error instanceof Error
        ? error
        : new Error('保存文件时发生未知错误。');
    }

    const [result] = results;
    if (result?.error) {
      throw new Error(result.error);
    }
    if (!result?.uri) {
      // 没有拿到目标 URI 视为取消（避免误报成功）。
      return { saved: false, reason: 'cancelled' };
    }
    return { saved: true, uri: result.uri, fileName: result.name ?? fileName };
  } finally {
    RNFS.unlink(cachePath).catch(() => {
      /* 临时缓存清理失败可忽略 */
    });
  }
}

export type ImportToLibraryResult =
  | { kind: 'character'; id: number; name: string }
  | { kind: 'preset'; id: number; name: string }
  | { kind: 'worldbook'; name: string; entriesImported: number };

/** 为用户预设生成不覆盖旧资料的名称。 */
export function avoidPresetNameCollision(
  baseName: string,
  existingNames: Iterable<string>,
): string {
  const normalizedBase = baseName.trim() || '未命名预设';
  const used = new Set(
    Array.from(existingNames, name => String(name || '').trim()).filter(Boolean),
  );
  if (!used.has(normalizedBase)) return normalizedBase;
  let suffix = 2;
  let candidate = `${normalizedBase} (${suffix})`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${normalizedBase} (${suffix})`;
  }
  return candidate;
}

/** 读取一个 shinewriter-preset-v1 JSON 为构建产物。 */
export function parsePresetArtifactJSON(
  jsonText: string,
  sourceName = 'preset.json',
): PresetArtifact {
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    throw new Error(`预设文件「${sourceName}」不是有效 JSON。`);
  }
  if (isSillyTavernOpenAIPreset(value)) {
    const imported = parseSillyTavernOpenAIPreset(value, sourceName);
    const preset: ShineWriterPresetV1 = {
      spec: 'shinewriter-writer-style-v1',
      name: imported.semantic.name,
      system_prompt: imported.legacy.systemPrompt,
      writing_style: imported.legacy.writingStyle,
      extra_instructions: imported.legacy.extraInstructions,
      temperature: Number((value as any).temperature) || 0.8,
      top_p: Number((value as any).top_p) || 0.9,
      max_tokens: Number((value as any).openai_max_tokens) || 4000,
      semantic: imported.semantic,
      source_format: 'sillytavern_openai',
      compatibility: imported.envelope,
    };
    return {
      kind: 'preset',
      name: preset.name,
      preset,
      compatibility: imported.envelope,
    };
  }
  const preset = parseShineWriterPresetV1(value);
  if (preset.semantic) {
    preset.semantic = normalizeWriterStyleSemantic(preset.semantic, preset.name);
    preset.source_format = preset.source_format || 'shinewriter';
  }
  return { kind: 'preset', name: preset.name, preset };
}

/**
 * 将构建预览产物直接写入资料库，并绑定到当前项目启用。
 * - 角色卡：落入默认角色合集（无则创建「未分组角色」），JSON 与文件导入一致
 * - 世界书：新建合集 + 条目（默认常驻策略与资料库导入一致）
 * - projectId 无效时抛错，不写库
 */
export async function importConstructionArtifactToLibrary(
  artifact: ConstructionArtifact,
  projectId: number,
): Promise<ImportToLibraryResult> {
  if (!Number.isFinite(projectId) || projectId <= 0) {
    throw new Error('请先在「项目」中选择一个项目。');
  }

  const json = serializeArtifact(artifact);
  const sourceName = buildConstructionFileName(artifact);

  if (artifact.kind === 'character') {
    const collectionId = await db.ensureDefaultCharacterCollection(projectId);
    const id = await importCharacterFromJSON(
      projectId,
      json,
      sourceName,
      collectionId,
    );
    return {
      kind: 'character',
      id,
      name: artifact.name || artifact.card.data.name || '角色卡',
    };
  }

  if (artifact.kind === 'preset') {
    const existing = await db.getAllPresets();
    const name = avoidPresetNameCollision(
      artifact.name || artifact.preset.name,
      existing.map(item => item.name),
    );
    const id = await db.createPreset(projectId, name);
    await db.updatePreset(id, {
      name,
      is_default: 0,
      system_prompt: artifact.preset.system_prompt,
      writing_style: artifact.preset.writing_style,
      extra_instructions: artifact.preset.extra_instructions,
      temperature: artifact.preset.temperature,
      top_p: artifact.preset.top_p,
      max_tokens: artifact.preset.max_tokens,
      semantic_json: artifact.preset.semantic
        ? JSON.stringify(artifact.preset.semantic)
        : null,
      compatibility_json: artifact.compatibility
        ? JSON.stringify(artifact.compatibility)
        : artifact.preset.compatibility
          ? JSON.stringify(artifact.preset.compatibility)
          : null,
      source_format: artifact.preset.source_format ||
        (artifact.preset.semantic ? 'shinewriter' : 'legacy_shinewriter'),
      source_fingerprint: artifact.compatibility?.sourceFingerprint || '',
      compatibility_fingerprint: artifact.compatibility?.sourceFingerprint || null,
      asset_contract_version: artifact.preset.semantic ? 2 : 1,
    });
    return { kind: 'preset', id, name };
  }

  const imported = await importWorldBookFromJSON(projectId, json);
  return {
    kind: 'worldbook',
    name: imported.name || artifact.name || '世界书',
    entriesImported:
      imported.entriesImported ?? imported.entries?.length ?? artifact.entryCount,
  };
}

/** 从已保存的 Preset v1 文件直接导入“我的预设”。 */
export async function importPresetFromJSON(
  projectId: number,
  jsonText: string,
  sourceName = 'preset.json',
): Promise<ImportToLibraryResult> {
  return importConstructionArtifactToLibrary(
    parsePresetArtifactJSON(jsonText, sourceName),
    projectId,
  );
}

/** 复用现有 Storage Access Framework 选择器导入 Preset v1。 */
export async function importSelectedPreset(
  projectId: number,
): Promise<ImportToLibraryResult | null> {
  let copiedPath: string | null = null;
  try {
    const file = await pickSourceFile([types.json]);
    if (!file) return null;
    copiedPath = file.localPath;
    return await importPresetFromJSON(
      projectId,
      await RNFS.readFile(file.localPath, 'utf8'),
      file.name,
    );
  } finally {
    if (copiedPath) RNFS.unlink(copiedPath).catch(() => {});
  }
}

export type {
  CharacterArtifact,
  PresetArtifact,
  ShineWriterPresetV1,
  WorldbookArtifact,
};
