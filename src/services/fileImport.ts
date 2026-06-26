import RNFS from 'react-native-fs';
import { keepLocalCopy, pick, types } from '@react-native-documents/picker';
import { inflate } from 'pako';
import * as db from './database';

/* eslint-disable no-bitwise */

export interface CharacterImportPayload {
  name: string;
  sourceType: 'json' | 'png';
  data: Record<string, unknown>;
}

interface ShineWriterCharacterAsset {
  imagePath?: string;
  imageSourceName?: string;
  imageUpdatedAt?: string;
}

export interface ParsedWorldBookEntry {
  keyword_primary: string;
  keyword_secondary: string;
  content: string;
  comment: string;
  enabled: number;
  constant: number;
  position: number;
}

export interface WorldBookImportResult {
  name: string;
  entries: ParsedWorldBookEntry[];
  entriesImported?: number;
}

function readJsonObject(jsonText: string): Record<string, any> {
  // 去除 UTF-8 BOM，避免 Windows 编辑器生成的文件解析失败
  const stripped = jsonText.replace(/^\uFEFF/, '');
  let data: any;
  try {
    data = JSON.parse(stripped);
  } catch {
    throw new Error('文件内容不是有效的 JSON 格式。');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('文件内容不是有效的 JSON 对象。');
  }
  return data;
}

function characterImageDirectory(): string {
  return `${RNFS.DocumentDirectoryPath}/character-images`;
}

function safeFileName(name: string): string {
  const sanitized = name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').trim();
  return sanitized || 'character.png';
}

async function persistCharacterPngImage(sourcePath: string, sourceName: string): Promise<string> {
  const dir = characterImageDirectory();
  await RNFS.mkdir(dir);
  const fileName = safeFileName(sourceName.toLowerCase().endsWith('.png') ? sourceName : `${sourceName}.png`);
  const destination = `${dir}/${Date.now()}-${fileName}`;
  await RNFS.copyFile(sourcePath, destination);
  return destination;
}

export function withCharacterImageAsset<T extends Record<string, any>>(
  data: T,
  imagePath: string,
  sourceName?: string,
): T & { __tavo?: ShineWriterCharacterAsset } {
  return {
    ...data,
    __tavo: {
      ...(data.__tavo || {}),
      imagePath,
      imageSourceName: sourceName,
      imageUpdatedAt: new Date().toISOString(),
    },
  };
}

export function getCharacterImagePath(dataJson?: string | null): string | null {
  if (!dataJson) return null;
  try {
    const data = JSON.parse(dataJson);
    return typeof data?.__tavo?.imagePath === 'string' ? data.__tavo.imagePath : null;
  } catch {
    return null;
  }
}

export function parseCharacterCardJSON(
  jsonText: string,
  sourceName = 'character.json',
): CharacterImportPayload {
  const data = readJsonObject(jsonText);
  const spec = String(data.spec || '');
  const cardData = data.data && typeof data.data === 'object' ? data.data : data;
  const name = String(cardData.name || data.name || '').trim();

  if (!name) {
    throw new Error(`无法从「${sourceName}」识别角色名称。`);
  }

  if (spec && !spec.startsWith('chara_card_v') && spec !== 'character_card_v3') {
    throw new Error(`不支持的角色卡格式：${spec}`);
  }

  return { name, sourceType: 'json', data };
}

function normalizeKeys(raw: any): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function entriesFromUnknown(rawEntries: any): any[] {
  if (Array.isArray(rawEntries)) return rawEntries;
  if (rawEntries && typeof rawEntries === 'object') return Object.values(rawEntries);
  return [];
}

