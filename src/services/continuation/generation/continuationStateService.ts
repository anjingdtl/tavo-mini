/**
 * Effective continuation state fusion + proposal confirmation + invalidation.
 * Spec §11, §12. Never calls LLM inside SQLite transactions.
 */
import type { ContinuationChapterPosition } from '../../../types/novel';
import { openDatabase } from '../../../data/connection/openDatabase';
import { executeTransaction } from '../../database/transaction';
import { v4 } from '../../uuidBridge';
import { CanonQueryService } from '../canon/canonQueryService';
import {
  buildOutboxInsertStatement,
  countPendingMajorProposals,
  countPendingStateExtractions,
  getProposalById,
  listValidEventsBefore,
  updateProposalStatus,
} from './generationRepository';
import type {
  EffectiveContinuationState,
  TypedEntityRef,
} from './types';
import { ContinuationCapabilityBlockedError } from './types';
import { processContinuationOutbox } from './continuationStateOutboxWorker';
import { applyContinuityEventWithAuthority } from '../../writing/memory/memoryAuthority';
import { commitAcceptedProposal } from './commitStateProposal';

export async function getEffectiveContinuationState(input: {
  projectId: number;
  canonSnapshotId: string;
  canonRevision: number;
  targetPosition: ContinuationChapterPosition;
  entityRefs?: TypedEntityRef[];
}): Promise<EffectiveContinuationState> {
  const snap = await CanonQueryService.getActiveSnapshot(input.projectId);
  if (snap.id !== input.canonSnapshotId || snap.revision !== input.canonRevision) {
    throw new ContinuationCapabilityBlockedError(
      'active Canon snapshot 与请求不一致，请重新分析或刷新。',
    );
  }
  if (snap.status !== 'ready') {
    throw new ContinuationCapabilityBlockedError('Canon snapshot 未就绪');
  }

  const atBoundary = snap.boundaryPosition;
  const bundle = await CanonQueryService.getContextBundle({
    projectId: input.projectId,
    snapshotId: snap.id,
    snapshotRevision: snap.revision,
    atSourcePosition: atBoundary,
    queryText: '',
    characterIds: [],
    tokenBudget: 4000,
    reviewPolicy: 'balanced',
  });

  const events = await listValidEventsBefore(
    input.projectId,
    input.targetPosition,
  );

  // 批量查询章节存在性，避免 N+1（原逐条 SELECT content 只为查存在性，
  // 却把整章正文拉到内存再扔掉，大章节 + 多事件时主线程长时间卡在 SQLite）。
  const db = await openDatabase();
  const applied: typeof events = [];
  const omittedReasons: string[] = [];
  if (events.length > 0) {
    const chapterIds = [...new Set(
      events.map(e => e.chapterId).filter((id): id is number => id != null),
    )];
    const existingIds = new Set<number>();
    // SQLite 参数上限 999，分批查询。
    const BATCH = 500;
    for (let i = 0; i < chapterIds.length; i += BATCH) {
      const batch = chapterIds.slice(i, i + BATCH);
      const placeholders = batch.map(() => '?').join(',');
      const [result] = await db.executeSql(
        `SELECT id FROM chapters WHERE id IN (${placeholders})`,
        batch,
      );
      for (let j = 0; j < result.rows.length; j += 1) {
        existingIds.add(result.rows.item(j).id);
      }
    }
    for (const ev of events) {
      if (!existingIds.has(ev.chapterId)) {
        omittedReasons.push(`event ${ev.id}: chapter missing`);
        continue;
      }
      // revision hash check is done by caller invalidation; here we trust
      // non-invalidated events. If chapter deleted, skip.
      applied.push(ev);
    }
  }

  const characterStates: EffectiveContinuationState['characterStates'] = [];
  for (const st of bundle.characterStates) {
    characterStates.push({
      ref: { refType: 'canon_character', id: st.characterId },
      summary: st.summary,
      fields: {
        location: st.location,
        physicalState: st.physicalState,
        emotionalState: st.emotionalState,
        aliveState: st.aliveState,
      },
      source: 'canon',
    });
  }

  const relationships: EffectiveContinuationState['relationships'] =
    bundle.relationships.map(r => ({
      source: { refType: 'canon_character' as const, id: r.sourceCharacterId },
      target: { refType: 'canon_character' as const, id: r.targetCharacterId },
      summary: `${r.relationType}: ${r.description}`,
      sourceLayer: 'canon' as const,
    }));

  const plotThreads: EffectiveContinuationState['plotThreads'] =
    bundle.plotThreads.map(p => ({
      id: p.id,
      title: p.title,
      status: p.status,
      summary: p.description,
      sourceLayer: 'canon' as const,
    }));

  const knowledge: EffectiveContinuationState['knowledge'] =
    bundle.knowledge.map(k => ({
      ref: { refType: 'canon_character' as const, id: k.characterId },
      factKey: k.factKey,
      factSummary: k.factSummary,
      knowledgeState: k.knowledgeState,
    }));

  const experiences: EffectiveContinuationState['experiences'] =
    bundle.experiences.map(e => ({
      ref: { refType: 'canon_character' as const, id: e.characterId },
      title: e.title,
      summary: e.description,
    }));

  // Apply confirmed continuation events (later wins for same field keys).
  for (const ev of applied) {
    let payload: any = {};
    try {
      payload = JSON.parse(ev.payloadJson);
    } catch {
      continue;
    }
    if (ev.eventType === 'character_state' || payload.summary) {
      const ref =
        ev.entityRefs[0] ??
        ({ refType: 'world', id: 'world' } as TypedEntityRef);
      const canonMatch = characterStates.find(
        st => st.source === 'canon' && String(st.ref.id) === String(ref.id),
      );
      const appliedAuthority = applyContinuityEventWithAuthority({
        eventType: ev.eventType,
        entityRefId: ref.id,
        payload,
        canonAliveState:
          typeof canonMatch?.fields?.aliveState === 'string'
            ? canonMatch.fields.aliveState
            : null,
        canonIdentityState:
          typeof canonMatch?.fields?.identityState === 'string'
            ? canonMatch.fields.identityState
            : null,
        canonKnowledgeBoundary:
          typeof canonMatch?.fields?.knowledgeBoundary === 'string'
            ? canonMatch.fields.knowledgeBoundary
            : null,
      });
      if (appliedAuthority.omittedReason) {
        omittedReasons.push(`event ${ev.id}: ${appliedAuthority.omittedReason}`);
      }
      characterStates.push({
        ref,
        summary: payload.summary ?? payload.description ?? ev.eventType,
        fields: Object.fromEntries(
          Object.entries(appliedAuthority.appliedFields).map(([key, value]) => [
            key,
            value == null ? null : String(value),
          ]),
        ),
        source: 'state_event',
      });
    }
    if (ev.eventType === 'relationship_change') {
      relationships.push({
        source: ev.entityRefs[0] ?? { refType: 'world', id: 'world' },
        target: ev.entityRefs[1] ?? { refType: 'world', id: 'world' },
        summary: payload.summary ?? '关系变化',
        sourceLayer: 'state_event',
      });
    }
    if (ev.eventType === 'plot_advance') {
      plotThreads.push({
        id: payload.plotThreadId ?? ev.id,
        title: payload.title ?? '剧情推进',
        status: payload.status ?? 'active',
        summary: payload.summary ?? '',
        sourceLayer: 'state_event',
      });
    }
  }

  // Story memory status (read-only, no LLM).
  let storyMemoryStatus = 'missing';
  let dirtyFromPosition: ContinuationChapterPosition | null = null;
  try {
    const [sm] = await db.executeSql(
      `SELECT status, dirty_from_position FROM project_story_memory WHERE project_id = ?`,
      [input.projectId],
    );
    if (sm.rows.length > 0) {
      storyMemoryStatus = sm.rows.item(0).status;
      dirtyFromPosition = sm.rows.item(0).dirty_from_position ?? null;
    }
  } catch {
    storyMemoryStatus = 'missing';
  }

  const pendingStateExtractionCount = await countPendingStateExtractions(
    input.projectId,
  );
  const pendingMajorProposalCount = await countPendingMajorProposals(
    input.projectId,
  );

  return {
    schemaVersion: 1,
    targetPosition: input.targetPosition,
    characterStates,
    relationships,
    plotThreads,
    knowledge,
    experiences,
    freshness: {
      canonReady: true,
      storyMemoryStatus,
      pendingStateExtractionCount,
      pendingMajorProposalCount,
      dirtyFromPosition,
    },
    appliedEventIds: applied.map(e => e.id),
    omittedReasons,
  };
}

