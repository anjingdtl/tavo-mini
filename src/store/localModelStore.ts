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
import {
  subscribeImportEvents,
  isLlamaCppAvailable,
  probeLlamaCppAvailable,
} from '../native/LlamaCppModule';

interface ImportState {
  importId: string | null;
  state:
    | 'idle'
    | 'preparing'
    | 'selecting'
    | 'copying'
    | 'hashing'
    | 'validating'
    | 'ready'
    | 'error';
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
  startImport: (sourceUri: string, originalFilename: string, displayName?: string, fileSize?: number) => Promise<void>;
  validateModel: (modelId: string) => Promise<void>;
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

  startImport: async (sourceUri, originalFilename, displayName, fileSize) => {
    // 同步判定 + 异步再探测一次，避开 RN 0.85 bridgeless 模式下 TurboModule 注入
    // 与首次 importModel 调用之间的竞态。
    const quickAvailable = isLlamaCppAvailable();
    const probedAvailable = quickAvailable ? true : await probeLlamaCppAvailable(2000);
    if (!probedAvailable) {
      const err = new Error('本地模型引擎初始化失败，请重启 App 后再试。');
      (err as { code?: string }).code = 'ENGINE_UNAVAILABLE';
      set({
        import: {
          ...initialImportState,
          importId: null,
          bytesCopied: 0,
          totalBytes: 0,
          state: 'error',
          errorCode: (err as { code?: string }).code ?? 'ENGINE_UNAVAILABLE',
          errorMessage: err.message,
        },
      });
      throw err;
    }

    // 先把状态切到 preparing，让 UI 立刻出现“正在准备模型文件…”模态，
    // 避免原生层挂起时用户看到“点完没反应”。
    set({
      import: {
        ...initialImportState,
        importId: '',
        state: 'preparing',
      },
    });

    // importId 由原生层在导入开始时生成，Promise resolve 前就开始发进度事件。
    // 用 subscribeImportEvents（不过滤）+ activeImportId 自行匹配：第一个事件确定 importId。
    let activeImportId: string | null = null;
    const unsub = subscribeImportEvents({
      onProgress: (e) => {
        if (activeImportId === null) activeImportId = e.importId;
        if (e.importId !== activeImportId) return;
        // content:// URI 通常拿不到总大小（原生层 totalBytes=-1），
        // 用文件选择器返回的 size 补齐，让进度条能正常显示百分比。
        const totalBytes = e.totalBytes > 0 ? e.totalBytes : fileSize ?? -1;
        set({
          import: {
            ...get().import,
            importId: activeImportId,
            bytesCopied: e.bytesCopied,
            totalBytes,
            state: totalBytes > 0 && e.bytesCopied >= totalBytes ? 'hashing' : 'copying',
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

    // 兜底：原生层太久没把第一个事件推上来就直接报错，避免永远卡在 preparing。
    // 大文件（如 2.8GB）复制可能超过 90 秒，按文件大小动态放宽：基础 90 秒 + 每 MB 250 毫秒。
    const timeoutMs = Math.max(90_000, Math.floor((fileSize ?? 0) / (1024 * 1024) * 250));
    let firstEventTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      firstEventTimer = setTimeout(() => {
        reject(
          Object.assign(new Error(`本地模型引擎无响应（${Math.round(timeoutMs / 1000)} 秒超时），请检查应用安装后重试。`), {
            code: 'IMPORT_TIMEOUT',
          }),
        );
      }, timeoutMs);
    });

    try {
      const model = await Promise.race<ReturnType<typeof importLocalModel>>([
        importLocalModel(sourceUri, originalFilename, displayName),
        timeoutPromise,
      ]);
      activeImportId = model.id;
      if (firstEventTimer) clearTimeout(firstEventTimer);

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
      if (firstEventTimer) clearTimeout(firstEventTimer);
      // 把常见的引擎未就绪 / 模型引擎挂起错误翻译为可读中文消息
      const rawMessage: string = error?.message || '模型导入失败';
      const friendlyMessage = rawMessage.includes('llama.cpp')
        ? '本地模型引擎尚未就绪，请检查应用安装或重新启动。'
        : rawMessage;
      set({
        import: {
          ...get().import,
          importId: activeImportId,
          state: 'error',
          errorCode: error?.code || 'IMPORT_FAILED',
          errorMessage: friendlyMessage,
        },
      });
      throw error;
    } finally {
      unsub();
      if (firstEventTimer) clearTimeout(firstEventTimer);
    }
  },

  cancelImport: async () => {
    // 当前原生层未暴露导入取消的 ReactMethod，导入会在后台继续完成；
    // 此处仅重置 UI 状态，完成后 refreshModels 会拉到结果。
    set({ import: initialImportState });
  },

  validateModel: async (modelId) => {
    const model = await getLocalModelById(modelId);
    if (!model) throw new Error('模型不存在');
    set({
      import: {
        ...initialImportState,
        importId: model.id,
        state: 'validating',
      },
    });
    try {
      await validateLocalModel(model);
      await get().refreshModels();
    } finally {
      set({ import: initialImportState });
    }
  },

  deleteModel: async (modelId) => {
    const model = await getLocalModelById(modelId);
    if (!model) throw new Error('模型不存在');
    await deleteLocalModel(model);
    await get().refreshModels();
  },
}));
