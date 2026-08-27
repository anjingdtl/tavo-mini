/**
 * Historical memory is deliberately separate from Canon facts and evidence.
 * It provides local candidate lookup and explicitly-started LLM summaries.
 */
import { openDatabase } from '../../../data/connection/openDatabase';
import { execute } from '../../../data/connection/execute';
import { executeTransaction } from '../../../data/connection/transaction';
import { now } from '../../../data/repositories/shared';
import { v4 } from '../../uuidBridge';
import {
  callLLMResult,
  resolveLLMRequestConfig,
  resolveLLMRequestConfigById,
} from '../../llm';
import type { LLMRequestConfig } from '../../llm/types';
import {
  resolveProviderOutputBudget,
  type ProviderCapabilityConfig,
} from '../../llm/providerCapabilities';
import { continuationSourceReader } from '../continuationSourceReader';
import type { BoundedSourceChapter } from '../types';
import { CanonQueryService } from './canonQueryService';
import type { HistoricalChapterCandidate, HistoricalDigest } from './types';

const LEGACY_HISTORY_INPUT_CHAR_BUDGET = 18_000;
const HISTORY_PROMPT_OVERHEAD_TOKENS = 1_200;
type Row = Record<string, any>;

export interface HistoricalDigestCoverage {
  readyDigestCount: number;
  readyChapterCount: number;
  ranges: Array<{ startPosition: number; endPosition: number }>;
}

/** Merge ready digest ranges so overlapping retry/legacy rows never inflate UI coverage. */
export function summarizeHistoricalDigestCoverage(
  digests: Array<
    Pick<HistoricalDigest, 'status' | 'startPosition' | 'endPosition'>
  >,
): HistoricalDigestCoverage {
  const ready = digests
    .filter(digest => digest.status === 'ready')
    .map(digest => ({
      startPosition: Number(digest.startPosition),
      endPosition: Number(digest.endPosition),
    }))
    .filter(range => range.endPosition > range.startPosition)
    .sort((a, b) => a.startPosition - b.startPosition);
  const ranges: HistoricalDigestCoverage['ranges'] = [];
  for (const range of ready) {
    const previous = ranges[ranges.length - 1];
    if (previous && range.startPosition <= previous.endPosition) {
      previous.endPosition = Math.max(previous.endPosition, range.endPosition);
    } else {
      ranges.push({ ...range });
    }
  }
  return {
    readyDigestCount: ready.length,
    readyChapterCount: ranges.reduce(
      (total, range) => total + range.endPosition - range.startPosition,
      0,
    ),
    ranges,
  };
}

function mapDigest(row: Row): HistoricalDigest {
  let keywords: string[] = [];
  try {
    const value = JSON.parse(row.keywords_json || '[]');
    keywords = Array.isArray(value) ? value.filter(x => typeof x === 'string') : [];
  } catch {}
  return {
    id: row.id, projectId: row.project_id, sourceId: row.source_id,
    sourceVersion: row.source_version, sourceSha256: row.source_sha256,
    parserVersion: row.parser_version, normalizationVersion: row.normalization_version,
    boundaryChapterId: row.boundary_chapter_id, boundaryPosition: row.boundary_position,
    boundaryCharOffsetExclusive: row.boundary_char_offset_exclusive,
    startPosition: row.start_position, endPosition: row.end_position, status: row.status,
    summary: row.summary || '', keywords, modelConfigId: row.model_config_id ?? null,
    errorCode: row.error_code ?? null, errorMessage: row.error_message ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at ?? null,
  };
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '').slice(0, 80);
}

function terms(value: string): string[] {
  return Array.from(new Set((value.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z][a-zA-Z0-9_-]{1,}/g) ?? [])
    .map(normalize).filter(x => x.length >= 2))).slice(0, 12);
}

function chapterTerms(chapter: BoundedSourceChapter): Array<{ display: string; normalized: string; kind: 'title' | 'name' }> {
  const raw = [chapter.title, ...(chapter.content.match(/[\u4e00-\u9fff]{2,8}|[a-zA-Z][a-zA-Z0-9_-]{1,}/g) ?? []).slice(0, 30)];
  const result = new Map<string, { display: string; normalized: string; kind: 'title' | 'name' }>();
  for (const display of raw) {
    const normalized = normalize(display);
    if (normalized.length >= 2) result.set(normalized, { display: display.slice(0, 80), normalized, kind: display === chapter.title ? 'title' : 'name' });
  }
  return Array.from(result.values()).slice(0, 24);
}

