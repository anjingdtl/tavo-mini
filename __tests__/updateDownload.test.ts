import RNFS from 'react-native-fs';
import { AppUpdate } from '../src/native/AppUpdateModule';
import {
  downloadAndVerifyUpdate,
  resumeUpdateDownload,
  type DownloadProgress,
} from '../src/services/updateService';
import type { AvailableUpdate } from '../src/services/updateProtocol';

const SHA = 'a'.repeat(64);
const SIGNER = '017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a';

const update: AvailableUpdate = {
  versionName: '3.0.1',
  versionCode: 3000100,
  apkName: 'ShineWriter-V3.0.1-release.apk',
  apkUrl: 'https://github.com/anjingdtl/tavo-mini/releases/download/V3.0.1/ShineWriter-V3.0.1-release.apk',
  sha256: SHA,
  forceUpdate: false,
  minimumVersionCode: 0,
  title: 'ShineWriter V3.0.1',
  notes: [],
  apkSizeBytes: 100,
  displayVersionName: 'V3.0.1',
  assetSizeBytes: 100,
  releaseTag: 'V3.0.1',
};

interface DownloadTaskFixture {
  downloadId: number;
  status: 'pending' | 'running' | 'paused' | 'successful' | 'failed';
  bytesDownloaded: number;
  totalBytes: number;
  reason: number;
  reasonMessage: string;
  versionCode: number;
  versionName: string;
  apkName: string;
  apkUrl: string;
  sha256: string;
  releaseInfo: string;
  createdAt: number;
  localUri: string;
}

function task(
  status: DownloadTaskFixture['status'],
  overrides: Partial<DownloadTaskFixture> = {},
): DownloadTaskFixture {
  return {
    downloadId: 1,
    status,
    bytesDownloaded: status === 'successful' ? 100 : 25,
    totalBytes: 100,
    reason: 0,
    reasonMessage: status === 'paused' ? '等待网络连接。' : '',
    versionCode: update.versionCode,
    versionName: update.versionName,
    apkName: update.apkName,
    apkUrl: update.apkUrl,
    sha256: update.sha256,
    releaseInfo: '',
    createdAt: Date.now(),
    localUri: 'content://downloads/test.apk',
    ...overrides,
  };
}

function validApkValidation() {
  return {
    valid: true,
    packageName: 'com.shinewriter',
    versionName: 'V3.0.1',
    versionCode: update.versionCode,
    signerSha256: SIGNER,
    packageMatches: true,
    versionMatches: true,
    signerMatches: true,
  };
}

