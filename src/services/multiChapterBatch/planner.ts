/**
 * Multi-chapter batch planner (Phase 5).
 *
 * User confirmation happens BEFORE any chapter / pipeline task creation —
 * this module only produces an editable plan + frozen planner hash.
 * Strict local validation; exactly ONE structure-fix request allowed,
 * reusing the frozen raw output (never re-reads project materials).
 */
import type { ChatMessage } from '../llm';
import { callLLMResult, resolveLLMRequestConfig } from '../llm';
import { requireReadyStageRequest } from '../pipeline/compileStageRequest';
import {
  compileBatchPlannerRequest,
  type BatchPlannerMaterials,
} from './plannerCompiler';
import {
  BATCH_MAX_CHAPTERS,
  BATCH_MIN_CHAPTERS,
  type BatchChapterPlan,
  type BatchChapterPlanItem,
} from '../../types/multiChapterBatch';
import { sha256Hex } from '../continuation/hashUtils';
import * as db from '../database';
import { getEnabledOutlinesByProject } from '../../data/repositories/outlineRepository';

export type PlannerValidationResult =
  | { ok: true; plan: BatchChapterPlan }
  | { ok: false; errors: string[] };

/** Strict local validation (doc §7.3). */
export function validateBatchChapterPlan(
  value: unknown,
  expectedCount: number,
): PlannerValidationResult {
  const errors: string[] = [];
  const chapters = (value as { chapters?: unknown })?.chapters;
  if (!Array.isArray(chapters)) {
    return { ok: false, errors: ['输出缺少 chapters 数组'] };
  }
  if (chapters.length !== expectedCount) {
    errors.push(
      `chapters 数量为 ${chapters.length}，必须严格等于 ${expectedCount}`,
    );
  }
  const ordinals = new Set<number>();
  for (let i = 0; i < chapters.length; i += 1) {
    const raw = chapters[i] as Record<string, unknown> | null;
    const label = `chapters[${i}]`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${label} 不是对象`);
      continue;
    }
    const ordinal = Number(raw.ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      errors.push(`${label}.ordinal 非法: ${String(raw.ordinal)}`);
    } else {
      if (ordinals.has(ordinal)) {
        errors.push(`${label}.ordinal 重复: ${ordinal}`);
      }
      ordinals.add(ordinal);
    }
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      errors.push(`${label}.title 为空`);
    }
    if (typeof raw.synopsis !== 'string' || !raw.synopsis.trim()) {
      errors.push(`${label}.synopsis 为空`);
    }
    if (
      !Array.isArray(raw.keyBeats) ||
      raw.keyBeats.length === 0 ||
      raw.keyBeats.some(k => typeof k !== 'string' || !String(k).trim())
    ) {
      errors.push(`${label}.keyBeats 必须是非空字符串数组`);
    }
    const targetWords = Number(raw.targetWords);
    if (
      !Number.isInteger(targetWords) ||
      targetWords < 500 ||
      targetWords > 20000
    ) {
      errors.push(`${label}.targetWords 非法: ${String(raw.targetWords)}`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const plan: BatchChapterPlan = {
    chapters: chapters.map((raw, index) => {
      const item = raw as Record<string, unknown>;
      return {
        ordinal: Number(item.ordinal) || index + 1,
        title: String(item.title).trim(),
        synopsis: String(item.synopsis).trim(),
        keyBeats: (item.keyBeats as string[]).map(k => String(k).trim()),
        carryIn: item.carryIn ? String(item.carryIn).trim() : '',
        carryOut: item.carryOut ? String(item.carryOut).trim() : '',
        targetWords: Number(item.targetWords),
      };
    }),
  };
  return { ok: true, plan };
}

export function parseBatchChapterPlan(
  rawText: string,
  expectedCount: number,
): PlannerValidationResult {
  const json = extractPlanJson(rawText);
  if (json != null) {
    // 模型给出了 JSON 结构：内容不合法时直接失败（走一次结构修复请求），
    // 不落入宽松解析——宽松解析只用于模型完全没有输出 JSON 的场景。
    return validateBatchChapterPlan(json, expectedCount);
  }
  // 形似 JSON 但解析失败（典型：被 max_tokens 截断、悬空逗号之外的语法
  // 缺陷）同样必须失败闭合。否则宽松回退会把整段残缺 JSON 原文当成
  // 第 1 章摘要塞进可编辑计划并冻结 hash，污染后续章节生成注入。
  if (looksLikeJsonPlan(rawText)) {
    return {
      ok: false,
      errors: ['模型输出形似 JSON 但无法解析（可能被输出长度截断或存在语法错误）'],
    };
  }
  // 宽松回退：输出不是严格 JSON 时按章节摘要解析。
  return parseBatchPlanFallback(rawText, expectedCount);
}

/** 去掉代码块围栏后以 { / [ 开头 —— 模型明确打算输出 JSON 的信号。 */
function looksLikeJsonPlan(rawText: string): boolean {
  let text = String(rawText || '').trim();
  if (!text) return false;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  return text.startsWith('{') || text.startsWith('[');
}

/**
 * 宽容 JSON 提取：支持 ```json 代码块包裹、前后解释文字、首尾大括号截取。
 * 提取不到返回 null（调用方走宽松摘要解析）。
 */
export function extractPlanJson(rawText: string): unknown | null {
  let text = String(rawText || '').trim();
  if (!text) return null;
  // 去掉 ```json / ``` 代码块包裹。
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // 截取首尾大括号之间的部分（容忍前后解释文字）。
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    text = text.substring(start, end + 1);
  }
  try {
    return JSON.parse(text);
  } catch {
    // 悬空逗号是模型 JSON 输出的高频缺陷。仅在严格解析已失败时才尝试
    // 去掉 `,}` / `,]` 再解析一次：正常路径零影响；字符串内容里恰好含
    // 该序列的极端场景最多让这次兜底也失败，仍返回 null 走失败分支。
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/**
 * 宽松摘要解析：模型直接输出 N 章摘要文本（每章以“第 N 章 / 第一章 / 1.”等
 * 开头）时，按章节切分并构造可编辑计划。
 */
export function parseBatchPlanFallback(
  rawText: string,
  expectedCount: number,
  defaultTargetWords = 3000,
): PlannerValidationResult {
  const text = String(rawText || '').trim();
  const lines = text.split(/\r?\n/);
  const chapters: BatchChapterPlanItem[] = [];

  // 先判断是否存在明确的章节分隔标记（“第 N 章 / 第一章 / 1.”）。
  const hasChapterMarkers = lines.some(line =>
    /^(第\s*[0-9一二三四五六七八九十]+\s*章|[0-9]+[.、)])/.test(line.trim()),
  );

  if (!hasChapterMarkers) {
    // 段落模式：按空行分段；单段且过短视为无法识别（例如模型只回了
    // 一句解释，而非章节摘要）。
    const blocks = text
      .split(/\n\s*\n/)
      .map(b => b.trim())
      .filter(Boolean);
    if (blocks.length === 0 || (blocks.length === 1 && blocks[0].length < 8)) {
      return { ok: false, errors: ['无法识别任何章节摘要'] };
    }
    for (let i = 0; i < Math.min(expectedCount, blocks.length); i += 1) {
      const block = blocks[i];
      chapters.push({
        ordinal: i + 1,
        title: `第 ${i + 1} 章`,
        synopsis: block,
        keyBeats: [block.split(/[。！？!?\n]/)[0].trim() || '推进本章目标'],
        carryIn: '',
        carryOut: '',
        targetWords: defaultTargetWords,
      });
    }
  } else {
    let current: string[] = [];
    const flush = () => {
      if (current.length === 0) return;
      const first = current[0];
      const titleMatch = first.match(
        /^(?:第\s*[0-9一二三四五六七八九十]+\s*章|[0-9]+[.、)])?\s*(.{0,20})/,
      );
      const title =
        titleMatch && titleMatch[1] && titleMatch[1].trim()
          ? titleMatch[1].trim()
          : `第 ${chapters.length + 1} 章`;
      // 摘要跳过标题行（避免“第 N 章 标题”重复进摘要）。
      const bodyLines = current.slice(1).map(l => l.trim()).filter(Boolean);
      const synopsis =
        bodyLines.join('\n').trim() ||
        (titleMatch && titleMatch[1] && titleMatch[1].trim()
          ? titleMatch[1].trim()
          : `第 ${chapters.length + 1} 章摘要`);
      chapters.push({
        ordinal: chapters.length + 1,
        title,
        synopsis,
        keyBeats: [synopsis.split(/[。！？!?\n]/)[0].trim() || '推进本章目标'],
        carryIn: '',
        carryOut: '',
        targetWords: defaultTargetWords,
      });
      current = [];
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^(第\s*[0-9一二三四五六七八九十]+\s*章|[0-9]+[.、)])/.test(trimmed)) {
        flush();
        current.push(trimmed);
      } else {
        current.push(trimmed);
      }
    }
    flush();
  }

  if (chapters.length === 0) {
    return { ok: false, errors: ['无法识别任何章节摘要'] };
  }
  // 数量不足时补齐占位章节（用户可在预览页编辑）。
  while (chapters.length < expectedCount) {
    chapters.push({
      ordinal: chapters.length + 1,
      title: `第 ${chapters.length + 1} 章`,
      synopsis: '待补充本章摘要',
      keyBeats: ['推进本章目标'],
      carryIn: '',
      carryOut: '',
      targetWords: defaultTargetWords,
    });
  }
  const plan: BatchChapterPlan = {
    chapters: chapters.slice(0, expectedCount),
  };
  return { ok: true, plan };
}

