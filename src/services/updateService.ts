import AsyncStorage from '@react-native-async-storage/async-storage';
import RNFS from 'react-native-fs';
import appVersionJson from '../constants/version.json';
import { AppUpdate } from '../native/AppUpdateModule';
import {
  buildAvailableUpdate,
  displayVersionName,
  isRecord,
  parseGitHubRelease,
  parseUpdateMetadata,
  RELEASE_PACKAGE_NAME,
  RELEASE_SIGNER_SHA256,
  UPDATE_METADATA_ASSET_NAME,
  UPDATE_RELEASES_LATEST_URL,
  type AvailableUpdate,
  type GitHubReleaseAsset,
  type GitHubReleaseDescriptor,
} from './updateProtocol';

const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const UPDATE_CACHE_KEY = '@shinewriter/update-check/v1';
const UPDATE_CACHE_VERSION = 1;
const UPDATE_DOWNLOAD_DIRECTORY = 'updates';

export type UpdateErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'INVALID_RELEASE'
  | 'INVALID_METADATA'
  | 'MISSING_METADATA_ASSET'
  | 'MISSING_APK_ASSET'
  | 'DOWNLOAD_FAILED'
  | 'HASH_MISMATCH'
  | 'PACKAGE_MISMATCH'
  | 'SIGNER_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'UNKNOWN_SOURCES'
  | 'INSTALL_FAILED';

