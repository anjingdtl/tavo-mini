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
  installApk(path: string): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export const AppUpdate =
  (NativeModules.AppUpdate as AppUpdateNativeModule | undefined) ?? null;
