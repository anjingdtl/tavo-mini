import type { ChatMessage } from '../llm';
import { estimateTokens } from '../../utils/tokenEstimator';
import { deriveDefaultSafetyMargin } from './budgetAllocator';
import { resolveElasticStageOutputReservation } from '../contextAutoAllocator';
import {
  briefRequiredSourceIds,
  briefRequiredSourceIdsV31,
  briefRequiredSourceIdsV32,
  briefRequiredSourceIdsV33,
  type BriefCompilerInputV33,
  briefWarningCount,
  type BriefCompilerInputV32,
  type BriefCompilerInputV31,
  type BriefCompilerInputV1,
} from './briefCompilerTypes';
import {
  compileStageRequestWithElasticBudget,
  type ElasticStageModule,
} from './elasticStageCompiler';
import type { ContextAllocationTrace } from './compileStageRequest';
import type { ElasticBudgetTrace } from './elasticBudgetAllocator';
import type { FrozenWriterStyleProjection } from '../writerStyle/types';

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

export interface BriefWriterStyleTrace {
  id: 'writerStyle';
  mode: FrozenWriterStyleProjection['mode'];
  protected: true;
  allocated: 'full';
  clipped: false;
  requested: number;
  allocatedTokens: number;
}

export interface CompiledBriefStageRequest {
  stage: 'brief';
  messages: ChatMessage[];
  input:
    | BriefCompilerInputV1
    | BriefCompilerInputV31
    | BriefCompilerInputV32
    | BriefCompilerInputV33;
  budget: BriefBudget;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  contextWindow: number;
  ready: boolean;
  error?: { code: string; message: string };
  allocations?: ContextAllocationTrace[];
  elasticBudgetTrace?: ElasticBudgetTrace;
  writerStyleTrace?: BriefWriterStyleTrace;
}

type BriefCompilerInput =
  | BriefCompilerInputV1
  | BriefCompilerInputV31
  | BriefCompilerInputV32
  | BriefCompilerInputV33;

function isV31Input(input: BriefCompilerInput): input is BriefCompilerInputV31 {
  return input.schemaVersion === 2;
}

function isV32Input(input: BriefCompilerInput): input is BriefCompilerInputV32 {
  return input.schemaVersion === 3;
}

function isV33Input(input: BriefCompilerInput): input is BriefCompilerInputV33 {
  return input.schemaVersion === 4;
}

function requiredIds(input: BriefCompilerInput): string[] {
  return isV31Input(input)
    ? briefRequiredSourceIdsV31(input)
    : isV33Input(input)
    ? briefRequiredSourceIdsV33(input)
    : isV32Input(input)
    ? briefRequiredSourceIdsV32(input)
    : briefRequiredSourceIds(input);
}

