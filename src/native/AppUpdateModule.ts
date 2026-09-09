import { NativeModules } from 'react-native';

export interface InstalledAppInfo {
  packageName: string;
  versionName: string;
  versionCode: number;
}

export interface ApkValidationResult {
  valid: boolean;
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  signerSha256?: string;
  packageMatches: boolean;
  versionMatches: boolean;
  signerMatches: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export type UpdateDownloadStatusName =
  | 'pending'
  | 'running'
  | 'paused'
  | 'successful'
  | 'failed';

export interface UpdateDownloadStatus {
  downloadId: number;
  status: UpdateDownloadStatusName;
  bytesDownloaded: number;
  totalBytes: number;
  reason: number;
  reasonMessage?: string;
  versionCode: number;
  versionName: string;
  apkName: string;
  apkUrl: string;
  sha256: string;
  releaseInfo?: string;
  createdAt: number;
  localUri?: string;
}

export interface AppUpdateNativeModule {
  getInstalledAppInfo(): Promise<InstalledAppInfo>;
  canInstallUnknownApps(): Promise<boolean>;
  openUnknownAppSettings(): Promise<boolean>;
  sha256File(path: string): Promise<string>;
  validateApk(
    path: string,
    expectedPackageName: string,
    expectedVersionCode: number,
    expectedSignerSha256: string,
  ): Promise<ApkValidationResult>;
  enqueueUpdateDownload(
    apkUrl: string,
    apkName: string,
    versionCode: number,
    versionName: string,
    sha256: string,
    releaseInfo: string,
  ): Promise<UpdateDownloadStatus>;
  getUpdateDownloadStatus(): Promise<UpdateDownloadStatus | null>;
  cancelUpdateDownload(): Promise<boolean>;
  materializeDownloadedUpdate(versionCode: number): Promise<string>;
  installApk(path: string): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export const AppUpdate =
  (NativeModules.AppUpdate as AppUpdateNativeModule | undefined) ?? null;