export function computePlannerHash(plan: BatchChapterPlan): string {
  return sha256Hex(JSON.stringify(plan)).slice(0, 32);
}

/** Normalize an edited plan (user edits before confirmation). */
export function normalizeEditedPlan(
  items: BatchChapterPlanItem[],
  expectedCount: number,
): PlannerValidationResult {
  return validateBatchChapterPlan({ chapters: items }, expectedCount);
}

const FIX_INSTRUCTION = (
  errors: string[],
  previousOutput: string,
  lengthTruncated = false,
) => `
上一次输出的 JSON 结构不合法，错误如下：
${errors.map(e => `- ${e}`).join('\n')}
${
  lengthTruncated
    ? '上一次输出疑似被输出长度上限截断：请大幅精简每章 synopsis 与 keyBeats，控制总长度，确保完整 JSON 能在限额内输出。\n'
    : ''
}你上一次的原始输出如下（供修复时参考，可能不完整）：
<previous_output>
${previousOutput}
</previous_output>
请基于该输出，仅修复 JSON 结构，重新输出完整 JSON（不要解释）。`;

/**
 * Planner wire max_tokens. The elastic compiler only sizes the INPUT side;
 * the output side is the fixed `reservedOutputTokens` reservation (default
 * 4000) — one constant doubling as the context-window reservation AND the
 * wire cap. Reasoning models count chain-of-thought inside completion
 * tokens, so a 4000 cap can starve the visible JSON and truncate it
 * mid-stream (finish_reason=length). When the user configured an explicit
 * max_output_tokens, honor it as the wire cap up to what the compiled
 * window math allows (input + output ≤ window − safety margin), with the
 * reservation as the floor. Unset configs keep the legacy reservation cap.
 */
