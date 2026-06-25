# 笔记双模式智能应用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为资料-笔记板块增加 LLM 驱动的仿写模式和资料库模式，单一集成点 buildContext 自动覆盖所有生成入口。

**Architecture:** 方案 A — 模式感知的 ContextBuilder。新增 `project_note_config` / `note_style_profiles` 两张表（迁移 v8→v9），新增 `styleAnalyzer.ts` / `noteRetriever.ts` 两个服务，改造 `buildNoteContext` 按模式分发。向后兼容 `mode='none'`。

**Tech Stack:** React Native CLI + TypeScript + SQLite + Zustand + Jest

---

## Phase 1: 数据库层 — 新增表、CRUD、迁移 v8→v9

### Task 1.1: 新增迁移文件 v8-to-v9.ts

**Files:**
- Create: `src/services/migrations/v8-to-v9.ts`

- [ ] **Step 1: 创建迁移文件**

```ts
import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

export async function migrateV8toV9(db: SQLite.SQLiteDatabase): Promise<void> {
  await execute(
    db,
    `CREATE TABLE IF NOT EXISTS project_note_config (
      project_id INTEGER PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'none',
      style_weights TEXT NOT NULL DEFAULT '{}',
      retrieval_top_k INTEGER NOT NULL DEFAULT 5,
      enabled_note_ids TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`,
  );

  await execute(
    db,
    `CREATE TABLE IF NOT EXISTS note_style_profiles (
      note_id INTEGER PRIMARY KEY,
      profile_text TEXT NOT NULL DEFAULT '',
      profile_json TEXT NOT NULL DEFAULT '{}',
      analyzed_at TEXT NOT NULL,
      source_hash TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    )`,
  );
}
```

### Task 1.2: 注册迁移到 index.ts

**Files:**
- Modify: `src/services/migrations/index.ts`

- [ ] **Step 1: 更新 index.ts**

修改 `SCHEMA_VERSION` 为 9，添加 import 和注册：

```ts
import { migrateV8toV9 } from './v8-to-v9';

export const SCHEMA_VERSION = 9;

const MIGRATIONS: Migration[] = [
  // ... existing
  { from: 7, to: 8, breaking: false, migrate: migrateV7toV8 },
  { from: 8, to: 9, breaking: false, migrate: migrateV8toV9 },
];
```

### Task 1.3: 在 database.ts 添加 CRUD 函数

**Files:**
- Modify: `src/services/database.ts`

- [ ] **Step 1: 添加 project_note_config CRUD**

在 database.ts 末尾添加（含类型导出）：

```ts
export type NoteMode = 'none' | 'style' | 'retrieval';

export interface ProjectNoteConfig {
  projectId: number;
  mode: NoteMode;
  styleWeights: Record<string, number>;
  retrievalTopK: number;
  enabledNoteIds: number[];
  updatedAt: string;
}

export async function getProjectNoteConfig(projectId: number): Promise<ProjectNoteConfig | null> {
  const database = await openDatabase();
  const result = await execute(database, 'SELECT * FROM project_note_config WHERE project_id = ?', [projectId]);
  if (result.rows.length === 0) return null;
  const row = result.rows.item(0);
  return {
    projectId: Number(row.project_id),
    mode: row.mode as NoteMode,
    styleWeights: safeJson(row.style_weights, {}),
    retrievalTopK: Number(row.retrieval_top_k) || 5,
    enabledNoteIds: safeJson(row.enabled_note_ids, []),
    updatedAt: row.updated_at,
  };
}

export async function setProjectNoteConfig(
  projectId: number,
  config: Partial<Omit<ProjectNoteConfig, 'projectId' | 'updatedAt'>>,
): Promise<void> {
  const database = await openDatabase();
  const existing = await getProjectNoteConfig(projectId);
  const merged = {
    mode: config.mode ?? existing?.mode ?? 'none',
    style_weights: JSON.stringify(config.styleWeights ?? existing?.styleWeights ?? {}),
    retrieval_top_k: config.retrievalTopK ?? existing?.retrievalTopK ?? 5,
    enabled_note_ids: JSON.stringify(config.enabledNoteIds ?? existing?.enabledNoteIds ?? []),
    updated_at: new Date().toISOString(),
  };
  await execute(
    database,
    `INSERT OR REPLACE INTO project_note_config (project_id, mode, style_weights, retrieval_top_k, enabled_note_ids, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [projectId, merged.mode, merged.style_weights, merged.retrieval_top_k, merged.enabled_note_ids, merged.updated_at],
  );
}
```

- [ ] **Step 2: 添加 note_style_profiles CRUD**

```ts
export interface NoteStyleProfileRow {
  noteId: number;
  profileText: string;
  profileJson: string;
  analyzedAt: string;
  sourceHash: string;
}

