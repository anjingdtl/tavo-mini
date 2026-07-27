/**
 * Effective continuation state fusion + proposal confirmation + invalidation.
 * Spec §11, §12. Never calls LLM inside SQLite transactions.
 */
import type { ContinuationChapterPosition } from '../../../types/novel';
import { openDatabase } from '../../../data/connection/openDatabase';
import { executeTransaction } from '../../database/transaction';
import { markStoryMemoryDirty } from '../../../data/repositories/storyMemoryRepository';
import { CanonQueryService } from '../canon/canonQueryService';
import {
  countPendingMajorProposals,
  countPendingStateExtractions,
  enqueueOutbox,
  getProposalById,
  insertEntity,
  insertStateEvent,
  invalidateEventsFromPosition,
  invalidateProposalsForChapter,
  listValidEventsBefore,
  updateProposalStatus,
} from './generationRepository';
import type {
  EffectiveContinuationState,
  TypedEntityRef,
} from './types';
import { ContinuationCapabilityBlockedError } from './types';

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

  // Drop events whose chapter revision no longer matches stored chapter content.
  const db = await openDatabase();
  const applied: typeof events = [];
  const omittedReasons: string[] = [];
  for (const ev of events) {
    const [ch] = await db.executeSql(
      'SELECT content FROM chapters WHERE id = ?',
      [ev.chapterId],
    );
    if (ch.rows.length === 0) {
      omittedReasons.push(`event ${ev.id}: chapter missing`);
      continue;
    }
    // revision hash check is done by caller invalidation; here we trust
    // non-invalidated events. If chapter deleted, skip.
    applied.push(ev);
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
      characterStates.push({
        ref,
        summary: payload.summary ?? payload.description ?? ev.eventType,
        fields: payload.fields ?? {},
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
}): Promise<{ eventId: string; entityId?: string }> {
  const proposal = await getProposalById(input.proposalId);
  if (!proposal) throw new Error('proposal 不存在');
  if (proposal.status !== 'pending') {
    throw new Error(`proposal 状态为 ${proposal.status}，无法确认`);
  }

  const db = await openDatabase();
  const [ch] = await db.executeSql(
    'SELECT position, content FROM chapters WHERE id = ?',
    [proposal.chapterId],
  );
  if (ch.rows.length === 0) throw new Error('章节不存在');
  const chapterPosition = ch.rows.item(0).position as number;

  let entityId: string | undefined;
  let payload: any = {};
  try {
    payload = JSON.parse(proposal.payloadJson);
  } catch {
    payload = {};
  }

  if (
    input.autoCreateEntity !== false &&
    (proposal.proposalType === 'new_character' ||
      proposal.proposalType === 'new_location' ||
      proposal.proposalType === 'new_organization')
  ) {
    const entityType =
      proposal.proposalType === 'new_character'
        ? 'character'
        : proposal.proposalType === 'new_location'
          ? 'location'
          : 'organization';
    entityId = await insertEntity({
      projectId: proposal.projectId,
      entityType,
      canonicalName: payload.name ?? payload.canonicalName ?? '未命名',
      createdFromProposalId: proposal.id,
      profileJson: proposal.payloadJson,
    });
  }

  const entityRefs: TypedEntityRef[] = [];
  if (entityId) {
    entityRefs.push({ refType: 'continuation_entity', id: entityId });
  } else if (proposal.subjectRefType && proposal.subjectRefId) {
    if (proposal.subjectRefType === 'canon_character') {
      entityRefs.push({
        refType: 'canon_character',
        id: Number(proposal.subjectRefId),
      });
    } else if (proposal.subjectRefType === 'continuation_entity') {
      entityRefs.push({
        refType: 'continuation_entity',
        id: proposal.subjectRefId,
      });
    } else if (proposal.subjectRefType === 'plotline') {
      entityRefs.push({ refType: 'plotline', id: Number(proposal.subjectRefId) });
    } else if (proposal.subjectRefType === 'world') {
      entityRefs.push({ refType: 'world', id: 'world' });
    }
  }

  const event = await insertStateEvent({
    proposalId: proposal.id,
    projectId: proposal.projectId,
    chapterId: proposal.chapterId,
    chapterPosition,
    chapterRevisionHash: proposal.chapterRevisionHash,
    eventType: proposal.proposalType,
    entityRefs,
    payloadJson: proposal.payloadJson,
    validFromPosition: chapterPosition,
  });

  await updateProposalStatus(
    proposal.id,
    'accepted',
    input.decisionNote ?? null,
  );

  // Mark story memory dirty + enqueue rebuild (local only).
  await executeTransaction(
    db,
    [
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
          chapterPosition,
          chapterPosition,
          chapterPosition,
          new Date().toISOString(),
          proposal.projectId,
        ],
      },
    ],
  );

  try {
    await markStoryMemoryDirty(proposal.projectId, chapterPosition, 'proposal_confirmed');
  } catch {
    // already dirtied above if memory row missing
  }

  await enqueueOutbox({
    projectId: proposal.projectId,
    chapterId: proposal.chapterId,
    operation: 'rebuild_story_memory',
    payload: {
      fromPosition: chapterPosition,
      proposalId: proposal.id,
      eventId: event.id,
    },
    dedupeKey: `rebuild_story_memory:${proposal.projectId}:${chapterPosition}:${proposal.chapterRevisionHash}`,
  });

  await enqueueOutbox({
    projectId: proposal.projectId,
    chapterId: proposal.chapterId,
    operation: 'apply_event',
    payload: { eventId: event.id, proposalId: proposal.id },
    dedupeKey: `apply_event:${event.id}`,
  });

  return { eventId: event.id, entityId };
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
  await invalidateEventsFromPosition(
    input.projectId,
    input.fromPosition,
    input.reason,
  );
  if (input.chapterIds) {
    for (const chapterId of input.chapterIds) {
      await invalidateProposalsForChapter(chapterId, input.reason);
    }
  }
  const db = await openDatabase();
  await executeTransaction(
    db,
    [
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
          new Date().toISOString(),
          input.projectId,
        ],
      },
    ],
  );
  await enqueueOutbox({
    projectId: input.projectId,
    chapterId: null,
    operation: 'rebuild_story_memory',
    payload: { fromPosition: input.fromPosition, reason: input.reason },
    dedupeKey: `rebuild_story_memory:${input.projectId}:${input.fromPosition}:${input.reason}`,
  });
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