function warningCount(input: BriefCompilerInput): number {
  if (!isV31Input(input) && !isV32Input(input) && !isV33Input(input)) {
    return briefWarningCount(input);
  }
  return [
    ...(input.review?.advisoryNotes || []),
    ...(input.review?.executableCorrections || []),
    ...(input.review?.unlocatedRequired || []),
    ...(input.factCheck?.corrections || []),
  ].filter(item =>
    typeof item === 'string'
      ? Boolean(item.trim())
      : item.severity === 'warning',
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
  writerStyle?: FrozenWriterStyleProjection;
}): BriefBudget {
  const maxOutput = Math.max(0, Number(params.modelMaxOutputTokens) || 0);
  const v32 = isV32Input(params.input);
  const v33 = isV33Input(params.input);
  const complexityFloor =
    512 +
    requiredIds(params.input).length * 140 +
    warningCount(params.input) * 60;
  const computedFloor = v32 || v33
    ? Math.max(768, complexityFloor)
    : clamp(complexityFloor, 768, 2048);
  const requestedVisibleFloor =
    Number(params.visibleOutputFloor) > 0
      ? Number(params.visibleOutputFloor)
      : 0;
  const visibleOutputFloor = v32 || v33
    ? Math.max(768, requestedVisibleFloor, computedFloor)
    : clamp(Math.max(requestedVisibleFloor, computedFloor), 768, 2048);
  const requestedReasoningHeadroom =
    Number(params.reasoningHeadroom) > 0
      ? Number(params.reasoningHeadroom)
      : 1200;
  const reasoningHeadroom = v32 || v33
    ? Math.max(1024, requestedReasoningHeadroom)
    : clamp(requestedReasoningHeadroom, 1024, 2048);
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
  const minimumRequiredOutputTokens = visibleOutputFloor + reasoningHeadroom;
  const messages = buildBriefCompilerMessages(params.input, params.writerStyle);
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

function withFrozenBriefWriterStyle(
  messages: ChatMessage[],
  writerStyle?: FrozenWriterStyleProjection,
): ChatMessage[] {
  const text = String(writerStyle?.text || '');
  if (!writerStyle || !text) return messages;
  return [{ role: 'system', content: text }, ...messages];
}

export function buildBriefCompilerMessages(
  input: BriefCompilerInput,
  writerStyle?: FrozenWriterStyleProjection,
): ChatMessage[] {
  const allowedSourceIds = requiredIds(input);
  if (isV33Input(input)) {
    const envelope = input.immutableEnvelope;
    return withFrozenBriefWriterStyle(
      [
        {
          role: 'system',
          content: [
            '你是 ShineWriter 当前统一流水线的 Brief Compiler。Brief 思考强度跟随用户档位；只把已归一化的 Review/FactCheck 语义压缩为 Final 可执行要求。',
            '不得重新审阅 Draft，不得新增事实、人物或剧情，不得输出正文、Markdown 或推理过程。',
            '只输出 strategy、actions、preserve、ending 四类语义字段；不要输出 schema、hash、sourceId 白名单或本地不可变信封。',
            'actions 每项必须包含 covers（只能逐字使用短 ID）、instruction；可选 preserve。required/hard 短 ID 必须至少被一条 action 覆盖；同一 ID 不得被相互矛盾的 action 覆盖。',
            `允许的短 ID：${JSON.stringify(envelope.allowedSourceIds)}`,
            `required/hard 短 ID：${JSON.stringify(envelope.requiredSourceIds)}`,
            'ending 只能复述已给出的结尾边界；preserve 只能保留输入中已有的事实或约束。',
            JSON.stringify({
              strategy: '保持前章状态自然衔接，只执行已确认的必要修订。',
              actions: [],
              preserve: [],
              ending: envelope.endingBoundary,
            }),
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            review: input.review,
            factCheck: input.factCheck,
          }),
        },
      ],
      writerStyle,
    );
  }
  if (isV32Input(input)) {
    return withFrozenBriefWriterStyle([
      {
        role: 'system',
        content: [
          '你是 ShineWriter V3.2 Brief Compiler。此独立 API 调用启用 low Thinking，只把已验证的 Review/FactCheck 语义压缩为 Final 可执行要求。',
          '不得重新审阅 Draft，不得新增事实、人物或剧情，不得输出正文或推理过程。',
          '只输出 BriefSemanticPayloadV32 JSON：verdict 为 apply_changes 或 no_changes，必须包含 instructions、openingContinuity、styleAdvisories。',
          'sourceIds 只能逐字引用白名单；hard/required sourceId 必须被 instruction 覆盖。没有必改项时 verdict 可以是 no_changes，但 openingContinuity 仍需给出至少一条保持策略，不能输出空数组。',
          'no_changes 时必须写出“从上一章结尾状态自然衔接，并保持已确认的人物、时间、地点和物品状态”等具体保持策略；不得用空 instructions、空 openingContinuity、空 styleAdvisories 伪装成完整 Brief。',
          '本地 immutableEnvelope 是权威，不要输出或改写其中的 sourceHash、requiredSourceIds、protectedFacts、hardConstraints、mustNotAdvance、outlineObligations、endingBoundary。',
          'instruction 必须包含 sourceIds、priority、target、instruction；target 只能是 opening/scene/middle/ending/global。',
          '每个 hard/required sourceId 只能出现在一条逻辑 instruction 中；如果 Review 与 FactCheck 对同一 sourceId 都有发现，必须合并为一条不相互矛盾的 instruction，不得为同一 sourceId 输出两条不同的 hard/required 指令。',
          '同一条 instruction 可以覆盖多个 sourceId，但只有它们确实共享同一个修复动作时才这样做；不得为了覆盖清单编造或拆分相互冲突的要求。',
          JSON.stringify({
            verdict: allowedSourceIds.length ? 'apply_changes' : 'no_changes',
            instructions: [],
            openingContinuity: [
              '从上一章结尾状态自然衔接，保持已确认的人物、时间、地点和物品状态。',
            ],
            styleAdvisories: [],
          }),
          'sourceId 白名单：' + JSON.stringify(allowedSourceIds),
          '本地不可变信封：' + JSON.stringify(input.immutableEnvelope),
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          review: input.review,
          factCheck: input.factCheck,
        }),
      },
    ], writerStyle);
  }
  if (isV31Input(input)) {
    return withFrozenBriefWriterStyle([
      {
        role: 'system',
        content: [
          '你是小说流水线 V3.1 的 Brief Compiler，只把已归一化审核意见压缩为终稿语义要求。',
          '不得重新审阅初稿，不得新增事实、人物或剧情，不得输出小说正文或推理过程。',
          '本地不可变信封是最终权威；不得改写其中的 sourceHash、requiredSourceIds、protectedFacts、hardConstraints、mustNotAdvance、outlineObligations、endingBoundary。',
          '只输出 BriefWritingSemanticPayloadV31 JSON，不要 Markdown、解释或推理。',
          `语义输出应包含 schemaVersion=2、coveredRequiredIds、openingContinuity、mustFix、mustPreserve、endingState、styleAdvisories；sourceId 只能从白名单选择：${JSON.stringify(
            allowedSourceIds,
          )}。`,
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
    ], writerStyle);
  }
  return withFrozenBriefWriterStyle([
    {
      role: 'system',
      content: [
        '你是小说流水线的 Brief Compiler，只负责压缩已归一化的审核意见。',
        '不得重新审阅初稿，不得新增事实、人物或剧情，不得输出小说正文或推理过程。',
        '保留所有 hard/required，保留大纲的不得提前推进与结尾目标，把 warning 放入 advisoryNotes。',
        '只输出符合 FinalWritingBriefV1 的 JSON 对象，不要输出 Markdown、解释或推理。',
        `必须保留机器字段：schemaVersion 必须为 1，sourceHash 必须原样等于 ${input.sourceHash}；coveredRequiredIds、mustFix、mustPreserve、mustNotAdvance、openingContinuity、endingState、advisoryNotes 也必须按下列合同输出。`,
        `sourceId 白名单（只能逐字选择，禁止创造、改写或从报告正文猜测）：${JSON.stringify(
          allowedSourceIds,
        )}；coveredRequiredIds 与 mustFix[].sourceIds 都只能使用此白名单。没有对应修复时 mustFix 输出空数组，不要填入角色名、章节名或自造 id。`,
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
  ], writerStyle);
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
function buildBriefBudgetModules(
  input: BriefCompilerInput,
  writerStyle?: FrozenWriterStyleProjection,
): {
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
      ...(writerStyle
        ? [
            {
              id: 'writerStyle',
              text: writerStyle.text,
              requirement: 'mandatory' as const,
              priority: 10,
              relevance: 1,
              reclaimable: false,
              shrinkPriority: 10,
            },
          ]
        : []),
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

function enrichBriefWriterStyleTrace(
  writerStyle: FrozenWriterStyleProjection | undefined,
  compiled: {
    allocations?: ContextAllocationTrace[];
    elasticBudgetTrace?: ElasticBudgetTrace;
  },
): {
  allocations?: ContextAllocationTrace[];
  elasticBudgetTrace?: ElasticBudgetTrace;
  writerStyleTrace?: BriefWriterStyleTrace;
} {
  if (!writerStyle) {
    return {
      allocations: compiled.allocations,
      elasticBudgetTrace: compiled.elasticBudgetTrace,
    };
  }
  const module = compiled.elasticBudgetTrace?.modules.find(
    item => item.id === 'writerStyle',
  );
  const requested = module?.availableTokens ?? writerStyle.estimatedTokens;
  const allocatedTokens = module?.finalAllocatedTokens ?? requested;
  const writerStyleTrace: BriefWriterStyleTrace = {
    id: 'writerStyle',
    mode: writerStyle.mode,
    protected: true,
    allocated: 'full',
    clipped: false,
    requested,
    allocatedTokens,
  };
  return {
    writerStyleTrace,
    allocations: (compiled.allocations || []).map(item =>
      item.id === 'writerStyle'
        ? {
            ...item,
            mode: writerStyle.mode,
            protected: true,
            clipped: false,
          }
        : item,
    ),
    elasticBudgetTrace: compiled.elasticBudgetTrace
      ? {
          ...compiled.elasticBudgetTrace,
          modules: compiled.elasticBudgetTrace.modules.map(item =>
            item.id === 'writerStyle'
              ? {
                  ...item,
                  mode: writerStyle.mode,
                  protected: true,
                  allocated: 'full' as const,
                  clipped: false,
                }
              : item,
          ),
        }
      : compiled.elasticBudgetTrace,
  };
}

export function compileBriefStageRequest(params: {
  input: BriefCompilerInput;
  contextWindow: number;
  modelMaxOutputTokens?: number;
  requestMaxTokens?: number;
  visibleOutputFloor?: number;
  reasoningHeadroom?: number;
  writerStyle?: FrozenWriterStyleProjection;
}): CompiledBriefStageRequest {
  const budget = calculateBriefBudget(params);
  const modules = buildBriefBudgetModules(params.input, params.writerStyle);
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
        params.writerStyle
          ? {
              ...params.writerStyle,
              text: clipped.get('writerStyle') || params.writerStyle.text,
            }
          : undefined,
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
  const writerStyleFields = enrichBriefWriterStyleTrace(
    params.writerStyle,
    compiled,
  );
  return {
    stage: 'brief',
    messages: compiled.messages || [],
    input: params.input,
    budget: nextBudget,
    estimatedInputTokens: compiledEstimatedInputTokens,
    reservedOutputTokens: budget.requestMaxTokens,
    contextWindow: params.contextWindow,
    ready,
    allocations: writerStyleFields.allocations,
    elasticBudgetTrace: writerStyleFields.elasticBudgetTrace,
    ...(writerStyleFields.writerStyleTrace
      ? { writerStyleTrace: writerStyleFields.writerStyleTrace }
      : {}),
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
