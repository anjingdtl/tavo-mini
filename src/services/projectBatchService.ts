import { utf8Encode } from './continuation/hashUtils';

export interface ProjectBatchArchiveInput {
  fileName: string;
  content: string;
}

export interface ProjectBatchArchiveEntry {
  fileName: string;
  byteLength: number;
}

export interface ProjectBatchArchive {
  fileName: string;
  bytes: Uint8Array;
  entries: ProjectBatchArchiveEntry[];
}

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
  };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Build a standards-compliant UTF-8 ZIP archive using the store method.
 * Project JSON is already the required final artifact; avoiding a second
 * compression buffer keeps the export path predictable for large projects.
 */
export function buildProjectBatchArchive(
  inputs: ProjectBatchArchiveInput[],
  date = new Date(),
): ProjectBatchArchive {
  if (inputs.length === 0) throw new Error('没有可导出的项目。');
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(
    2,
    '0',
  )}${String(date.getDate()).padStart(2, '0')}`;
  const fileName = `ShineWriter-Projects-${stamp}.zip`;
  const { date: dosDay, time: dosTime } = dosDateTime(date);
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const entries: ProjectBatchArchiveEntry[] = [];
  let offset = 0;

  for (const input of inputs) {
    const name = utf8Encode(input.fileName);
    const data = utf8Encode(input.content);
    const checksum = crc32(data);
    const localHeader = new Uint8Array(30 + name.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, dosTime);
    writeUint16(localHeader, 12, dosDay);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, data.length);
    writeUint32(localHeader, 22, data.length);
    writeUint16(localHeader, 26, name.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(name, 30);
    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + name.length);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0x0800);
    writeUint16(centralHeader, 10, 0);
    writeUint16(centralHeader, 12, dosTime);
    writeUint16(centralHeader, 14, dosDay);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, data.length);
    writeUint32(centralHeader, 24, data.length);
    writeUint16(centralHeader, 28, name.length);
    writeUint16(centralHeader, 30, 0);
    writeUint16(centralHeader, 32, 0);
    writeUint16(centralHeader, 34, 0);
    writeUint16(centralHeader, 36, 0);
    writeUint32(centralHeader, 38, 0);
    writeUint32(centralHeader, 42, offset);
    centralHeader.set(name, 46);
    centralParts.push(centralHeader);
    entries.push({ fileName: input.fileName, byteLength: data.length });
    offset += localHeader.length + data.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const localDirectory = concatBytes(localParts);
  const end = new Uint8Array(22);
  writeUint32(end, 0, 0x06054b50);
  writeUint16(end, 4, 0);
  writeUint16(end, 6, 0);
  writeUint16(end, 8, entries.length);
  writeUint16(end, 10, entries.length);
  writeUint32(end, 12, centralDirectory.length);
  writeUint32(end, 16, localDirectory.length);
  writeUint16(end, 20, 0);

  return {
    fileName,
    bytes: concatBytes([localDirectory, centralDirectory, end]),
    entries,
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const bitmap = (first << 16) | (second << 8) | third;
    output += alphabet[(bitmap >>> 18) & 63];
    output += alphabet[(bitmap >>> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(bitmap >>> 6) & 63] : '=';
    output += index + 2 < bytes.length ? alphabet[bitmap & 63] : '=';
  }
  return output;
}