export class UpdateServiceError extends Error {
  readonly code: UpdateErrorCode;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    code: UpdateErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'UpdateServiceError';
    this.code = code;
    this.status = options.status;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export type UpdateCheckStatus = 'update' | 'latest' | 'skipped';

export interface UpdateCheckResult {
  status: UpdateCheckStatus;
  currentVersionName: string;
  currentVersionCode: number;
  release?: AvailableUpdate;
  fromCache?: boolean;
}

export interface DownloadProgress {
  bytesWritten: number;
  contentLength: number;
  percent: number;
}

export interface VerifiedDownloadedUpdate {
  path: string;
  sha256: string;
  apk: {
    packageName: string;
    versionName: string;
    versionCode: number;
    signerSha256: string;
  };
}

interface UpdateCacheRecord {
  schemaVersion: number;
  checkedAt: number;
  result: 'latest' | 'update';
  release?: AvailableUpdate;
}

let checkInFlight: Promise<UpdateCheckResult> | null = null;
let downloadInFlight: Promise<VerifiedDownloadedUpdate> | null = null;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isHttpSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new UpdateServiceError(
        'TIMEOUT',
        'GitHub 更新检查超时，请稍后重试。',
        { cause: error },
      );
    }
    throw new UpdateServiceError(
      'NETWORK',
      '无法连接 GitHub，请检查网络后重试。',
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (error) {
    throw error;
  }
  if (!isHttpSuccess(response.status)) {
    throw new UpdateServiceError(
      'HTTP_ERROR',
      `GitHub 返回 HTTP ${response.status}。`,
      { status: response.status },
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new UpdateServiceError('INVALID_METADATA', 'GitHub 返回的 JSON 无效。', {
      cause: error,
    });
  }
}

function metadataAsset(
  release: GitHubReleaseDescriptor,
): GitHubReleaseAsset {
  const asset = release.assets.find(
    candidate => candidate.name === UPDATE_METADATA_ASSET_NAME,
  );
  if (!asset) {
    throw new UpdateServiceError(
      'MISSING_METADATA_ASSET',
      '该 Release 缺少 update.json，暂不能安全更新。',
    );
  }
  return asset;
}

function apkAssetForMetadata(
  release: GitHubReleaseDescriptor,
  rawMetadata: unknown,
): GitHubReleaseAsset {
  if (!isRecord(rawMetadata) || typeof rawMetadata.apkName !== 'string') {
    throw new UpdateServiceError(
      'INVALID_METADATA',
      'update.json 缺少有效的 apkName。',
    );
  }
  const asset = release.assets.find(
    candidate => candidate.name === rawMetadata.apkName,
  );
  if (!asset) {
    throw new UpdateServiceError(
      'MISSING_APK_ASSET',
      `该 Release 缺少 ${rawMetadata.apkName}，暂不能安全更新。`,
    );
  }
  return asset;
}

function mapProtocolError(error: unknown): UpdateServiceError {
  if (error instanceof UpdateServiceError) return error;
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  if (
    code === 'MISSING_METADATA_ASSET' ||
    code === 'MISSING_APK_ASSET' ||
    code === 'INVALID_RELEASE' ||
    code === 'INVALID_METADATA'
  ) {
    const message =
      isRecord(error) && typeof error.message === 'string'
        ? error.message
        : 'Release 元数据无效。';
    return new UpdateServiceError(code as UpdateErrorCode, message);
  }
  return new UpdateServiceError('INVALID_RELEASE', 'Release 元数据无效。', {
    cause: error,
  });
}

async function readCache(): Promise<UpdateCacheRecord | null> {
  try {
    const raw = await AsyncStorage.getItem(UPDATE_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (
      parsed.schemaVersion !== UPDATE_CACHE_VERSION ||
      typeof parsed.checkedAt !== 'number' ||
      !Number.isFinite(parsed.checkedAt) ||
      (parsed.result !== 'latest' && parsed.result !== 'update')
    ) {
      return null;
    }
    if (parsed.result === 'update' && !isRecord(parsed.release)) return null;
    return parsed as unknown as UpdateCacheRecord;
  } catch {
    return null;
  }
}

async function writeCache(result: UpdateCheckResult): Promise<void> {
  const cache: UpdateCacheRecord = {
    schemaVersion: UPDATE_CACHE_VERSION,
    checkedAt: Date.now(),
    result: result.status === 'update' ? 'update' : 'latest',
    ...(result.release ? { release: result.release } : {}),
  };
  try {
    await AsyncStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // A cache write must never turn a successful network check into a UI error.
  }
}

async function currentAppInfo(): Promise<{
  versionName: string;
  versionCode: number;
}> {
  if (AppUpdate) {
    try {
      const info = await AppUpdate.getInstalledAppInfo();
      if (
        info &&
        typeof info.versionName === 'string' &&
        Number.isSafeInteger(info.versionCode)
      ) {
        return {
          versionName: displayVersionName(info.versionName),
          versionCode: info.versionCode,
        };
      }
    } catch {
      // The generated JS metadata remains a safe fallback for the check UI.
    }
  }
  return {
    versionName: appVersionJson.versionName,
    versionCode: appVersionJson.versionCode,
  };
}

async function checkForUpdateOnce(): Promise<UpdateCheckResult> {
  const current = await currentAppInfo();
  let release: GitHubReleaseDescriptor;
  try {
    release = parseGitHubRelease(await fetchJson(UPDATE_RELEASES_LATEST_URL));
  } catch (error) {
    throw mapProtocolError(error);
  }

  const metadataFileAsset = metadataAsset(release);
  let rawMetadata: unknown;
  try {
    rawMetadata = await fetchJson(metadataFileAsset.browser_download_url);
  } catch (error) {
    if (error instanceof UpdateServiceError && error.code === 'HTTP_ERROR') {
      throw error;
    }
    throw new UpdateServiceError(
      'INVALID_METADATA',
      '无法读取 Release 的 update.json。',
      { cause: error },
    );
  }
  const apkAsset = apkAssetForMetadata(release, rawMetadata);
  let parsedMetadata;
  try {
    parsedMetadata = parseUpdateMetadata(rawMetadata, release, apkAsset);
  } catch (error) {
    throw mapProtocolError(error);
  }
  const available = {
    ...buildAvailableUpdate(parsedMetadata, release, apkAsset),
    forceUpdate:
      parsedMetadata.forceUpdate ||
      current.versionCode < parsedMetadata.minimumVersionCode,
  };
  if (!shouldOfferUpdate(available.versionCode, current.versionCode)) {
    const result: UpdateCheckResult = {
      status: 'latest',
      currentVersionName: current.versionName,
      currentVersionCode: current.versionCode,
    };
    await writeCache(result);
    return result;
  }
  const result: UpdateCheckResult = {
    status: 'update',
    currentVersionName: current.versionName,
    currentVersionCode: current.versionCode,
    release: available,
  };
  await writeCache(result);
  return result;
}

export function shouldOfferUpdate(
  remoteVersionCode: number,
  localVersionCode: number,
): boolean {
  return (
    Number.isSafeInteger(remoteVersionCode) &&
    Number.isSafeInteger(localVersionCode) &&
    remoteVersionCode > localVersionCode
  );
}

export async function checkForUpdate(options: {
  force?: boolean;
} = {}): Promise<UpdateCheckResult> {
  if (checkInFlight) return checkInFlight;
  const force = options.force === true;
  checkInFlight = (async () => {
    const current = await currentAppInfo();
    if (!force) {
      const cache = await readCache();
      const cacheIsFresh =
        cache && Date.now() - cache.checkedAt < AUTO_CHECK_INTERVAL_MS;
      const cachedRelease =
        cache?.result === 'update' &&
        cache.release &&
        shouldOfferUpdate(cache.release.versionCode, current.versionCode)
          ? cache.release
          : undefined;
      if (
        cacheIsFresh &&
        (cache?.result === 'latest' ||
          (cache?.result === 'update' && cachedRelease))
      ) {
        return {
          status: 'skipped',
          currentVersionName: current.versionName,
          currentVersionCode: current.versionCode,
          ...(cachedRelease ? { release: cachedRelease } : {}),
          fromCache: true,
        } satisfies UpdateCheckResult;
      }
    }
    return checkForUpdateOnce();
  })();
  try {
    return await checkInFlight;
  } finally {
    checkInFlight = null;
  }
}

function updateErrorForValidation(
  result: {
    packageMatches: boolean;
    versionMatches: boolean;
    signerMatches: boolean;
  },
): UpdateServiceError {
  if (!result.packageMatches) {
    return new UpdateServiceError(
      'PACKAGE_MISMATCH',
      '安装包包名验证失败，已拒绝安装。',
    );
  }
  if (!result.signerMatches) {
    return new UpdateServiceError(
      'SIGNER_MISMATCH',
      '安装包签名验证失败，已拒绝安装。',
    );
  }
  if (!result.versionMatches) {
    return new UpdateServiceError(
      'VERSION_MISMATCH',
      '安装包版本验证失败，已拒绝安装。',
    );
  }
  return new UpdateServiceError('VERSION_MISMATCH', '安装包验证失败，已拒绝安装。');
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    if (await RNFS.exists(path)) await RNFS.unlink(path);
  } catch {
    // Cleanup is best effort; the next attempt will use a new temp path.
  }
}

function updateDownloadPath(apkName: string): {
  directory: string;
  finalPath: string;
  tempPath: string;
} {
  const directory = `${RNFS.CachesDirectoryPath}/${UPDATE_DOWNLOAD_DIRECTORY}`;
  const finalPath = `${directory}/${apkName}`;
  return {
    directory,
    finalPath,
    tempPath: `${finalPath}.part`,
  };
}

async function downloadAndVerifyUpdateOnce(
  update: AvailableUpdate,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<VerifiedDownloadedUpdate> {
  if (!AppUpdate) {
    throw new UpdateServiceError(
      'DOWNLOAD_FAILED',
      '当前 Android 版本未加载更新原生模块。',
    );
  }
  const paths = updateDownloadPath(update.apkName);
  if (!(await RNFS.exists(paths.directory))) await RNFS.mkdir(paths.directory);
  // A .part file is never considered installable. Remove any old interrupted
  // download before starting a fresh, deterministic retry.
  await unlinkIfExists(paths.tempPath);

  let downloadResult: { statusCode?: number; bytesWritten?: number };
  try {
    const task = RNFS.downloadFile({
      fromUrl: update.apkUrl,
      toFile: paths.tempPath,
      progressDivider: 1,
      begin: response => {
        onProgress?.({
          bytesWritten: 0,
          contentLength: response.contentLength,
          percent: 0,
        });
      },
      progress: response => {
        const contentLength = response.contentLength;
        const bytesWritten = response.bytesWritten;
        onProgress?.({
          bytesWritten,
          contentLength,
          percent:
            contentLength > 0
              ? clampPercent((bytesWritten / contentLength) * 100)
              : 0,
        });
      },
    });
    downloadResult = await task.promise;
  } catch (error) {
    await unlinkIfExists(paths.tempPath);
    throw new UpdateServiceError('DOWNLOAD_FAILED', '更新包下载失败，请重试。', {
      cause: error,
    });
  }
  if (!downloadResult || !isHttpSuccess(downloadResult.statusCode || 0)) {
    await unlinkIfExists(paths.tempPath);
    throw new UpdateServiceError(
      'DOWNLOAD_FAILED',
      `更新包下载失败（HTTP ${downloadResult?.statusCode || 0}）。`,
    );
  }

  try {
    const stats = await RNFS.stat(paths.tempPath);
    if (!stats || Number(stats.size) <= 0) {
      throw new Error('empty APK');
    }
    const actualHash = (await AppUpdate.sha256File(paths.tempPath)).toLowerCase();
    if (actualHash !== update.sha256.toLowerCase()) {
      throw new UpdateServiceError(
        'HASH_MISMATCH',
        '安装包完整性校验失败，已删除无效文件。',
      );
    }
    const validation = await AppUpdate.validateApk(
      paths.tempPath,
      RELEASE_PACKAGE_NAME,
      update.versionCode,
      RELEASE_SIGNER_SHA256,
    );
    if (
      !validation.valid ||
      !validation.packageMatches ||
      !validation.versionMatches ||
      !validation.signerMatches
    ) {
      throw updateErrorForValidation(validation);
    }
    await unlinkIfExists(paths.finalPath);
    await RNFS.moveFile(paths.tempPath, paths.finalPath);
    onProgress?.({
      bytesWritten: Number(stats.size),
      contentLength: Number(stats.size),
      percent: 100,
    });
    return {
      path: paths.finalPath,
      sha256: actualHash,
      apk: {
        packageName: validation.packageName || RELEASE_PACKAGE_NAME,
        versionName: validation.versionName || update.displayVersionName,
        versionCode: validation.versionCode || update.versionCode,
        signerSha256: validation.signerSha256 || RELEASE_SIGNER_SHA256,
      },
    };
  } catch (error) {
    await unlinkIfExists(paths.tempPath);
    await unlinkIfExists(paths.finalPath);
    if (error instanceof UpdateServiceError) throw error;
    throw new UpdateServiceError('DOWNLOAD_FAILED', '安装包校验失败，已删除无效文件。', {
      cause: error,
    });
  }
}

export function downloadAndVerifyUpdate(
  update: AvailableUpdate,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<VerifiedDownloadedUpdate> {
  if (downloadInFlight) return downloadInFlight;
  downloadInFlight = downloadAndVerifyUpdateOnce(update, onProgress);
  return downloadInFlight.finally(() => {
    downloadInFlight = null;
  });
}

export function formatUpdateError(error: unknown): string {
  if (error instanceof UpdateServiceError) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return '更新失败，请稍后重试。';
}

export function isUpdateServiceError(
  error: unknown,
): error is UpdateServiceError {
  return error instanceof UpdateServiceError;
}

export const updateServiceConstants = {
  autoCheckIntervalMs: AUTO_CHECK_INTERVAL_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  cacheKey: UPDATE_CACHE_KEY,
  downloadDirectory: UPDATE_DOWNLOAD_DIRECTORY,
};