/**
 * Confirm a proposal: create event + dirty story memory + outbox in one local tx.
 * LLM rebuild happens later via outbox worker.
 */
export async function confirmProposal(input: {
  proposalId: string;
  decisionNote?: string;
  autoCreateEntity?: boolean;
  /** Bulk review defers the worker until all local decisions are committed. */
  processOutbox?: boolean;
}): Promise<{ eventId: string; entityId?: string }> {
  const result = await commitAcceptedProposal({
    proposalId: input.proposalId,
    decisionNote: input.decisionNote,
    autoCreateEntity: input.autoCreateEntity,
  });
  if (input.processOutbox !== false) {
    processContinuationOutbox({ limit: 2 }).catch(() => {});
  }
  return result;
}

/**
 * Confirm a loaded set of proposals in one user action.
 *
 * Each proposal keeps the same durable event/entity/outbox transaction as the
 * single-item action. The only difference is that outbox processing is
 * deferred until every local decision has committed, preventing concurrent
 * Story Memory rebuilds from racing one another during bulk review.
 */
export async function confirmAllProposals(input: {
  projectId: number;
  proposalIds: string[];
  autoCreateEntity?: boolean;
}): Promise<{
  confirmedCount: number;
  failedProposalIds: string[];
  syncProcessed: number;
  syncFailed: number;
}> {
  const proposalIds = [...new Set(input.proposalIds)];
  const failedProposalIds: string[] = [];
  let confirmedCount = 0;

  for (const proposalId of proposalIds) {
    try {
      const proposal = await getProposalById(proposalId);
      if (!proposal || proposal.projectId !== input.projectId) {
        throw new Error('proposal 不存在或不属于当前项目');
      }
      await confirmProposal({
        proposalId,
        autoCreateEntity: input.autoCreateEntity,
        processOutbox: false,
      });
      confirmedCount += 1;
    } catch {
      // Keep processing the remaining loaded proposals. The caller receives
      // the exact failures and can retry them without hiding a partial commit.
      failedProposalIds.push(proposalId);
    }
  }

  if (confirmedCount === 0) {
    return {
      confirmedCount,
      failedProposalIds,
      syncProcessed: 0,
      syncFailed: 0,
    };
  }

  const sync = await processContinuationOutbox({
    // A proposal creates at most one apply event and one rebuild row; allow a
    // small margin for pre-existing durable work without imposing a hardcoded
    // one-at-a-time UI loop.
    limit: Math.max(10, confirmedCount * 2 + 4),
  });
  return {
    confirmedCount,
    failedProposalIds,
    syncProcessed: sync.processed,
    syncFailed: sync.failed,
  };
}