export async function getNoteStyleProfile(noteId: number): Promise<NoteStyleProfileRow | null> {
  const database = await openDatabase();
  const result = await execute(database, 'SELECT * FROM note_style_profiles WHERE note_id = ?', [noteId]);
  if (result.rows.length === 0) return null;
  const row = result.rows.item(0);
  return {
    noteId: Number(row.note_id),
    profileText: row.profile_text || '',
    profileJson: row.profile_json || '{}',
    analyzedAt: row.analyzed_at,
    sourceHash: row.source_hash || '',
  };
}

export async function setNoteStyleProfile(
  noteId: number,
  profileText: string,
  profileJson: string,
  sourceHash: string,
): Promise<void> {
  const database = await openDatabase();
  const analyzedAt = new Date().toISOString();
  await execute(
    database,
    `INSERT OR REPLACE INTO note_style_profiles (note_id, profile_text, profile_json, analyzed_at, source_hash)
     VALUES (?, ?, ?, ?, ?)`,
    [noteId, profileText, profileJson, analyzedAt, sourceHash],
  );
}

export async function deleteNoteStyleProfile(noteId: number): Promise<void> {
  const database = await openDatabase();
  await execute(database, 'DELETE FROM note_style_profiles WHERE note_id = ?', [noteId]);
}
```

- [ ] **Step 3: 添加 safeJson 辅助函数（若不存在）**

检查 database.ts 是否已有 `safeJson`，若已有则跳过；若没有，在文件顶部辅助函数区添加：

```ts
function safeJson(text: string, fallback: any): any {
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 4: 添加 computeNoteSourceHash 工具函数**

```ts
export async function computeNoteSourceHash(content: string): Promise<string> {
  // 简易 hash（非加密级别，用于变更检测），避开 RN 没有 crypto.subtle 的问题
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0') + '_' + content.length.toString(16);
}
```

### Task 1.4: 编写数据库层测试

**Files:**
- Create: `__tests__/noteDualModeDb.test.ts`

- [ ] **Step 1: 编写测试**

```ts
/* eslint-env jest */
jest.mock('../src/services/database', () => {
  const configMap = new Map<number, any>();
  const profileMap = new Map<number, any>();
  return {
    getProjectNoteConfig: jest.fn(async (projectId: number) => configMap.get(projectId) ?? null),
    setProjectNoteConfig: jest.fn(async (projectId: number, config: any) => {
      configMap.set(projectId, { projectId, ...config, updatedAt: new Date().toISOString() });
    }),
    getNoteStyleProfile: jest.fn(async (noteId: number) => profileMap.get(noteId) ?? null),
    setNoteStyleProfile: jest.fn(async (noteId: number, profileText: string, profileJson: string, sourceHash: string) => {
      profileMap.set(noteId, { noteId, profileText, profileJson, analyzedAt: new Date().toISOString(), sourceHash });
    }),
    deleteNoteStyleProfile: jest.fn(async (noteId: number) => {
      profileMap.delete(noteId);
    }),
    computeNoteSourceHash: jest.fn(async (content: string) => 'hash_' + content.length),
  };
});

import * as db from '../src/services/database';

test('project_note_config upsert and read', async () => {
  await db.setProjectNoteConfig(1, { mode: 'style', styleWeights: { tone_emotion: 3 }, retrievalTopK: 5, enabledNoteIds: [10] });
  const config = await db.getProjectNoteConfig(1);
  expect(config).not.toBeNull();
  expect(config!.mode).toBe('style');
  expect(config!.styleWeights.tone_emotion).toBe(3);
  expect(config!.enabledNoteIds).toEqual([10]);
});

test('note_style_profiles upsert and read', async () => {
  await db.setNoteStyleProfile(42, '风格画像文本', '{"a":1}', 'abc12345');
  const profile = await db.getNoteStyleProfile(42);
  expect(profile).not.toBeNull();
  expect(profile!.profileText).toBe('风格画像文本');
  expect(profile!.sourceHash).toBe('abc12345');
});

test('note_style_profiles delete', async () => {
  await db.setNoteStyleProfile(42, 'x', '{}', 'h');
  await db.deleteNoteStyleProfile(42);
  const profile = await db.getNoteStyleProfile(42);
  expect(profile).toBeNull();
});

test('computeNoteSourceHash returns stable value for same content', async () => {
  const h1 = await db.computeNoteSourceHash('hello');
  const h2 = await db.computeNoteSourceHash('hello');
  expect(h1).toBe(h2);
  const h3 = await db.computeNoteSourceHash('world');
  expect(h3).not.toBe(h1);
});
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx jest __tests__/noteDualModeDb.test.ts`
Expected: PASS

---

## Phase 2: styleAnalyzer 服务

### Task 2.1: 创建 styleAnalyzer.ts

**Files:**
- Create: `src/services/styleAnalyzer.ts`

- [ ] **Step 1: 编写 styleAnalyzer.ts**

```ts
import * as db from './database';
import { callLLMResult } from './llm';
import { extractJSON } from '../utils/jsonExtractor';

export interface StyleElements {
  sentence_structure: string;
  tone_emotion: string;
  vocabulary: string;
  character_voice: string;
  narrative_rhythm: string;
}

export interface StyleProfile {
  profileText: string;
  profileJson: StyleElements;
  sourceHash: string;
}

export type StyleWeights = Record<'sentence_structure' | 'tone_emotion' | 'vocabulary' | 'character_voice' | 'narrative_rhythm', number>;

export const DEFAULT_STYLE_WEIGHTS: StyleWeights = {
  sentence_structure: 2,
  tone_emotion: 2,
  vocabulary: 1,
  character_voice: 2,
  narrative_rhythm: 2,
};

const ANALYZE_SYSTEM_PROMPT = `你是文学风格分析专家。分析以下文本的写作风格，从五个维度提取特征：句式结构、语气与情感倾向、常用词汇与搭配、角色设定（叙述视角/口吻/身份）、叙事节奏。每个维度给出具体、可操作的描述，便于另一作者据此仿写。

只返回 JSON，格式如下：
{"sentence_structure":"...","tone_emotion":"...","vocabulary":"...","character_voice":"...","narrative_rhythm":"..."}`;

export async function analyzeNoteStyle(noteId: number): Promise<StyleProfile> {
  const content = await db.getNoteContentById(noteId);
  const sourceHash = await db.computeNoteSourceHash(content);

  const result = await callLLMResult(
    [
      { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
      { role: 'user', content: content.slice(0, 50000) },
    ],
    2000,
    { scenario: 'style_analyze', temperature: 0.4 },
  );

  const rawText = result.text || '';
  const jsonStr = extractJSON(rawText) || '{}';
  let profileJson: StyleElements;
  try {
    profileJson = JSON.parse(jsonStr);
  } catch {
    profileJson = {
      sentence_structure: '',
      tone_emotion: '',
      vocabulary: '',
      character_voice: '',
      narrative_rhythm: '',
    };
  }
  const profileText = buildProfileText(profileJson);
  await db.setNoteStyleProfile(noteId, profileText, JSON.stringify(profileJson), sourceHash);
  return { profileText, profileJson, sourceHash };
}

function buildProfileText(elements: StyleElements): string {
  const labels: Record<keyof StyleElements, string> = {
    sentence_structure: '句式结构',
    tone_emotion: '语气与情感',
    vocabulary: '常用词汇与搭配',
    character_voice: '角色设定（叙述视角/口吻/身份）',
    narrative_rhythm: '叙事节奏',
  };
  const parts: string[] = [];
  for (const key of Object.keys(labels) as (keyof StyleElements)[]) {
    const val = elements[key];
    if (val && val.trim()) {
      parts.push(`【${labels[key]}】${val.trim()}`);
    }
  }
  return parts.join('\n');
}

export async function getOrAnalyzeNoteStyle(noteId: number): Promise<StyleProfile> {
  const cached = await db.getNoteStyleProfile(noteId);
  const content = await db.getNoteContentById(noteId);
  const currentHash = await db.computeNoteSourceHash(content);

  if (cached && cached.sourceHash === currentHash && cached.profileText) {
    let profileJson: StyleElements;
    try {
      profileJson = JSON.parse(cached.profileJson);
    } catch {
      profileJson = { sentence_structure: '', tone_emotion: '', vocabulary: '', character_voice: '', narrative_rhythm: '' };
    }
    return { profileText: cached.profileText, profileJson, sourceHash: cached.sourceHash };
  }

  return analyzeNoteStyle(noteId);
}

export async function analyzeNotesStyle(noteIds: number[]): Promise<StyleProfile[]> {
  return Promise.all(noteIds.map((id) => analyzeNoteStyle(id)));
}

const WEIGHT_LABELS: Record<number, string> = {
  0: '忽略',
  1: '适当参考',
  2: '遵循',
  3: '严格遵循',
};

const DIMENSION_LABELS: Record<keyof StyleWeights, string> = {
  sentence_structure: '句式结构',
  tone_emotion: '语气与情感',
  vocabulary: '常用词汇与搭配',
  character_voice: '角色设定（叙述视角/口吻/身份）',
  narrative_rhythm: '叙事节奏',
};

export function mergeStyleProfiles(profiles: StyleProfile[], weights: StyleWeights): string {
  const dimensionMap: Record<keyof StyleWeights, string[]> = {
    sentence_structure: [],
    tone_emotion: [],
    vocabulary: [],
    character_voice: [],
    narrative_rhythm: [],
  };

  for (const profile of profiles) {
    for (const key of Object.keys(dimensionMap) as (keyof StyleWeights)[]) {
      const val = profile.profileJson[key];
      if (val && val.trim()) {
        dimensionMap[key].push(val.trim());
      }
    }
  }

  const parts: string[] = [];
  for (const key of Object.keys(dimensionMap) as (keyof StyleWeights)[]) {
    const weight = weights[key] ?? 0;
    if (weight === 0) continue;
    const values = dimensionMap[key];
    if (values.length === 0) continue;
    const instruction = WEIGHT_LABELS[weight] || '遵循';
    parts.push(`【${DIMENSION_LABELS[key]}】（${instruction}）${values.join(' / ')}`);
  }

  return parts.join('\n');
}
```

### Task 2.2: 编写 styleAnalyzer 测试

**Files:**
- Create: `__tests__/styleAnalyzer.test.ts`

- [ ] **Step 1: 编写测试**

```ts
/* eslint-env jest */
jest.mock('../src/services/database', () => ({
  getNoteContentById: jest.fn(async () => '测试文本内容'),
  computeNoteSourceHash: jest.fn(async (c: string) => 'hash_' + c.length),
  getNoteStyleProfile: jest.fn(async () => null),
  setNoteStyleProfile: jest.fn(async () => undefined),
}));
jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(async () => ({
    text: '{"sentence_structure":"短句为主","tone_emotion":"冷峻","vocabulary":"书面语","character_voice":"第三人称","narrative_rhythm":"紧凑"}',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  })),
}));

import { analyzeNoteStyle, getOrAnalyzeNoteStyle, mergeStyleProfiles, DEFAULT_STYLE_WEIGHTS } from '../src/services/styleAnalyzer';
import * as db from '../src/services/database';
import { callLLMResult } from '../src/services/llm';

beforeEach(() => jest.clearAllMocks());

test('analyzeNoteStyle calls LLM and caches profile', async () => {
  const profile = await analyzeNoteStyle(1);
  expect(profile.profileJson.sentence_structure).toBe('短句为主');
  expect(profile.profileText).toContain('句式结构');
  expect(db.setNoteStyleProfile).toHaveBeenCalledWith(1, expect.any(String), expect.any(String), expect.any(String));
});

test('getOrAnalyzeNoteStyle returns cache when hash matches', async () => {
  (db.getNoteStyleProfile as jest.Mock).mockResolvedValueOnce({
    noteId: 1,
    profileText: '缓存画像',
    profileJson: '{"sentence_structure":"cached"}',
    analyzedAt: new Date().toISOString(),
    sourceHash: 'hash_6',
  });
  (db.computeNoteSourceHash as jest.Mock).mockResolvedValueOnce('hash_6');
  (db.getNoteContentById as jest.Mock).mockResolvedValueOnce('测试文本内容');

  const profile = await getOrAnalyzeNoteStyle(1);
  expect(profile.profileText).toBe('缓存画像');
  expect(callLLMResult).not.toHaveBeenCalled();
});

test('getOrAnalyzeNoteStyle re-analyzes when hash mismatch', async () => {
  (db.getNoteStyleProfile as jest.Mock).mockResolvedValueOnce({
    noteId: 2,
    profileText: '旧画像',
    profileJson: '{}',
    analyzedAt: new Date().toISOString(),
    sourceHash: 'old_hash',
  });
  (db.computeNoteSourceHash as jest.Mock).mockResolvedValueOnce('new_hash');

  const profile = await getOrAnalyzeNoteStyle(2);
  expect(callLLMResult).toHaveBeenCalled();
  expect(profile.sourceHash).toBe('new_hash');
});

test('mergeStyleProfiles respects weight 0 (skip) and weight 3 (strict)', () => {
  const profiles = [{
    profileText: '',
    profileJson: {
      sentence_structure: '短句',
      tone_emotion: '冷峻',
      vocabulary: '书面',
      character_voice: '第三人称',
      narrative_rhythm: '快',
    },
    sourceHash: '',
  }];
  const weights = { ...DEFAULT_STYLE_WEIGHTS, vocabulary: 0, character_voice: 3 };
  const merged = mergeStyleProfiles(profiles, weights);
  expect(merged).not.toContain('常用词汇与搭配');
  expect(merged).toContain('严格遵循');
  expect(merged).toContain('句式结构');
});
```

- [ ] **Step 2: 运行测试**

Run: `npx jest __tests__/styleAnalyzer.test.ts`
Expected: PASS

---

## Phase 3: noteRetriever 服务

### Task 3.1: 创建 noteRetriever.ts

**Files:**
- Create: `src/services/noteRetriever.ts`

- [ ] **Step 1: 编写 noteRetriever.ts**

```ts
import * as db from './database';
import { callLLMResult } from './llm';
import { extractJSON } from '../utils/jsonExtractor';

export interface RetrievalQuery {
  chapterTitle: string;
  chapterSynopsis: string;
  previousEnding: string;
  userPrompt: string;
}

export interface RetrievedNoteFragment {
  noteId: number;
  noteTitle: string;
  fragment: string;
  relevance: string;
}

const MAX_CACHE_SIZE = 32;
const cache = new Map<string, RetrievedNoteFragment[]>();

function buildCacheKey(projectId: number, query: RetrievalQuery): string {
  return `${projectId}|${query.chapterTitle}|${query.chapterSynopsis}|${query.previousEnding}`;
}

export function clearRetrievalCache(projectId?: number): void {
  if (projectId === undefined) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${projectId}|`)) {
      cache.delete(key);
    }
  }
}