export function resolveHistoricalDigestInputCharBudget(
  contextWindow: number | null | undefined,
  maxOutputTokens: number | null | undefined,
  providerConfig?: ProviderCapabilityConfig,
): number {
  if (!Number.isFinite(contextWindow) || (contextWindow ?? 0) <= 0) {
    return LEGACY_HISTORY_INPUT_CHAR_BUDGET;
  }
  const outputReserve = resolveHistoricalDigestMaxTokens(
    maxOutputTokens,
    providerConfig,
  );
  return Math.max(
    LEGACY_HISTORY_INPUT_CHAR_BUDGET,
    Math.floor(
      ((contextWindow as number) -
        outputReserve -
        HISTORY_PROMPT_OVERHEAD_TOKENS) *
        1.5,
    ),
  );
}

export function resolveHistoricalDigestMaxTokens(
  maxOutputTokens: number | null | undefined,
  providerConfig?: ProviderCapabilityConfig,
): number {
  const config: ProviderCapabilityConfig = providerConfig ?? {
    provider_type: 'openai_compatible',
    model_name: '',
    url: '',
  };
  return resolveProviderOutputBudget({
    config: {
      ...config,
      max_output_tokens: maxOutputTokens,
    },
    requestedMaxTokens: maxOutputTokens,
  }).wireMaxTokens;
}

