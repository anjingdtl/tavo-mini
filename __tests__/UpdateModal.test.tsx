import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppUpdate } from '../src/native/AppUpdateModule';
import { UpdateModal } from '../src/components/UpdateModal';
import {
  downloadAndVerifyUpdate,
  formatUpdateError,
  getUpdateDownloadStatus,
  resumeUpdateDownload,
} from '../src/services/updateService';
import type { AvailableUpdate } from '../src/services/updateProtocol';

jest.mock('../src/services/updateService', () => ({
  downloadAndVerifyUpdate: jest.fn(),
  getUpdateDownloadStatus: jest.fn(async () => null),
  resumeUpdateDownload: jest.fn(),
  formatUpdateError: jest.fn(error => error?.message || '更新失败'),
  isUpdateServiceError: jest.fn(error => error?.name === 'UpdateServiceError'),
  UpdateServiceError: class UpdateServiceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'UpdateServiceError';
      this.code = code;
    }
  },
}));

const release: AvailableUpdate = {
  versionName: '3.0.1',
  versionCode: 3000100,
  apkName: 'ShineWriter-V3.0.1-release.apk',
  apkUrl: 'https://github.com/anjingdtl/tavo-mini/releases/download/V3.0.1/ShineWriter-V3.0.1-release.apk',
  sha256: 'a'.repeat(64),
  forceUpdate: false,
  minimumVersionCode: 0,
  title: 'ShineWriter V3.0.1',
  notes: ['修复更新流程'],
  displayVersionName: 'V3.0.1',
  releaseTag: 'V3.0.1',
};

describe('UpdateModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getUpdateDownloadStatus as jest.Mock).mockResolvedValue(null);
    (downloadAndVerifyUpdate as jest.Mock).mockResolvedValue({
      path: '/tmp/cache/updates/ShineWriter-V3.0.1-release.apk',
      sha256: release.sha256,
      apk: {
        packageName: 'com.shinewriter',
        versionName: 'V3.0.1',
        versionCode: release.versionCode,
        signerSha256: '017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a',
      },
    });
    (resumeUpdateDownload as jest.Mock).mockResolvedValue(null);
  });

  it('shows the available update and triggers verified download plus system install', async () => {
    const onClose = jest.fn();
    const screen = render(
      <UpdateModal
        visible
        release={release}
        currentVersionName="V3.0.0"
        onClose={onClose}
      />,
    );

    expect(screen.getByText('发现新版本 V3.0.1')).toBeTruthy();
    expect(screen.getByText('修复更新流程')).toBeTruthy();
    fireEvent.press(screen.getByText('立即更新'));

    await waitFor(() => {
      expect(downloadAndVerifyUpdate).toHaveBeenCalledWith(
        release,
        expect.any(Function),
      );
      expect(AppUpdate?.installApk).toHaveBeenCalledWith(
        '/tmp/cache/updates/ShineWriter-V3.0.1-release.apk',
      );
    });
  });

  it('allows the user to postpone a non-forced update', () => {
    const onClose = jest.fn();
    const screen = render(
      <UpdateModal
        visible
        release={release}
        currentVersionName="V3.0.0"
        onClose={onClose}
      />,
    );
    fireEvent.press(screen.getByText('稍后更新'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(formatUpdateError).not.toHaveBeenCalled();
  });

  it('restores a completed system task and continues into verification/install after remount', async () => {
    (getUpdateDownloadStatus as jest.Mock).mockResolvedValue({
      downloadId: 8,
      status: 'successful',
      bytesDownloaded: 100,
      totalBytes: 100,
      reason: 0,
      reasonMessage: '',
      versionCode: release.versionCode,
      versionName: release.versionName,
      apkName: release.apkName,
      apkUrl: release.apkUrl,
      sha256: release.sha256,
      createdAt: Date.now(),
    });
    (resumeUpdateDownload as jest.Mock).mockResolvedValue({
      path: '/tmp/cache/updates/ShineWriter-V3.0.1-release.apk',
      sha256: release.sha256,
      apk: {
        packageName: 'com.shinewriter',
        versionName: 'V3.0.1',
        versionCode: release.versionCode,
        signerSha256: '017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a',
      },
    });

    render(
      <UpdateModal
        visible
        release={release}
        currentVersionName="V3.0.0"
        onClose={jest.fn()}
      />,
    );

    await waitFor(() => {
      expect(resumeUpdateDownload).toHaveBeenCalledWith(release, expect.any(Function));
      expect(AppUpdate?.installApk).toHaveBeenCalledWith(
        '/tmp/cache/updates/ShineWriter-V3.0.1-release.apk',
      );
    });
  });
});
