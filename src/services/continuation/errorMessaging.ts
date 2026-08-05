/**
 * User-facing error message mapping for the continuation module.
 *
 * The repository layer (`continuationImportService.ts`) classifies raw errors
 * into a small set of `errorCode` strings via `classifyError`. This module
 * turns those codes into actionable Chinese messages with suggested next steps
 * so the UI can show Toast / Alert with concrete guidance instead of a bare
 * "请重试".
 *
 * Kept side-effect free and string-only so it can be safely called from any
 * render path without triggering extra work.
 */

export interface ImportErrorMessage {
  /** Short title for the alert/toast header. */
  title: string;
  /** Optional suggested next step for the user. */
  suggestion?: string;
}

/** Map a continuation import errorCode to a user-facing message. */
export function mapImportErrorToUserMessage(
  errorCode: string | null | undefined,
  rawMessage: string,
): ImportErrorMessage {
  switch (errorCode) {
    case 'unsupported_encoding':
      return {
        title: 'TXT 编码不支持',
        suggestion: '请将文件转为 UTF-8 后重试，或导入时手动指定编码。',
      };
    case 'file_too_large':
      return {
        title: '文件超过 200MB 限制',
        suggestion: '请拆分文件后重试。',
      };
    case 'decode_failed':
      return {
        title: '解码失败',
        suggestion: '疑似编码不匹配，请尝试手动指定编码（UTF-8 / GBK）。',
      };
    case 'parse_failed':
      return {
        title: '解析失败',
        suggestion: rawMessage || '请检查文件内容后重试。',
      };
    case 'chunk_integrity_failed':
      return {
        title: '分块校验失败',
        suggestion: '请重新导入该文件。',
      };
    case 'continuation_source_integrity_failed':
    case 'chunk_length_mismatch':
    case 'chunk_hash_mismatch':
    case 'chunk_offset_gap':
    case 'chunk_offset_overlap':
    case 'chunk_surrogate_boundary':
    case 'read_range_length_mismatch':
    case 'chapter_range_invalid':
    case 'chapter_content_mismatch':
      return {
        title: '原著存储完整性失败',
        suggestion:
          '当前错误不可通过“稍后重试”恢复。请重新导入原始 TXT；' +
          '若导入后仍失败，请先执行原著完整性检查。',
      };
    case 'style_sample_hash_mismatch':
      return {
        title: '风格样本校验失败',
        suggestion:
          '采样正文与源回读不一致，通常表示原著分块已损坏。' +
          '请重新导入原始 TXT，不要反复点击单独重试。',
      };
    case 'storage_full':
      return {
        title: '存储空间不足',
        suggestion: '请清理设备空间后重试。',
      };
    case 'source_changed':
      return {
        title: '源文件已变更',
        suggestion: '请重新选择文件并导入。',
      };
    case 'job_interrupted':
      return {
        title: '上次导入被中断',
        suggestion: '可在续写首页恢复或重新开始导入。',
      };
    default:
      return {
        title: rawMessage || '未知错误',
      };
  }
}

/** Format a list of failed files for an Alert body. */
export function formatFailedFilesList(
  failedFiles: Array<{ fileName: string; message: string }>,
  maxShown = 5,
): string {
  const shown = failedFiles.slice(0, maxShown);
  const lines = shown.map(f => `• ${f.fileName}: ${f.message}`);
  if (failedFiles.length > maxShown) {
    lines.push(`...（其余 ${failedFiles.length - maxShown} 个文件失败）`);
  }
  return lines.join('\n');
}