export function resolvePlannerWireMaxTokens(input: {
  reservedOutputTokens: number;
  maxOutputTokens?: number | null;
  contextWindow?: number | null;
  estimatedInputTokens?: number | null;
  safetyMargin?: number | null;
}): number {
  const reserved = Math.max(0, Number(input.reservedOutputTokens) || 0);
  const configuredMax = Number(input.maxOutputTokens) || 0;
  const contextWindow = Number(input.contextWindow) || 0;
  if (!(configuredMax > 0) || !(contextWindow > 0)) {
    return reserved;
  }
  const margin = Math.max(0, Number(input.safetyMargin) || 0);
  const estimatedInput = Math.max(0, Number(input.estimatedInputTokens) || 0);
  const ceiling = Math.max(0, contextWindow - estimatedInput - margin);
  return Math.max(reserved, Math.min(configuredMax, ceiling));
};

export interface CreateBatchChapterPlanResult {
  plan: BatchChapterPlan;
  hash: string;
  requestJson: string;
  requestFingerprint: string;
  messages: ChatMessage[];
  estimatedInputTokens: number;
  usedRepair: boolean;
}

export interface CreateBatchChapterPlanInput {
  projectId: number;
  sourcePrompt: string;
  chapterCount: number;
  targetWordsPerChapter: number;
  pipelineMode: string;
  optionalInstruction?: string;
  materials: BatchPlannerMaterials;
  reservedOutputTokens?: number;
  externalSignal?: AbortSignal;
}