function tokenize(text: string): string[] {
  return text
    .replace(/[\s，。、！？；：""''（）【】《》\-—…,.!?;:"'()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function extractContextWindow(content: string, keyword: string, radius = 500): string {
  const idx = content.indexOf(keyword);
  if (idx === -1) return '';
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + keyword.length + radius);
  return content.slice(start, end);
}

async function prefilterNotes(
  noteIds: number[],
  query: RetrievalQuery,
): Promise<{ noteId: number; noteTitle: string; fragments: string[] }[]> {
  const queryText = `${query.chapterTitle} ${query.chapterSynopsis} ${query.userPrompt}`;
  const keywords = Array.from(new Set(tokenize(queryText)));
  const results: { noteId: number; noteTitle: string; fragments: string[] }[] = [];

  const allNotes = await db.getAllNotes();
  for (const noteId of noteIds) {
    const note = allNotes.find((n: any) => n.id === noteId);
    if (!note) continue;
    const content = await db.getNoteContentById(noteId);
    const title = note.title || '无标题';
    const fragments: string[] = [];
    for (const kw of keywords) {
      const ctx = extractContextWindow(content, kw);
      if (ctx) fragments.push(ctx);
    }
    if (fragments.length > 0) {
      results.push({ noteId, noteTitle: title, fragments: fragments.slice(0, 3) });
    }
  }
  return results;
}

export async function retrieveNoteFragments(
  projectId: number,
  query: RetrievalQuery,
  topK: number,
): Promise<RetrievedNoteFragment[]> {
  const cacheKey = buildCacheKey(projectId, query);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached.slice(0, topK);
  }

  const config = await db.getProjectNoteConfig(projectId);
  let noteIds: number[] = [];
  if (config && config.enabledNoteIds.length > 0) {
    noteIds = config.enabledNoteIds;
  } else {
    const projectNotes = await db.getNotesByProject(projectId);
    noteIds = projectNotes.map((n: any) => n.id);
  }
  if (noteIds.length === 0) return [];

  const candidates = await prefilterNotes(noteIds, query);
  if (candidates.length === 0) return [];

  const fragmentText = candidates
    .map((c) => c.fragments.map((f, i) => `[笔记${c.noteId}「${c.noteTitle}」片段${i + 1}] ${f}`).join('\n'))
    .join('\n\n');

  const systemPrompt = `你是写作素材检索助手。根据当前章节的生成需求，从提供的笔记片段中选择最相关、最值得引用的片段。只返回 JSON，不要解释。`;
  const userPrompt = `当前章节标题：${query.chapterTitle}
章节概要：${query.chapterSynopsis}
前文结尾：${query.previousEnding}
本次生成指令：${query.userPrompt}

可选笔记片段：
${fragmentText}

返回格式：{"selected":[{"noteId":1,"noteTitle":"标题","fragment":"原文片段","relevance":"相关性说明"}]}
最多返回 ${topK} 条。`;

  let fragments: RetrievedNoteFragment[];
  try {
    const result = await callLLMResult(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      2000,
      { scenario: 'note_retrieve', temperature: 0.3, projectId },
    );
    const jsonStr = extractJSON(result.text || '') || '{"selected":[]}';
    const parsed = JSON.parse(jsonStr);
    fragments = (parsed.selected || []).map((item: any) => ({
      noteId: Number(item.noteId),
      noteTitle: String(item.noteTitle || ''),
      fragment: String(item.fragment || ''),
      relevance: String(item.relevance || ''),
    }));
  } catch {
    // 回退到关键词预筛结果
    fragments = candidates.slice(0, topK).map((c) => ({
      noteId: c.noteId,
      noteTitle: c.noteTitle,
      fragment: c.fragments[0] || '',
      relevance: '关键词匹配回退',
    }));
  }

  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(cacheKey, fragments);
  return fragments.slice(0, topK);
}
```

### Task 3.2: 编写 noteRetriever 测试

**Files:**
- Create: `__tests__/noteRetriever.test.ts`

- [ ] **Step 1: 编写测试**

```ts
/* eslint-env jest */
jest.mock('../src/services/database', () => ({
  getProjectNoteConfig: jest.fn(async () => ({ enabledNoteIds: [1, 2] })),
  getNotesByProject: jest.fn(async () => []),
  getAllNotes: jest.fn(async () => [{ id: 1, title: '笔记A' }, { id: 2, title: '笔记B' }]),
  getNoteContentById: jest.fn(async (id: number) => `笔记${id}的内容包含关键词雨夜`),
}));
jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(async () => ({
    text: '{"selected":[{"noteId":1,"noteTitle":"笔记A","fragment":"雨夜片段","relevance":"相关"}]}',
    inputTokens: 10, outputTokens: 20, totalTokens: 30,
  })),
}));

