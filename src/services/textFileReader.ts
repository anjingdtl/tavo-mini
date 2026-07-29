import { requireContinuationTextImport } from '../native/ContinuationTextImportModule';

const DECODE_CHUNK_BYTES = 192 * 1024;

export interface DecodedTextFile {
  text: string;
  /** Native detector result, retained for UI feedback such as “GB18030”. */
  encoding: string;
}

/**
 * Read a user-selected TXT file with Android's native charset detector.
 *
 * Unlike react-native-fs' `utf8` mode, this also accepts the GBK/GB18030 and
 * UTF-16 files commonly produced by Windows text editors. Decoding stays
 * chunked across the native bridge so large notes do not require a base64
 * copy in JavaScript.
 */
export async function readTextFileWithAutoEncodingResult(
  path: string,
): Promise<DecodedTextFile> {
  const decoder = requireContinuationTextImport();
  const detected = await decoder.detectEncoding(path);
  const fileSizeBytes = Number(detected.fileSizeBytes);

  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes < 0) {
    throw new Error('无法读取 TXT 文件大小，请重新选择文件。');
  }
  if (fileSizeBytes === 0) {
    return { text: '', encoding: detected.encoding };
  }

  const parts: string[] = [];
  let byteOffset = 0;

  while (byteOffset < fileSizeBytes) {
    const chunk = await decoder.decodeChunk(
      path,
      detected.encoding,
      byteOffset,
      DECODE_CHUNK_BYTES,
      null,
    );
    const nextByteOffset = Number(chunk.nextByteOffset);

    if (
      !Number.isFinite(nextByteOffset) ||
      nextByteOffset <= byteOffset ||
      nextByteOffset > fileSizeBytes
    ) {
      throw new Error('TXT 解码无进展，文件可能已损坏或编码无法识别。');
    }

    parts.push(chunk.text);
    byteOffset = nextByteOffset;
    if (chunk.atEof) break;
  }

  if (byteOffset < fileSizeBytes) {
    throw new Error('TXT 文件未能完整读取，请确认文件未损坏后重试。');
  }

  // Java's UTF decoders preserve BOM as U+FEFF; it is metadata rather than
  // user-authored note content and should not enter the database.
  return {
    text: parts.join('').replace(/^\uFEFF/, ''),
    encoding: detected.encoding,
  };
}

/**
 * Backwards-compatible text-only reader for existing note-import callers.
 */
export async function readTextFileWithAutoEncoding(
  path: string,
): Promise<string> {
  return (await readTextFileWithAutoEncodingResult(path)).text;
}
