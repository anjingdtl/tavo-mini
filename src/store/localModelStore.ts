import { create } from 'zustand';
import {
  listLocalModels,
  getLocalModelById,
  importLocalModel,
  validateLocalModel,
  loadLocalModel,
  deleteLocalModel,
} from '../services/localModels';
import type { LocalModel } from '../services/localModels';
import { subscribeImportEvents, isLlamaCppAvailable } from '../native/LlamaCppModule';

interface ImportState {
  importId: string | null;
  state: 'idle' | 'selecting' | 'copying' | 'hashing' | 'validating' | 'ready' | 'error';
  bytesCopied: number;
  totalBytes: number;
  errorCode: string | null;
  errorMessage: string | null;
}

interface LocalModelState {
  models: LocalModel[];
  import: ImportState;
  loadingModelId: string | null;
  loadModel: (modelId: string) => Promise<void>;
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

  loadModel: async (modelId) => {
    const model = await getLocalModelById(modelId);
    if (!model) throw new Error('模型不存在');
    set({ loadingModelId: modelId });
    try {
      await loadLocalModel(model);
    } finally {
      set({ loadingModelId: null });
    }
  },

  startImport: async (sourceUri, originalFilename, displayName) => {
    if (!isLlamaCppAvailable()) {
      throw new Error('本地 llama.cpp 模块尚未就绪，请检查应用安装或重新启动。');
    }

    set({
      import: {
        ...initialImportState,
        importId: '',
        state: 'selecting',
      },
    });

    // importId 由原生层在导入开始时生成，Promise resolve 前就开始发进度事件。
    // 用 subscribeImportEvents（不过滤）+ activeImportId 自行匹配：第一个事件确定 importId。
    let activeImportId: string | null = null;
    const unsub = subscribeImportEvents({
      onProgress: (e) => {
        if (activeImportId === null) activeImportId = e.importId;
        if (e.importId !== activeImportId) return;
        set({
          import: {
            ...get().import,
            importId: activeImportId,
            bytesCopied: e.bytesCopied,
            totalBytes: e.totalBytes,
            state: e.totalBytes > 0 && e.bytesCopied >= e.totalBytes ? 'hashing' : 'copying',
          },
        });
      },
      onState: (e) => {
        if (activeImportId === null) activeImportId = e.importId;
        if (e.importId !== activeImportId) return;
        set({
          import: {
            ...get().import,
            importId: activeImportId,
            state: e.state as ImportState['state'],
          },
        });
      },
    });

    try {
      const model = await importLocalModel(sourceUri, originalFilename, displayName);
      activeImportId = model.id;

      set({
        import: {
          ...get().import,
          importId: activeImportId,
          state: 'validating',
          errorCode: null,
          errorMessage: null,
        },
      });

      await validateLocalModel(model);

      set({
        import: {
          ...get().import,
          importId: activeImportId,
          state: 'ready',
        },
      });

      await get().refreshModels();
    } catch (error: any) {
      set({
        import: {
          ...get().import,
          importId: activeImportId,
          state: 'error',
          errorCode: error?.code || 'IMPORT_FAILED',
          errorMessage: error?.message || '模型导入失败',
        },
      });
      throw error;
    } finally {
      unsub();
    }
  },

  cancelImport: async () => {
    // 当前原生层未暴露导入取消的 ReactMethod，导入会在后台继续完成；
    // 此处仅重置 UI 状态，完成后 refreshModels 会拉到结果。
    set({ import: initialImportState });
  },

  deleteModel: async (modelId) => {
    const model = await getLocalModelById(modelId);
    if (!model) throw new Error('模型不存在');
    await deleteLocalModel(model);
    await get().refreshModels();
  },
}));
