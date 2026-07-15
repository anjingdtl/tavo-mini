import type { LLMProvider } from '../../types/llmProvider';
import type {
  ChatMessage,
  LLMGenerateOptions,
  LLMRequestConfig,
  LLMResult,
} from './types';
import type { PromptTemplate } from '../../types/localModel';
import { getLocalModelById, logLLMUsage } from '../database';
import { estimateMessagesTokens } from '../../utils/tokenEstimator';
import {
  isLlamaCppAvailable,
  loadModel as nativeLoadModel,
  generate as nativeGenerate,
  cancel as nativeCancel,
  observeGeneration,
  type CompletedEvent,
} from '../../native/LlamaCppModule';
import { applyPromptTemplate } from './llamaCppPromptAdapter';
import {
  scheduleLLMRequest,
  getLLMTaskQueueDefaults,
} from './requestScheduler';
import {
  createLLMTimeoutController,
  resolveLLMTimeoutPolicy,
  toLLMRequestError,
} from './requestPolicy';
import {
  LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
  LOCAL_LLM_SAFE_MAX_OUTPUT_TOKENS,
} from '../../constants/llmDefaults';

/**
 * llama.cpp 本地 Provider：实现 LLMProvider 接口，对接 NativeModules.LlamaCpp。
 *
 * - 模型加载缓存：模块级 currentLoadedModelId，同一模型重复 generate 不重 load。
 *   若原生侧因内存压力卸载了模型，下次 generate 会收到「模型未加载」错误，
 *   此时重置标记，用户重试即可重新加载。
 * - 流式生成：native generate 立即 resolve，token/completed/error 走事件。
 *   Provider 聚合为单个 Promise<CompletedEvent>。
 * - 取消：externalSignal.aborted 时调 nativeCancel，原生侧发 cancelled=true 的 Completed。
 */

let currentLoadedModelId: string | null = null;
let currentLoadedContextLength: number | null = null;

/** 供 localModels.unloadLocalModel 调用：重置加载缓存标记。 */
export function invalidateLoadedModel(): void {
  currentLoadedModelId = null;
  currentLoadedContextLength = null;
}