function splitHistoricalDigestChapters(
  chapters: BoundedSourceChapter[],
  inputCharBudget: number,
): BoundedSourceChapter[][] {
  const groups: BoundedSourceChapter[][] = [];
  let group: BoundedSourceChapter[] = [];
  let used = 0;
  for (const chapter of chapters) {
    const cost = chapter.title.length + chapter.content.length + 32;
    if (group.length > 0 && used + cost > inputCharBudget) {
      groups.push(group);
      group = [];
      used = 0;
    }
    group.push(chapter);
    used += cost;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

function prompt(
  chapters: BoundedSourceChapter[],
  inputCharBudget: number,
): string {
  let used = 0;
  const source: string[] = [];
  for (const chapter of chapters) {
    const excerpt = chapter.content.slice(0, Math.max(0, inputCharBudget - used));
    if (!excerpt) break;
    used += excerpt.length;
    source.push(`【${chapter.position}｜${chapter.title}】\n${excerpt}`);
  }
  return [
    '仅输出 JSON：{"summary":"...","keywords":["..."]}。',
    '概括事件、人物变化、世界规则、未解线索，并保留章节 position。不得杜撰；这是历史概览，不是 Canon 事实或原文证据。',
    source.join('\n\n'),
  ].join('\n\n');
}

/**
 * Historical digests are structured summaries, not reasoning tasks. DeepSeek
 * V4 thinking remains enabled. The caller uses bounded chapter groups and a
 * completion budget large enough for thinking plus the final JSON body.
 */
export function buildHistoricalDigestRequestOptions(
  projectId: number,
  digestId: string,
  requestConfig?: LLMRequestConfig,
) {
  return {
    queueClass: 'pipeline' as const,
    queuePriority: 'normal' as const,
    projectId,
    taskId: digestId,
    scenario: 'continuation_historical_digest',
    responseFormat: 'json_object' as const,
    requestConfig,
  };
}

function parse(raw: string): { summary: string; keywords: string[] } {
  const json = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const value = JSON.parse(json);
  if (!value || typeof value.summary !== 'string') throw new Error('历史摘要返回格式无效');
  return {
    summary: value.summary.trim().slice(0, 12_000),
    keywords: Array.isArray(value.keywords)
      ? value.keywords.filter((x: unknown): x is string => typeof x === 'string').map((x: string) => x.trim()).filter(Boolean).slice(0, 24)
      : [],
  };
}

async function digestChapters(digestId: string) {
  const db = await openDatabase();
  const [result] = await db.executeSql(
    'SELECT chapter_id, chapter_position, chapter_title FROM continuation_historical_digest_chapters WHERE digest_id = ? ORDER BY chapter_position ASC',
    [digestId],
  );
  return Array.from({ length: result.rows.length }, (_, index) => result.rows.item(index) as { chapter_id: number; chapter_position: number; chapter_title: string });
}

/** Queue groups and build the local index. This does not make a network call. */
export async function queueHistoricalDigests(input: {
  projectId: number;
  groupSize?: number;
  modelConfigId?: number | null;
}): Promise<{ digestIds: string[]; indexedChapterCount: number }> {
  const source = await continuationSourceReader.getSnapshot(input.projectId);
  const canon = await CanonQueryService.getActiveSnapshot(input.projectId);
  if (canon.sourceId !== source.sourceId || canon.sourceSha256 !== source.normalizedSha256 ||
    canon.boundaryCharOffsetExclusive !== source.boundary.charOffsetExclusive) {
    throw new Error('当前 Canon 与原著边界不一致，无法建立历史摘要。');
  }
  const ranges = canon.coverage.analyzedRanges ?? [];
  const chapters = (await continuationSourceReader.listBoundedSourceChapters(source))
    .filter(chapter => !ranges.some(range => chapter.position >= range.startPosition && chapter.position < range.endPosition));
  if (!chapters.length) return { digestIds: [], indexedChapterCount: 0 };
  const requestConfig = input.modelConfigId
    ? await resolveLLMRequestConfigById(input.modelConfigId)
    : await resolveLLMRequestConfig();
  const inputCharBudget = resolveHistoricalDigestInputCharBudget(
    requestConfig.context_window,
    requestConfig.max_output_tokens,
    requestConfig,
  );
  const groups = input.groupSize
    ? Array.from(
        { length: Math.ceil(chapters.length / input.groupSize) },
        (_, index) =>
          chapters.slice(
            index * input.groupSize!,
            (index + 1) * input.groupSize!,
          ),
      )
    : splitHistoricalDigestChapters(chapters, inputCharBudget);
  const db = await openDatabase();
  const timestamp = now();
  const ids: string[] = [];
  const statements: Array<{ sql: string; params?: any[] }> = [];
  for (const group of groups) {
    const start = group[0].position as number;
    const end = (group[group.length - 1].position as number) + 1;
    const [existing] = await db.executeSql(
      `SELECT id FROM continuation_historical_digests WHERE project_id = ? AND source_id = ?
       AND boundary_char_offset_exclusive = ? AND start_position = ? AND end_position = ? AND status != 'outdated'`,
      [input.projectId, source.sourceId, source.boundary.charOffsetExclusive, start, end],
    );
    const id = existing.rows.length ? existing.rows.item(0).id : v4();
    ids.push(id);
    if (existing.rows.length) continue;
    statements.push({
      sql: `INSERT INTO continuation_historical_digests (
        id, project_id, source_id, source_version, source_sha256, parser_version, normalization_version,
        boundary_chapter_id, boundary_position, boundary_char_offset_exclusive, start_position, end_position,
        status, summary, keywords_json, model_config_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', '', '[]', ?, ?, ?)`,
      params: [id, input.projectId, source.sourceId, source.sourceVersion, source.normalizedSha256,
        source.parserVersion, source.normalizationVersion, source.boundary.chapterId, source.boundary.chapterPosition,
        source.boundary.charOffsetExclusive, start, end, requestConfig.id, timestamp, timestamp],
    });
    for (const chapter of group) {
      statements.push({ sql: 'INSERT INTO continuation_historical_digest_chapters (digest_id, chapter_id, chapter_position, chapter_title) VALUES (?, ?, ?, ?)', params: [id, chapter.id, chapter.position, chapter.title] });
      for (const term of chapterTerms(chapter)) {
        statements.push({ sql: 'INSERT INTO continuation_historical_index_terms (digest_id, chapter_id, chapter_position, term_normalized, term_display, term_kind) VALUES (?, ?, ?, ?, ?, ?)', params: [id, chapter.id, chapter.position, term.normalized, term.display, term.kind] });
      }
    }
  }
  if (statements.length) await executeTransaction(db, statements);
  return { digestIds: ids, indexedChapterCount: chapters.length };
}

/** Runs exactly one explicitly queued LLM digest. */
export async function processHistoricalDigest(digestId: string): Promise<HistoricalDigest> {
  const db = await openDatabase();
  const [result] = await db.executeSql('SELECT * FROM continuation_historical_digests WHERE id = ?', [digestId]);
  if (!result.rows.length) throw new Error('历史摘要任务不存在');
  const digest = mapDigest(result.rows.item(0));
  if (digest.status === 'ready' || digest.status === 'cancelled') return digest;
  const source = await continuationSourceReader.getSnapshot(digest.projectId);
  const valid = digest.sourceId === source.sourceId && digest.sourceVersion === source.sourceVersion &&
    digest.sourceSha256 === source.normalizedSha256 && digest.parserVersion === source.parserVersion &&
    digest.normalizationVersion === source.normalizationVersion && digest.boundaryChapterId === source.boundary.chapterId &&
    digest.boundaryCharOffsetExclusive === source.boundary.charOffsetExclusive;
  if (!valid) {
    await execute(db, "UPDATE continuation_historical_digests SET status = 'outdated', updated_at = ? WHERE id = ?", [now(), digestId]);
    return { ...digest, status: 'outdated', updatedAt: now() };
  }
  const refIds = new Set((await digestChapters(digestId)).map(row => row.chapter_id));
  const chapters = (await continuationSourceReader.listBoundedSourceChapters(source)).filter(chapter => refIds.has(chapter.id));
  if (!chapters.length) throw new Error('历史摘要没有可读取的边界内章节');
  await execute(db, "UPDATE continuation_historical_digests SET status = 'running', error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?", [now(), digestId]);
  try {
    const requestConfig = digest.modelConfigId
      ? await resolveLLMRequestConfigById(digest.modelConfigId)
      : await resolveLLMRequestConfig();
    const response = await callLLMResult(
      [
        {
          role: 'user',
          content: prompt(
            chapters,
            resolveHistoricalDigestInputCharBudget(
              requestConfig.context_window,
              requestConfig.max_output_tokens,
              requestConfig,
            ),
          ),
        },
      ],
      resolveHistoricalDigestMaxTokens(
        requestConfig.max_output_tokens,
        requestConfig,
      ),
      buildHistoricalDigestRequestOptions(
        digest.projectId,
        digestId,
        requestConfig,
      ),
    );
    const value = parse(response.text ?? '');
    const refs = await digestChapters(digestId);
    const statements: Array<{ sql: string; params?: any[] }> = [{
      sql: "UPDATE continuation_historical_digests SET status = 'ready', summary = ?, keywords_json = ?, error_code = NULL, error_message = NULL, updated_at = ?, completed_at = ? WHERE id = ?",
      params: [value.summary, JSON.stringify(value.keywords), now(), now(), digestId],
    }];
    for (const ref of refs) for (const keyword of value.keywords) {
      const normalized = normalize(keyword);
      if (normalized.length >= 2) statements.push({ sql: "INSERT OR IGNORE INTO continuation_historical_index_terms (digest_id, chapter_id, chapter_position, term_normalized, term_display, term_kind) VALUES (?, ?, ?, ?, ?, 'keyword')", params: [digestId, ref.chapter_id, ref.chapter_position, normalized, keyword.slice(0, 80)] });
    }
    await executeTransaction(db, statements);
    const [fresh] = await db.executeSql('SELECT * FROM continuation_historical_digests WHERE id = ?', [digestId]);
    return mapDigest(fresh.rows.item(0));
  } catch (error) {
    await execute(db, "UPDATE continuation_historical_digests SET status = 'failed', error_code = 'llm_failed', error_message = ?, updated_at = ? WHERE id = ?", [error instanceof Error ? error.message : '历史摘要生成失败', now(), digestId]);
    throw error;
  }
}

export async function listHistoricalDigestReferences(input: { projectId: number; queryText: string; limit?: number }): Promise<HistoricalDigest[]> {
  const wanted = terms(input.queryText);
  if (!wanted.length) return [];
  const source = await continuationSourceReader.getSnapshot(input.projectId);
  const db = await openDatabase();
  const matches = wanted.map(() => 'EXISTS (SELECT 1 FROM continuation_historical_index_terms t WHERE t.digest_id = d.id AND t.term_normalized = ?)').join(' OR ');
  const [result] = await db.executeSql(
    `SELECT d.* FROM continuation_historical_digests d WHERE d.project_id = ? AND d.source_id = ?
      AND d.source_version = ? AND d.source_sha256 = ? AND d.boundary_chapter_id = ?
      AND d.boundary_char_offset_exclusive = ? AND d.status = 'ready' AND (${matches})
      ORDER BY d.end_position DESC LIMIT ?`,
    [input.projectId, source.sourceId, source.sourceVersion, source.normalizedSha256,
      source.boundary.chapterId, source.boundary.charOffsetExclusive, ...wanted, input.limit ?? 3],
  );
  return Array.from({ length: result.rows.length }, (_, index) => mapDigest(result.rows.item(index)));
}

/** Read-only coverage summary for the active source/boundary shown in the overview UI. */
export async function getHistoricalDigestCoverage(
  projectId: number,
): Promise<HistoricalDigestCoverage> {
  const source = await continuationSourceReader.getSnapshot(projectId);
  const db = await openDatabase();
  const [result] = await db.executeSql(
    `SELECT * FROM continuation_historical_digests WHERE project_id = ? AND source_id = ?
      AND source_version = ? AND source_sha256 = ? AND boundary_chapter_id = ?
      AND boundary_char_offset_exclusive = ? AND status = 'ready'`,
    [
      projectId,
      source.sourceId,
      source.sourceVersion,
      source.normalizedSha256,
      source.boundary.chapterId,
      source.boundary.charOffsetExclusive,
    ],
  );
  return summarizeHistoricalDigestCoverage(
    Array.from({ length: result.rows.length }, (_, index) =>
      mapDigest(result.rows.item(index)),
    ),
  );
}

/** Local-only candidates. The caller must ask the user before any backfill. */
export async function findHistoricalChapterCandidates(input: { projectId: number; queryText: string; limit?: number }): Promise<HistoricalChapterCandidate[]> {
  const wanted = terms(input.queryText);
  if (!wanted.length) return [];
  const source = await continuationSourceReader.getSnapshot(input.projectId);
  const db = await openDatabase();
  const [result] = await db.executeSql(
    `SELECT t.digest_id, t.chapter_id, t.chapter_position, c.chapter_title, t.term_display
     FROM continuation_historical_index_terms t JOIN continuation_historical_digests d ON d.id = t.digest_id
     JOIN continuation_historical_digest_chapters c ON c.digest_id = t.digest_id AND c.chapter_id = t.chapter_id
     WHERE d.project_id = ? AND d.source_id = ? AND d.source_version = ? AND d.source_sha256 = ?
       AND d.boundary_chapter_id = ? AND d.boundary_char_offset_exclusive = ? AND d.status != 'outdated'
       AND t.term_normalized IN (${wanted.map(() => '?').join(',')}) ORDER BY t.chapter_position DESC LIMIT ?`,
    [input.projectId, source.sourceId, source.sourceVersion, source.normalizedSha256,
      source.boundary.chapterId, source.boundary.charOffsetExclusive, ...wanted, input.limit ?? 30],
  );
  const groups = new Map<string, HistoricalChapterCandidate>();
  for (let index = 0; index < result.rows.length; index++) {
    const row = result.rows.item(index);
    const key = `${row.digest_id}:${row.chapter_id}`;
    const current: HistoricalChapterCandidate = groups.get(key) ?? { digestId: row.digest_id, chapterId: row.chapter_id, chapterPosition: row.chapter_position, chapterTitle: row.chapter_title, matchedTerms: [] };
    if (!current.matchedTerms.includes(row.term_display)) current.matchedTerms.push(row.term_display);
    groups.set(key, current);
  }
  return Array.from(groups.values());
}

export async function markHistoricalDigestsOutdated(projectId: number): Promise<void> {
  const db = await openDatabase();
  await execute(db, "UPDATE continuation_historical_digests SET status = 'outdated', updated_at = ? WHERE project_id = ? AND status IN ('queued', 'running', 'ready', 'failed')", [now(), projectId]);
}
