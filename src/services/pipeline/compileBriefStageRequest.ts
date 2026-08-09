import type { ChatMessage } from '../llm';
import { estimateTokens } from '../../utils/tokenEstimator';
import { deriveDefaultSafetyMargin } from './budgetAllocator';
import { resolveElasticStageOutputReservation } from '../contextAutoAllocator';
import {
  briefRequiredSourceIds,
  briefRequiredSourceIdsV31,
  briefWarningCount,
  type BriefCompilerInputV31,
  type BriefCompilerInputV1,
} from './briefCompilerTypes';
import {
  compileStageRequestWithElasticBudget,
  type ElasticStageModule,
} from './elasticStageCompiler';
import type { ContextAllocationTrace } from './compileStageRequest';
import type { ElasticBudgetTrace } from './elasticBudgetAllocator';

export interface BriefBudget {
  visibleOutputFloor: number;
  reasoningHeadroom: number;
  requestMaxTokens: number;
  estimatedInputTokens: number;
  safetyMargin: number;
  fits: boolean;
  blockingReason: string | null;
  softInputLimit?: number;
}

export interface CompiledBriefStageRequest {
  stage: 'brief';
  messages: ChatMessage[];
  input: BriefCompilerInputV1 | BriefCompilerInputV31;
  budget: BriefBudget;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  contextWindow: number;
  ready: boolean;
  error?: { code: string; message: string };
  allocations?: ContextAllocationTrace[];
  elasticBudgetTrace?: ElasticBudgetTrace;
}

type BriefCompilerInput = BriefCompilerInputV1 | BriefCompilerInputV31;

function isV31Input(input: BriefCompilerInput): input is BriefCompilerInputV31 {
  return input.schemaVersion === 2;
}

function requiredIds(input: BriefCompilerInput): string[] {
  return isV31Input(input)
    ? briefRequiredSourceIdsV31(input)
    : briefRequiredSourceIds(input);
}

