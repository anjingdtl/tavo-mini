/**
 * Phase 3–facing Canon read API (Spec §13, §22).
 *
 * UI and Phase 3 MUST use this service only — never query Canon tables directly.
 * Every public method validates active snapshot id + revision in one read path.
 */
import type { SourceChapterPosition } from '../../../types/novel';
import { openDatabase } from '../../../data/connection/openDatabase';
import {
  CanonSnapshotOutdatedError,
  type CanonConstraintLevel,
  type CanonContextBundle,
  type CanonEvidenceView,
  type CanonReviewStatus,
  type CanonSnapshot,
  type CharacterExperience,
  type CharacterKnowledge,
  type CharacterProfile,
  type CharacterRelationship,
  type CharacterStateSnapshot,
  type CanonTimelineEvent,
  type PlotThread,
  type PlotThreadStatus,
  type ResolvedCharacterMention,
  type ReviewPolicy,
  type WorldRule,
} from './types';
import {
  getSnapshotByIdInTx,
  listWorldRulesForQuery,
  mapCharacter,
  mapExperience,
  mapKnowledge,
  mapPlotThread,
  mapRelationship,
  mapState,
  mapTimeline,
  mapEvidence,
} from './canonRepository';
import { continuationSourceReader } from '../continuationSourceReader';
import { asUtf16Offset } from '../continuationSourceRepository';
import { normalizeAlias } from './canonEntityResolver';

function statusesForPolicy(policy: ReviewPolicy): CanonReviewStatus[] {
  if (policy === 'strict') return ['confirmed', 'locked'];
  if (policy === 'balanced') return ['confirmed', 'locked', 'pending'];
  return ['confirmed', 'locked', 'pending'];
}

async function assertActiveSnapshot(
  projectId: number,
  snapshotId: string,
  snapshotRevision: number,
): Promise<CanonSnapshot> {
  const db = await openDatabase();
  const [settingsResult] = await db.executeSql(
    'SELECT active_canon_snapshot_id FROM continuation_settings WHERE project_id = ?',
    [projectId],
  );
  if (settingsResult.rows.length === 0) {
    throw new CanonSnapshotOutdatedError('项目无续写设置');
  }
  const activeId = settingsResult.rows.item(0).active_canon_snapshot_id as
    | string
    | null;
  if (!activeId || activeId !== snapshotId) {
    throw new CanonSnapshotOutdatedError('不是当前 active Canon snapshot');
  }
  const snap = await getSnapshotByIdInTx(db, snapshotId);
  if (!snap || snap.status !== 'ready') {
    throw new CanonSnapshotOutdatedError('snapshot 未就绪');
  }
  if (snap.revision !== snapshotRevision) {
    throw new CanonSnapshotOutdatedError('snapshot revision 已变化');
  }
  return snap;
}

function assertPositionInBoundary(
  snap: CanonSnapshot,
  at: SourceChapterPosition,
): void {
  if (at < 0 || at > snap.boundaryPosition) {
    // atSourcePosition is a chapter position; may equal boundary chapter when
    // querying "state at continuation start". Allow <= boundaryPosition.
  }
  if (at > snap.boundaryPosition) {
    throw new Error('查询位置越过 Canon boundary');
  }
}

