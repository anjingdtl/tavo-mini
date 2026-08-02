/**
 * V3 strict parsers for the quality-first workflow (Implementation plan §4.4,
 * §4.5).
 *
 * These are intentionally separate from the V2 `parseWriterResult()` so legacy
 * and V2 runs keep their permissive behavior. V3 enforces schemaVersion=2 on
 * Writer output and schemaVersion=1 on Integrated Reviser output.
 *
 * Pure functions. Throw Chinese, actionable errors on contract violation.
 */
import { stripModelJson } from '../canon/canonJsonValidators';
import type { ContinuationPlan } from './types';
import type { ContinuationV3PlanBeat } from './continuationV3Types';

export interface ParsedV3WriterResult {
  plan: ContinuationPlan;
  /**
   * V3 plan structure preserved separately for telemetry / prompt echo checks.
   * The canonical `ContinuationPlan` (schemaVersion 1) is derived from it so
   * downstream V2-compatible code keeps working.
   */
  v3Plan: {
    schemaVersion: 2;
    targetHanCharacters: number;
    chapterGoal: string;
    centralConflict: string;
    beats: ContinuationV3PlanBeat[];
    participatingCharacterIds: number[];
    characterActions: unknown[];
    plotAdvances: unknown[];
    foreshadowingActions: unknown[];
    proposedStateChanges: unknown[];
    risks: unknown[];
  };
  content: string;
}

export interface ParsedV3ReviserResult {
  content: string;
}

function ensureObject(parsed: unknown): asserts parsed is Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('V3 输出顶层必须是 JSON object，不能是数组或解释文字。');
  }
}

/**
 * Strict V3 Writer contract (plan §4.4). Differs from V2 `parseWriterResult()`:
 *  - schemaVersion must be exactly 2;
 *  - plan.targetHanCharacters is required and echoed back;
 *  - every beat must have a positive integer order, non-empty summary and a
 *    positive integer targetHanCharacters;
 *  - content must be non-empty prose, not nested JSON, not a title/plan.
 */
