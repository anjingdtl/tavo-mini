import { NativeModules } from 'react-native';

/**
 * Native chunked TXT decoder for continuation imports (Spec §10).
 *
 * Backed by `ContinuationTextImportModule` (Kotlin). The module reads the
 * user-picked file in byte chunks and decodes UTF-8 (incl. BOM), UTF-16 LE/BE,
 * GBK and GB18030, handling multi-byte boundaries so a 5 MB TXT never becomes
 * a single base64 blob in JS. Returns the consumed byte count so the cursor
 * can advance without splitting a multi-byte character.
 */
export interface DetectedEncoding {
  encoding: string;
  /** 0–1; < 0.7 means the importer should ask the user to confirm. */
  confidence: number;
  hasBom: boolean;
  fileSizeBytes: number;
}

export interface DecodedChunk {
  text: string;
  nextByteOffset: number;
  decodedChars: number;
  bytesConsumed: number;
  atEof: boolean;
}

export interface FileMeta {
  fileSizeBytes: number;
  canRead: boolean;
  /** Present when canRead is false due to the file exceeding the size ceiling. */
  errorCode?: string;
}

export interface ContinuationTextImportModuleType {
  detectEncoding(path: string): Promise<DetectedEncoding>;
  readFileMeta(path: string): Promise<FileMeta>;
  decodeChunk(
    path: string,
    encoding: string,
    byteOffset: number,
    maxBytes: number,
    options?: Record<string, unknown> | null,
  ): Promise<DecodedChunk>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

/**
 * Lazily-resolved native module. `undefined` when not linked (tests, non-Android
 * platforms, or a fresh JS bundle before the native side is registered).
 */
export const ContinuationTextImport =
  (NativeModules.ContinuationTextImport as ContinuationTextImportModuleType | undefined) ??
  null;

/** Throw a typed error if the native module isn't available. */
export function requireContinuationTextImport(): ContinuationTextImportModuleType {
  if (!ContinuationTextImport) {
    throw new Error('续写原著导入原生模块未加载，请重启应用后再试。');
  }
  return ContinuationTextImport;
}