function makeRequestId(): string {
  return `llamacpp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function positiveNumber(value?: number): number | null {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0
    ? numericValue
    : null;
}

function resolveLocalMaxTokens(
  optionValue?: number,
  configValue?: number,
): number {
  const candidates = [
    positiveNumber(optionValue),
    positiveNumber(configValue),
    LOCAL_LLM_SAFE_MAX_OUTPUT_TOKENS,
  ].filter((value): value is number => value !== null);
  const requested =
    candidates.length > 0
      ? Math.min(...candidates)
      : LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.min(requested, LOCAL_LLM_SAFE_MAX_OUTPUT_TOKENS);
}

function shouldDisableReasoning(modelName?: string): boolean {
  return /\bqwen3\b/i.test(modelName || '');
}

function addNoThinkInstruction(messages: ChatMessage[]): ChatMessage[] {
  const nextMessages = messages.map(message => ({ ...message }));
  const instruction =
    '不要输出思考过程、分析说明或 <think> 标签，只输出最终结果。';
  const systemIndex = nextMessages.findIndex(
    message => message.role === 'system',
  );
  if (systemIndex >= 0) {
    const systemMessage = nextMessages[systemIndex];
    systemMessage.content = `${systemMessage.content}\n\n${instruction}`;
  } else {
    nextMessages.unshift({ role: 'system', content: instruction });
  }

  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    if (nextMessages[index].role === 'user') {
      nextMessages[
        index
      ].content = `${nextMessages[index].content}\n\n/no_think`;
      return nextMessages;
    }
  }
  nextMessages.push({ role: 'user', content: '/no_think' });
  return nextMessages;
}

function stripReasoningBlocks(text: string): string {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/^\s*<think>[\s\S]*$/i, '');
  return cleaned.replace(/<\/?think>/gi, '').trim();
}

async function safeLogUsage(fields: {
  scenario: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  status: string;
  errorCode?: string;
  modelName?: string;
  projectId?: number;
  llmConfigId?: number;
  llmConfigName?: string;
}) {
  try {
    await logLLMUsage(fields);
  } catch {
    // Usage 日志不能中断生成。
  }
}

async function ensureModelLoaded(
  modelId: string,
  relativePath: string,
  contextLength: number,
): Promise<void> {
  if (
    currentLoadedModelId === modelId &&
    currentLoadedContextLength === contextLength
  ) {
    return;
  }
  await nativeLoadModel(modelId, relativePath, contextLength);
  currentLoadedModelId = modelId;
  currentLoadedContextLength = contextLength;
}

/**
 * 调一次原生流式生成，聚合为 Promise<CompletedEvent>。
 * 不处理 signal/usage，由调用方包装。modelId 传入用于原生层校验。
 */
function runGeneration(
  requestId: string,
  modelId: string,
  template: PromptTemplate,
  messages: ChatMessage[],
  opts: { max_tokens: number; temperature: number; top_p: number },
  onToken?: (delta: string, sequence: number) => void,
): Promise<CompletedEvent> {
  return new Promise<CompletedEvent>((resolve, reject) => {
    // P1-#8 修复：onToken 必须和 onCompleted / onError 一起在 nativeGenerate 之前注册，
    // 否则 native 端已经 emit 的 token 会被 RN bridge 丢弃（DeviceEventEmitter
    // 对没有 listener 的事件直接 swallow）。
    const unsub = observeGeneration(requestId, {
      onToken: onToken ? e => onToken(e.delta, e.sequence) : undefined,
      onCompleted: e => {
        unsub();
        resolve(e);
      },
      onError: e => {
        unsub();
        reject(Object.assign(new Error(e.message), { code: e.code }));
      },
    });
    const prompt = applyPromptTemplate(template, messages);
    nativeGenerate(requestId, modelId, {
      prompt,
      max_tokens: opts.max_tokens,
      temperature: opts.temperature,
      top_p: opts.top_p,
    }).catch(err => {
      unsub();
      reject(err);
    });
  });
}

export const llamaCppProvider: LLMProvider = {
  type: 'llama_cpp',

  async test(
    config: LLMRequestConfig,
    externalSignal?: AbortSignal,
  ): Promise<string> {
    if (!isLlamaCppAvailable()) {
      throw new Error('本地 llama.cpp 引擎不可用，请检查应用安装。');
    }
    const modelId = config.local_model_id;
    if (!modelId) {
      throw new Error('请先在设置中选择一个本地 GGUF 模型。');
    }
    const model = await getLocalModelById(modelId);
    if (!model) {
      throw new Error('所选本地模型已不存在，请重新选择。');
    }

    const timeoutController = createLLMTimeoutController({
      policy: resolveLLMTimeoutPolicy('connection_test', 'llama_cpp'),
      externalSignal,
    });
    try {
      const contextLength = Math.max(
        512,
        Math.min(4096, config.context_window || 2048),
      );
      await ensureModelLoaded(model.id, model.relative_path, contextLength);
      if (timeoutController.signal.aborted) {
        throw new Error('本地模型连接测试已取消');
      }

      const requestId = makeRequestId();
      const result = await runGeneration(
        requestId,
        model.id,
        model.prompt_template,
        [{ role: 'user', content: '请回复“连接成功”。' }],
        { max_tokens: 16, temperature: 0, top_p: 0.9 },
        () => timeoutController.markProgress('first_token'),
      );

      if (result.cancelled) {
        throw new Error('连接测试已取消');
      }
      return result.text || '连接成功';
    } catch (error: any) {
      throw toLLMRequestError(
        error,
        timeoutController,
        '本地模型连接测试失败。',
      );
    } finally {
      timeoutController.dispose();
    }
  },

  async generate(
    messages: ChatMessage[],
    options: LLMGenerateOptions,
    externalSignal?: AbortSignal,
  ): Promise<LLMResult> {
    const config = options.requestConfig;
    if (!config) {
      throw new Error('缺少 LLM 请求配置');
    }
    const modelId = config.local_model_id;
    if (!modelId) {
      throw new Error('本地模型配置缺失：未指定 local_model_id。');
    }
    if (!isLlamaCppAvailable()) {
      throw new Error('本地 llama.cpp 引擎不可用，请检查应用安装。');
    }

    const model = await getLocalModelById(modelId);
    if (!model) {
      throw new Error('所选本地模型已不存在，请重新选择。');
    }
    if (model.status !== 'ready') {
      throw new Error(
        `模型当前状态为「${model.status}」，无法生成。请先完成校验。`,
      );
    }

    const inputEstimate = estimateMessagesTokens(messages);
    const scenario = options.scenario || 'chat';
    const modelName = model.display_name;
    const projectId = options.projectId;
    const llmConfigId = config.id;
    const llmConfigName = config.name;
    const maxTokens = resolveLocalMaxTokens(
      options.max_tokens,
      config.max_output_tokens,
    );
    const temperature = options.temperature ?? 0.8;
    const topP = options.top_p ?? 0.9;
    const generationMessages = shouldDisableReasoning(modelName)
      ? addNoThinkInstruction(messages)
      : messages;

    try {
      const result = await scheduleLLMRequest(
        async queueSignal => {
          const timeoutController = createLLMTimeoutController({
            policy: resolveLLMTimeoutPolicy(scenario, 'llama_cpp'),
            taskId: options.taskId,
            externalSignal: queueSignal,
            onProgress: options.onProgress,
          });
          const requestId = makeRequestId();
          const onAbort = () => {
            nativeCancel(requestId).catch(() => {});
          };
          queueSignal.addEventListener('abort', onAbort, { once: true });
          try {
            const contextLength = Math.max(
              512,
              Math.min(4096, config.context_window || 2048),
            );
            await ensureModelLoaded(
              model.id,
              model.relative_path,
              contextLength,
            );
            if (timeoutController.signal.aborted) {
              throw new Error('本地模型请求已取消');
            }

            const generationResult = await runGeneration(
              requestId,
              model.id,
              model.prompt_template,
              generationMessages,
              {
                max_tokens: maxTokens,
                temperature,
                top_p: topP,
              },
              () => timeoutController.markProgress('first_token'),
            );
            const abortCode = timeoutController.getAbortCode();
            if (abortCode) {
              const timeoutError = new Error('本地模型请求已停止') as Error & {
                code?: string;
              };
              timeoutError.code = abortCode;
              throw timeoutError;
            }
            return {
              generationResult,
              metrics: { ...timeoutController.metrics },
            };
          } catch (error: any) {
            throw toLLMRequestError(
              error,
              timeoutController,
              '本地模型生成失败。',
            );
          } finally {
            queueSignal.removeEventListener('abort', onAbort);
            timeoutController.dispose();
          }
        },
        {
          taskId: options.taskId,
          queueClass: 'local',
          queuePriority:
            getLLMTaskQueueDefaults(options.taskId)?.queuePriority ||
            options.queuePriority ||
            'normal',
          projectId,
          externalSignal,
          onQueueState: options.onQueueState,
        },
      );

      if (result.generationResult.cancelled) {
        const cancelError = new Error('已取消') as Error & { code?: string };
        cancelError.code = 'cancelled';
        await safeLogUsage({
          scenario,
          inputTokens: inputEstimate,
          outputTokens: 0,
          totalTokens: inputEstimate,
          status: 'error',
          errorCode: 'cancelled',
          modelName,
          projectId,
          llmConfigId,
          llmConfigName,
        });
        throw cancelError;
      }

      const outputTokens = result.generationResult.outputTokens;
      const totalTokens = inputEstimate + outputTokens;
      await safeLogUsage({
        scenario,
        inputTokens: inputEstimate,
        outputTokens,
        totalTokens,
        status: 'success',
        modelName,
        projectId,
        llmConfigId,
        llmConfigName,
      });

      return {
        text: stripReasoningBlocks(result.generationResult.text || ''),
        inputTokens: inputEstimate,
        outputTokens,
        totalTokens,
        metrics: result.metrics,
      };
    } catch (error: any) {
      // 模型未加载类错误：重置缓存标记，下次重新加载
      const msg = String(error?.message || '');
      if (msg.includes('模型未加载') || error?.code === 'ENGINE_NOT_READY') {
        currentLoadedModelId = null;
      }
      if (error?.code === 'cancelled') {
        throw error;
      }
      await safeLogUsage({
        scenario,
        inputTokens: inputEstimate,
        outputTokens: 0,
        totalTokens: inputEstimate,
        status: 'error',
        errorCode: String(error?.code || 'unknown'),
        modelName,
        projectId,
        llmConfigId,
        llmConfigName,
      });
      throw error;
    }
  },
};
