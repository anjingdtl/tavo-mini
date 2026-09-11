import RNFS from 'react-native-fs';
import { keepLocalCopy, pick, types } from '@react-native-documents/picker';
import { localFileUriToPath } from '../utils/localFileUri';

export type CharacterImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

/** Product limit for AI visual-reference assets. Legacy PNG cards use a separate validator below. */
export const CHARACTER_VISUAL_REFERENCE_MAX_MB = 5;
export const CHARACTER_VISUAL_REFERENCE_MAX_BYTES =
  CHARACTER_VISUAL_REFERENCE_MAX_MB * 1024 * 1024;

// Keep the existing names as compatibility aliases for callers/tests that
// treated the old generic image limit as the visual-reference limit.
export const CHARACTER_IMAGE_MAX_MB = CHARACTER_VISUAL_REFERENCE_MAX_MB;
export const CHARACTER_IMAGE_MAX_BYTES = CHARACTER_VISUAL_REFERENCE_MAX_BYTES;

export interface CharacterVisualReference {
  localPath: string;
  name: string;
  mimeType: CharacterImageMimeType;
  size: number;
}

interface CharacterAssetMetadata {
  imagePath?: string;
  imageSourceName?: string;
  imageMimeType?: CharacterImageMimeType;
  imageSize?: number;
  imageUpdatedAt?: string;
}

export interface CharacterImageAssetContainer {
  __tavo?: CharacterAssetMetadata;
}

function imageDirectory(): string {
  return `${RNFS.DocumentDirectoryPath}/character-images`;
}

function cacheDirectory(): string {
  return RNFS.CachesDirectoryPath;
}

function safeFileName(name: string, fallbackExtension: string): string {
  const sanitized = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .trim();
  const base = sanitized || `character${fallbackExtension}`;
  return base.toLowerCase().endsWith(fallbackExtension)
    ? base
    : `${base}${fallbackExtension}`;
}

function extensionForMimeType(mimeType: CharacterImageMimeType): string {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  return '.png';
}

function normalizeMimeType(
  name: string,
  mimeType?: string | null,
): CharacterImageMimeType | null {
  const normalized = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
    return 'image/jpeg';
  }
  if (normalized === 'image/png') return 'image/png';
  if (normalized === 'image/webp') return 'image/webp';
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return null;
}