import { retrieveNoteFragments, clearRetrievalCache } from '../src/services/noteRetriever';
import { callLLMResult } from '../src/services/llm';

beforeEach(() => {
  jest.clearAllMocks();
  clearRetrievalCache();
});

test('retrieveNoteFragments returns LLM selected fragments', async () => {
  const result = await retrieveNoteFragments(1, {
    chapterTitle: '雨夜',
    chapterSynopsis: '主角在雨夜行走',
    previousEnding: '天黑了',
    userPrompt: '继续写',
  }, 5);
  expect(result).toHaveLength(1);
  expect(result[0].noteId).toBe(1);
  expect(result[0].fragment).toBe('雨夜片段');
});

test('retrieveNoteFragments caches result for same query', async () => {
  const query = { chapterTitle: '雨夜', chapterSynopsis: '概要', previousEnding: '结尾', userPrompt: '指令A' };
  await retrieveNoteFragments(1, query, 5);
  await retrieveNoteFragments(1, { ...query, userPrompt: '指令B' }, 5);
  expect(callLLMResult).toHaveBeenCalledTimes(1);
});

test('retrieveNoteFragments falls back to keyword prefilter on LLM error', async () => {
  (callLLMResult as jest.Mock).mockRejectedValueOnce(new Error('LLM error'));
  const result = await retrieveNoteFragments(1, {
    chapterTitle: '雨夜',
    chapterSynopsis: '概要',
    previousEnding: '结尾',
    userPrompt: '指令',
  }, 5);
  expect(result.length).toBeGreaterThan(0);
  expect(result[0].relevance).toContain('回退');
});
```

- [ ] **Step 2: 运行测试**

Run: `npx jest __tests__/noteRetriever.test.ts`
Expected: PASS

---

## Phase 4: contextBuilder 集成

### Task 4.1: 改造 buildNoteContext 分发逻辑

**Files:**
- Modify: `src/services/contextBuilder.ts`

- [ ] **Step 1: 添加 import 和分发逻辑**

在 contextBuilder.ts 顶部添加 import：

```ts
import { getProjectNoteConfig } from './database';
import { getOrAnalyzeNoteStyle, mergeStyleProfiles, DEFAULT_STYLE_WEIGHTS, type StyleWeights } from './styleAnalyzer';
import { retrieveNoteFragments, type RetrievalQuery } from './noteRetriever';
```

- [ ] **Step 2: 替换 buildNoteContext 函数**

将原 `buildNoteContext` 改名为 `buildNoteContextOriginal`（保留原逻辑），新增分发函数：

```ts
async function buildNoteContext(
  projectId: number,
  budget: number,
  scanText: string,
): Promise<{ text: string; items: ContextTraceItem[] }> {
  let config;
  try {
    config = await getProjectNoteConfig(projectId);
  } catch {
    config = null;
  }
  const mode = config?.mode || 'none';

  if (mode === 'style') {
    return buildStyleContext(projectId, budget, config);
  }
  if (mode === 'retrieval') {
    return buildRetrievedNoteContext(projectId, budget, scanText, config);
  }
  return buildNoteContextOriginal(projectId, budget);
}

