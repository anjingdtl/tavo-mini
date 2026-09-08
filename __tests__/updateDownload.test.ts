import RNFS from 'react-native-fs';
import { AppUpdate } from '../src/native/AppUpdateModule';
import {
  downloadAndVerifyUpdate,
  type DownloadProgress,
} from '../src/services/updateService';
import type { AvailableUpdate } from '../src/services/updateProtocol';

const SHA = 'a'.repeat(64);

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

describe('downloadAndVerifyUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (RNFS.exists as jest.Mock).mockResolvedValue(false);
    (RNFS.mkdir as jest.Mock).mockResolvedValue(undefined);
    (RNFS.stat as jest.Mock).mockResolvedValue({ size: 100, mtime: Date.now() });
    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      promise: Promise.resolve({ statusCode: 200, bytesWritten: 100 }),
    });
    (AppUpdate?.sha256File as jest.Mock).mockResolvedValue(SHA);
    (AppUpdate?.validateApk as jest.Mock).mockResolvedValue({
      valid: true,
      packageName: 'com.shinewriter',
      versionName: 'V3.0.1',
      versionCode: 3000100,
      signerSha256: '017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a',
      packageMatches: true,
      versionMatches: true,
      signerMatches: true,
    });
  });

  it('downloads to a .part file, verifies the hash/signature, then atomically moves the APK', async () => {
    const progress: DownloadProgress[] = [];
    const result = await downloadAndVerifyUpdate(update, value => progress.push(value));

    expect(RNFS.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fromUrl: update.apkUrl,
        toFile: expect.stringMatching(/ShineWriter-V3\.0\.1-release\.apk\.part$/),
      }),
    );
    expect(RNFS.moveFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.apk\.part$/),
      expect.stringMatching(/ShineWriter-V3\.0\.1-release\.apk$/),
    );
    expect(result.path).toMatch(/ShineWriter-V3\.0\.1-release\.apk$/);
    expect(progress[progress.length - 1]?.percent).toBe(100);
  });

  it('rejects a hash mismatch and removes the invalid temporary file', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (AppUpdate?.sha256File as jest.Mock).mockResolvedValue('b'.repeat(64));
    await expect(downloadAndVerifyUpdate(update)).rejects.toMatchObject({
      code: 'HASH_MISMATCH',
    });
    expect(RNFS.moveFile).not.toHaveBeenCalled();
    expect(RNFS.unlink).toHaveBeenCalled();
  });

  it('coalesces repeated download taps into one native download', async () => {
    const first = downloadAndVerifyUpdate(update);
    const second = downloadAndVerifyUpdate(update);
    await Promise.all([first, second]);
    expect(RNFS.downloadFile).toHaveBeenCalledTimes(1);
  });
});