function warningCount(input: BriefCompilerInput): number {
  if (!isV31Input(input)) return briefWarningCount(input);
  return [
    ...(input.review?.advisoryNotes || []),
    ...(input.review?.executableCorrections || []),
    ...(input.review?.unlocatedRequired || []),
    ...(input.factCheck?.corrections || []),
  ].filter(item =>
    typeof item === 'string' ? Boolean(item.trim()) : item.severity === 'warning',
  ).length;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function calculateBriefBudget(params: {
  input: BriefCompilerInput;
  contextWindow: number;
  modelMaxOutputTokens?: number;
  /** Frozen elastic output reservation; absent only for direct/legacy callers. */
  requestMaxTokens?: number;
  visibleOutputFloor?: number;
  reasoningHeadroom?: number;
}): BriefBudget {
  const maxOutput = Math.max(0, Number(params.modelMaxOutputTokens) || 0);
  const computedFloor = clamp(
    512 +
      requiredIds(params.input).length * 140 +
      warningCount(params.input) * 60,
    768,
    2048,
  );
  const visibleOutputFloor = clamp(
    Math.max(
      Number(params.visibleOutputFloor) > 0
        ? Number(params.visibleOutputFloor)
        : 0,
      computedFloor,
    ),
    768,
    2048,
  );
  const reasoningHeadroom = clamp(
    Number(params.reasoningHeadroom) > 0
      ? Number(params.reasoningHeadroom)
      : 1200,
    1024,
    2048,
  );
  // `max_tokens` is the elastic per-request provider reservation.  The
  // visible JSON floor and low reasoning headroom remain independent minimum
  // fit accounts, but they must not become a Brief-only 2K/4K cap.  New V3
  // snapshots freeze this reservation; direct callers derive it from the
  // same 20% model-window envelope.
  const requestMaxTokens =
    Number(params.requestMaxTokens) > 0
      ? Math.max(1, Math.floor(Number(params.requestMaxTokens)))
      : resolveElasticStageOutputReservation({
          contextWindow: params.contextWindow,
          modelMaxOutputTokens: params.modelMaxOutputTokens,
        });
  const minimumRequiredOutputTokens =
    visibleOutputFloor + reasoningHeadroom;
  const messages = buildBriefCompilerMessages(params.input);
  const estimatedInputTokens = estimateTokens(
    messages.map(message => message.content).join('\n'),
  );
  const safetyMargin = deriveDefaultSafetyMargin(params.contextWindow);
  const softInputLimit = Math.max(
    0,
    Math.floor(params.contextWindow * 0.8) - requestMaxTokens - safetyMargin,
  );
  const fits =
    params.contextWindow > 0 &&
    (maxOutput <= 0 || maxOutput >= minimumRequiredOutputTokens) &&
    estimatedInputTokens + requestMaxTokens + safetyMargin <=
      params.contextWindow;
  return {
    visibleOutputFloor,
    reasoningHeadroom,
    requestMaxTokens,
    estimatedInputTokens,
    safetyMargin,
    fits,
    blockingReason: fits
      ? null
      : maxOutput > 0 && maxOutput < minimumRequiredOutputTokens
      ? '模型 max_output_tokens 无法同时容纳 Brief 可见 JSON 保底与 low Thinking 余量'
      : 'Brief 输入、可见 JSON 保底、low Thinking 余量与安全边界无法同时适配模型窗口',
    softInputLimit,
  };
}

export function buildBriefCompilerMessages(
  input: BriefCompilerInput,
): ChatMessage[] {
  const allowedSourceIds = requiredIds(input);
  if (isV31Input(input)) {
    return [
      {
        role: 'system',
        content: [
          '你是小说流水线 V3.1 的 Brief Compiler，只把已归一化审核意见压缩为终稿语义要求。',
          '不得重新审阅初稿，不得新增事实、人物或剧情，不得输出小说正文或推理过程。',
          '本地不可变信封是最终权威；不得改写其中的 sourceHash、requiredSourceIds、protectedFacts、hardConstraints、mustNotAdvance、outlineObligations、endingBoundary。',
          '只输出 BriefWritingSemanticPayloadV31 JSON，不要 Markdown、解释或推理。',
          `语义输出应包含 schemaVersion=2、coveredRequiredIds、openingContinuity、mustFix、mustPreserve、endingState、styleAdvisories；sourceId 只能从白名单选择：${JSON.stringify(allowedSourceIds)}。`,
          'mustFix 每项必须包含 sourceIds（字符串数组）、target（kind 为 opening/scene/middle/ending/global）、instruction（非空字符串）、preserve（字符串数组）。',
          '如果没有 required/hard 修复，coveredRequiredIds 与 mustFix 必须为 []；没有对应语义时其余数组也输出 []，不要省略 schemaVersion。',
          'endingState 有结尾边界时请原样复述 endingBoundary；不要编造新的结尾。',
          `最小合法语义模板：${JSON.stringify({
            schemaVersion: 2,
            coveredRequiredIds: allowedSourceIds.length ? allowedSourceIds : [],
            openingContinuity: [],
            mustFix: [],
            mustPreserve: [],
            endingState: '原样复述本地 endingBoundary',
            styleAdvisories: [],
          })}`,
          `本地不可变信封：${JSON.stringify(input.immutableEnvelope)}`,
          '即使 Thinking 开启，JSON 也必须写入 message.content，不能只返回 reasoning_content。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `【已归一化审核输入】\n${JSON.stringify({
          review: input.review,
          factCheck: input.factCheck,
          immutableEnvelope: input.immutableEnvelope,
        })}`,
      },
    ];
  }
  return [
    {
      role: 'system',
      content: [
        '你是小说流水线的 Brief Compiler，只负责压缩已归一化的审核意见。',
        '不得重新审阅初稿，不得新增事实、人物或剧情，不得输出小说正文或推理过程。',
        '保留所有 hard/required，保留大纲的不得提前推进与结尾目标，把 warning 放入 advisoryNotes。',
        '只输出符合 FinalWritingBriefV1 的 JSON 对象，不要输出 Markdown、解释或推理。',
        `必须保留机器字段：schemaVersion 必须为 1，sourceHash 必须原样等于 ${input.sourceHash}；coveredRequiredIds、mustFix、mustPreserve、mustNotAdvance、openingContinuity、endingState、advisoryNotes 也必须按下列合同输出。`,
        `sourceId 白名单（只能逐字选择，禁止创造、改写或从报告正文猜测）：${JSON.stringify(allowedSourceIds)}；coveredRequiredIds 与 mustFix[].sourceIds 都只能使用此白名单。没有对应修复时 mustFix 输出空数组，不要填入角色名、章节名或自造 id。`,
        'mustFix 每一项必须完整包含 sourceIds（字符串数组）、location（字符串）、instruction（非空字符串）、preserve（字符串数组）四个字段；禁止用 rewriteGoal、diagnosis 或其他字段替代 instruction，无法形成完整项时直接输出 mustFix: []。',
        `mustFix 项模板：${JSON.stringify({
          sourceIds: allowedSourceIds.length ? [allowedSourceIds[0]] : [],
          location: 'opening',
          instruction: '明确写出需要在本章执行的修复动作。',
          preserve: ['需要保持的既有事实。'],
        })}`,
        `JSON 合同模板：${JSON.stringify({
          schemaVersion: 1,
          sourceHash: input.sourceHash,
          coveredRequiredIds: [],
          mustFix: [],
          mustPreserve: [],
          mustNotAdvance: [],
          openingContinuity: [],
          endingState: '',
          advisoryNotes: [],
        })}`,
        '即使 Thinking 开启，最终 JSON 也必须写入 message.content，不能只返回 reasoning_content。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `【已归一化审核输入】\n${JSON.stringify(input)}`,
    },
  ];
}

function parseRecord(value: string | undefined): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

function arrayValue(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

/** Keep all executable constraints mandatory while allowing advisory material
 * to participate in the same elastic allocator as every other stage. */
function buildBriefBudgetModules(input: BriefCompilerInput): {
  mandatory: ElasticStageModule[];
  optional: ElasticStageModule[];
} {
  const core = {
    review: input.review
      ? {
          executableCorrections: input.review.executableCorrections,
          unlocatedRequired: input.review.unlocatedRequired,
          outlineExecution: input.review.outlineExecution,
        }
      : undefined,
    factCheck: input.factCheck
      ? {
          corrections: input.factCheck.corrections,
          protectedFacts: input.factCheck.protectedFacts,
          hardConstraints: input.factCheck.hardConstraints,
        }
      : undefined,
  };
  const advisory = {
    reviewAdvisory: input.review?.advisoryNotes || [],
  };
  return {
    mandatory: [
      {
        id: 'brief_core',
        text: JSON.stringify(core),
        requirement: 'mandatory',
        priority: 10,
        relevance: 1,
        reclaimable: false,
        shrinkPriority: 10,
      },
    ],
    optional: [
      {
        id: 'brief_advisory',
        text: JSON.stringify(advisory),
        requirement: 'optional',
        priority: 2,
        relevance: 0.5,
        maxTokens: estimateTokens(JSON.stringify(advisory)),
        shrinkPriority: 1,
        burstPriority: 0,
      },
    ],
  };
}

function buildBriefInputFromBudgetModules(
  input: BriefCompilerInput,
  clipped: ReadonlyMap<string, string>,
): BriefCompilerInput {
  const core = parseRecord(clipped.get('brief_core'));
  const advisory = parseRecord(clipped.get('brief_advisory'));
  return {
    ...input,
    review: input.review
      ? {
          ...input.review,
          executableCorrections: arrayValue(core.review?.executableCorrections),
          unlocatedRequired: arrayValue(core.review?.unlocatedRequired),
          outlineExecution:
            core.review?.outlineExecution || input.review.outlineExecution,
          advisoryNotes: arrayValue(advisory.reviewAdvisory).filter(
            (value): value is string => typeof value === 'string',
          ),
        }
      : undefined,
    factCheck: input.factCheck
      ? {
          ...input.factCheck,
          corrections: arrayValue(core.factCheck?.corrections),
          protectedFacts: arrayValue(core.factCheck?.protectedFacts).filter(
            (value): value is string => typeof value === 'string',
          ),
          hardConstraints: arrayValue(core.factCheck?.hardConstraints).filter(
            (value): value is string => typeof value === 'string',
          ),
        }
      : undefined,
  };
}

export function compileBriefStageRequest(params: {
  input: BriefCompilerInput;
  contextWindow: number;
  modelMaxOutputTokens?: number;
  requestMaxTokens?: number;
  visibleOutputFloor?: number;
  reasoningHeadroom?: number;
}): CompiledBriefStageRequest {
  const budget = calculateBriefBudget(params);
  const modules = buildBriefBudgetModules(params.input);
  const modelCap = Math.max(0, Number(params.modelMaxOutputTokens) || 0);
  const compiled = compileStageRequestWithElasticBudget({
    stage: 'brief',
    contextWindow: params.contextWindow,
    reservedOutputTokens: budget.requestMaxTokens,
    safetyMargin: budget.safetyMargin,
    mandatoryModules: modules.mandatory,
    elasticModules: modules.optional,
    buildMessages: clipped =>
      buildBriefCompilerMessages(
        buildBriefInputFromBudgetModules(params.input, clipped),
      ),
  });
  const minimumRequiredOutputTokens =
    budget.visibleOutputFloor + budget.reasoningHeadroom;
  const modelCapTooSmall =
    modelCap > 0 && modelCap < minimumRequiredOutputTokens;
  const ready = compiled.ready && !modelCapTooSmall;
  const blockingReason = modelCapTooSmall
    ? '模型 max_output_tokens 无法同时容纳 Brief 可见 JSON 保底与 low Thinking 余量'
    : compiled.ready
    ? null
    : compiled.error.message;
  const compiledEstimatedInputTokens = compiled.ready
    ? compiled.estimatedInputTokens
    : compiled.estimatedInputTokens || 0;
  const compiledSafetyMargin = compiled.ready
    ? compiled.safetyMargin
    : compiled.diagnostics.safetyMargin;
  const nextBudget: BriefBudget = {
    ...budget,
    estimatedInputTokens: compiledEstimatedInputTokens,
    safetyMargin: compiledSafetyMargin,
    fits: ready,
    blockingReason,
    softInputLimit: compiled.elasticBudgetTrace?.softInputLimit,
  };
  return {
    stage: 'brief',
    messages: compiled.messages || [],
    input: params.input,
    budget: nextBudget,
    estimatedInputTokens: compiledEstimatedInputTokens,
    reservedOutputTokens: budget.requestMaxTokens,
    contextWindow: params.contextWindow,
    ready,
    allocations: compiled.allocations,
    elasticBudgetTrace: compiled.elasticBudgetTrace,
    ...(!ready
      ? {
          error: {
            code: 'CONTEXT_WINDOW_EXCEEDED',
            message: blockingReason || 'Brief 上下文窗口不足',
          },
        }
      : {}),
  };
}
