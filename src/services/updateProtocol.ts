/**
 * The public GitHub Release contract consumed by the in-app updater.
 *
 * The release API is untrusted input. Keep all shape, version, URL and asset
 * checks in this module so the UI and the download path never receive a
 * partially validated object.
 */

export const UPDATE_REPOSITORY = 'anjingdtl/tavo-mini';
export const UPDATE_RELEASES_LATEST_URL =
  `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
export const UPDATE_METADATA_ASSET_NAME = 'update.json';
export const RELEASE_PACKAGE_NAME = 'com.shinewriter';
export const RELEASE_SIGNER_SHA256 =
  '017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const APK_NAME_PATTERN = /^ShineWriter-V(\d+\.\d+\.\d+)-release\.apk$/;
const MAX_NOTES = 100;
const MAX_NOTE_LENGTH = 4000;

export type UpdateMetadataErrorCode =
  | 'INVALID_METADATA'
  | 'INVALID_RELEASE'
  | 'INVALID_ASSET'
  | 'RELEASE_NOT_STABLE'
  | 'MISSING_METADATA_ASSET'
  | 'MISSING_APK_ASSET';

export class UpdateMetadataError extends Error {
  readonly code: UpdateMetadataErrorCode;

  constructor(code: UpdateMetadataErrorCode, message: string) {
    super(message);
    this.name = 'UpdateMetadataError';
    this.code = code;
  }
}

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface GitHubReleaseDescriptor {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
  html_url?: string;
  published_at?: string | null;
}

export interface UpdateMetadata {
  versionName: string;
  versionCode: number;
  apkName: string;
  apkUrl: string;
  sha256: string;
  forceUpdate: boolean;
  minimumVersionCode: number;
  title: string;
  notes: string[];
  apkSizeBytes?: number;
}

export interface AvailableUpdate extends UpdateMetadata {
  displayVersionName: string;
  assetSizeBytes?: number;
  releaseTag: string;
  releaseUrl?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeVersionName(value: string): string {
  const normalized = value.trim().replace(/^V/i, '');
  if (!SEMVER_PATTERN.test(normalized)) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      `版本号格式无效：${value}`,
    );
  }
  return normalized;
}

export function displayVersionName(versionName: string): string {
  return `V${normalizeVersionName(versionName)}`;
}

export function expectedApkName(versionName: string): string {
  return `ShineWriter-${displayVersionName(versionName)}-release.apk`;
}

function isHttpsGitHubAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'github.com' ||
        url.hostname === 'objects.githubusercontent.com')
    );
  } catch {
    return false;
  }
}

function readString(
  record: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      `update.json 字段 ${key} 必须是字符串。`,
    );
  }
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed.length === 0) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      `update.json 字段 ${key} 不能为空。`,
    );
  }
  return trimmed;
}

function readInteger(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
): number {
  const value = record[key];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      `update.json 字段 ${key} 必须是大于等于 ${minimum} 的整数。`,
    );
  }
  return value;
}

function parseAsset(value: unknown): GitHubReleaseAsset {
  if (!isRecord(value)) {
    throw new UpdateMetadataError('INVALID_ASSET', 'GitHub asset 结构无效。');
  }
  const name = readString(value, 'name');
  const browserDownloadUrl = readString(value, 'browser_download_url');
  if (!isHttpsGitHubAssetUrl(browserDownloadUrl)) {
    throw new UpdateMetadataError(
      'INVALID_ASSET',
      `GitHub asset ${name} 不是受信任的 HTTPS 下载地址。`,
    );
  }
  const size = value.size;
  if (
    size !== undefined &&
    (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0)
  ) {
    throw new UpdateMetadataError(
      'INVALID_ASSET',
      `GitHub asset ${name} 的 size 无效。`,
    );
  }
  return {
    name,
    browser_download_url: browserDownloadUrl,
    ...(size === undefined ? {} : { size }),
  };
}
export function parseGitHubRelease(value: unknown): GitHubReleaseDescriptor {
  if (!isRecord(value)) {
    throw new UpdateMetadataError('INVALID_RELEASE', 'GitHub Release 结构无效。');
  }
  const tagName = readString(value, 'tag_name');
  if (typeof value.draft !== 'boolean' || typeof value.prerelease !== 'boolean') {
    throw new UpdateMetadataError(
      'INVALID_RELEASE',
      'GitHub Release 缺少 draft/prerelease 布尔字段。',
    );
  }
  if (value.draft || value.prerelease) {
    throw new UpdateMetadataError(
      'RELEASE_NOT_STABLE',
      'Draft 或 prerelease 不参与正式更新。',
    );
  }
  if (!Array.isArray(value.assets)) {
    throw new UpdateMetadataError(
      'INVALID_RELEASE',
      'GitHub Release assets 必须是数组。',
    );
  }
  const assets = value.assets.map(parseAsset);
  const htmlUrl = value.html_url;
  if (htmlUrl !== undefined && typeof htmlUrl !== 'string') {
    throw new UpdateMetadataError('INVALID_RELEASE', 'GitHub Release html_url 无效。');
  }
  const publishedAt = value.published_at;
  if (
    publishedAt !== undefined &&
    publishedAt !== null &&
    typeof publishedAt !== 'string'
  ) {
    throw new UpdateMetadataError(
      'INVALID_RELEASE',
      'GitHub Release published_at 无效。',
    );
  }
  return {
    tag_name: tagName,
    draft: value.draft,
    prerelease: value.prerelease,
    assets,
    ...(htmlUrl === undefined ? {} : { html_url: htmlUrl }),
    ...(publishedAt === undefined ? {} : { published_at: publishedAt }),
  };
}

/**
 * Useful for callers that query the paginated releases endpoint in tooling.
 * Stable releases are selected without comparing tag strings.
 */
export function selectStableRelease(values: unknown[]): GitHubReleaseDescriptor | null {
  const releases: GitHubReleaseDescriptor[] = [];
  for (const value of values) {
    try {
      releases.push(parseGitHubRelease(value));
    } catch (error) {
      if (
        error instanceof UpdateMetadataError &&
        error.code === 'RELEASE_NOT_STABLE'
      ) {
        continue;
      }
      throw error;
    }
  }
  return releases[0] || null;
}

export function parseUpdateMetadata(
  value: unknown,
  release: GitHubReleaseDescriptor,
  apkAsset: GitHubReleaseAsset,
): UpdateMetadata {
  if (!isRecord(value)) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      'update.json 必须是 JSON 对象。',
    );
  }

  const versionName = normalizeVersionName(readString(value, 'versionName'));
  const versionCode = readInteger(value, 'versionCode', 1);
  const apkName = readString(value, 'apkName');
  if (apkName !== expectedApkName(versionName)) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      `APK 文件名必须为 ${expectedApkName(versionName)}。`,
    );
  }
  const matchedVersion = apkName.match(APK_NAME_PATTERN)?.[1];
  if (matchedVersion !== versionName) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      'APK 文件名与 versionName 不一致。',
    );
  }
  if (apkAsset.name !== apkName) {
    throw new UpdateMetadataError(
      'MISSING_APK_ASSET',
      `Release 缺少 ${apkName} 对应的正式 APK asset。`,
    );
  }

  const declaredApkUrl = readString(value, 'apkUrl', { allowEmpty: true });
  if (declaredApkUrl && !isHttpsGitHubAssetUrl(declaredApkUrl)) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      'apkUrl 必须是 GitHub asset 的 HTTPS 地址。',
    );
  }
  if (declaredApkUrl && declaredApkUrl !== apkAsset.browser_download_url) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      'apkUrl 与 Release APK asset 下载地址不一致。',
    );
  }

  const sha256 = readString(value, 'sha256').toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      'sha256 必须是 64 位十六进制字符串。',
    );
  }
  if (typeof value.forceUpdate !== 'boolean') {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      'forceUpdate 必须是布尔值。',
    );
  }
  const minimumVersionCode = readInteger(value, 'minimumVersionCode', 0);
  if (minimumVersionCode > versionCode) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      'minimumVersionCode 不能高于 versionCode。',
    );
  }
  const title = readString(value, 'title');
  if (title.length > 200) {
    throw new UpdateMetadataError('INVALID_METADATA', 'title 过长。');
  }
  if (!Array.isArray(value.notes) || value.notes.length > MAX_NOTES) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      `notes 必须是长度不超过 ${MAX_NOTES} 的字符串数组。`,
    );
  }
  const notes = value.notes.map((note, index) => {
    if (typeof note !== 'string' || note.trim().length === 0) {
      throw new UpdateMetadataError(
        'INVALID_METADATA',
        `notes[${index}] 必须是非空字符串。`,
      );
    }
    const normalized = note.trim();
    if (normalized.length > MAX_NOTE_LENGTH) {
      throw new UpdateMetadataError(
        'INVALID_METADATA',
        `notes[${index}] 过长。`,
      );
    }
    return normalized;
  });

  const declaredSize = value.apkSizeBytes;
  if (
    declaredSize !== undefined &&
    (typeof declaredSize !== 'number' ||
      !Number.isSafeInteger(declaredSize) ||
      declaredSize <= 0)
  ) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      'apkSizeBytes 必须是正整数。',
    );
  }
  if (
    declaredSize !== undefined &&
    apkAsset.size !== undefined &&
    declaredSize !== apkAsset.size
  ) {
    throw new UpdateMetadataError(
      'INVALID_METADATA',
      'apkSizeBytes 与 GitHub APK asset size 不一致。',
    );
  }

  const expectedTag = displayVersionName(versionName);
  if (release.tag_name.toLowerCase() !== expectedTag.toLowerCase()) {
    throw new UpdateMetadataError(
      'INVALID_RELEASE',
      `Release tag ${release.tag_name} 与 update.json 版本不一致。`,
    );
  }

  return {
    versionName,
    versionCode,
    apkName,
    apkUrl: declaredApkUrl || apkAsset.browser_download_url,
    sha256,
    forceUpdate: value.forceUpdate,
    minimumVersionCode,
    title,
    notes,
    ...(declaredSize === undefined ? {} : { apkSizeBytes: declaredSize }),
  };
}

export function buildAvailableUpdate(
  metadata: UpdateMetadata,
  release: GitHubReleaseDescriptor,
  apkAsset: GitHubReleaseAsset,
): AvailableUpdate {
  return {
    ...metadata,
    displayVersionName: displayVersionName(metadata.versionName),
    ...(apkAsset.size === undefined ? {} : { assetSizeBytes: apkAsset.size }),
    releaseTag: release.tag_name,
    ...(release.html_url === undefined ? {} : { releaseUrl: release.html_url }),
  };
}
