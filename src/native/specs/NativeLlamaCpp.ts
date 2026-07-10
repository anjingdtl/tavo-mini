import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  getCapabilities(): Promise<Object>;
  importModel(
    sourceUri: string,
    originalFilename: string,
    displayName: string,
  ): Promise<Object>;
  validateModel(modelId: string, relativePath: string): Promise<Object>;
  loadModel(modelId: string, relativePath: string, contextLength: number): Promise<Object>;
  generate(requestId: string, modelId: string, request: Object): Promise<void>;
  cancel(requestId: string): Promise<void>;
  unloadModel(): Promise<void>;
  deleteModelFiles(modelId: string, relativePath: string): Promise<void>;
  modelFileExists(relativePath: string): Promise<boolean>;
  cleanupStagingFiles(): Promise<number>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('LlamaCpp');
