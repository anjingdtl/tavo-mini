/**
 * 共享流式 TXT 解码管线（B0：项目 TXT 与续写 TXT 的同一套 Streaming 能力）。
 *
 * 项目页「TXT 小说 → 可编辑项目」与续写「原著导入」都必须使用同一个
 * decode → normalize → line feed 管线，而不是各自维护一套大文件解析逻辑。
 *
 * 本模块拥有：
 *   - 原生 decodeChunk 的 192 KiB 分块循环（ UTF-8/UTF-16/GBK/GB18030）；
 *   - StreamingNormalizer（跨块 CRLF/代理对/BOM 细节与一次性完全等价）；
 *   - 完整行拆分（跨块携带尾部半行；超长行按部件投递，不拼接巨串）。
 *
 * 调用方通过回调获得：原始解码块、归一化块、完整行（含行首 UTF-16 偏移）、
 * 超长行部件、进度。回调按数据出现顺序被逐一 await。
 *
 * 行为与 Continue 时代逐字节等价：同一输入、任意分块下，
 * normalizedCharCount / normalizedByteCount / normalizedSha256 与一次性
 * normalizeSourceText 完全一致（由 __tests__/txtStreaming.test.ts 锁定）。
 */
import { requireContinuationTextImport } from '../native/ContinuationTextImportModule';
import { createStreamingNormalizer } from './continuation/continuationNormalizer';

/** 每个 decodeChunk 请求的最大字节数（与续写导入一致）。 */
export const TXT_STREAM_CHUNK_BYTES = 192 * 1024;
/**
 * 超过该长度的行不拼接成完整字符串，改按部件投递（避免路径化超长行制造
 * 第二个巨型 JS 字符串导致 Android 堆溢出）。
 */
export const TXT_STREAM_MAX_JOINED_LINE_CHARS = 16 * 1024;

export interface StreamTxtFileInput {
  /** App 私有可读的绝对路径。 */
  localPath: string;
  /** 解码编码（utf-8 / utf-16le / utf-16be / gbk / gb18030）。 */
  encoding: string;
  fileSizeBytes: number;
  /** 仅用于错误消息展示。 */
  originalFileName?: string;
}

export interface StreamDecodedTextCallbacks {
  /** 每个解码块（归一化之前，用于 raw 哈希等）。 */
  onDecodedChunk?: (meta: { fileIndex: number; rawText: string }) => void | Promise<void>;
  /** 每个归一化块（用于 fallback 哈希 / 文本累积等）。 */
  onNormalizedChunk?: (meta: { fileIndex: number; block: string }) => void | Promise<void>;
  /** 每个完整行（不含换行符）。行首偏移是归一化文本中的 UTF-16 偏移。 */
  onLine?: (meta: {
    fileIndex: number;
    line: string;
    lineStartOffset: number;
    lineLength: number;
  }) => void | Promise<void>;
  /** 超过 MAX_JOINED_LINE_CHARS 的长行按部件投递（不拼接）。 */
  onLongLineParts?: (meta: {
    fileIndex: number;
    parts: readonly string[];
    lineStartOffset: number;
    lineLength: number;
  }) => void | Promise<void>;
  /** 每个解码块处理完后回调；globalProcessedBytes 跨文件累计。 */
  onProgress?: (meta: {
    fileIndex: number;
    byteCursor: number;
    globalProcessedBytes: number;
    totalBytes: number;
  }) => void | Promise<void>;
}

export interface StreamDecodedTextResult {
  normalizedCharCount: number;
  normalizedByteCount: number;
  normalizedSha256: string;
  removedBom: boolean;
}

/**
 * 流式解码 → 归一化 → 完整行投递（多文件顺序合并）。
 *
 * 与续写导入原 runPipelineToReview 的读取段逐行为等价：每个文件的末尾
 * 半行先冲刷（行间不跨文件合并），行首偏移跨文件持续累加（等价于把多个
 * 文件按序拼接后一次性解析）。
 */
export async function streamDecodedText(input: {
  files: StreamTxtFileInput[];
  callbacks: StreamDecodedTextCallbacks;
}): Promise<StreamDecodedTextResult> {
  const { files, callbacks } = input;
  if (files.length === 0) {
    throw new Error('未选择任何文件。');
  }
  const mod = requireContinuationTextImport();
  const normalizer = createStreamingNormalizer();

  // 跨块携带的半行（同一文件内）；文件边界先冲刷。
  let pendingLineParts: string[] = [];
  let pendingLineLength = 0;
  let pendingLineStartOffset = 0;

  const totalBytes = files.reduce((s, f) => s + f.fileSizeBytes, 0);

  const emitLine = async (fileIndex: number) => {
    if (pendingLineLength <= TXT_STREAM_MAX_JOINED_LINE_CHARS) {
      const line =
        pendingLineParts.length === 1
          ? pendingLineParts[0]
          : pendingLineParts.join('');
      await callbacks.onLine?.({
        fileIndex,
        line,
        lineStartOffset: pendingLineStartOffset,
        lineLength: pendingLineLength,
      });
    } else {
      await callbacks.onLongLineParts?.({
        fileIndex,
        parts: pendingLineParts,
        lineStartOffset: pendingLineStartOffset,
        lineLength: pendingLineLength,
      });
    }
  };

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    let byteCursor = 0;
    while (byteCursor < file.fileSizeBytes) {
      const decoded = await mod.decodeChunk(
        file.localPath,
        file.encoding,
        byteCursor,
        TXT_STREAM_CHUNK_BYTES,
        null,
      );
      if (decoded.bytesConsumed === 0 && !decoded.atEof) {
        throw new Error(
          `解码 ${file.originalFileName ?? '文件'} 无进展，疑似编码不匹配，请确认文件编码。`,
        );
      }

      await callbacks.onDecodedChunk?.({ fileIndex, rawText: decoded.text });

      const normalizedBlock = normalizer.push(decoded.text);
      await callbacks.onNormalizedChunk?.({ fileIndex, block: normalizedBlock });

      // 按完整行拆分：块内以 '\n' 分割，块尾残余并入 pending。
      let blockRest = normalizedBlock;
      while (true) {
        const nlIdx = blockRest.indexOf('\n');
        if (nlIdx < 0) {
          if (blockRest.length > 0) {
            pendingLineParts.push(blockRest);
            pendingLineLength += blockRest.length;
          }
          break;
        }
        const segment = blockRest.slice(0, nlIdx);
        if (pendingLineParts.length > 0) {
          pendingLineParts.push(segment);
        } else {
          pendingLineParts = [segment];
        }
        pendingLineLength += segment.length;
        await emitLine(fileIndex);
        pendingLineStartOffset += pendingLineLength + 1;
        pendingLineParts = [];
        pendingLineLength = 0;
        blockRest = blockRest.slice(nlIdx + 1);
      }

      byteCursor = decoded.nextByteOffset;
      const processedBefore = files
        .slice(0, fileIndex)
        .reduce((s, f) => s + f.fileSizeBytes, 0);
      await callbacks.onProgress?.({
        fileIndex,
        byteCursor,
        globalProcessedBytes: processedBefore + byteCursor,
        totalBytes,
      });
      if (decoded.atEof) break;
    }

    // 文件末尾冲刷尾部半行；行首偏移只加行长（本行后无 '\n'，不 +1），
    // 下一个文件的第一行从正确偏移开始。
    if (pendingLineLength > 0) {
      await emitLine(fileIndex);
      pendingLineStartOffset += pendingLineLength;
      pendingLineParts = [];
      pendingLineLength = 0;
    }
  }

  return normalizer.finalize();
}