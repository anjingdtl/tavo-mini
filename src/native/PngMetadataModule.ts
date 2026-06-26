import { NativeModules } from 'react-native';

export interface PngMetadataResult {
  key: string;
  data: string;
}

export interface PngMetadataModuleType {
  parsePngMetadata(filePath: string): Promise<PngMetadataResult[]>;
  // NativeEventEmitter 协议要求
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

// 10.21 修复：原导出为 any，补类型注解；原生模块可能未注册，保留 undefined 兜底
export const PngMetadata = NativeModules.PngMetadata as PngMetadataModuleType | undefined;
