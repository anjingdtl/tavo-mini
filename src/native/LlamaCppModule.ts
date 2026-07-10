import { NativeModules, DeviceEventEmitter, type EmitterSubscription } from 'react-native';

/**
 * TS 桥接层：对接 Kotlin `LlamaCppModule`（NativeModules.LlamaCpp）。
 *
 * 10 个 ReactMethod 包装为 Promise；流式生成与导入进度通过
 * DeviceEventEmitter 事件返回，提供 observeGeneration / subscribeImportEvents
 * 两个订阅辅助函数（按 requestId / importId 过滤）。
 *
 * 事件名常量必须与 Kotlin `LlamaCppEvents` 逐字对应：
 *  LlamaCppToken / LlamaCppCompleted / LlamaCppError
 *  LlamaCppImportProgress / LlamaCppImportState
 */

const native = NativeModules.LlamaCpp;

export const LlamaCppEvents = {
  TOKEN: 'LlamaCppToken',
  COMPLETED: 'LlamaCppCompleted',
  ERROR: 'LlamaCppError',
  IMPORT_PROGRESS: 'LlamaCppImportProgress',
  IMPORT_STATE: 'LlamaCppImportState',
} as const;

export interface CapabilitiesResult {
  available: boolean;
  cpuSupported: boolean;
  freeMemoryMB: number;
  totalMemoryMB: number;
}

export interface ImportResult {
  importId: string;
  originalFilename: string;
  displayName: string;
  fileSize: number;
  sha256: string;
  stagingRelativePath: string;
}

export interface LoadResult {
  backend: string;
  loadTimeMs: number;
}

export interface GenerateRequest {
  /** 已格式化好的完整 prompt（优先于 messages）。 */
  prompt: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
}

export interface TokenEvent {
  requestId: string;
  delta: string;
  sequence: number;
}

export interface CompletedEvent {
  requestId: string;
  text: string;
  outputTokens: number;
  tokensPerSecond: number;
  elapsedMs: number;
  cancelled: boolean;
}

export interface ErrorEvent {
  requestId: string;
  code: string;
  message: string;
}

export interface ImportProgressEvent {
  importId: string;
  bytesCopied: number;
  totalBytes: number;
  percent: number;
}

export interface ImportStateEvent {
  importId: string;
  state: string;
}

export interface GenerationObservers {
  onToken?: (e: TokenEvent) => void;
  onCompleted?: (e: CompletedEvent) => void;
  onError?: (e: ErrorEvent) => void;
}

export interface ImportObservers {
  onProgress?: (e: ImportProgressEvent) => void;
  onState?: (e: ImportStateEvent) => void;
}

/** 原生模块引用（可能在 JS-only 环境/测试中为 undefined）。 */
export const LlamaCppNative = native;

// RN 0.85 bridgeless 模式下，TurboModule 不再自动写入 NativeModules 代理；
// 它们走 cpp 端的 __turboModuleProxy。这里加一层 fallback 探测：
// 1. NativeModules.LlamaCpp（legacy + bridgeless shim）
// 2. global.__turboModuleProxy('LlamaCpp')（codegen TurboModule）
// 3. TurboModuleRegistry.get('LlamaCpp')（public API）
//
// 不在运行时 import codegen spec：NativeLlamaCpp.ts 使用 getEnforcing，
// 若 app-level C++ provider 尚未装入 native binary，会直接触发红屏。
function findNative(): unknown {
  if (native) return native;
  const anyGlobal = globalThis as unknown as {
    __turboModuleProxy?: (name: string) => unknown;
  };
  if (typeof anyGlobal.__turboModuleProxy === 'function') {
    try {
      const m = anyGlobal.__turboModuleProxy('LlamaCpp');
      if (m) return m;
    } catch {
      // 探测失败时静默忽略
    }
  }
  try {
    const TurboModuleRegistry = require('react-native').TurboModuleRegistry as
      | { get?: (name: string) => unknown }
      | undefined;
    const m = TurboModuleRegistry?.get?.('LlamaCpp');
    if (m) return m;
  } catch {
    // 探测失败时静默忽略
  }
  return null;
}

let cachedAvailable: boolean | null = null;
let probePromise: Promise<boolean> | null = null;

function probeOnce(): boolean {
  if (findNative()) return true;
  return false;
}

export function isLlamaCppAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable;
  const ok = probeOnce();
  if (ok) {
    cachedAvailable = true;
    return true;
  }
  return false;
}

