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

  let entityType: 'character' | 'location' | 'organization' | undefined;
  let entityName: string | undefined;
  if (
    input.autoCreateEntity !== false &&
    (proposal.proposalType === 'new_character' ||
      proposal.proposalType === 'new_location' ||
      proposal.proposalType === 'new_organization')
  ) {
    entityType =
      proposal.proposalType === 'new_character'
        ? 'character'
        : proposal.proposalType === 'new_location'
          ? 'location'
          : 'organization';
    entityId = `cen_${v4().replace(/-/g, '')}`;
    entityName = payload.name ?? payload.canonicalName ?? '未命名';
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

  const eventId = `ce_${v4().replace(/-/g, '')}`;
  const rebuildOutboxId = `co_${v4().replace(/-/g, '')}`;
  const applyOutboxId = `co_${v4().replace(/-/g, '')}`;
  const ts = new Date().toISOString();
  const rebuildDedupeKey = `rebuild_story_memory:${proposal.projectId}:${chapterPosition}:${proposal.chapterRevisionHash}`;

  // Proposal decision, resulting event, memory invalidation and both outbox
  // records form one durable local commit. No LLM work occurs in this tx.
  await executeTransaction(
    db,
    [
      ...(entityId && entityType && entityName
        ? [{
            sql: `INSERT INTO continuation_entities (
              id, project_id, entity_type, canonical_name, profile_json,
              created_from_proposal_id, status, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?)`,
            params: [
              entityId,
              proposal.projectId,
              entityType,
              entityName,
              proposal.payloadJson,
              proposal.id,
              'active',
              ts,
              ts,
            ],
          }]
        : []),
      {
        sql: `INSERT INTO continuation_state_events (
          id, proposal_id, project_id, chapter_id, chapter_position,
          chapter_revision_hash, event_type, entity_refs_json, payload_json,
          valid_from_position, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          eventId,
          proposal.id,
          proposal.projectId,
          proposal.chapterId,
          chapterPosition,
          proposal.chapterRevisionHash,
          proposal.proposalType,
          JSON.stringify(entityRefs),
          proposal.payloadJson,
          chapterPosition,
          ts,
        ],
      },
      {
        sql: `UPDATE continuation_state_proposals
          SET status = 'accepted', decision_note = ?, decided_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
        params: [input.decisionNote ?? null, ts, ts, proposal.id],
      },
      {
        sql: 'INSERT OR IGNORE INTO project_story_memory (project_id, updated_at) VALUES (?, ?)',
        params: [proposal.projectId, ts],
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
          chapterPosition,
          chapterPosition,
          chapterPosition,
          ts,
          proposal.projectId,
        ],
      },
      {
        sql: `INSERT OR IGNORE INTO continuation_state_sync_outbox (
          id, project_id, chapter_id, operation, payload_json, dedupe_key,
          state, attempt_count, created_at, updated_at
        ) VALUES (?,?,?,?,?,?, 'pending', 0, ?, ?)`,
        params: [
          rebuildOutboxId,
          proposal.projectId,
          proposal.chapterId,
          'rebuild_story_memory',
          JSON.stringify({
            fromPosition: chapterPosition,
            proposalId: proposal.id,
            eventId,
          }),
          rebuildDedupeKey,
          ts,
          ts,
        ],
      },
      {
        sql: `INSERT OR IGNORE INTO continuation_state_sync_outbox (
          id, project_id, chapter_id, operation, payload_json, dedupe_key,
          state, attempt_count, created_at, updated_at
        ) VALUES (?,?,?,?,?,?, 'pending', 0, ?, ?)`,
        params: [
          applyOutboxId,
          proposal.projectId,
          proposal.chapterId,
          'apply_event',
          JSON.stringify({ eventId, proposalId: proposal.id }),
          `apply_event:${eventId}`,
          ts,
          ts,
        ],
      },
    ],
  );
  processContinuationOutbox({ limit: 2 }).catch(() => {});
  return { eventId, entityId };
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
    {
      sql: `INSERT OR IGNORE INTO continuation_state_sync_outbox (
        id, project_id, chapter_id, operation, payload_json, dedupe_key,
        state, attempt_count, created_at, updated_at
      ) VALUES (?,?,?,?,?,?, 'pending', 0, ?, ?)`,
      params: [
        outboxId,
        input.projectId,
        null,
        'rebuild_story_memory',
        JSON.stringify({ fromPosition: input.fromPosition, reason: input.reason }),
        `rebuild_story_memory:${input.projectId}:${input.fromPosition}:${input.reason}`,
        ts,
        ts,
      ],
    },
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