export class BatchPlannerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BatchPlannerError';
    this.code = code;
  }
}

/** Load planner materials from the DB (best-effort per source). */
export async function collectPlannerMaterials(
  projectId: number,
): Promise<BatchPlannerMaterials> {
  const outlineRows = await getEnabledOutlinesByProject(projectId);
  const outlineText = (outlineRows || [])
    .map((o: any) => `${o.title || ''}\n${o.content || ''}`)
    .join('\n\n')
    .slice(0, 12000);

  const chapters = await db.getChaptersByProject(projectId);
  const recentChaptersText = chapters
    .filter((c: any) => c.position >= Math.max(0, chapters.length - 3))
    .map((c: any) => `【第 ${c.position + 1} 章｜${c.title}】\n${(c.synopsis || '').slice(0, 300)}`)
    .join('\n\n');

  let charactersText = '';
  let worldbookText = '';
  let storyMemoryText = '';
  try {
    const characters = await db.getCharactersByProject(projectId);
    charactersText = (characters || [])
      .slice(0, 8)
      .map((c: any) => {
        const data = (() => {
          try {
            return JSON.parse(c.data_json || '{}');
          } catch {
            return {};
          }
        })();
        const desc =
          data.description || data.background || data.personality || '';
        return `${c.name}：${String(desc).slice(0, 150)}`;
      })
      .join('\n');
  } catch {
    // non-fatal
  }
  try {
    const worldbook = await db.getWorldbookEntriesByProject(projectId);
    worldbookText = (worldbook || [])
      .filter((w: any) => w.enabled !== false && w.constant)
      .slice(0, 8)
      .map((w: any) => `${w.keyword_primary}：${String(w.content).slice(0, 150)}`)
      .join('\n');
  } catch {
    // non-fatal
  }
  try {
    const memory = await db.getProjectStoryMemory(projectId);
    const state = memory?.state as
      | {
          mainline?: { summary?: string; goal?: string };
          characters?: Record<string, { name?: string; summary?: string }>;
          metadata?: Record<string, unknown>;
        }
      | undefined;
    if (state) {
      const parts: string[] = [];
      if (state.mainline?.summary) parts.push(`主线：${state.mainline.summary}`);
      if (state.mainline?.goal) parts.push(`目标：${state.mainline.goal}`);
      if (state.characters) {
        const chars = Object.values(state.characters)
          .slice(0, 8)
          .map(c => `${c.name || ''}：${(c.summary || '').slice(0, 150)}`)
          .filter(Boolean);
        if (chars.length) parts.push(`角色状态：${chars.join('；')}`);
      }
      storyMemoryText = parts.join('\n').slice(0, 4000);
    }
  } catch {
    // non-fatal
  }
  return { outlineText, recentChaptersText, charactersText, worldbookText, storyMemoryText };
}

/**
 * Run the planner: compile → LLM → strict validation → (once) structure fix.
 * Blocked compile throws BEFORE any model call (mandatory summary overflow).
 */