describe('downloadAndVerifyUpdate', () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    (RNFS.stat as jest.Mock).mockResolvedValue({ size: 100, mtime: Date.now() });
    (AppUpdate?.getUpdateDownloadStatus as jest.Mock).mockResolvedValue(null);
    (AppUpdate?.enqueueUpdateDownload as jest.Mock).mockResolvedValue(task('successful'));
    (AppUpdate?.materializeDownloadedUpdate as jest.Mock).mockResolvedValue(
      '/tmp/cache/updates/ShineWriter-V3.0.1-release.apk',
    );
    (AppUpdate?.sha256File as jest.Mock).mockResolvedValue(SHA);
    (AppUpdate?.validateApk as jest.Mock).mockResolvedValue(validApkValidation());
  });

  it('delegates the transfer to Android DownloadManager, then materializes and verifies the APK', async () => {
    const progress: DownloadProgress[] = [];
    const result = await downloadAndVerifyUpdate(update, value => progress.push(value));

    expect(AppUpdate?.enqueueUpdateDownload).toHaveBeenCalledWith(
      update.apkUrl,
      update.apkName,
      update.versionCode,
      update.versionName,
      update.sha256,
      expect.stringContaining('releaseTag'),
    );
    expect(AppUpdate?.materializeDownloadedUpdate).toHaveBeenCalledWith(update.versionCode);
    expect(RNFS.downloadFile).not.toHaveBeenCalled();
    expect(RNFS.moveFile).not.toHaveBeenCalled();
    expect(result.path).toMatch(/ShineWriter-V3\.0\.1-release\.apk$/);
    expect(progress[progress.length - 1]?.percent).toBe(100);
    expect(progress[0]?.status).toBe('successful');
  });

  it('restores a successful persisted task after a simulated app restart without enqueueing again', async () => {
    (AppUpdate?.getUpdateDownloadStatus as jest.Mock).mockResolvedValue(task('successful'));

    await downloadAndVerifyUpdate(update);

    expect(AppUpdate?.enqueueUpdateDownload).not.toHaveBeenCalled();
    expect(AppUpdate?.materializeDownloadedUpdate).toHaveBeenCalledWith(update.versionCode);
  });

  it('resumeUpdateDownload never creates a task when no persisted task exists', async () => {
    await expect(resumeUpdateDownload(update)).resolves.toBeNull();
    expect(AppUpdate?.enqueueUpdateDownload).not.toHaveBeenCalled();
  });

  it('resumeUpdateDownload verifies an existing task after returning to the foreground', async () => {
    (AppUpdate?.getUpdateDownloadStatus as jest.Mock).mockResolvedValue(task('successful'));

    await expect(resumeUpdateDownload(update)).resolves.toBeTruthy();
    expect(AppUpdate?.enqueueUpdateDownload).not.toHaveBeenCalled();
    expect(AppUpdate?.materializeDownloadedUpdate).toHaveBeenCalledWith(update.versionCode);
  });

  it('polls a running system task until DownloadManager reports completion', async () => {
    jest.useFakeTimers();
    (AppUpdate?.enqueueUpdateDownload as jest.Mock).mockResolvedValue(task('running'));
    (AppUpdate?.getUpdateDownloadStatus as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(task('successful'));

    const pending = downloadAndVerifyUpdate(update);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(750);
    await expect(pending).resolves.toMatchObject({
      path: expect.stringContaining('ShineWriter-V3.0.1-release.apk'),
    });
  });

  it('preserves a paused system task and reports a recoverable pause', async () => {
    (AppUpdate?.enqueueUpdateDownload as jest.Mock).mockResolvedValue(
      task('paused', { reasonMessage: '等待网络连接。' }),
    );

    await expect(downloadAndVerifyUpdate(update)).rejects.toMatchObject({
      code: 'DOWNLOAD_PAUSED',
    });
    expect(AppUpdate?.cancelUpdateDownload).not.toHaveBeenCalled();
    expect(AppUpdate?.materializeDownloadedUpdate).not.toHaveBeenCalled();
  });

  it('replaces a failed persisted task with a fresh system task', async () => {
    (AppUpdate?.getUpdateDownloadStatus as jest.Mock).mockResolvedValue(
      task('failed', { reason: 1001, reasonMessage: '网络数据错误。' }),
    );

    await expect(downloadAndVerifyUpdate(update)).resolves.toBeTruthy();
    expect(AppUpdate?.enqueueUpdateDownload).toHaveBeenCalledTimes(1);
  });

  it('does not reuse an old version task', async () => {
    (AppUpdate?.getUpdateDownloadStatus as jest.Mock).mockResolvedValue(
      task('running', {
        versionCode: 3000000,
        versionName: 'V3.0.0',
        apkName: 'ShineWriter-V3.0.0-release.apk',
        sha256: 'b'.repeat(64),
      }),
    );

    await expect(downloadAndVerifyUpdate(update)).resolves.toBeTruthy();
    expect(AppUpdate?.cancelUpdateDownload).toHaveBeenCalledTimes(1);
    expect(AppUpdate?.enqueueUpdateDownload).toHaveBeenCalledTimes(1);
  });

  it('rejects hash, package, version, and signer mismatches before install', async () => {
    const cases = [
      {
        configure: () => (AppUpdate?.sha256File as jest.Mock).mockResolvedValue('b'.repeat(64)),
        code: 'HASH_MISMATCH',
      },
      {
        configure: () =>
          (AppUpdate?.validateApk as jest.Mock).mockResolvedValue({
            ...validApkValidation(),
            valid: false,
            packageMatches: false,
          }),
        code: 'PACKAGE_MISMATCH',
      },
      {
        configure: () =>
          (AppUpdate?.validateApk as jest.Mock).mockResolvedValue({
            ...validApkValidation(),
            valid: false,
            versionMatches: false,
            versionCode: 3000000,
          }),
        code: 'VERSION_MISMATCH',
      },
      {
        configure: () =>
          (AppUpdate?.validateApk as jest.Mock).mockResolvedValue({
            ...validApkValidation(),
            valid: false,
            signerMatches: false,
            signerSha256: 'b'.repeat(64),
          }),
        code: 'SIGNER_MISMATCH',
      },
    ] as const;

    for (const candidate of cases) {
      jest.clearAllMocks();
      (RNFS.stat as jest.Mock).mockResolvedValue({ size: 100, mtime: Date.now() });
      (AppUpdate?.getUpdateDownloadStatus as jest.Mock).mockResolvedValue(null);
      (AppUpdate?.enqueueUpdateDownload as jest.Mock).mockResolvedValue(task('successful'));
      (AppUpdate?.materializeDownloadedUpdate as jest.Mock).mockResolvedValue(
        '/tmp/cache/updates/ShineWriter-V3.0.1-release.apk',
      );
      (AppUpdate?.sha256File as jest.Mock).mockResolvedValue(SHA);
      (AppUpdate?.validateApk as jest.Mock).mockResolvedValue(validApkValidation());
      candidate.configure();

      await expect(downloadAndVerifyUpdate(update)).rejects.toMatchObject({
        code: candidate.code,
      });
      expect(AppUpdate?.cancelUpdateDownload).toHaveBeenCalled();
    }
  });

  it('coalesces repeated taps into one native task', async () => {
    const first = downloadAndVerifyUpdate(update);
    const second = downloadAndVerifyUpdate(update);
    await Promise.all([first, second]);
    expect(AppUpdate?.enqueueUpdateDownload).toHaveBeenCalledTimes(1);
  });
});
