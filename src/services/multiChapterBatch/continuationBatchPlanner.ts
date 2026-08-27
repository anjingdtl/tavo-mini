/**
 * Continuation batch planner (doc §7).
 *
 * Produces an editable N-chapter continuation plan. Reuses the outline
 * planner's strict validation / fallback parse / hash contract (same
 * BatchChapterPlanItem schema) but compiles its own prompt from a completely
 * different authority: bounded Source boundary + Canon + continuation state.
 *
 * Hard contract (doc §7.3): original-work content enters ONLY through the
 * bounded continuationSourceReader. No direct chunk/repository reads, no
 * UI future-browsing APIs, nothing past the boundary offset.
 */
import type { ChatMessage } from '../llm';
import { callLLMResult, resolveLLMRequestConfig } from '../llm';
import { requireReadyStageRequest } from '../pipeline/compileStageRequest';
import {
  compileContinuationBatchPlannerRequest,
  type ContinuationBatchPlannerMaterials,
} from './continuationBatchPlannerCompiler';
import {
  parseBatchChapterPlan,
  computePlannerHash,
  resolvePlannerWireMaxTokens,
  resolvePlannerReservedOutputTokens,
} from './planner';
import {
  BATCH_MAX_CHAPTERS,
  BATCH_MIN_CHAPTERS,
  type BatchChapterPlan,
  type ContinuationBatchAnchorV1,
} from '../../types/multiChapterBatch';
import { sha256Hex } from '../continuation/hashUtils';
import * as db from '../database';
import { continuationSourceReader } from '../continuation/continuationSourceReader';
import { CanonQueryService } from '../continuation/canon/canonQueryService';
import { getEffectiveContinuationState } from '../continuation/generation/continuationStateService';
import {
  getNextContinuationChapterPosition,
} from '../continuation/chapterNumbering/continuationChapterNumbering';

export class ContinuationBatchPlannerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContinuationBatchPlannerError';
    this.code = code;
  }
}

const SEAM_TAIL_CHARS = 800;
const CANON_BUNDLE_TOKEN_BUDGET = 3500;
const DIGEST_FIELD_CAP = 160;

function cap(text: string, capChars = DIGEST_FIELD_CAP): string {
  const value = String(text ?? '').trim();
  return value.length > capChars ? `${value.slice(0, capChars)}…` : value;
}

/**
 * Capture the frozen continuation batch anchor (doc §6.1): live Source
 * snapshot identity + boundary + active Canon snapshot + continuation tail.
 * Throws when the project has no ready Source/Canon — creating a batch on an
 * unprepared project must fail closed, not plan against missing authority.
 */
export async function captureContinuationBatchAnchor(
  projectId: number,
): Promise<ContinuationBatchAnchorV1> {
  const snapshot = await continuationSourceReader.getSnapshot(projectId);
  const canon = await CanonQueryService.getActiveSnapshot(projectId);
  const chapters = await db.getChaptersByProject(projectId);
  const tailPosition =
    chapters.length > 0
      ? Math.max(...chapters.map((c: any) => Number(c.position)))
      : -1;
  const tailChapter =
    chapters.length > 0
      ? chapters.reduce((max: any, c: any) =>
          Number(c.position) >= Number(max.position) ? c : max,
        )
      : null;
  return {
    schemaVersion: 1,
    sourceId: snapshot.sourceId,
    sourceVersion: snapshot.sourceVersion,
    sourceSha256: snapshot.normalizedSha256,
    boundaryPosition: snapshot.boundary.chapterPosition,
    boundaryChapterId: snapshot.boundary.chapterId,
    boundaryCharOffsetExclusive: snapshot.boundary.charOffsetExclusive,
    canonSnapshotId: canon.id,
    canonRevision: canon.revision,
    startingContinuationTailPosition: tailPosition,
    startingContinuationTailChapterId: tailChapter?.id ?? null,
  };
}

/**
 * Collect planner materials. Every original-work byte flows through the
 * bounded reader; Canon flows through CanonQueryService; the continuation
 * state flows through the effective-state fusion service.
 */