function normalizePath(path: string): string {
  return path.replace(/^file:\/\//i, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isWithinDirectory(path: string, directory: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedDirectory = normalizePath(directory);
  return (
    normalizedPath === normalizedDirectory ||
    normalizedPath.startsWith(`${normalizedDirectory}/`)
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return Boolean(await RNFS.exists(path));
  } catch {
    return false;
  }
}

export async function validateCharacterVisualReference(input: {
  localPath: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
}): Promise<CharacterVisualReference> {
  const mimeType = normalizeMimeType(input.name, input.mimeType);
  if (!mimeType) {
    throw new Error('角色参考图仅支持 JPEG、PNG 或 WebP 格式。');
  }
  if (!(await pathExists(input.localPath))) {
    throw new Error('角色参考图临时文件不存在，请重新选择。');
  }
  const stat = await RNFS.stat(input.localPath);
  const size = Number(input.size ?? stat.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('角色参考图文件为空或无法读取。');
  }
  if (size > CHARACTER_VISUAL_REFERENCE_MAX_BYTES) {
    throw new Error(
      `角色参考图不能超过 ${CHARACTER_VISUAL_REFERENCE_MAX_MB} MB。`,
    );
  }
  return {
    localPath: input.localPath,
    name: input.name || `character${extensionForMimeType(mimeType)}`,
    mimeType,
    size: Math.floor(size),
  };
}

/**
 * Validate a legacy PNG character card image.
 *
 * PNG cards predate the AI visual-reference limit and may legitimately be
 * larger than 5MB because the PNG also carries the embedded card payload.
 * Keep the safety checks (existence, non-empty file, PNG type) without applying
 * the unrelated visual-reference size cap.
 */
export async function validateCharacterCardImportedImage(input: {
  localPath: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
}): Promise<CharacterVisualReference> {
  const mimeType = normalizeMimeType(input.name, input.mimeType);
  if (mimeType !== 'image/png') {
    throw new Error('角色卡图片仅支持 PNG 格式。');
  }
  if (!(await pathExists(input.localPath))) {
    throw new Error('角色卡 PNG 临时文件不存在，请重新选择。');
  }
  const stat = await RNFS.stat(input.localPath);
  const size = Number(input.size ?? stat.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('角色卡 PNG 文件为空或无法读取。');
  }
  return {
    localPath: input.localPath,
    name: input.name || 'character.png',
    mimeType,
    size: Math.floor(size),
  };
}

export async function pickCharacterVisualReference(): Promise<CharacterVisualReference | null> {
  const [selected] = await pick({
    type: [types.images],
    allowMultiSelection: false,
    mode: 'import',
  });
  if (!selected) return null;

  const [copy] = await keepLocalCopy({
    files: [{ uri: selected.uri, fileName: selected.name || 'character-image' }],
    destination: 'cachesDirectory',
  });
  if (!copy || copy.status === 'error') {
    throw new Error(copy?.copyError || '复制角色参考图失败。');
  }
  const localPath = localFileUriToPath(copy.localUri);
  try {
    return await validateCharacterVisualReference({
      localPath,
      name: selected.name || 'character-image',
      mimeType: selected.type,
    });
  } catch (error) {
    await RNFS.unlink(localPath).catch(() => {});
    throw error;
  }
}

export async function persistCharacterImage(
  reference: CharacterVisualReference,
): Promise<string> {
  const validated = await validateCharacterVisualReference(reference);
  return persistValidatedCharacterImage(validated);
}

export async function persistCharacterCardImage(
  reference: CharacterVisualReference,
): Promise<string> {
  const validated = await validateCharacterCardImportedImage(reference);
  return persistValidatedCharacterImage(validated);
}

async function persistValidatedCharacterImage(
  validated: CharacterVisualReference,
): Promise<string> {
  const directory = imageDirectory();
  await RNFS.mkdir(directory);
  const extension = extensionForMimeType(validated.mimeType);
  const fileName = safeFileName(validated.name, extension);
  const destination = `${directory}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}-${fileName}`;
  await RNFS.copyFile(validated.localPath, destination);
  return destination;
}

export async function deleteCharacterImageFile(
  imagePath?: string | null,
): Promise<void> {
  if (!imagePath || !isWithinDirectory(imagePath, imageDirectory())) return;
  if (await pathExists(imagePath)) await RNFS.unlink(imagePath).catch(() => {});
}

export async function cleanupTemporaryCharacterVisualReference(
  reference?: CharacterVisualReference | null,
): Promise<void> {
  if (!reference?.localPath) return;
  if (!isWithinDirectory(reference.localPath, cacheDirectory())) return;
  if (await pathExists(reference.localPath)) {
    await RNFS.unlink(reference.localPath).catch(() => {});
  }
}

export function withCharacterImageAsset<T extends Record<string, any>>(
  data: T,
  imagePath: string,
  sourceName?: string,
  metadata?: Pick<CharacterAssetMetadata, 'imageMimeType' | 'imageSize'>,
): T & { __tavo?: CharacterAssetMetadata } {
  return {
    ...data,
    __tavo: {
      ...(data.__tavo || {}),
      imagePath,
      imageSourceName: sourceName,
      ...(metadata?.imageMimeType
        ? { imageMimeType: metadata.imageMimeType }
        : {}),
      ...(metadata?.imageSize == null ? {} : { imageSize: metadata.imageSize }),
      imageUpdatedAt: new Date().toISOString(),
    },
  };
}

export function getCharacterImagePath(dataJson?: string | null): string | null {
  if (!dataJson) return null;
  try {
    const data = JSON.parse(dataJson);
    return typeof data?.__tavo?.imagePath === 'string'
      ? data.__tavo.imagePath
      : null;
  } catch {
    return null;
  }
}

export function getCharacterImageMetadata(dataJson?: string | null): {
  path: string | null;
  mimeType?: CharacterImageMimeType;
  size?: number;
} {
  if (!dataJson) return { path: null };
  try {
    const asset = JSON.parse(dataJson)?.__tavo;
    return {
      path: typeof asset?.imagePath === 'string' ? asset.imagePath : null,
      ...(normalizeMimeType('', asset?.imageMimeType)
        ? { mimeType: normalizeMimeType('', asset.imageMimeType)! }
        : {}),
      ...(Number.isFinite(Number(asset?.imageSize))
        ? { size: Number(asset.imageSize) }
        : {}),
    };
  } catch {
    return { path: null };
  }
}

export function removeCharacterImageAsset<T extends Record<string, any>>(data: T): T {
  const next = { ...data } as T & { __tavo?: CharacterAssetMetadata };
  if (next.__tavo) {
    const rest = { ...next.__tavo };
    delete rest.imagePath;
    delete rest.imageSourceName;
    delete rest.imageMimeType;
    delete rest.imageSize;
    delete rest.imageUpdatedAt;
    next.__tavo = Object.keys(rest).length > 0 ? rest : undefined;
  }
  return next;
}
