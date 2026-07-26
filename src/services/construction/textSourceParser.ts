import { estimateTokens } from '../../utils/tokenEstimator';

/* eslint-disable no-bitwise -- UTF-16/Base64 decoding operates on bytes. */

export interface TextSourceSection {
  id: string;
  title: string;
  content: string;
  estimatedTokens: number;
}

export interface ParsedTextSource {
  name: string;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
  sections: TextSourceSection[];
}

function decodeBase64(base64: string): Uint8Array {
  const atobFn = (globalThis as any).atob;
  const binary =
    typeof atobFn === 'function'
      ? atobFn(base64.replace(/\s/g, ''))
      : (() => {
          const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
          let output = '';
          let buffer = 0;
          let bits = 0;
          for (const char of base64.replace(/\s/g, '')) {
            if (char === '=') break;
            const value = alphabet.indexOf(char);
            if (value < 0) continue;
            buffer = (buffer << 6) | value;
            bits += 6;
            if (bits >= 8) {
              bits -= 8;
              output += String.fromCharCode((buffer >> bits) & 0xff);
            }
          }
          return output;
        })();
  return Uint8Array.from(binary as string, (char: string) => char.charCodeAt(0));
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    let escaped = '';
    for (const byte of bytes) escaped += `%${byte.toString(16).padStart(2, '0')}`;
    return decodeURIComponent(escaped);
  } catch {
    throw new Error('TXT 不是有效的 UTF-8 编码，请另存为 UTF-8 后重试。');
  }
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  if (bytes.length % 2 !== 0) {
    throw new Error('TXT 的 UTF-16 字节长度不完整。');
  }
  let output = '';
  for (let index = 0; index < bytes.length; index += 2) {
    const unit = littleEndian
      ? bytes[index] | (bytes[index + 1] << 8)
      : (bytes[index] << 8) | bytes[index + 1];
    output += String.fromCharCode(unit);
  }
  return output;
}

/** 从 Android 文件选择器读出的 base64 内容解码常见 TXT 编码。 */
export function decodeTextSourceBase64(base64: string): {
  text: string;
  encoding: ParsedTextSource['encoding'];
} {
  const bytes = decodeBase64(base64);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeUtf16(bytes.slice(2), true), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16(bytes.slice(2), false), encoding: 'utf-16be' };
  }
  const utf8 = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.slice(3)
    : bytes;
  return { text: decodeUtf8(utf8), encoding: 'utf-8' };
}

function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

function sectionId(index: number): string {
  return `section-${index + 1}`;
}

function makeSection(index: number, title: string, content: string): TextSourceSection | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return {
    id: sectionId(index),
    title: title.trim() || `片段 ${index + 1}`,
    content: trimmed,
    estimatedTokens: estimateTokens(trimmed),
  };
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line) || /^\s*第[0-9一二三四五六七八九十百千万两]+[章节回]\S*/.test(line);
}

function splitUntitledParagraphs(text: string): TextSourceSection[] {
  const paragraphs = text.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
  const sections: TextSourceSection[] = [];
  let buffer = '';
  for (const paragraph of paragraphs) {
    if (buffer && visibleLength(buffer) + visibleLength(paragraph) > 2400) {
      const section = makeSection(sections.length, `片段 ${sections.length + 1}`, buffer);
      if (section) sections.push(section);
      buffer = paragraph;
    } else {
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    }
  }
  const last = makeSection(sections.length, `片段 ${sections.length + 1}`, buffer);
  if (last) sections.push(last);
  return sections;
}

function visibleLength(value: string): number {
  return value.replace(/\s/g, '').length;
}

/** 本地把 TXT 切成可选择的章节/标题/段落，不向网络或数据库写入内容。 */
export function parseConstructionTextSource(
  text: string,
  fileName = '导入的 TXT',
  encoding: ParsedTextSource['encoding'] = 'utf-8',
): ParsedTextSource {
  const normalized = normalizeText(text);
  if (!normalized) throw new Error('TXT 内容为空。');
  const lines = normalized.split('\n');
  const hasHeading = lines.some(isHeading);
  const sections: TextSourceSection[] = [];
  if (!hasHeading) {
    sections.push(...splitUntitledParagraphs(normalized));
  } else {
    let title = '';
    let body: string[] = [];
    const flush = () => {
      const section = makeSection(sections.length, title || `片段 ${sections.length + 1}`, body.join('\n'));
      if (section) sections.push(section);
    };
    for (const line of lines) {
      if (isHeading(line)) {
        flush();
        title = line.replace(/^#{1,6}\s*/, '').trim();
        body = [];
      } else {
        body.push(line);
      }
    }
    flush();
  }
  if (sections.length === 0) throw new Error('TXT 中没有可用于构建的有效段落。');
  return {
    name: fileName.replace(/\.[^.]+$/, '').trim() || '导入的 TXT',
    encoding,
    sections,
  };
}

export function buildTextSourceSnapshot(
  source: ParsedTextSource,
  selectedIds: string[],
): string {
  const selected = new Set(selectedIds);
  const sections = source.sections.filter(section => selected.has(section.id));
  if (sections.length === 0) throw new Error('请至少选择一个 TXT 片段。');
  return [
    `【TXT 来源：${source.name}】已选择 ${sections.length} 段`,
    ...sections.map((section, index) => `【${index + 1}. ${section.title}】\n${section.content}`),
  ].join('\n\n');
}