export const CanonQueryService = {
  async getActiveSnapshot(projectId: number): Promise<CanonSnapshot> {
    const db = await openDatabase();
    const [settingsResult] = await db.executeSql(
      'SELECT active_canon_snapshot_id FROM continuation_settings WHERE project_id = ?',
      [projectId],
    );
    if (settingsResult.rows.length === 0) {
      throw new CanonSnapshotOutdatedError('项目无续写设置');
    }
    const activeId = settingsResult.rows.item(0).active_canon_snapshot_id as
      | string
      | null;
    if (!activeId) {
      throw new CanonSnapshotOutdatedError('没有 active Canon snapshot');
    }
    const snap = await getSnapshotByIdInTx(db, activeId);
    if (!snap || snap.status !== 'ready') {
      throw new CanonSnapshotOutdatedError('active snapshot 不可用');
    }
    return snap;
  },

  async getWorldRules(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    atSourcePosition: SourceChapterPosition;
    levels?: CanonConstraintLevel[];
    reviewStatuses?: CanonReviewStatus[];
    query?: string;
    limit?: number;
  }): Promise<WorldRule[]> {
    const snap = await assertActiveSnapshot(
      input.projectId,
      input.snapshotId,
      input.snapshotRevision,
    );
    assertPositionInBoundary(snap, input.atSourcePosition);
    const db = await openDatabase();
    const statuses =
      input.reviewStatuses ?? statusesForPolicy('balanced');
    let rows = await listWorldRulesForQuery(
      db,
      input.snapshotId,
      input.atSourcePosition,
      statuses,
      input.limit ?? 50,
    );
    if (input.levels?.length) {
      const set = new Set(input.levels);
      rows = rows.filter(r => set.has(r.constraintLevel));
    }
    if (input.query) {
      const q = input.query.toLowerCase();
      rows = rows.filter(
        r =>
          r.title.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q),
      );
    }
    return rows;
  },

  async resolveCharacters(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    text: string;
    atSourcePosition: SourceChapterPosition;
  }): Promise<ResolvedCharacterMention[]> {
    const snap = await assertActiveSnapshot(
      input.projectId,
      input.snapshotId,
      input.snapshotRevision,
    );
    assertPositionInBoundary(snap, input.atSourcePosition);
    const db = await openDatabase();
    const [chars] = await db.executeSql(
      `SELECT id, canonical_name FROM canon_characters
        WHERE snapshot_id = ? AND review_status NOT IN ('ignored', 'superseded')`,
      [input.snapshotId],
    );
    const [aliases] = await db.executeSql(
      `SELECT character_id, alias, alias_normalized, is_ambiguous, valid_from_position, valid_to_position
        FROM canon_character_aliases
        WHERE snapshot_id = ? AND review_status NOT IN ('ignored', 'superseded')`,
      [input.snapshotId],
    );

    type Cand = { characterId: number; name: string; norm: string };
    const catalog: Cand[] = [];
    for (let i = 0; i < chars.rows.length; i++) {
      const r = chars.rows.item(i);
      catalog.push({
        characterId: r.id,
        name: r.canonical_name,
        norm: normalizeAlias(r.canonical_name),
      });
    }
    for (let i = 0; i < aliases.rows.length; i++) {
      const r = aliases.rows.item(i);
      const from = r.valid_from_position as number;
      const to = r.valid_to_position as number | null;
      if (input.atSourcePosition < from) continue;
      if (to != null && input.atSourcePosition >= to) continue;
      catalog.push({
        characterId: r.character_id,
        name: r.alias,
        norm: r.alias_normalized || normalizeAlias(r.alias),
      });
    }

    // Longest-match first (Spec §6.7, §8.3).
    catalog.sort((a, b) => b.norm.length - a.norm.length);
    const text = input.text;
    const occupied = new Array(text.length).fill(false);
    const mentions: ResolvedCharacterMention[] = [];

    for (const cand of catalog) {
      if (!cand.norm) continue;
      let from = 0;
      while (from < text.length) {
        const idx = text.indexOf(cand.name, from);
        if (idx < 0) break;
        const end = idx + cand.name.length;
        let blocked = false;
        for (let i = idx; i < end; i++) {
          if (occupied[i]) {
            blocked = true;
            break;
          }
        }
        if (!blocked) {
          for (let i = idx; i < end; i++) occupied[i] = true;
          // Collect other candidates that also match this span.
          const others = catalog.filter(
            c =>
              c.name === cand.name ||
              (c.norm === cand.norm && c.characterId !== cand.characterId),
          );
          const uniqueIds = new Map<number, Cand>();
          for (const o of others.length ? others : [cand]) {
            uniqueIds.set(o.characterId, o);
          }
          const candidates = Array.from(uniqueIds.values()).map(c => ({
            characterId: c.characterId,
            name: c.name,
            confidence: uniqueIds.size > 1 ? 0.4 : 0.9,
          }));
          mentions.push({
            text: cand.name,
            start: idx,
            end,
            characterId: candidates.length === 1 ? candidates[0].characterId : null,
            candidates,
            ambiguous: candidates.length > 1,
          });
        }
        from = idx + 1;
      }
    }
    mentions.sort((a, b) => a.start - b.start);
    return mentions;
  },

  async getCharacterProfiles(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    characterIds: number[];
  }): Promise<CharacterProfile[]> {
    await assertActiveSnapshot(
      input.projectId,
      input.snapshotId,
      input.snapshotRevision,
    );
    if (input.characterIds.length === 0) return [];
    const db = await openDatabase();
    const ph = input.characterIds.map(() => '?').join(',');
    const [result] = await db.executeSql(
      `SELECT * FROM canon_characters
        WHERE snapshot_id = ? AND id IN (${ph})
          AND review_status NOT IN ('ignored', 'superseded')`,
      [input.snapshotId, ...input.characterIds],
    );
    const out: CharacterProfile[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      out.push(mapCharacter(result.rows.item(i)));
    }
    return out;
  },

  async getCharacterStates(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    characterIds: number[];
    atSourcePosition: SourceChapterPosition;
  }): Promise<CharacterStateSnapshot[]> {
    const snap = await assertActiveSnapshot(
      input.projectId,
      input.snapshotId,
      input.snapshotRevision,
    );
    assertPositionInBoundary(snap, input.atSourcePosition);
    if (input.characterIds.length === 0) return [];
    const db = await openDatabase();
    const out: CharacterStateSnapshot[] = [];
    for (const cid of input.characterIds) {
      const [result] = await db.executeSql(
        `SELECT * FROM canon_character_state_snapshots
          WHERE snapshot_id = ? AND character_id = ?
            AND chapter_position <= ?
            AND review_status NOT IN ('ignored', 'superseded')
          ORDER BY chapter_position DESC, revision DESC, id DESC
          LIMIT 1`,
        [input.snapshotId, cid, input.atSourcePosition],
      );
      if (result.rows.length > 0) {
        out.push(mapState(result.rows.item(0)));
      }
    }
    return out;
  },

  async getRelationships(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    characterIds: number[];
    atSourcePosition: SourceChapterPosition;
    maxDepth: 1 | 2;
  }): Promise<CharacterRelationship[]> {
    const snap = await assertActiveSnapshot(
      input.projectId,
      input.snapshotId,
      input.snapshotRevision,
    );
    assertPositionInBoundary(snap, input.atSourcePosition);
    if (input.characterIds.length === 0) return [];
    const db = await openDatabase();
    const seed = new Set(input.characterIds);
    const ph = input.characterIds.map(() => '?').join(',');
    const [result] = await db.executeSql(
      `SELECT * FROM canon_relationships
        WHERE snapshot_id = ?
          AND review_status NOT IN ('ignored', 'superseded')
          AND valid_from_position <= ?
          AND (valid_to_position IS NULL OR valid_to_position > ?)
          AND (source_character_id IN (${ph}) OR target_character_id IN (${ph}))
        ORDER BY confidence DESC, id ASC
        LIMIT 200`,
      [
        input.snapshotId,
        input.atSourcePosition,
        input.atSourcePosition,
        ...input.characterIds,
        ...input.characterIds,
      ],
    );
    let out: CharacterRelationship[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      out.push(mapRelationship(result.rows.item(i)));
    }
    if (input.maxDepth === 2) {
      const neighborIds = new Set<number>();
      for (const r of out) {
        if (!seed.has(r.sourceCharacterId)) neighborIds.add(r.sourceCharacterId);
        if (!seed.has(r.targetCharacterId)) neighborIds.add(r.targetCharacterId);
      }
      if (neighborIds.size > 0) {
        const ids = Array.from(neighborIds);
        const ph2 = ids.map(() => '?').join(',');
        const [r2] = await db.executeSql(
          `SELECT * FROM canon_relationships
            WHERE snapshot_id = ?
              AND review_status NOT IN ('ignored', 'superseded')
              AND valid_from_position <= ?
              AND (valid_to_position IS NULL OR valid_to_position > ?)
              AND (source_character_id IN (${ph2}) OR target_character_id IN (${ph2}))
            LIMIT 200`,
          [input.snapshotId, input.atSourcePosition, input.atSourcePosition, ...ids, ...ids],
        );
        const seen = new Set(out.map(x => x.id));
        for (let i = 0; i < r2.rows.length; i++) {
          const row = mapRelationship(r2.rows.item(i));
          if (!seen.has(row.id)) out.push(row);
        }
      }
    }
    return out;
  },

  async getCharacterExperiences(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    characterIds: number[];
    atSourcePosition: SourceChapterPosition;
    query?: string;
    limit: number;
  }): Promise<CharacterExperience[]> {
    const snap = await assertActiveSnapshot(
      input.projectId,
      input.snapshotId,
      input.snapshotRevision,
    );
    assertPositionInBoundary(snap, input.atSourcePosition);
    if (input.characterIds.length === 0) return [];
    const db = await openDatabase();
    const ph = input.characterIds.map(() => '?').join(',');
    const [result] = await db.executeSql(
      `SELECT * FROM canon_character_experiences
        WHERE snapshot_id = ?
          AND character_id IN (${ph})
          AND chapter_position <= ?
          AND review_status NOT IN ('ignored', 'superseded')
        ORDER BY chapter_position DESC, importance DESC, id DESC
        LIMIT ?`,
      [input.snapshotId, ...input.characterIds, input.atSourcePosition, input.limit],
    );
    let out: CharacterExperience[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      out.push(mapExperience(result.rows.item(i)));
    }
    if (input.query) {
      const q = input.query.toLowerCase();
      out = out.filter(
        e =>
          e.title.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q),
      );
    }
    return out;
  },

  async getCharacterKnowledge(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    characterIds: number[];
    atSourcePosition: SourceChapterPosition;
  }): Promise<CharacterKnowledge[]> {
    const snap = await assertActiveSnapshot(
      input.projectId,
      input.snapshotId,
      input.snapshotRevision,
    );
    assertPositionInBoundary(snap, input.atSourcePosition);
    if (input.characterIds.length === 0) return [];
    const db = await openDatabase();
    const ph = input.characterIds.map(() => '?').join(',');
    const [result] = await db.executeSql(
      `SELECT * FROM canon_character_knowledge
        WHERE snapshot_id = ?
          AND character_id IN (${ph})
          AND valid_from_position <= ?
          AND (valid_to_position IS NULL OR valid_to_position > ?)
          AND review_status NOT IN ('ignored', 'superseded')
        ORDER BY id ASC`,
      [
        input.snapshotId,
        ...input.characterIds,
        input.atSourcePosition,
        input.atSourcePosition,
      ],
    );
    const out: CharacterKnowledge[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      out.push(mapKnowledge(result.rows.item(i)));
    }
    return out;
  },

  async getPlotThreads(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    atSourcePosition: SourceChapterPosition;
    characterIds?: number[];
    statuses?: PlotThreadStatus[];
    limit: number;
  }): Promise<PlotThread[]> {
    const snap = await assertActiveSnapshot(
      input.projectId,
      input.snapshotId,
      input.snapshotRevision,
    );
    assertPositionInBoundary(snap, input.atSourcePosition);
    const db = await openDatabase();
    const [result] = await db.executeSql(
      `SELECT * FROM canon_plot_threads
        WHERE snapshot_id = ?
          AND start_position <= ?
          AND review_status NOT IN ('ignored', 'superseded')
        ORDER BY importance DESC, last_advanced_position DESC, id ASC
        LIMIT ?`,
      [input.snapshotId, input.atSourcePosition, input.limit],
    );
    let out: PlotThread[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      out.push(mapPlotThread(result.rows.item(i)));
    }
    if (input.statuses?.length) {
      const set = new Set(input.statuses);
      out = out.filter(p => set.has(p.status));
    }
    if (input.characterIds?.length) {
      const wanted = new Set(input.characterIds);
      const filtered: PlotThread[] = [];
      for (const p of out) {
        const [links] = await db.executeSql(
          `SELECT character_id FROM canon_plot_thread_characters
            WHERE snapshot_id = ? AND plot_thread_id = ?`,
          [input.snapshotId, p.id],
        );
        for (let i = 0; i < links.rows.length; i++) {
          if (wanted.has(links.rows.item(i).character_id)) {
            filtered.push(p);
            break;
          }
        }
      }
      out = filtered;
    }
    return out;
  },

  async getTimelineEvents(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    atSourcePosition: SourceChapterPosition;
    characterIds?: number[];
    limit: number;
  }): Promise<CanonTimelineEvent[]> {
    const snap = await assertActiveSnapshot(
      input.projectId,
      input.snapshotId,
      input.snapshotRevision,
    );
    assertPositionInBoundary(snap, input.atSourcePosition);
    const db = await openDatabase();
    const [result] = await db.executeSql(
      `SELECT * FROM canon_timeline_events
        WHERE snapshot_id = ?
          AND chapter_position <= ?
          AND review_status NOT IN ('ignored', 'superseded')
        ORDER BY chapter_position DESC, importance DESC, id DESC
        LIMIT ?`,
      [input.snapshotId, input.atSourcePosition, input.limit],
    );
    let out: CanonTimelineEvent[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      out.push(mapTimeline(result.rows.item(i)));
    }
    if (input.characterIds?.length) {
      const wanted = new Set(input.characterIds);
      out = out.filter(e => {
        try {
          const ids = JSON.parse(e.participantCharacterIdsJson) as number[];
          return ids.some(id => wanted.has(id));
        } catch {
          return false;
        }
      });
    }
    return out;
  },

  async readEvidence(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    evidenceId: number;
  }): Promise<CanonEvidenceView> {
    await assertActiveSnapshot(
      input.projectId,
      input.snapshotId,
      input.snapshotRevision,
    );
    const db = await openDatabase();
    const [result] = await db.executeSql(
      'SELECT * FROM canon_evidence WHERE id = ? AND snapshot_id = ?',
      [input.evidenceId, input.snapshotId],
    );
    if (result.rows.length === 0) throw new Error('证据不存在');
    const base = mapEvidence(result.rows.item(0));
    const sourceSnapshot = await continuationSourceReader.getSnapshot(
      input.projectId,
    );
    const quoteFull = await continuationSourceReader.readBoundedEvidenceRange({
      snapshot: sourceSnapshot,
      start: asUtf16Offset(base.charStart),
      end: asUtf16Offset(base.charEnd),
    });
    return { ...base, quoteFull };
  },

  async getContextBundle(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    atSourcePosition: SourceChapterPosition;
    queryText: string;
    characterIds: number[];
    tokenBudget: number;
    reviewPolicy: ReviewPolicy;
  }): Promise<CanonContextBundle> {
    const snap = await assertActiveSnapshot(
      input.projectId,
      input.snapshotId,
      input.snapshotRevision,
    );
    assertPositionInBoundary(snap, input.atSourcePosition);
    const statuses = statusesForPolicy(input.reviewPolicy);
    const omitted: Record<string, number> = {};

    const worldRules = await this.getWorldRules({
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
      atSourcePosition: input.atSourcePosition,
      reviewStatuses: statuses.filter(s => s !== 'pending') as CanonReviewStatus[],
      limit: 20,
    });

    // balanced: also allow high-confidence pending as weak refs
    let pendingRules: WorldRule[] = [];
    if (input.reviewPolicy === 'balanced' || input.reviewPolicy === 'loose') {
      pendingRules = (
        await this.getWorldRules({
          projectId: input.projectId,
          snapshotId: input.snapshotId,
          snapshotRevision: input.snapshotRevision,
          atSourcePosition: input.atSourcePosition,
          reviewStatuses: ['pending'],
          limit: 10,
        })
      ).filter(r => r.confidence >= 0.75);
    }

    const mentions = await this.resolveCharacters({
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
      text: input.queryText,
      atSourcePosition: input.atSourcePosition,
    });
    const resolvedIds = new Set(input.characterIds);
    for (const m of mentions) {
      if (m.characterId) resolvedIds.add(m.characterId);
    }
    const characterIds = Array.from(resolvedIds);

    const characters = await this.getCharacterProfiles({
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
      characterIds,
    });
    const characterStates = await this.getCharacterStates({
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
      characterIds,
      atSourcePosition: input.atSourcePosition,
    });
    const relationships = await this.getRelationships({
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
      characterIds,
      atSourcePosition: input.atSourcePosition,
      maxDepth: 1,
    });
    const experiences = await this.getCharacterExperiences({
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
      characterIds,
      atSourcePosition: input.atSourcePosition,
      limit: 20,
    });
    const knowledge = await this.getCharacterKnowledge({
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
      characterIds,
      atSourcePosition: input.atSourcePosition,
    });
    const plotThreads = await this.getPlotThreads({
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
      atSourcePosition: input.atSourcePosition,
      characterIds,
      limit: 15,
    });
    // Timeline blocking only confirmed/locked in strict (Spec §6.14).
    const timelineStatuses =
      input.reviewPolicy === 'strict'
        ? (['confirmed', 'locked'] as CanonReviewStatus[])
        : statuses;
    let timelineEvents = await this.getTimelineEvents({
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
      atSourcePosition: input.atSourcePosition,
      characterIds,
      limit: 20,
    });
    timelineEvents = timelineEvents.filter(e =>
      timelineStatuses.includes(e.reviewStatus),
    );

    const allRules = [...worldRules, ...pendingRules];
    // Token budget trim (rough CJK estimate: 1 token ≈ 1.5 chars).
    const estimate = (s: string) => Math.ceil(s.length / 1.5);
    let used = 0;
    const pack = <T extends { id: number }>(
      items: T[],
      serialize: (t: T) => string,
      key: string,
    ): T[] => {
      const kept: T[] = [];
      for (const item of items) {
        const cost = estimate(serialize(item));
        if (used + cost > input.tokenBudget) {
          omitted[key] = (omitted[key] ?? 0) + 1;
          continue;
        }
        used += cost;
        kept.push(item);
      }
      return kept;
    };

    const bundle: CanonContextBundle = {
      snapshot: snap,
      worldRules: pack(allRules, r => r.title + r.description, 'worldRules'),
      characters: pack(characters, c => c.canonicalName + c.description, 'characters'),
      characterStates: pack(characterStates, s => s.summary, 'characterStates'),
      relationships: pack(relationships, r => r.description + r.relationType, 'relationships'),
      experiences: pack(experiences, e => e.title + e.description, 'experiences'),
      knowledge: pack(knowledge, k => k.factSummary, 'knowledge'),
      plotThreads: pack(plotThreads, p => p.title + p.description, 'plotThreads'),
      timelineEvents: pack(timelineEvents, t => t.title + t.summary, 'timelineEvents'),
      evidenceRefs: [],
      estimatedTokens: used,
      omittedReasonCounts: omitted,
    };
    return bundle;
  },
};

export type { CanonSnapshot, CanonContextBundle };
