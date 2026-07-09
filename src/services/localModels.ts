import { LocalLLM } from '../native/LocalLLMModule';
import type { LocalModel, LocalModelStatus, LocalModelBackend } from '../types/localModel';
import {
  listLocalModels as dbListLocalModels,
  getLocalModelById as dbGetLocalModelById,
  getLocalModelBySha256 as dbGetLocalModelBySha256,
  createLocalModel as dbCreateLocalModel,
  updateLocalModel as dbUpdateLocalModel,
  deleteLocalModelRecord as dbDeleteLocalModelRecord,
  countLLMConfigsUsingModel as dbCountLLMConfigsUsingModel,
} from './database';

export type { LocalModel, LocalModelStatus, LocalModelBackend };

export const listLocalModels = dbListLocalModels;
export const getLocalModelById = dbGetLocalModelById;
export const getLocalModelBySha256 = dbGetLocalModelBySha256;
export const createLocalModel = dbCreateLocalModel;
export const updateLocalModel = dbUpdateLocalModel;
export const deleteLocalModelRecord = dbDeleteLocalModelRecord;
export const countLLMConfigsUsingModel = dbCountLLMConfigsUsingModel;

function now(): string {
  return new Date().toISOString();
}

function ensureModule() {
  if (!LocalLLM) {
    throw new Error('本地 llama.cpp 模块尚未就绪，请检查应用安装或重新启动。');
  }
}

export async function importLocalModel(
  sourceUri: string,
  originalFilename: string,
  displayName?: string,
): Promise<LocalModel> {
  ensureModule();
  const name = (displayName || originalFilename).replace(/\.(litertlm|gguf)$/i, '');
  const result = await LocalLLM!.importModel(sourceUri, originalFilename, name);

  const existing = await dbGetLocalModelBySha256(result.sha256);
  if (existing) {
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
  };
  await dbCreateLocalModel(model);
  return model;
}

export async function validateLocalModel(
  model: LocalModel,
  backend: LocalModelBackend = 'auto',
): Promise<void> {
  ensureModule();
  try {
    const result = await LocalLLM!.validateModel(model.id, model.relative_path, backend === 'npu' ? 'auto' : backend);
    await dbUpdateLocalModel(model.id, {
      status: 'ready',
      backend_preference: backend,
      validated_backend: result.backend,
      context_length: result.contextLength ?? null,
      max_output_tokens: result.maxOutputTokens ?? null,
      load_time_ms: result.loadTimeMs,
      last_validated_at: now(),
      error_code: null,
      error_message: null,
    });
  } catch (error: any) {
    await dbUpdateLocalModel(model.id, {
      status: 'error',
      error_code: error?.code || 'VALIDATION_FAILED',
      error_message: error?.message || '模型验证失败',
    });
    throw error;
  }
}

export async function loadLocalModel(
  model: LocalModel,
  backend: LocalModelBackend = 'auto',
) {
  ensureModule();
  return LocalLLM!.loadModel(model.id, model.relative_path, backend === 'npu' ? 'auto' : backend);
}

export async function deleteLocalModel(model: LocalModel): Promise<void> {
  ensureModule();
  const usageCount = await dbCountLLMConfigsUsingModel(model.id);
  if (usageCount > 0) {
    throw new Error('该模型正被 LLM 配置使用，请先删除相关配置。');
  }
  await LocalLLM!.deleteModelFiles(model.id, model.relative_path);
  await dbDeleteLocalModelRecord(model.id);
}

export async function cleanupOrphanedModels(): Promise<void> {
  const models = await dbListLocalModels();
  for (const model of models) {
    const exists = await LocalLLM?.modelFileExists(model.relative_path);
    if (!exists && model.status !== 'missing') {
      await dbUpdateLocalModel(model.id, {
        status: 'missing',
        error_code: 'MODEL_FILE_MISSING',
        error_message: '模型文件已丢失或已被移除',
      });
    }
  }
}

export async function cleanupStagingFiles(): Promise<number> {
  return LocalLLM?.cleanupStagingFiles() ?? Promise.resolve(0);
}