export async function createBatchChapterPlan(
  input: CreateBatchChapterPlanInput,
): Promise<CreateBatchChapterPlanResult> {
  if (input.chapterCount < BATCH_MIN_CHAPTERS || input.chapterCount > BATCH_MAX_CHAPTERS) {
    throw new BatchPlannerError(
      'BATCH_PLAN_INVALID',
      `章节数必须在 ${BATCH_MIN_CHAPTERS}～${BATCH_MAX_CHAPTERS} 之间`,
    );
  }
  if (!input.sourcePrompt.trim()) {
    throw new BatchPlannerError('BATCH_PLAN_INVALID', '剧情摘要不能为空');
  }
  const requestConfig = await resolveLLMRequestConfig();
  const contextWindow = Number(requestConfig.context_window) || 0;
  if (!(contextWindow > 0)) {
    throw new BatchPlannerError('BATCH_PLAN_INVALID', '当前模型未配置有效上下文窗口');
  }
  const reservedOutputTokens = input.reservedOutputTokens ?? 4000;

  const compiled = compileBatchPlannerRequest({
    sourcePrompt: input.sourcePrompt,
    chapterCount: input.chapterCount,
    targetWordsPerChapter: input.targetWordsPerChapter,
    pipelineMode: input.pipelineMode,
    materials: input.materials,
    contextWindow,
    reservedOutputTokens,
    optionalInstruction: input.optionalInstruction,
  });
  if (!compiled.ready) {
    // LLM call count 0 — user summary cannot fit the hard limit.
    throw new BatchPlannerError(
      'BATCH_CONTEXT_BUDGET_BLOCKED',
      compiled.error.message,
    );
  }
  const ready = requireReadyStageRequest(compiled);
  const messages = ready.messages;
  const wireMaxTokens = resolvePlannerWireMaxTokens({
    reservedOutputTokens,
    maxOutputTokens: requestConfig.max_output_tokens,
    contextWindow,
    estimatedInputTokens: ready.estimatedInputTokens,
    safetyMargin: ready.safetyMargin,
  });
  const requestJson = JSON.stringify({
    messages,
    maxTokens: reservedOutputTokens,
    contextWindow,
  });
  const requestFingerprint = sha256Hex(requestJson).slice(0, 32);

  let sawLengthFinish = false;
  const runPlannerCall = async (msgs: ChatMessage[]) => {
    const result = await callLLMResult(msgs, wireMaxTokens, {
      requestConfig,
      scenario: 'batch_planner',
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: wireMaxTokens,
      responseFormat: 'json_object',
      projectId: input.projectId,
    });
    if (result.finishReason === 'length') {
      sawLengthFinish = true;
    }
    return result.text || '';
  };

  let rawText = await runPlannerCall(messages);
  let validation = parseBatchChapterPlan(rawText, input.chapterCount);
  let usedRepair = false;
  if (!validation.ok) {
    // Exactly ONE structure-only repair request, reusing the frozen raw
    // output — never re-reads project materials.
    const repairMessages: ChatMessage[] = [
      ...messages,
      {
        role: 'user',
        content: FIX_INSTRUCTION(
          validation.errors,
          rawText,
          sawLengthFinish,
        ),
      },
    ];
    rawText = await runPlannerCall(repairMessages);
    validation = parseBatchChapterPlan(rawText, input.chapterCount);
    usedRepair = true;
  }
  if (!validation.ok) {
    throw new BatchPlannerError(
      'BATCH_PLAN_INVALID',
      `规划输出不合法：${validation.errors.join('；')}${
        sawLengthFinish
          ? '（模型输出疑似被 max_tokens 截断，可在 LLM 设置中调大最大输出长度后重试）'
          : ''
      }`,
    );
  }
  const hash = computePlannerHash(validation.plan);
  return {
    plan: validation.plan,
    hash,
    requestJson,
    requestFingerprint,
    messages,
    estimatedInputTokens: ready.estimatedInputTokens,
    usedRepair,
  };
}