/** 异步探测本地模块是否真的就绪（用于 store 启动导入前的最后判断）。 */
export async function probeLlamaCppAvailable(timeoutMs = 1000): Promise<boolean> {
  if (cachedAvailable === true) return true;
  if (probePromise) return probePromise;
  probePromise = new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (probeOnce()) {
        cachedAvailable = true;
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        cachedAvailable = false;
        resolve(false);
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
  return probePromise;
}

function ensureModule(): void {
  if (!findNative()) {
    throw new Error('本地 llama.cpp 模块尚未就绪，请检查应用安装或重新启动。');
  }
}

function currentNative(): NonNullable<unknown> {
  // 调用前确保 findNative() 已发现
  return findNative() as NonNullable<unknown>;
}

// ── ReactMethod 包装 ─────────────────────────────────────────

export async function getCapabilities(): Promise<CapabilitiesResult> {
  ensureModule();
  return (currentNative() as { getCapabilities: () => Promise<CapabilitiesResult> }).getCapabilities();
}

export async function importModel(
  sourceUri: string,
  originalFilename: string,
  displayName: string,
): Promise<ImportResult> {
  ensureModule();
  return (currentNative() as {
    importModel: (a: string, b: string, c: string) => Promise<ImportResult>;
  }).importModel(sourceUri, originalFilename, displayName);
}

export async function validateModel(modelId: string, relativePath: string): Promise<LoadResult> {
  ensureModule();
  return (currentNative() as {
    validateModel: (a: string, b: string) => Promise<LoadResult>;
  }).validateModel(modelId, relativePath);
}

export async function loadModel(
  modelId: string,
  relativePath: string,
  contextLength = 4096,
): Promise<LoadResult> {
  ensureModule();
  return (currentNative() as {
    loadModel: (a: string, b: string, c: number) => Promise<LoadResult>;
  }).loadModel(modelId, relativePath, contextLength);
}

/**
 * 流式生成。Promise 立即 resolve（表示「开始生成」），实际 token/完成/错误
 * 通过事件返回，需配合 observeGeneration 订阅。
 */
export async function generate(
  requestId: string,
  modelId: string,
  request: GenerateRequest,
): Promise<void> {
  ensureModule();
  return (currentNative() as {
    generate: (a: string, b: string, c: GenerateRequest) => Promise<void>;
  }).generate(requestId, modelId, request);
}

export async function cancel(requestId: string): Promise<void> {
  ensureModule();
  return (currentNative() as { cancel: (a: string) => Promise<void> }).cancel(requestId);
}

export async function unloadModel(): Promise<void> {
  ensureModule();
  return (currentNative() as { unloadModel: () => Promise<void> }).unloadModel();
}

export async function deleteModelFiles(modelId: string, relativePath: string): Promise<void> {
  ensureModule();
  return (currentNative() as {
    deleteModelFiles: (a: string, b: string) => Promise<void>;
  }).deleteModelFiles(modelId, relativePath);
}

export async function modelFileExists(relativePath: string): Promise<boolean> {
  ensureModule();
  return (currentNative() as { modelFileExists: (a: string) => Promise<boolean> }).modelFileExists(
    relativePath,
  );
}

export async function cleanupStagingFiles(): Promise<number> {
  ensureModule();
  return (currentNative() as { cleanupStagingFiles: () => Promise<number> }).cleanupStagingFiles();
}

// ── 事件订阅辅助 ─────────────────────────────────────────────

/**
 * 订阅某次生成的流式事件，按 requestId 过滤。
 * 返回取消订阅函数（组件卸载或生成结束时调用）。
 */
export function observeGeneration(requestId: string, observers: GenerationObservers): () => void {
  const subs: EmitterSubscription[] = [];
  if (observers.onToken) {
    subs.push(
      DeviceEventEmitter.addListener(LlamaCppEvents.TOKEN, (e: TokenEvent) => {
        if (e && e.requestId === requestId) observers.onToken!(e);
      }),
    );
  }
  if (observers.onCompleted) {
    subs.push(
      DeviceEventEmitter.addListener(LlamaCppEvents.COMPLETED, (e: CompletedEvent) => {
        if (e && e.requestId === requestId) observers.onCompleted!(e);
      }),
    );
  }
  if (observers.onError) {
    subs.push(
      DeviceEventEmitter.addListener(LlamaCppEvents.ERROR, (e: ErrorEvent) => {
        if (e && e.requestId === requestId) observers.onError!(e);
      }),
    );
  }
  return () => subs.forEach((s) => s.remove());
}

/**
 * 订阅某次导入的进度/状态事件，按 importId 过滤。
 * 返回取消订阅函数。
 */
export function observeImport(importId: string, observers: ImportObservers): () => void {
  const subs: EmitterSubscription[] = [];
  if (observers.onProgress) {
    subs.push(
      DeviceEventEmitter.addListener(LlamaCppEvents.IMPORT_PROGRESS, (e: ImportProgressEvent) => {
        if (e && e.importId === importId) observers.onProgress!(e);
      }),
    );
  }
  if (observers.onState) {
    subs.push(
      DeviceEventEmitter.addListener(LlamaCppEvents.IMPORT_STATE, (e: ImportStateEvent) => {
        if (e && e.importId === importId) observers.onState!(e);
      }),
    );
  }
  return () => subs.forEach((s) => s.remove());
}

/**
 * 订阅全部导入事件（不过滤 importId）。
 * 用于 importId 尚未确定的阶段（importModel Promise resolve 之前就开始收事件），
 * 调用方需自行按 importId 过滤。返回取消订阅函数。
 */
export function subscribeImportEvents(observers: ImportObservers): () => void {
  const subs: EmitterSubscription[] = [];
  if (observers.onProgress) {
    subs.push(
      DeviceEventEmitter.addListener(LlamaCppEvents.IMPORT_PROGRESS, (e: ImportProgressEvent) => {
        if (e) observers.onProgress!(e);
      }),
    );
  }
  if (observers.onState) {
    subs.push(
      DeviceEventEmitter.addListener(LlamaCppEvents.IMPORT_STATE, (e: ImportStateEvent) => {
        if (e) observers.onState!(e);
      }),
    );
  }
  return () => subs.forEach((s) => s.remove());
}