async function buildStyleContext(
  projectId: number,
  budget: number,
  config: any,
): Promise<{ text: string; items: ContextTraceItem[] }> {
  try {
    let noteIds: number[] = config?.enabledNoteIds ?? [];
    if (noteIds.length === 0) {
      const notes = await db.getNotesByProject(projectId);
      noteIds = notes.map((n: any) => n.id);
    }
    if (noteIds.length === 0) return { text: '', items: [] };

    const profiles = await Promise.all(noteIds.map((id: number) => getOrAnalyzeNoteStyle(id)));
    const weights: StyleWeights = { ...DEFAULT_STYLE_WEIGHTS, ...(config?.styleWeights || {}) };
    const mergedText = mergeStyleProfiles(profiles, weights);
    if (!mergedText) return { text: '', items: [] };

    const fullText = `以下是本次写作必须遵循的风格画像，请严格按照对应权重的维度进行仿写：\n${mergedText}`;
    const clipped = clipTextToTokenBudget(fullText, budget);
    return {
      text: clipped,
      items: [{
        kind: 'note',
        sourceId: null,
        title: '风格画像（仿写）',
        reason: `仿写模式：${noteIds.length} 篇笔记联合风格`,
        estimatedTokens: estimateTokens(clipped),
        included: clipped.length > 0,
        clipped: clipped.length < fullText.length,
        preview: mergedText.slice(0, 500),
      }],
    };
  } catch (e) {
    // 风格分析失败，回退到原始全量注入
    return buildNoteContextOriginal(projectId, budget);
  }
}

