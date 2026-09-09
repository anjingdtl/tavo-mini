import AsyncStorage from '@react-native-async-storage/async-storage';
import RNFS from 'react-native-fs';
import appVersionJson from '../constants/version.json';
import {
  AppUpdate,
  type UpdateDownloadStatus,
  type UpdateDownloadStatusName,
} from '../native/AppUpdateModule';
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
  | 'DOWNLOAD_PAUSED'
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
  status?: UpdateDownloadStatusName;
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
const downloadInFlight = new Map<number, Promise<VerifiedDownloadedUpdate>>();
const DOWNLOAD_STATUS_POLL_MS = 750;

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

function progressFromDownloadStatus(
  task: UpdateDownloadStatus,
): DownloadProgress {
  const bytesWritten = Math.max(0, Number(task.bytesDownloaded) || 0);
  const contentLength = Math.max(0, Number(task.totalBytes) || 0);
  return {
    bytesWritten,
    contentLength,
    percent:
      contentLength > 0
        ? clampPercent((bytesWritten / contentLength) * 100)
        : task.status === 'successful'
          ? 100
          : 0,
    status: task.status,
  };
}

function statusMetadataMatches(
  task: UpdateDownloadStatus,
  update: AvailableUpdate,
): boolean {
  return (
    task.versionCode === update.versionCode &&
    task.apkName === update.apkName &&
    task.sha256.toLowerCase() === update.sha256.toLowerCase()
  );
}

function releaseInfoFor(update: AvailableUpdate): string {
  return JSON.stringify({
    title: update.title,
    notes: update.notes,
    releaseTag: update.releaseTag,
    releaseUrl: update.releaseUrl || '',
  });
}

async function enqueueSystemDownload(
  update: AvailableUpdate,
): Promise<UpdateDownloadStatus> {
  if (!AppUpdate?.enqueueUpdateDownload) {
    throw new UpdateServiceError(
      'DOWNLOAD_FAILED',
      '当前 Android 版本未加载系统更新下载模块。',
    );
  }
  return AppUpdate.enqueueUpdateDownload(
    update.apkUrl,
    update.apkName,
    update.versionCode,
    update.versionName,
    update.sha256,
    releaseInfoFor(update),
  );
}

async function cancelSystemDownload(): Promise<void> {
  const cancel = AppUpdate?.cancelUpdateDownload;
  if (!cancel) return;
  try {
    await cancel();
  } catch {
    // The original validation error is more useful to the caller. Native
    // cleanup is best effort and the next explicit retry can replace the row.
  }
}

async function waitForSystemDownload(
  update: AvailableUpdate,
  initialTask: UpdateDownloadStatus,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<UpdateDownloadStatus> {
  let task = initialTask;
  while (true) {
    if (!statusMetadataMatches(task, update)) {
      throw new UpdateServiceError(
        'DOWNLOAD_FAILED',
        '系统下载任务与当前 Release 不一致，已拒绝继续处理。',
      );
    }
    onProgress?.(progressFromDownloadStatus(task));
    if (task.status === 'successful') return task;
    if (task.status === 'paused') {
      throw new UpdateServiceError(
        'DOWNLOAD_PAUSED',
        task.reasonMessage || '系统下载已暂停，网络可用后会继续。',
      );
    }
    if (task.status === 'failed') {
      throw new UpdateServiceError(
        'DOWNLOAD_FAILED',
        task.reasonMessage || 'Android 系统下载失败，请重试。',
      );
    }

    // This timer only refreshes foreground UI state. DownloadManager owns the
    // actual transfer and continues independently when JS is suspended/killed.
    await new Promise<void>(resolve => setTimeout(resolve, DOWNLOAD_STATUS_POLL_MS));
    const nextTask = await AppUpdate?.getUpdateDownloadStatus();
    if (!nextTask) {
      throw new UpdateServiceError(
        'DOWNLOAD_FAILED',
        'Android 系统下载任务已丢失，请重试。',
      );
    }
    task = nextTask;
  }
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
  let task = await AppUpdate.getUpdateDownloadStatus();
  if (
    !task ||
    task.status === 'failed' ||
    !statusMetadataMatches(task, update)
  ) {
    if (task && !statusMetadataMatches(task, update)) {
      await cancelSystemDownload();
    }
    task = await enqueueSystemDownload(update);
  }
  const completedTask = await waitForSystemDownload(update, task, onProgress);

  let path: string;
  try {
    if (!AppUpdate.materializeDownloadedUpdate) {
      throw new Error('系统下载结果读取模块不可用。');
    }
    path = await AppUpdate.materializeDownloadedUpdate(update.versionCode);
    const stats = await RNFS.stat(path);
    if (!stats || Number(stats.size) <= 0) {
      throw new Error('empty APK');
    }
    const actualHash = (await AppUpdate.sha256File(path)).toLowerCase();
    if (actualHash !== update.sha256.toLowerCase()) {
      throw new UpdateServiceError(
        'HASH_MISMATCH',
        '安装包完整性校验失败，已删除无效文件。',
      );
    }
    const validation = await AppUpdate.validateApk(
      path,
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
    onProgress?.({ ...progressFromDownloadStatus(completedTask), percent: 100 });
    return {
      path,
      sha256: actualHash,
      apk: {
        packageName: validation.packageName || RELEASE_PACKAGE_NAME,
        versionName: validation.versionName || update.displayVersionName,
        versionCode: validation.versionCode || update.versionCode,
        signerSha256: validation.signerSha256 || RELEASE_SIGNER_SHA256,
      },
    };
  } catch (error) {
    // Remove the completed DownloadManager row and the private cache copy on
    // any local validation failure. A retry must create a fresh task and must
    // never reuse bytes that failed SHA/package/version/signer validation.
    await cancelSystemDownload();
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
  const existing = downloadInFlight.get(update.versionCode);
  if (existing) return existing;
  const pending = downloadAndVerifyUpdateOnce(update, onProgress);
  const tracked = pending.finally(() => {
    if (downloadInFlight.get(update.versionCode) === tracked) {
      downloadInFlight.delete(update.versionCode);
    }
  });
  downloadInFlight.set(update.versionCode, tracked);
  return tracked;
}

export async function getUpdateDownloadStatus(): Promise<UpdateDownloadStatus | null> {
  if (!AppUpdate?.getUpdateDownloadStatus) return null;
  return AppUpdate.getUpdateDownloadStatus();
}

/** Resume/verify only an already persisted task; never enqueue on app resume. */
export async function resumeUpdateDownload(
  update: AvailableUpdate,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<VerifiedDownloadedUpdate | null> {
  const task = await getUpdateDownloadStatus();
  if (!task || task.versionCode !== update.versionCode) return null;
  if (task.status === 'failed') {
    throw new UpdateServiceError(
      'DOWNLOAD_FAILED',
      task.reasonMessage || 'Android 系统下载失败，请明确重试。',
    );
  }
  return downloadAndVerifyUpdate(update, onProgress);
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
