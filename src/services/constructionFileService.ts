import RNFS from 'react-native-fs';
import {
  errorCodes,
  isErrorWithCode,
  saveDocuments,
} from '@react-native-documents/picker';
import type {
  CharacterArtifact,
  ConstructionArtifact,
  WorldbookArtifact,
} from './construction/targets';

/**
 * 「构建」模块的文件序列化与系统保存封装（SPEC §9.3）。
 *
 * 复用现有 Android Storage Access Framework 流程（saveDocuments），不申请宽泛
 * 存储权限、不假定可写入固定公共目录。用户取消保存窗口时返回 null —— 调用方
 * 不得据此显示「保存成功」或写入资料库。
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
    artifact.kind === 'character' ? artifact.card : artifact.lorebook;
  return JSON.stringify(payload, null, 2);
}

export function buildConstructionFileName(artifact: ConstructionArtifact): string {
  const base = safeFileName(artifact.name);
  return artifact.kind === 'character'
    ? `${base}-角色卡.json`
    : `${base}-世界书.json`;
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

export type { CharacterArtifact, WorldbookArtifact };