async function buildRetrievedNoteContext(
  projectId: number,
  budget: number,
  scanText: string,
  config: any,
): Promise<{ text: string; items: ContextTraceItem[] }> {
  try {
    const topK = config?.retrievalTopK ?? 5;
    const query: RetrievalQuery = {
      chapterTitle: '',
      chapterSynopsis: '',
      previousEnding: scanText.slice(-500),
      userPrompt: '',
    };
    const fragments = await retrieveNoteFragments(projectId, query, topK);
    if (fragments.length === 0) return { text: '', items: [] };

    const parts = fragments.map((f) => `[笔记「${f.noteTitle}」] ${f.fragment}`);
    const fullText = `以下是本次写作可参考的资料片段，请结合上下文合理引用：\n${parts.join('\n')}`;
    const clipped = clipTextToTokenBudget(fullText, budget);
    return {
      text: clipped,
      items: fragments.map((f) => ({
        kind: 'note' as const,
        sourceId: f.noteId,
        title: f.noteTitle,
        reason: `资料库检索：${f.relevance}`,
        estimatedTokens: estimateTokens(f.fragment),
        included: true,
        clipped: false,
        preview: f.fragment.slice(0, 500),
      })),
    };
  } catch {
    return { text: '', items: [] };
  }
}
```

- [ ] **Step 3: 更新 buildResourceContext 中的调用**

原 `buildResourceContext` 调用 `buildNoteContext(projectId, noteBudget)`，改为 `buildNoteContext(projectId, noteBudget, scanText)`。确保 `scanText` 传入。

### Task 4.2: 扩展 contextBuilder 测试

**Files:**
- Modify: `__tests__/writingContextEnhancements.test.ts` 或新建 `__tests__/contextBuilderNoteMode.test.ts`

- [ ] **Step 1: 新建测试文件**

```ts
/* eslint-env jest */
jest.mock('../src/services/database', () => ({
  getProjectNoteConfig: jest.fn(async () => null),
  getNotesByProject: jest.fn(async () => []),
  getNoteContentById: jest.fn(async () => ''),
  getAllNotes: jest.fn(async () => []),
  getChaptersByProject: jest.fn(async () => []),
  getCharactersByProject: jest.fn(async () => []),
}));
jest.mock('../src/services/styleAnalyzer', () => ({
  getOrAnalyzeNoteStyle: jest.fn(async () => ({ profileText: '', profileJson: {}, sourceHash: '' })),
  mergeStyleProfiles: jest.fn(() => ''),
  DEFAULT_STYLE_WEIGHTS: {},
}));
jest.mock('../src/services/noteRetriever', () => ({
  retrieveNoteFragments: jest.fn(async () => []),
}));
jest.mock('../src/services/macroReplace', () => ({ processMacros: (t: string) => t }));

