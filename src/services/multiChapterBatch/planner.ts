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
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      errors: ['JSON 解析失败，输出不是合法 JSON'],
    };
  }
  return validateBatchChapterPlan(parsed, expectedCount);
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

const FIX_INSTRUCTION = (errors: string[]) => `
上一次输出的 JSON 结构不合法，错误如下：
${errors.map(e => `- ${e}`).join('\n')}
请基于你刚才输出的内容，仅修复 JSON 结构，重新输出完整 JSON（不要解释）。`;

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
  const requestJson = JSON.stringify({
    messages,
    maxTokens: reservedOutputTokens,
    contextWindow,
  });
  const requestFingerprint = sha256Hex(requestJson).slice(0, 32);

  const runPlannerCall = async (msgs: ChatMessage[]) => {
    const result = await callLLMResult(msgs, reservedOutputTokens, {
      requestConfig,
      scenario: 'batch_planner',
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: reservedOutputTokens,
      responseFormat: 'json_object',
      projectId: input.projectId,
    });
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
        content: FIX_INSTRUCTION(validation.errors),
      },
    ];
    rawText = await runPlannerCall(repairMessages);
    validation = parseBatchChapterPlan(rawText, input.chapterCount);
    usedRepair = true;
  }
  if (!validation.ok) {
    throw new BatchPlannerError(
      'BATCH_PLAN_INVALID',
      `规划输出不合法：${validation.errors.join('；')}`,
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
