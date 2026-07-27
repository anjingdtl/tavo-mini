/**
 * Outbox worker for extract_state / apply_event / rebuild_story_memory.
 * LLM calls happen OUTSIDE SQLite transactions (Spec §11, §4.14).
 */
import { openDatabase } from '../../../data/connection/openDatabase';
import { callLLMResult, resolveLLMRequestConfigById } from '../../llm';
import { rebuildStoryMemory } from '../../storyMemory/storyMemoryRebuild';
import { stripModelJson } from '../canon/canonJsonValidators';
import { compileStateExtractionMessages } from './continuationPromptCompiler';
import {
  casOutboxState,
  contentRevisionHash,
  insertProposals,
  ensureGenerationSettings,
  listPendingOutbox,
  markRunsInterruptedOnColdStart,
} from './generationRepository';
import type { ProposalType } from './types';

export async function coldStartNormalizeContinuation(): Promise<number> {
  return markRunsInterruptedOnColdStart();
}

/**
 * Process pending outbox items. Safe to call repeatedly (dedupe + CAS).
 */
export async function processContinuationOutbox(options?: {
  limit?: number;
  /** Injected LLM for tests; when set, skips resolveLLM. */
  callExtract?: (messages: any[]) => Promise<string>;
  /** Injected story memory rebuild for tests. */
  rebuildStoryMemory?: (projectId: number, fromPosition: number) => Promise<void>;
}): Promise<{ processed: number; failed: number }> {
  const items = await listPendingOutbox(options?.limit ?? 10);
  let processed = 0;
  let failed = 0;

  for (const item of items) {
    const claimed = await casOutboxState(
      item.id,
      ['pending', 'interrupted'],
      { state: 'running', bumpAttempt: true },
    );
    if (!claimed) continue;

    try {
      if (item.operation === 'extract_state') {
        await handleExtractState(item.payloadJson, options?.callExtract);
      } else if (item.operation === 'apply_event') {
        // Event already created on confirm; mark complete.
      } else if (item.operation === 'rebuild_story_memory') {
        const payload = JSON.parse(item.payloadJson) as {
          fromPosition?: number;
        };
        if (options?.rebuildStoryMemory) {
          await options.rebuildStoryMemory(
            item.projectId,
            payload.fromPosition ?? 0,
          );
        } else {
          await rebuildStoryMemory(item.projectId, {
            fromPosition: payload.fromPosition ?? 0,
            mode: 'auto',
          });
        }
      }

      await casOutboxState(item.id, ['running'], {
        state: 'completed',
        completedAt: new Date().toISOString(),
      });
      processed += 1;
    } catch (e: any) {
      await casOutboxState(item.id, ['running'], {
        state: 'failed',
        lastError: e?.message ?? String(e),
      });
      failed += 1;
    }
  }

  return { processed, failed };
}

async function handleExtractState(
  payloadJson: string,
  callExtract?: (messages: any[]) => Promise<string>,
): Promise<void> {
  const payload = JSON.parse(payloadJson) as {
    projectId: number;
    chapterId: number;
    chapterRevisionHash: string;
    sourceRunId?: string | null;
    llmConfigId?: number;
  };

  const db = await openDatabase();
  const [ch] = await db.executeSql(
    'SELECT content, position FROM chapters WHERE id = ?',
    [payload.chapterId],
  );
  if (ch.rows.length === 0) {
    throw new Error('章节不存在，无法状态提取');
  }
  const content = String(ch.rows.item(0).content ?? '');
  const hash = contentRevisionHash(content);
  if (hash !== payload.chapterRevisionHash) {
    throw new Error('章节正文已变更，与定稿 hash 不一致');
  }

  const messages = compileStateExtractionMessages(content, '[]');
  let raw: string;
  if (callExtract) {
    raw = await callExtract(messages);
  } else {
    const settings = await ensureGenerationSettings(payload.projectId);
    const configId =
      payload.llmConfigId ?? settings.stateExtractionLlmConfigId;
    const requestConfig = configId
      ? await resolveLLMRequestConfigById(configId)
      : undefined;
    const result = await callLLMResult(messages, 2048, {
      queueClass: 'background',
      queuePriority: 'background',
      projectId: payload.projectId,
      taskId: `extract_${payload.chapterId}`,
      scenario: 'continuation_state_extraction',
      responseFormat: 'json_object',
      requestConfig,
    });
    raw = result.text ?? '';
  }

  const proposals = parseExtraction(raw, content.length);
  await insertProposals(
    proposals.map(p => ({
      projectId: payload.projectId,
      chapterId: payload.chapterId,
      sourceRunId: payload.sourceRunId ?? null,
      extractionContentHash: hash,
      chapterRevisionHash: hash,
      proposalType: p.proposalType,
      subjectRefType: p.subjectRefType,
      subjectRefId: p.subjectRefId,
      payloadJson: JSON.stringify(p.payload),
      evidenceStart: p.evidenceStart,
      evidenceEnd: p.evidenceEnd,
    })),
  );
}