export async function rejectProposal(
  proposalId: string,
  note?: string,
): Promise<void> {
  await updateProposalStatus(proposalId, 'rejected', note ?? null);
}

/**
 * Invalidate continuation state from earliest affected chapter position
 * (modification / delete / reorder). Does not touch Source Canon.
 */
export async function invalidateContinuationStateFromPosition(input: {
  projectId: number;
  fromPosition: number;
  chapterIds?: number[];
  reason: string;
}): Promise<void> {
  const db = await openDatabase();
  const ts = new Date().toISOString();
  const outboxId = `co_${v4().replace(/-/g, '')}`;
  const statements: Array<{ sql: string; params?: any[] }> = [
    {
      sql: `UPDATE continuation_state_events
        SET invalidated_at = ?, invalidation_reason = ?
        WHERE project_id = ? AND invalidated_at IS NULL
          AND (valid_from_position >= ? OR chapter_position >= ?)`,
      params: [
        ts,
        input.reason,
        input.projectId,
        input.fromPosition,
        input.fromPosition,
      ],
    },
    {
      sql: 'INSERT OR IGNORE INTO project_story_memory (project_id, updated_at) VALUES (?, ?)',
      params: [input.projectId, ts],
    },
    {
      sql: `UPDATE project_story_memory SET status = 'dirty',
        dirty_from_position = CASE
          WHEN dirty_from_position IS NULL THEN ?
          WHEN dirty_from_position > ? THEN ?
          ELSE dirty_from_position
        END,
        updated_at = ?
        WHERE project_id = ?`,
      params: [
        input.fromPosition,
        input.fromPosition,
        input.fromPosition,
        ts,
        input.projectId,
      ],
    },
    buildOutboxInsertStatement({
      id: outboxId,
      projectId: input.projectId,
      chapterId: null,
      operation: 'rebuild_story_memory',
      payload: { fromPosition: input.fromPosition, reason: input.reason },
      dedupeKey: `rebuild_story_memory:${input.projectId}:${input.fromPosition}:${input.reason}`,
      ts,
    }),
  ];
  for (const chapterId of input.chapterIds ?? []) {
    statements.splice(1, 0, {
      sql: `UPDATE continuation_state_proposals
        SET status = 'invalidated', decision_note = ?, decided_at = ?, updated_at = ?
        WHERE chapter_id = ? AND status IN ('pending', 'accepted')`,
      params: [input.reason, ts, ts, chapterId],
    });
    statements.splice(2, 0, {
      sql: `UPDATE continuation_check_results
        SET resolution_status = 'obsolete', updated_at = ?
        WHERE chapter_id = ? AND resolution_status = 'open'`,
      params: [ts, chapterId],
    });
  }
  await executeTransaction(
    db,
    statements,
  );
  processContinuationOutbox({ limit: 1 }).catch(() => {});
}

/** When chapter content hash changes after finalize — clear finalized linkage. */
export async function onChapterContentChanged(input: {
  projectId: number;
  chapterId: number;
  position: number;
  newContentHash: string;
}): Promise<void> {
  await invalidateContinuationStateFromPosition({
    projectId: input.projectId,
    fromPosition: input.position,
    chapterIds: [input.chapterId],
    reason: `chapter_content_changed:${input.newContentHash.slice(0, 12)}`,
  });
  // Mark open checks on this chapter obsolete via run linkage is handled by
  // chapter-level proposal invalidation above.
}