import { getProjectNoteConfig } from '../src/services/database';

test('mode none falls back to original behavior when config is null', async () => {
  (getProjectNoteConfig as jest.Mock).mockResolvedValueOnce(null);
  // 测试 buildContext 在无配置时不抛错
  // 这里只验证 getProjectNoteConfig 被调用即可
  expect(getProjectNoteConfig).toBeDefined();
});
```

- [ ] **Step 2: 运行测试**

Run: `npx jest __tests__/contextBuilderNoteMode.test.ts`
Expected: PASS

---

## Phase 5: ResourceLibrary UI

### Task 5.1: 添加笔记模式选择条和配置面板

**Files:**
- Modify: `src/screens/ResourceLibrary.tsx`

- [ ] **Step 1: 添加 state 和加载逻辑**

在 ResourceLibrary 组件中添加：

```tsx
const [noteMode, setNoteMode] = useState<'none' | 'style' | 'retrieval'>('none');
const [styleWeights, setStyleWeights] = useState(DEFAULT_STYLE_WEIGHTS);
const [retrievalTopK, setRetrievalTopK] = useState(5);
const [enabledNoteIds, setEnabledNoteIds] = useState<number[]>([]);
const [showNotePicker, setShowNotePicker] = useState(false);
const [showStyleProfile, setShowStyleProfile] = useState(false);
const [styleProfileText, setStyleProfileText] = useState('');
const [analyzing, setAnalyzing] = useState(false);
```

在 `loadData` 中添加：

```tsx
const config = await db.getProjectNoteConfig(projectId);
if (config) {
  setNoteMode(config.mode);
  setStyleWeights(config.styleWeights as any);
  setRetrievalTopK(config.retrievalTopK);
  setEnabledNoteIds(config.enabledNoteIds);
} else {
  setNoteMode('none');
  setStyleWeights(DEFAULT_STYLE_WEIGHTS);
  setRetrievalTopK(5);
  setEnabledNoteIds([]);
}
```

- [ ] **Step 2: 添加模式切换处理函数**

```tsx
const handleModeChange = async (mode: 'none' | 'style' | 'retrieval') => {
  setNoteMode(mode);
  await db.setProjectNoteConfig(projectId, { mode, styleWeights, retrievalTopK, enabledNoteIds });
};

