/**
 * Durable Continuity State commit. No LLM. Does not import the outbox worker
 * so extract_state auto-commit can call it without a cycle.
 */
import { openDatabase } from '../../../data/connection/openDatabase';
import { executeTransaction } from '../../database/transaction';
import { v4 } from '../../uuidBridge';
import {
  buildOutboxInsertStatement,
  getProposalById,
} from './generationRepository';
import type { TypedEntityRef } from './types';

export async function commitAcceptedProposal(input: {
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
  const rebuildDedupeKey =
    `rebuild_story_memory:${proposal.projectId}:${chapterPosition}:${proposal.chapterRevisionHash}:${eventId}`;

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
      buildOutboxInsertStatement({
        id: rebuildOutboxId,
        projectId: proposal.projectId,
        chapterId: proposal.chapterId,
        operation: 'rebuild_story_memory',
        payload: {
          fromPosition: chapterPosition,
          proposalId: proposal.id,
          eventId,
        },
        dedupeKey: rebuildDedupeKey,
        ts,
      }),
      buildOutboxInsertStatement({
        id: applyOutboxId,
        projectId: proposal.projectId,
        chapterId: proposal.chapterId,
        operation: 'apply_event',
        payload: { eventId, proposalId: proposal.id },
        dedupeKey: `apply_event:${eventId}`,
        ts,
      }),
    ],
  );
  return { eventId, entityId };
}