function parseExtraction(
  raw: string,
  textLen: number,
): Array<{
  proposalType: ProposalType;
  subjectRefType: string | null;
  subjectRefId: string | null;
  payload: Record<string, unknown>;
  evidenceStart: number;
  evidenceEnd: number;
}> {
  const stripped = stripModelJson(raw);
  let parsed: any;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error('State extraction JSON 解析失败');
  }
  const list = Array.isArray(parsed?.proposals)
    ? parsed.proposals
    : Array.isArray(parsed)
      ? parsed
      : [];
  if (!Array.isArray(list) || list.length === 0) {
    // Empty is allowed (no state change)
    return [];
  }

  const out: Array<{
    proposalType: ProposalType;
    subjectRefType: string | null;
    subjectRefId: string | null;
    payload: Record<string, unknown>;
    evidenceStart: number;
    evidenceEnd: number;
  }> = [];

  const allowed: ProposalType[] = [
    'character_state',
    'relationship_change',
    'plot_advance',
    'character_experience',
    'knowledge_change',
    'new_world_fact',
    'new_character',
    'new_location',
    'new_organization',
    'foreshadowing',
    'other',
  ];

  for (const item of list) {
    if (!allowed.includes(item.proposalType)) continue;
    const es = Number(item.evidenceStart);
    const ee = Number(item.evidenceEnd);
    if (!(es >= 0 && ee > es && ee <= textLen)) {
      // Spec: invalid offset → reject whole batch
      throw new Error('State extraction evidence offset 越界，整批拒绝');
    }
    out.push({
      proposalType: item.proposalType,
      subjectRefType: item.subjectRefType ?? null,
      subjectRefId:
        item.subjectRefId != null ? String(item.subjectRefId) : null,
      payload: item.payload ?? { summary: item.summary ?? '' },
      evidenceStart: es,
      evidenceEnd: ee,
    });
  }
  return out;
}

/** Deterministic extract helper for tests / offline. */
export function deterministicExtractFromText(text: string): {
  proposals: Array<{
    proposalType: ProposalType;
    payload: Record<string, unknown>;
    evidenceStart: number;
    evidenceEnd: number;
  }>;
} {
  const proposals: Array<{
    proposalType: ProposalType;
    payload: Record<string, unknown>;
    evidenceStart: number;
    evidenceEnd: number;
  }> = [];
  const m = text.match(/【状态:([^\]]+)】/);
  if (m && m.index != null) {
    proposals.push({
      proposalType: 'character_state',
      payload: { summary: m[1] },
      evidenceStart: m.index,
      evidenceEnd: m.index + m[0].length,
    });
  }
  const n = text.match(/【新人物:([^\]]+)】/);
  if (n && n.index != null) {
    proposals.push({
      proposalType: 'new_character',
      payload: { name: n[1], summary: `新人物 ${n[1]}` },
      evidenceStart: n.index,
      evidenceEnd: n.index + n[0].length,
    });
  }
  return { proposals };
}