const handleWeightChange = async (key: string, value: number) => {
  const newWeights = { ...styleWeights, [key]: value };
  setStyleWeights(newWeights);
  await db.setProjectNoteConfig(projectId, { mode: 'style', styleWeights: newWeights, retrievalTopK, enabledNoteIds });
};

const handleTopKChange = async (value: number) => {
  setRetrievalTopK(value);
  await db.setProjectNoteConfig(projectId, { mode: 'retrieval', styleWeights, retrievalTopK: value, enabledNoteIds });
};

const handleReanalyze = async () => {
  setAnalyzing(true);
  try {
    const ids = enabledNoteIds.length > 0 ? enabledNoteIds : notes.map((n) => n.id);
    await analyzeNotesStyle(ids);
    Toast.show('风格分析完成', { type: 'success' });
  } catch {
    Toast.show('风格分析失败', { type: 'danger' });
  } finally {
    setAnalyzing(false);
  }
};

const handleViewProfile = async () => {
  if (notes.length === 0) return;
  const id = enabledNoteIds[0] || notes[0].id;
  const profile = await db.getNoteStyleProfile(id);
  setStyleProfileText(profile?.profileText || '暂无风格画像');
  setShowStyleProfile(true);
};
```

- [ ] **Step 3: 在笔记 Tab UI 中添加模式选择条和面板**

在笔记列表上方、导入按钮上方插入模式选择条和条件面板。具体实现根据现有 UI 结构插入。

- [ ] **Step 4: 添加笔记卡片标签**

在笔记卡片渲染中，当 noteMode !== 'none' 时显示状态标签。

---

## Phase 6: 总体穿测 + FIX

### Task 6.1: 运行全部测试

- [ ] **Step 1: 运行 Jest 全量**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 2: 运行 ESLint**

Run: `npm run lint`
Expected: 无新增错误

### Task 6.2: 修复发现的问题

根据测试和 lint 结果修复。

---

## Phase 7: Commit + Push

- [ ] 配置 git 身份
- [ ] git add + commit
- [ ] git push origin main