export function parseWorldBookJSON(jsonText: string, sourceName?: string): WorldBookImportResult {
  const data = readJsonObject(jsonText);
  let name = sourceName
    ? sourceName.replace(/\.[^.]+$/, '').trim() || '导入的世界书'
    : '导入的世界书';
  let entries: any[] = [];

  if (data.spec === 'lorebook_v3' && data.data) {
    name = String(data.data.name || name);
    entries = entriesFromUnknown(data.data.entries);
  } else if (data.lorebook_v3) {
    name = String(data.lorebook_v3.name || name);
    entries = entriesFromUnknown(data.lorebook_v3.entries);
  } else if (data.entries) {
    name = String(data.name || name);
    entries = entriesFromUnknown(data.entries);
  } else if (String(data.spec || '').startsWith('chara_card_v')) {
    const cardData = data.data || data;
    const book = cardData.character_book || cardData.characterBook;
    if (book) {
      name = String(book.name || `${cardData.name || '角色'}的世界书`);
      entries = entriesFromUnknown(book.entries);
    }
  }

  const parsed = entries
    .map((entry, index): ParsedWorldBookEntry | null => {
      const keys = normalizeKeys(entry.keys ?? entry.key ?? entry.keyword ?? entry.keyword_primary);
      const secondaryKeys = normalizeKeys(entry.secondary_keys ?? entry.keysecondary ?? entry.keyword_secondary);
      const content = String(entry.content || '').trim();
      const constant = entry.constant === true || entry.constant === 1 || keys.length === 0 ? 1 : 0;
      if (!content || (keys.length === 0 && !constant)) return null;
      return {
        keyword_primary: keys[0] || '',
        keyword_secondary: secondaryKeys.length ? secondaryKeys.join(', ') : keys.slice(1).join(', '),
        content,
        comment: String(entry.comment || entry.name || ''),
        enabled: entry.enabled === false || entry.disable === true ? 0 : 1,
        constant,
        position: Number(entry.position ?? entry.insertion_order ?? entry.order ?? index) || index,
      };
    })
    .filter((entry): entry is ParsedWorldBookEntry => Boolean(entry));

  if (parsed.length === 0) {
    throw new Error('未找到可导入的世界书条目。');
  }

  return { name, entries: parsed };
}

function decodeLatin1(bytes: number[]): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    result += String.fromCharCode.apply(null, bytes.slice(i, i + 8192));
  }
  return result;
}

function decodeUtf8Bytes(bytes: number[]): string {
  try {
    const escaped = bytes.map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
    return decodeURIComponent(escaped);
  } catch {
    // Invalid UTF-8 sequence — fallback to lossy Latin-1 decode
    return decodeLatin1(bytes);
  }
}

function decodeBase64(base64: string): string {
  const atobFn = (globalThis as any).atob;
  if (typeof atobFn === 'function') return atobFn(base64);
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
}

function decodeBase64Utf8(base64: string): string {
  const binary = decodeBase64(base64);
  const escaped = Array.from(binary, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  return decodeURIComponent(escaped);
}

function parsePngTextChunks(base64: string): Record<string, string> {
  const binary = decodeBase64(base64);
  const bytes = Array.from(binary, (char) => char.charCodeAt(0));
  const result: Record<string, string> = {};
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length =
      ((bytes[offset] << 24) >>> 0) +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3];
    const type = decodeLatin1(bytes.slice(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) break;

    if (type === 'tEXt') {
      const chunk = decodeLatin1(bytes.slice(dataStart, dataEnd));
      const split = chunk.indexOf('\0');
      if (split > -1) {
        result[chunk.slice(0, split)] = chunk.slice(split + 1);
      }
    } else if (type === 'zTXt') {
      const data = bytes.slice(dataStart, dataEnd);
      const split = data.indexOf(0);
      if (split > -1 && data[split + 1] === 0) {
        const keyword = decodeLatin1(data.slice(0, split));
        const compressed = new Uint8Array(data.slice(split + 2));
        result[keyword] = decodeUtf8Bytes(Array.from(inflate(compressed)));
      }
    } else if (type === 'iTXt') {
      const data = bytes.slice(dataStart, dataEnd);
      const keywordEnd = data.indexOf(0);
      if (keywordEnd > -1 && keywordEnd + 3 < data.length) {
        const keyword = decodeLatin1(data.slice(0, keywordEnd));
        const compressed = data[keywordEnd + 1] === 1;
        let cursor = keywordEnd + 3;
        const languageEnd = data.indexOf(0, cursor);
        if (languageEnd === -1) {
          offset = dataEnd + 4;
          continue;
        }
        cursor = languageEnd + 1;
        const translatedEnd = data.indexOf(0, cursor);
        if (translatedEnd === -1) {
          offset = dataEnd + 4;
          continue;
        }
        const textBytes = data.slice(translatedEnd + 1);
        result[keyword] = compressed
          ? decodeUtf8Bytes(Array.from(inflate(new Uint8Array(textBytes))))
          : decodeUtf8Bytes(textBytes);
      }
    }

    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }

  return result;
}

export async function parseCharacterCardPNG(filePath: string): Promise<CharacterImportPayload> {
  const base64 = await RNFS.readFile(filePath, 'base64');
  const chunks = parsePngTextChunks(base64);
  const raw = chunks.chara || chunks.ccv3 || chunks.character || chunks.Description;
  if (!raw) {
    throw new Error('PNG 中未找到 SillyTavern 角色卡元数据。');
  }

  const decoded = raw.trim().startsWith('{') ? raw : decodeBase64Utf8(raw);
  const payload = parseCharacterCardJSON(decoded, filePath);
  return { ...payload, sourceType: 'png' };
}

