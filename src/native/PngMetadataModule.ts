import { NativeModules } from 'react-native';

export interface PngMetadataResult {
  key: string;
  data: string;
}

export const PngMetadata = NativeModules.PngMetadata;