export async function collectContinuationBatchPlannerMaterials(
  projectId: number,
): Promise<ContinuationBatchPlannerMaterials> {
  const snapshot = await continuationSourceReader.getSnapshot(projectId);

  // Boundary identity + seam: metas near the boundary + the boundary
  // chapter's clipped tail. listBoundedSourceChaptersForRange reads exactly
  // one bounded chapter (content clipped at the boundary offset).
  const metas = await continuationSourceReader.listBoundedSourceChapterMetas(
    snapshot,
  );
  const recentMetas = metas.slice(-3);
  const boundaryMeta = metas.length > 0 ? metas[metas.length - 1] : null;
  let seamTail = '';
  if (boundaryMeta) {
    const boundaryChapters =
      await continuationSourceReader.listBoundedSourceChaptersForRange(
        snapshot,
        boundaryMeta.position,
        boundaryMeta.position,
      );
    const boundaryContent = boundaryChapters[0]?.content ?? '';
    if (boundaryContent.length > 0) {
      seamTail = boundaryContent.slice(-SEAM_TAIL_CHARS);
    }
  }
  const metaLines = recentMetas
    .map(
      m =>
        `原著第 ${Number(m.position) + 1} 章《${m.title || '无题'}》`,
    )
    .join('\n');
  const sourceBoundaryText = [
    `续写起点位于原著第 ${Number(snapshot.boundary.chapterPosition) + 1} 章内（边界字符偏移 ${snapshot.boundary.charOffsetExclusive}）。`,
    metaLines ? `边界前最近章节：\n${metaLines}` : '',
    seamTail ? `边界章节结尾接缝（截取，续写必须自然承接）：\n${seamTail}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  // Canon hard facts digest via the Canon boundary.
  const canon = await CanonQueryService.getActiveSnapshot(projectId);
  const bundle = await CanonQueryService.getContextBundle({
    projectId,
    snapshotId: canon.id,
    snapshotRevision: canon.revision,
    atSourcePosition: snapshot.boundary.chapterPosition,
    queryText: '',
    characterIds: [],
    tokenBudget: CANON_BUNDLE_TOKEN_BUDGET,
    reviewPolicy: 'balanced',
  });
  const nameById = new Map<number, string>();
  for (const character of bundle.characters) {
    nameById.set(Number((character as any).id), character.canonicalName);
  }
  const canonParts: string[] = [];
  if (bundle.worldRules.length > 0) {
    canonParts.push(
      `世界规则：\n${bundle.worldRules
        .slice(0, 8)
        .map(r => `- [${r.constraintLevel}] ${cap(r.title, 40)}：${cap(r.description, 120)}`)
        .join('\n')}`,
    );
  }
  if (bundle.characterStates.length > 0) {
    canonParts.push(
      `人物状态（边界处）：\n${bundle.characterStates
        .slice(0, 10)
        .map(
          s =>
            `- ${nameById.get(Number(s.characterId)) || `角色#${s.characterId}`}：${cap(
              s.summary ||
                [s.location, s.physicalState, s.emotionalState, s.currentGoal]
                  .filter(Boolean)
                  .join('；'),
            )}（${s.aliveState === 'dead' ? '已死亡' : s.aliveState}）`,
        )
        .join('\n')}`,
    );
  }
  if (bundle.relationships.length > 0) {
    canonParts.push(
      `人物关系：\n${bundle.relationships
        .slice(0, 8)
        .map(
          r =>
            `- ${nameById.get(Number(r.sourceCharacterId)) || '?'} → ${
              nameById.get(Number(r.targetCharacterId)) || '?'
            }：${cap(`${r.relationType} ${r.description}`, 100)}`,
        )
        .join('\n')}`,
    );
  }
  if (bundle.plotThreads.length > 0) {
    canonParts.push(
      `情节线：\n${bundle.plotThreads
        .slice(0, 8)
        .map(
          p =>
            `- [${p.status}] ${cap(p.title, 40)}：${cap(
              p.unresolvedQuestionsJson && p.unresolvedQuestionsJson !== '[]'
                ? p.description
                : p.description,
              120,
            )}`,
        )
        .join('\n')}`,
    );
  }
  const canonHardFactsText = canonParts.join('\n\n');

  // Current continuation state (best-effort preferred tier).
  let continuationStateText = '';
  try {
    const targetPosition = await getNextContinuationChapterPosition(projectId);
    const effective = await getEffectiveContinuationState({
      projectId,
      canonSnapshotId: canon.id,
      canonRevision: canon.revision,
      targetPosition,
    });
    const stateLines: string[] = [];
    if (effective.characterStates.length > 0) {
      stateLines.push(
        `续写层人物状态：\n${effective.characterStates
          .slice(0, 8)
          .map(
            s =>
              `- ${s.ref.refType === 'canon_character' ? nameById.get(Number(s.ref.id)) || `角色#${s.ref.id}` : `实体#${s.ref.id}`}：${cap(
                s.summary ||
                  [s.fields?.location, s.fields?.physicalState, s.fields?.emotionalState]
                    .filter(Boolean)
                    .join('；'),
              )}`,
          )
          .join('\n')}`,
      );
    }
    if (effective.plotThreads.length > 0) {
      stateLines.push(
        `活跃情节线：${effective.plotThreads
          .slice(0, 6)
          .map(p => cap(p.title, 40))
          .join('；')}`,
      );
    }
    const freshness = (effective as any).freshness;
    if (freshness) {
      stateLines.push(
        `状态健康度：canonReady=${String(freshness.canonReady)}, pendingStateExtraction=${Number(
          freshness.pendingStateExtractionCount ?? 0,
        )}`,
      );
    }
    continuationStateText = stateLines.join('\n\n');
  } catch {
    continuationStateText = '';
  }

  // Recent continuation chapters (titles + synopses only — V5 owns the prose
  // seam at generation time; the planner never needs full bodies).
  const chapters = await db.getChaptersByProject(projectId);
  const recentContinuationText = chapters
    .slice(-2)
    .map(
      (c: any) =>
        `已续写《${c.title || `第 ${Number(c.position) + 1} 章`}》：${cap(c.synopsis || '', 200)}`,
    )
    .join('\n');

  // Story memory digest (optional tier).
  let storyMemoryText = '';
  try {
    const memory = await db.getProjectStoryMemory(projectId);
    const state = memory?.state as
      | {
          mainline?: { summary?: string; goal?: string };
          characters?: Record<string, { name?: string; summary?: string }>;
        }
      | undefined;
    if (state) {
      const parts: string[] = [];
      if (state.mainline?.summary) parts.push(`主线：${state.mainline.summary}`);
      if (state.mainline?.goal) parts.push(`目标：${state.mainline.goal}`);
      if (state.characters) {
        const chars = Object.values(state.characters)
          .slice(0, 8)
          .map(c => `${c.name || ''}：${cap(c.summary || '', 120)}`)
          .filter(Boolean);
        if (chars.length) parts.push(`角色状态：${chars.join('；')}`);
      }
      storyMemoryText = parts.join('\n').slice(0, 4000);
    }
  } catch {
    storyMemoryText = '';
  }

  return {
    sourceBoundaryText,
    canonHardFactsText,
    continuationStateText,
    recentContinuationText,
    storyMemoryText,
  };
}