export function parseV3WriterResult(
  raw: string,
  frozenTargetHanCharacters: number,
): ParsedV3WriterResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripModelJson(raw));
  } catch {
    throw new Error(
      'V3 Writer 返回的不是合法 JSON。请确认模型支持 JSON 输出且未混入推理内容。',
    );
  }
  ensureObject(parsed);

  if (parsed.schemaVersion !== 2) {
    throw new Error(
      'V3 Writer JSON 缺少 schemaVersion=2。请使用 V3 写手提示并确认模型未返回 V1 结构。',
    );
  }

  const planRaw = parsed.plan;
  if (!planRaw || typeof planRaw !== 'object' || Array.isArray(planRaw)) {
    throw new Error('V3 Writer JSON 缺少 plan 对象。');
  }
  const p = planRaw as Record<string, unknown>;

  const targetEcho = Number(p.targetHanCharacters);
  if (
    !Number.isFinite(targetEcho) ||
    targetEcho !== Math.floor(targetEcho) ||
    targetEcho <= 0
  ) {
    throw new Error(
      'V3 Writer plan.targetHanCharacters 必须是正整数，请按本次冻结目标回填。',
    );
  }
  // The plan echo must equal the frozen target exactly. Plan §4.4: "必须等于
  // 冻结 target". A mismatch is a contract violation, not a length failure —
  // it means the model ignored the dynamic target, which is exactly the V2 bug.
  if (targetEcho !== frozenTargetHanCharacters) {
    throw new Error(
      `V3 Writer plan.targetHanCharacters(${targetEcho}) 与冻结目标(${frozenTargetHanCharacters})不一致，请确认模型读取了本次动态目标。`,
    );
  }

  if (typeof p.chapterGoal !== 'string' || !p.chapterGoal.trim()) {
    throw new Error('V3 Writer plan.chapterGoal 必须是非空字符串。');
  }
  if (typeof p.centralConflict !== 'string' || !p.centralConflict.trim()) {
    throw new Error('V3 Writer plan.centralConflict 必须是非空字符串。');
  }
  if (!Array.isArray(p.beats) || p.beats.length === 0) {
    throw new Error('V3 Writer plan.beats 必须是非空数组。');
  }
  if (!Array.isArray(p.participatingCharacterIds)) {
    throw new Error('V3 Writer plan.participatingCharacterIds 必须是数组。');
  }

  const beats: ContinuationV3PlanBeat[] = p.beats.map(
    (beat: unknown, index: number) => {
      if (!beat || typeof beat !== 'object' || Array.isArray(beat)) {
        throw new Error(`V3 Writer plan.beats[${index}] 不是有效对象。`);
      }
      const b = beat as Record<string, unknown>;
      const order = Number(b.order);
      const summary = typeof b.summary === 'string' ? b.summary.trim() : '';
      const beatTarget = Number(b.targetHanCharacters);
      if (
        !Number.isFinite(order) ||
        order !== Math.floor(order) ||
        order <= 0
      ) {
        throw new Error(
          `V3 Writer plan.beats[${index}].order 必须是正整数。`,
        );
      }
      if (!summary) {
        throw new Error(
          `V3 Writer plan.beats[${index}].summary 必须是非空字符串。`,
        );
      }
      if (
        !Number.isFinite(beatTarget) ||
        beatTarget !== Math.floor(beatTarget) ||
        beatTarget <= 0
      ) {
        throw new Error(
          `V3 Writer plan.beats[${index}].targetHanCharacters 必须是正整数。`,
        );
      }
      return {
        order,
        summary: b.summary as string,
        targetHanCharacters: beatTarget,
      };
    },
  );

  const participatingCharacterIds = (p.participatingCharacterIds as unknown[])
    .filter((id: unknown) => Number.isFinite(Number(id)))
    .map((id: unknown) => Number(id));

  if (typeof parsed.content !== 'string' || !parsed.content.trim()) {
    throw new Error(
      'V3 Writer JSON 缺少非空 content。模型可能只返回了推理或被 max_tokens 截断。',
    );
  }
  // content must be prose, not nested JSON / plan wrapper (plan §4.4).
  const trimmedContent = (parsed.content as string).trim();
  try {
    const nested = JSON.parse(trimmedContent);
    if (
      nested &&
      typeof nested === 'object' &&
      (nested.plan || nested.content || nested.schemaVersion != null)
    ) {
      throw new Error('V3 Writer content 不能再次包含 plan 或 JSON 包装。');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('不能再次包含')) {
      throw error;
    }
    // Normal prose is not valid JSON — that is the expected path.
  }

  const v3Plan = {
    schemaVersion: 2 as const,
    targetHanCharacters: targetEcho,
    chapterGoal: p.chapterGoal as string,
    centralConflict: p.centralConflict as string,
    beats,
    participatingCharacterIds,
    characterActions: Array.isArray(p.characterActions)
      ? (p.characterActions as unknown[])
      : [],
    plotAdvances: Array.isArray(p.plotAdvances)
      ? (p.plotAdvances as unknown[])
      : [],
    foreshadowingActions: Array.isArray(p.foreshadowingActions)
      ? (p.foreshadowingActions as unknown[])
      : [],
    proposedStateChanges: Array.isArray(p.proposedStateChanges)
      ? (p.proposedStateChanges as unknown[])
      : [],
    risks: Array.isArray(p.risks) ? (p.risks as unknown[]) : [],
  };

  // Derive a V2-compatible ContinuationPlan (schemaVersion 1) so downstream
  // checker/repair/savePlan code keeps working without forking.
  const plan: ContinuationPlan = {
    schemaVersion: 1,
    chapterGoal: v3Plan.chapterGoal,
    centralConflict: v3Plan.centralConflict,
    beats: v3Plan.beats.map(b => ({
      order: b.order,
      summary: b.summary,
    })),
    participatingCharacterIds: v3Plan.participatingCharacterIds,
    characterActions: v3Plan.characterActions as any,
    plotAdvances: v3Plan.plotAdvances as any,
    foreshadowingActions: v3Plan.foreshadowingActions as any,
    proposedStateChanges: v3Plan.proposedStateChanges as any,
    risks: v3Plan.risks as any,
  };

  return { plan, v3Plan, content: parsed.content as string };
}

/**
 * Strict V3 Integrated Reviser contract (plan §4.5). The reviser returns the
 * FULL revised chapter, never an offset patch. Output must be exactly:
 *   { "schemaVersion": 1, "content": "完整修订章节正文" }
 */
export function parseV3ReviserResult(raw: string): ParsedV3ReviserResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripModelJson(raw));
  } catch {
    throw new Error(
      'V3 Integrated Reviser 返回的不是合法 JSON。请确认模型输出严格 JSON。',
    );
  }
  ensureObject(parsed);
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      'V3 Integrated Reviser JSON 缺少 schemaVersion=1。',
    );
  }
  if (typeof parsed.content !== 'string' || !parsed.content.trim()) {
    throw new Error(
      'V3 Integrated Reviser 缺少非空 content。模型可能只返回了推理或摘要，未输出完整修订正文。',
    );
  }
  // Guard against the model returning a patch object instead of full content.
  if (
    Array.isArray((parsed as Record<string, unknown>).patches) ||
    (parsed as Record<string, unknown>).replacement != null
  ) {
    throw new Error(
      'V3 Integrated Reviser 必须返回完整修订正文，不能返回 offset 补丁。',
    );
  }
  return { content: parsed.content as string };
}