async function pickLocalFile(allowedTypes: string[]): Promise<{ localPath: string; name: string; mimeType?: string | null } | null> {
  const [selected] = await pick({ type: allowedTypes, allowMultiSelection: false, mode: 'import' });
  if (!selected) return null;

  const [copy] = await keepLocalCopy({
    files: [{ uri: selected.uri, fileName: selected.name || 'shinewriter-import' }],
    destination: 'cachesDirectory',
  });
  if (copy.status === 'error') {
    throw new Error(copy.copyError || '复制导入文件失败。');
  }

  return {
    localPath: copy.localUri.replace(/^file:\/\//, ''),
    name: selected.name || 'shinewriter-import',
    mimeType: selected.type,
  };
}

function isPngSelection(file: { name: string; mimeType?: string | null }): boolean {
  return file.name.toLowerCase().endsWith('.png') || file.mimeType === 'image/png';
}

export async function importSelectedCharacter(projectId: number): Promise<number | null> {
  const file = await pickLocalFile([types.json, types.images]);
  if (!file) return null;
  const isPng = isPngSelection(file);
  let payload = isPng
    ? await parseCharacterCardPNG(file.localPath)
    : parseCharacterCardJSON(await RNFS.readFile(file.localPath, 'utf8'), file.name);
  if (isPng) {
    const imagePath = await persistCharacterPngImage(file.localPath, file.name);
    payload = { ...payload, data: withCharacterImageAsset(payload.data, imagePath, file.name) };
  }
  return db.createCharacter(projectId, payload.name, payload.sourceType, JSON.stringify(payload.data));
}

export async function pickCharacterPngImageReplacement(): Promise<string | null> {
  const file = await pickLocalFile([types.images]);
  if (!file) return null;
  if (!isPngSelection(file)) {
    throw new Error('请选择 PNG 图片文件。');
  }
  return persistCharacterPngImage(file.localPath, file.name);
}

export async function importSelectedNoteText(projectId: number): Promise<{ firstId: number; createdCount: number } | null> {
  const file = await pickLocalFile([types.plainText, types.allFiles]);
  if (!file) return null;
  const content = await RNFS.readFile(file.localPath, 'utf8');
  const title = file.name.replace(/\.[^.]+$/, '').trim() || '导入的 TXT 笔记';
  return db.createNotesFromTextChunks(projectId, title, content);
}

export async function importSelectedWorldBook(projectId: number): Promise<WorldBookImportResult | null> {
  const file = await pickLocalFile([types.json]);
  if (!file) return null;

  const parsed = parseWorldBookJSON(await RNFS.readFile(file.localPath, 'utf8'), file.name);
  const collectionId = await db.createWorldbookCollection(projectId, parsed.name, { enabled: 1 });
  try {
    let count = 0;
    for (const entry of parsed.entries) {
      await db.createWorldbookEntry(projectId, entry.keyword_primary, entry.content, entry.enabled, {
        collection_id: collectionId,
        keyword_secondary: entry.keyword_secondary,
        comment: entry.comment,
        constant: entry.constant,
        position: entry.position,
      });
      count++;
    }
    await db.updateWorldbookCollectionTokenEstimate(collectionId);
    return { ...parsed, entriesImported: count };
  } catch (error) {
    // Partial import failed — clean up the orphaned collection
    await db.deleteWorldbookCollection(collectionId).catch(() => {});
    throw error;
  }
}

export async function importCharacterFromJSON(
  projectId: number,
  jsonText: string,
  sourceName = 'character.json',
): Promise<number> {
  const payload = parseCharacterCardJSON(jsonText, sourceName);
  return db.createCharacter(projectId, payload.name, payload.sourceType, JSON.stringify(payload.data));
}

export async function importWorldBookFromJSON(
  projectId: number,
  jsonText: string,
): Promise<WorldBookImportResult> {
  const parsed = parseWorldBookJSON(jsonText);
  const collectionId = await db.createWorldbookCollection(projectId, parsed.name, { enabled: 1 });
  try {
    let count = 0;
    for (const entry of parsed.entries) {
      await db.createWorldbookEntry(projectId, entry.keyword_primary, entry.content, entry.enabled, {
        collection_id: collectionId,
        keyword_secondary: entry.keyword_secondary,
        comment: entry.comment,
        constant: entry.constant,
        position: entry.position,
      });
      count++;
    }
    await db.updateWorldbookCollectionTokenEstimate(collectionId);
    return { ...parsed, entriesImported: count };
  } catch (error) {
    await db.deleteWorldbookCollection(collectionId).catch(() => {});
    throw error;
  }
}