export interface CreateContinuationBatchPlanResult {
  plan: BatchChapterPlan;
  hash: string;
  requestJson: string;
  requestFingerprint: string;
  messages: ChatMessage[];
  estimatedInputTokens: number;
  usedRepair: boolean;
}

export interface CreateContinuationBatchPlanInput {
  projectId: number;
  sourcePrompt: string;
  chapterCount: number;
  targetWordsPerChapter: number;
  materials: ContinuationBatchPlannerMaterials;
  reservedOutputTokens?: number;
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
 * Run the continuation planner: compile → LLM → strict validation → (once)
 * structure fix. A mandatory overflow blocks BEFORE any model call
 * (Protected overflow ⇒ 0 LLM calls, doc §27).
 */
export async function createContinuationBatchChapterPlan(
  input: CreateContinuationBatchPlanInput,
): Promise<CreateContinuationBatchPlanResult> {
  if (
    input.chapterCount < BATCH_MIN_CHAPTERS ||
    input.chapterCount > BATCH_MAX_CHAPTERS
  ) {
    throw new ContinuationBatchPlannerError(
      'BATCH_PLAN_INVALID',
      `章节数必须在 ${BATCH_MIN_CHAPTERS}～${BATCH_MAX_CHAPTERS} 之间`,
    );
  }
  if (!input.sourcePrompt.trim()) {
    throw new ContinuationBatchPlannerError(
      'BATCH_PLAN_INVALID',
      '本批续写目标不能为空',
    );
  }
  const requestConfig = await resolveLLMRequestConfig();
  const contextWindow = Number(requestConfig.context_window) || 0;
  if (!(contextWindow > 0)) {
    throw new ContinuationBatchPlannerError(
      'BATCH_PLAN_INVALID',
      '当前模型未配置有效上下文窗口',
    );
  }
  const reservedOutputTokens = resolvePlannerReservedOutputTokens({
    explicitReservation: input.reservedOutputTokens,
    contextWindow,
    maxOutputTokens: requestConfig.max_output_tokens,
    providerConfig: requestConfig,
  });

  const compiled = compileContinuationBatchPlannerRequest({
    sourcePrompt: input.sourcePrompt,
    chapterCount: input.chapterCount,
    targetWordsPerChapter: input.targetWordsPerChapter,
    materials: input.materials,
    contextWindow,
    reservedOutputTokens,
  });
  if (!compiled.ready) {
    // LLM call count 0 — protected material cannot fit the hard limit.
    throw new ContinuationBatchPlannerError(
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
    providerConfig: requestConfig,
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
    throw new ContinuationBatchPlannerError(
      'BATCH_PLAN_INVALID',
      `续写规划输出不合法：${validation.errors.join('；')}${
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
