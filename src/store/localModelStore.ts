import { create } from 'zustand';
import {
  listLocalModels,
  getLocalModelById,
  importLocalModel,
  validateLocalModel,
  loadLocalModel,
  deleteLocalModel,
} from '../services/localModels';
import type { LocalModel, LocalModelBackend } from '../services/localModels';
import { LocalLLM, observeImport, unobserveImport } from '../native/LocalLLMModule';

interface ImportState {
  importId: string | null;
  state: 'idle' | 'selecting' | 'copying' | 'validating' | 'ready' | 'error';
  bytesCopied: number;
  totalBytes: number;
  errorCode: string | null;
  errorMessage: string | null;
}

interface LocalModelState {
  models: LocalModel[];
  import: ImportState;
  loadingModelId: string | null;
  loadModel: (modelId: string, backend?: LocalModelBackend) => Promise<void>;
  startImport: (sourceUri: string, originalFilename: string, displayName?: string) => Promise<void>;
  cancelImport: () => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  refreshModels: () => Promise<void>;
}

const initialImportState: ImportState = {
  importId: null,
  state: 'idle',
  bytesCopied: 0,
  totalBytes: 0,
  errorCode: null,
  errorMessage: null,
};

export const useLocalModelStore = create<LocalModelState>((set, get) => ({
  models: [],
  import: initialImportState,
  loadingModelId: null,

  refreshModels: async () => {
    const models = await listLocalModels();
    set({ models });
  },

  loadModel: async (modelId, backend = 'auto') => {
    const model = await getLocalModelById(modelId);
    if (!model) throw new Error('模型不存在');
    set({ loadingModelId: modelId });
    try {
      await loadLocalModel(model, backend);
    } finally {
      set({ loadingModelId: null });
    }
  },

  startImport: async (sourceUri, originalFilename, displayName) => {
    if (!LocalLLM) {
      throw new Error('本地 llama.cpp 模块尚未就绪，请检查应用安装或重新启动。');
    }

    set({
      import: {
        ...initialImportState,
        importId: '',
        state: 'selecting',
      },
    });

    let importId = '';
    let observerSet = false;

    try {
      const model = await importLocalModel(sourceUri, originalFilename, displayName);
      importId = model.id;
      observerSet = true;

      observeImport(importId, (event) => {
        if ('bytesCopied' in event) {
          set({
            import: {
              ...get().import,
              importId,
              bytesCopied: event.bytesCopied,
              totalBytes: event.totalBytes,
              state: 'copying',
            },
          });
        } else if ('state' in event) {
          set({
            import: {
              ...get().import,
              importId,
              state: event.state,
            },
          });
        }
      });

      set({
        import: {
          ...get().import,
          importId,
          state: 'validating',
          errorCode: null,
          errorMessage: null,
        },
      });

      await validateLocalModel(model, 'auto');

      set({
        import: {
          ...get().import,
          importId,
          state: 'ready',
        },
      });

      await get().refreshModels();
    } catch (error: any) {
      set({
        import: {
          ...get().import,
          importId,
          state: 'error',
          errorCode: error?.code || 'IMPORT_FAILED',
          errorMessage: error?.message || '模型导入失败',
        },
      });
      throw error;
    } finally {
      if (observerSet && importId) {
        unobserveImport(importId);
      }
    }
  },

  cancelImport: async () => {
    const { import: importState } = get();
    if (importState.importId && LocalLLM) {
      try {
        await LocalLLM.cancel(importState.importId);
      } catch {
        // 取消指令发送失败不影响重置状态
      }
    }
    set({ import: initialImportState });
  },

  deleteModel: async (modelId) => {
    const model = await getLocalModelById(modelId);
    if (!model) throw new Error('模型不存在');
    await deleteLocalModel(model);
    await get().refreshModels();
  },
}));
