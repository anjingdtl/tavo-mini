import * as db from './database';
import type { LocalModel, LocalModelStatus, LocalModelBackend, PromptTemplate } from '../types/localModel';
import {
  getCapabilities,
  importModel as nativeImportModel,
  validateModel as nativeValidateModel,
  loadModel as nativeLoadModel,
  unloadModel as nativeUnloadModel,
  deleteModelFiles as nativeDeleteModelFiles,
  modelFileExists as nativeModelFileExists,
  cleanupStagingFiles as nativeCleanupStagingFiles,
  isLlamaCppAvailable,
  type CapabilitiesResult,
  type ImportResult,
  type LoadResult,
} from '../native/LlamaCppModule';
import { invalidateLoadedModel } from './llm/llamaCppProvider';

export type { LocalModel, LocalModelStatus, LocalModelBackend, PromptTemplate };

export const listLocalModels = db.listLocalModels;
export const getLocalModelById = db.getLocalModelById;
export const getLocalModelBySha256 = db.getLocalModelBySha256;
export const createLocalModel = db.createLocalModel;
export const updateLocalModel = db.updateLocalModel;
export const deleteLocalModelRecord = db.deleteLocalModelRecord;
export const countLLMConfigsUsingModel = db.countLLMConfigsUsingModel;

function now(): string {
  return new Date().toISOString();
}

function ensureModule(): void {
  if (!isLlamaCppAvailable()) {
    throw new Error('本地 llama.cpp 模块尚未就绪，请检查应用安装或重新启动。');
  }
}

/** 查询设备能力（CPU 支持、可用内存）。 */
export async function getLocalModelCapabilities(): Promise<CapabilitiesResult> {
  ensureModule();
  return getCapabilities();
}

/**
 * 导入 GGUF 模型：流式复制 + SHA-256 + GGUF 头校验（原生层完成）。
 * promptTemplate 在导入时给定，默认 chatml，后续可用 updateLocalModel 修改。
 */
export async function importLocalModel(
  sourceUri: string,
  originalFilename: string,
  displayName?: string,
  promptTemplate: PromptTemplate = 'chatml',
): Promise<LocalModel> {
  ensureModule();
  const name = (displayName || originalFilename).replace(/\.gguf$/i, '');
  const result: ImportResult = await nativeImportModel(sourceUri, originalFilename, name);

  const existing = await db.getLocalModelBySha256(result.sha256);
  if (existing) {
    // 原生层在返回 SHA-256 前已将文件移动到最终目录。重复文件不能只在
    // JS 层报错，否则会留下没有数据库记录、无法从管理页删除的整份模型。
    // 清理失败不覆盖重复导入提示，避免把用户可操作的原因隐藏掉。
    try {
      await nativeDeleteModelFiles(result.importId, result.stagingRelativePath);
    } catch {
      // 下次启动的 staging 清理会作为兜底；仍向调用方返回重复文件错误。
    }
    throw new Error('该模型文件已导入，请勿重复导入。');
  }

  const model: LocalModel = {
    id: result.importId,
    display_name: result.displayName || name,
    original_filename: result.originalFilename,
    relative_path: result.stagingRelativePath,
    file_size: result.fileSize,
    sha256: result.sha256,
    status: 'validating',
    backend_preference: 'auto',
    validated_backend: null,
    context_length: null,
    max_output_tokens: null,
    load_time_ms: null,
    first_token_ms: null,
    tokens_per_second: null,
    imported_at: now(),
    last_used_at: null,
    last_validated_at: null,
    error_code: null,
    error_message: null,
    prompt_template: promptTemplate,
    actual_backend: null,
  };
  await db.createLocalModel(model);
  return model;
}

/**
 * 校验模型：原生层加载后立即卸载，确认 GGUF 可解析。
 * 新引擎仅 CPU，返回的 LoadResult 只含 backend/loadTimeMs，
 * context_length/max_output_tokens 暂置 null（llama.cpp 不强制上报）。
 */
export async function validateLocalModel(model: LocalModel): Promise<void> {
  ensureModule();
  try {
    const result: LoadResult = await nativeValidateModel(model.id, model.relative_path);
    await db.updateLocalModel(model.id, {
      status: 'ready',
      validated_backend: 'cpu',
      actual_backend: result.backend,
      context_length: null,
      max_output_tokens: null,
      load_time_ms: result.loadTimeMs,
      last_validated_at: now(),
      error_code: null,
      error_message: null,
    });
  } catch (error: any) {
    await db.updateLocalModel(model.id, {
      status: 'error',
      error_code: error?.code || 'VALIDATION_FAILED',
      error_message: error?.message || '模型验证失败',
    });
    throw error;
  }
}

/** 加载模型到内存（保持加载状态，供后续 generate 复用）。 */
export async function loadLocalModel(model: LocalModel): Promise<LoadResult> {
  ensureModule();
  return nativeLoadModel(model.id, model.relative_path);
}

/** 卸载当前已加载模型，释放 JNI 资源 + 重置 Provider 加载缓存。 */
export async function unloadLocalModel(): Promise<void> {
  ensureModule();
  invalidateLoadedModel();
  return nativeUnloadModel();
}

/** 删除模型文件 + 数据库记录（需先确认未被 LLM 配置引用）。 */
export async function deleteLocalModel(model: LocalModel): Promise<void> {
  ensureModule();
  const usageCount = await db.countLLMConfigsUsingModel(model.id);
  if (usageCount > 0) {
    throw new Error('该模型正被 LLM 配置使用，请先删除相关配置。');
  }
  await nativeDeleteModelFiles(model.id, model.relative_path);
  await db.deleteLocalModelRecord(model.id);
}

/** 扫描所有模型记录，将磁盘上已缺失的标记为 missing。 */
export async function cleanupOrphanedModels(): Promise<void> {
  const models = await db.listLocalModels();
  for (const model of models) {
    if (!isLlamaCppAvailable()) break;
    const exists = await nativeModelFileExists(model.relative_path);
    if (!exists && model.status !== 'missing') {
      await db.updateLocalModel(model.id, {
        status: 'missing',
        error_code: 'MODEL_FILE_MISSING',
        error_message: '模型文件已丢失或已被移除',
      });
    }
  }
}

/** 清理 staging 临时文件，返回清理数量。 */
export async function cleanupStagingFiles(): Promise<number> {
  if (!isLlamaCppAvailable()) return 0;
  return nativeCleanupStagingFiles();
}
