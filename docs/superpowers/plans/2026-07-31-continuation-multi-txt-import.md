# 续写模式多 TXT 原著导入 + LLM 顺序排序 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让续写模式支持一次导入多个 TXT 原著文件，导入前可选地用 LLM 分析文件先后顺序，用户可在预览页调整顺序后拼接为单一虚拟 source 导入。

**Architecture:** 方案A——多 TXT 按 LLM 排序/用户调整后的顺序拼接成一本线性文本，写入单一 `continuation_sources` 行。新增 `file_index` 列仅作来源标记，不参与 offset 计算；Phase 2/3 reader/snapshot/Canon 无需改动。Schema v28→v29 加列（非 breaking）。多文件流式串联复用现有 `runPipelineToReview` 的单遍流式优势，normalizer/parser/hasher 跨文件共享实例。

**Tech Stack:** React Native CLI + TypeScript + SQLite (react-native-sqlite-storage) + Zustand + @react-native-documents/picker + 现有 `callLLM` JSON 模式

**Spec:** `docs/superpowers/specs/2026-07-31-continuation-multi-txt-import-design.md`

---

## 文件结构

### 新增

| 路径 | 职责 |
|------|------|
| `src/services/migrations/v28-to-v29.ts` | Schema 28→29 迁移：给 3 张续写表加 `file_index`/`source_files_json`/`is_multi_file`/`file_count` 列 |
| `src/services/continuation/continuationOrderingService.ts` | LLM 排序服务：输入采样数组，输出顺序 + 置信度 + 理由；失败回退文件名排序 |
| `src/screens/continuation/ContinuationSourceOrderingScreen.tsx` | 排序预览页：展示 LLM/回退排序结果 + 上移/下移/移除按钮 + "确认顺序"按钮 |
| `__tests__/continuationOrderingService.test.ts` | 排序服务单元测试 |
| `__tests__/migrations-v28-v29.test.ts` | 迁移测试 |
| `__tests__/continuationMultiFileImport.test.ts` | 多文件导入单元测试 |

### 修改

| 路径 | 改动 |
|------|------|
| `src/services/migrations/index.ts` | `SCHEMA_VERSION` 28→29，注册 v28→v29 迁移 |
| `src/data/schema/createCurrentSchema.ts:414-487` | 三张续写表建表语句镜像新列 |
| `src/services/database/schemaManifest.ts:378-443` | 三张表的 `columns` 数组追加新列名 |
| `__tests__/migrationTestUtils.ts:115-148` | mock schema 的 `continuation_sources` Set 加新列 |
| `src/services/continuation/continuationSourceRepository.ts` | `ChunkInput`/`InsertChapterInput` 加 `fileIndex`；`insertChunks`/`insertChapters` 实现加列；新增 `updateSourceMultiFileMeta` |
| `src/services/continuation/continuationImportService.ts` | `StartImportInput` 改成文件数组；`startContinuationImport` 重构；`runPipelineToReview` 多文件流式串联；checkpoint_json 扩展 |
| `src/screens/continuation/ContinuationSourceChaptersScreen.tsx:180-243` | `handleImport` 改多选 + 跳转排序预览页 |
| `src/navigation/TabNavigator.tsx:99-120,287-338` | `ResourceStackParamList` 加 `ContinuationSourceOrdering`；注册新屏幕 |
| `src/screens/continuation/ContinuationHomeScreen.tsx:231-235` | 隐私说明文字补充"多文件合并时由 LLM 推断顺序" |

---

## Task 1: Schema v28→v29 迁移（加列）

**Files:**
- Create: `src/services/migrations/v28-to-v29.ts`
- Modify: `src/services/migrations/index.ts:30-60`
- Modify: `src/data/schema/createCurrentSchema.ts:414-487`
- Modify: `src/services/database/schemaManifest.ts:378-443`
- Modify: `__tests__/migrationTestUtils.ts:115-148`
- Test: `__tests__/migrations-v28-v29.test.ts`

- [ ] **Step 1: 写迁移测试（TDD）**

创建 `__tests__/migrations-v28-v29.test.ts`：

```typescript
import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_VERSION } from '../src/services/migrations';
import { buildV28toV29Statements } from '../src/services/migrations/v28-to-v29';
import { applyMigration } from '../src/services/migrations/helpers';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 29 — multi-file continuation import', () => {
  it('reflects the new schema version', () => {
    expect(SCHEMA_VERSION).toBe(29);
  });

  it('adds source_files_json / is_multi_file / file_count to continuation_sources', async () => {
    const mock = createMigrationDb({ schemaVersion: 28 });
    await applyMigration(mock.database as any, buildV28toV29Statements());
    const cols = mock.schemas.get('continuation_sources');
    expect(cols).toBeDefined();
    expect(cols!.has('source_files_json')).toBe(true);
    expect(cols!.has('is_multi_file')).toBe(true);
    expect(cols!.has('file_count')).toBe(true);
  });

  it('adds file_index to continuation_source_text_chunks', async () => {
    const mock = createMigrationDb({ schemaVersion: 28 });
    await applyMigration(mock.database as any, buildV28toV29Statements());
    const cols = mock.schemas.get('continuation_source_text_chunks');
    expect(cols).toBeDefined();
    expect(cols!.has('file_index')).toBe(true);
  });

  it('adds file_index to continuation_source_chapters', async () => {
    const mock = createMigrationDb({ schemaVersion: 28 });
    await applyMigration(mock.database as any, buildV28toV29Statements());
    const cols = mock.schemas.get('continuation_source_chapters');
    expect(cols).toBeDefined();
    expect(cols!.has('file_index')).toBe(true);
  });

  it('mirrors new columns in createCurrentSchema for fresh installs', async () => {
    const sql: string[] = [];
    await createCurrentSchema({
      executeSql: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return [{ rows: { length: 0, item: () => null } }];
      }),
    } as any);
    const joined = sql.join('\n');
    // continuation_sources
    expect(joined).toContain('source_files_json TEXT');
    expect(joined).toContain('is_multi_file INTEGER NOT NULL DEFAULT 0');
    expect(joined).toContain('file_count INTEGER NOT NULL DEFAULT 1');
    // chunks
    expect(joined).toMatch(/continuation_source_text_chunks[\s\S]*file_index INTEGER NOT NULL DEFAULT 0/);
    // chapters
    expect(joined).toMatch(/continuation_source_chapters[\s\S]*file_index INTEGER NOT NULL DEFAULT 0/);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest __tests__/migrations-v28-v29.test.ts`
Expected: FAIL — `Cannot find module '../src/services/migrations/v28-to-v29'`

- [ ] **Step 3: 创建迁移文件**

创建 `src/services/migrations/v28-to-v29.ts`：

```typescript
import type { SqlStatement } from '../database/transaction';

/**
 * Schema 28 → 29: multi-file TXT import for continuation sources.
 *
 * Adds source_files_json / is_multi_file / file_count to continuation_sources
 * for recording multi-file metadata; adds file_index to chunks and chapters
 * tables as provenance markers. Non-breaking: all new columns have defaults
 * that preserve single-file semantics for existing rows.
 */
export function buildV28toV29Statements(): SqlStatement[] {
  return [
    {
      sql: `ALTER TABLE continuation_sources
        ADD COLUMN source_files_json TEXT`,
    },
    {
      sql: `ALTER TABLE continuation_sources
        ADD COLUMN is_multi_file INTEGER NOT NULL DEFAULT 0
        CHECK(is_multi_file IN (0, 1))`,
    },
    {
      sql: `ALTER TABLE continuation_sources
        ADD COLUMN file_count INTEGER NOT NULL DEFAULT 1
        CHECK(file_count >= 1)`,
    },
    {
      sql: `ALTER TABLE continuation_source_text_chunks
        ADD COLUMN file_index INTEGER NOT NULL DEFAULT 0
        CHECK(file_index >= 0)`,
    },
    {
      sql: `ALTER TABLE continuation_source_chapters
        ADD COLUMN file_index INTEGER NOT NULL DEFAULT 0
        CHECK(file_index >= 0)`,
    },
  ];
}
```

- [ ] **Step 4: 注册迁移到 index.ts**

修改 `src/services/migrations/index.ts`：

1. 顶部 import 区加：
```typescript
import { buildV28toV29Statements } from './v28-to-v29';
```

2. 行 30 把 `SCHEMA_VERSION` 改成 29：
```typescript
export const SCHEMA_VERSION = 29;
```

3. `MIGRATIONS` 数组末尾（行 59 后）加：
```typescript
  { from: 28, to: 29, breaking: false, buildStatements: async () => buildV28toV29Statements() },
```

- [ ] **Step 5: 镜像到 createCurrentSchema.ts**

修改 `src/data/schema/createCurrentSchema.ts` 行 414-487 的三张续写表建表语句。

**`continuation_sources`**（在 `activated_at TEXT,` 之前加 3 列）：
```sql
CREATE TABLE IF NOT EXISTS continuation_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staging', 'needs_review', 'ready', 'failed', 'superseded')),
  display_name TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'text/plain',
  detected_encoding TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  raw_sha256 TEXT NOT NULL,
  normalized_sha256 TEXT NOT NULL,
  normalized_char_count INTEGER NOT NULL,
  normalized_byte_count INTEGER NOT NULL,
  chapter_count INTEGER NOT NULL DEFAULT 0,
  parser_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  source_files_json TEXT,
  is_multi_file INTEGER NOT NULL DEFAULT 0 CHECK(is_multi_file IN (0, 1)),
  file_count INTEGER NOT NULL DEFAULT 1 CHECK(file_count >= 1),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  activated_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, version),
  UNIQUE(project_id, id)
)
```

**`continuation_source_text_chunks`**（在 `content_sha256 TEXT NOT NULL,` 之后加 1 列）：
```sql
CREATE TABLE IF NOT EXISTS continuation_source_text_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
  char_start_offset INTEGER NOT NULL CHECK(char_start_offset >= 0),
  char_end_offset INTEGER NOT NULL CHECK(char_end_offset > char_start_offset),
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  file_index INTEGER NOT NULL DEFAULT 0 CHECK(file_index >= 0),
  FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
  UNIQUE(source_id, chunk_index),
  UNIQUE(source_id, char_start_offset)
)
```

**`continuation_source_chapters`**（在 `exclusion_reason TEXT,` 之后、`created_at TEXT NOT NULL,` 之前加 1 列）：
```sql
CREATE TABLE IF NOT EXISTS continuation_source_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  volume_title TEXT,
  detected_title TEXT NOT NULL,
  title TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  paragraph_count INTEGER NOT NULL,
  source_start_offset INTEGER NOT NULL,
  content_start_offset INTEGER NOT NULL,
  source_end_offset INTEGER NOT NULL,
  is_excluded INTEGER NOT NULL DEFAULT 0 CHECK(is_excluded IN (0, 1)),
  exclusion_reason TEXT,
  file_index INTEGER NOT NULL DEFAULT 0 CHECK(file_index >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
  UNIQUE(source_id, position),
  UNIQUE(source_id, id),
  CHECK(char_count >= 0),
  CHECK(paragraph_count >= 0),
  CHECK(source_start_offset >= 0),
  CHECK(content_start_offset >= source_start_offset),
  CHECK(source_end_offset >= content_start_offset)
)
```

- [ ] **Step 6: 更新 schemaManifest.ts 的 columns 数组**

修改 `src/services/database/schemaManifest.ts` 行 378-443：

- `continuation_sources` 的 `columns` 数组追加：`'source_files_json'`, `'is_multi_file'`, `'file_count'`
- `continuation_source_text_chunks` 的 `columns` 数组追加：`'file_index'`
- `continuation_source_chapters` 的 `columns` 数组追加：`'file_index'`

- [ ] **Step 7: 更新 migrationTestUtils.ts 的 mock schema**

修改 `__tests__/migrationTestUtils.ts` 行 115-148 的 `schemaVersion >= 19` 块：

在 `continuation_sources` 的 Set 里加：`'source_files_json'`, `'is_multi_file'`, `'file_count'`
在 `continuation_source_text_chunks` 的 Set 里加：`'file_index'`
在 `continuation_source_chapters` 的 Set 里加：`'file_index'`

**注意**：这些列只在 `schemaVersion >= 29` 时才该出现，但因为 mock 的初始 schema 是"迁移前"状态，所以加进 Set 是为了让迁移后 ALTER 能识别。查看现有代码确认：`createMigrationDb` 的初始 schema 应该是迁移前的状态，所以**不要**在初始 Set 里加新列——它们应该由 ALTER TABLE 动态添加。如果测试失败说"列已存在"，再移除。

- [ ] **Step 8: 运行测试验证通过**

Run: `npx jest __tests__/migrations-v28-v29.test.ts`
Expected: PASS（5 个测试全绿）

- [ ] **Step 9: 跑迁移矩阵测试确认无回归**

Run: `npx jest __tests__/migrationMatrix.test.ts __tests__/migrationCoverage.test.ts`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add src/services/migrations/v28-to-v29.ts src/services/migrations/index.ts src/data/schema/createCurrentSchema.ts src/services/database/schemaManifest.ts __tests__/migrationTestUtils.ts __tests__/migrations-v28-v29.test.ts
git commit -F - <<'EOF'
feat(continuation): Schema 29 多 TXT 导入加列

- continuation_sources: source_files_json / is_multi_file / file_count
- continuation_source_text_chunks: file_index
- continuation_source_chapters: file_index
非 breaking，所有新列有默认值，单文件语义向后兼容
EOF
```

（PowerShell 环境用临时文件传 commit message：写到 `.git/COMMIT_MSG_TMP` 后 `git commit -F .git/COMMIT_MSG_TMP`）

---

## Task 2: Repository 层加 file_index 支持

**Files:**
- Modify: `src/services/continuation/continuationSourceRepository.ts:155-585`
- Test: `__tests__/continuationSourceRepository.test.ts`（若存在）或新增

- [ ] **Step 1: 扩展 ChunkInput 和 InsertChapterInput 接口**

修改 `src/services/continuation/continuationSourceRepository.ts`：

`ChunkInput`（行 430-436）加 `fileIndex`：
```typescript
export interface ChunkInput {
  chunkIndex: number;
  charStartOffset: Utf16Offset;
  charEndOffset: Utf16Offset;
  content: string;
  contentSha256: string;
  fileIndex: number;
}
```

`InsertChapterInput`（行 537-550）加 `fileIndex`：
```typescript
export interface InsertChapterInput {
  position: SourceChapterPosition;
  volumeTitle: string | null;
  detectedTitle: string;
  title: string;
  contentSha256: string;
  charCount: number;
  paragraphCount: number;
  sourceStartOffset: Utf16Offset;
  contentStartOffset: Utf16Offset;
  sourceEndOffset: Utf16Offset;
  isExcluded?: boolean;
  exclusionReason?: string | null;
  fileIndex: number;
}
```

- [ ] **Step 2: 更新 insertChunks 实现**

修改 `insertChunks`（行 439-459），SQL 加 `file_index` 列：

```typescript
export async function insertChunks(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
  chunks: ChunkInput[],
): Promise<void> {
  if (chunks.length === 0) return;
  const statements: SqlStatement[] = chunks.map(c => ({
    sql: `INSERT INTO continuation_source_text_chunks (
        source_id, chunk_index, char_start_offset, char_end_offset, content, content_sha256, file_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [
      sourceId,
      c.chunkIndex,
      c.charStartOffset,
      c.charEndOffset,
      c.content,
      c.contentSha256,
      c.fileIndex,
    ],
  }));
  await executeTransaction(db, statements);
}
```

- [ ] **Step 3: 更新 insertChapters 实现**

修改 `insertChapters`（行 553-585），SQL 加 `file_index` 列：

```typescript
export async function insertChapters(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
  chapters: InsertChapterInput[],
): Promise<void> {
  if (chapters.length === 0) return;
  const ts = now();
  const statements: SqlStatement[] = chapters.map(c => ({
    sql: `INSERT INTO continuation_source_chapters (
        source_id, position, volume_title, detected_title, title, content_sha256,
        char_count, paragraph_count, source_start_offset, content_start_offset,
        source_end_offset, is_excluded, exclusion_reason, file_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      sourceId,
      c.position,
      c.volumeTitle,
      c.detectedTitle,
      c.title,
      c.contentSha256,
      c.charCount,
      c.paragraphCount,
      c.sourceStartOffset,
      c.contentStartOffset,
      c.sourceEndOffset,
      c.isExcluded ? 1 : 0,
      c.exclusionReason ?? null,
      c.fileIndex,
      ts,
      ts,
    ],
  }));
  await executeTransaction(db, statements);
}
```

- [ ] **Step 4: 新增 updateSourceMultiFileMeta 函数**

在 `continuationSourceRepository.ts` 末尾（`clearActiveSourceAndDelete` 之后）加：

```typescript
/**
 * Update multi-file metadata on a source. Called at the end of
 * runPipelineToReview to record per-file provenance.
 */
export async function updateSourceMultiFileMeta(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
  patch: {
    sourceFilesJson: string | null;
    isMultiFile: boolean;
    fileCount: number;
  },
): Promise<void> {
  await db.executeSql(
    `UPDATE continuation_sources
      SET source_files_json = ?, is_multi_file = ?, file_count = ?, updated_at = ?
      WHERE id = ?`,
    [
      patch.sourceFilesJson,
      patch.isMultiFile ? 1 : 0,
      patch.fileCount,
      now(),
      sourceId,
    ],
  );
}
```

- [ ] **Step 5: 扩展 InsertSourceInput 接口**

修改 `InsertSourceInput`（行 155-172），加可选的 multi-file 字段：

```typescript
export interface InsertSourceInput {
  projectId: number;
  version: number;
  status: ContinuationSourceStatus;
  displayName: string;
  originalFileName: string;
  detectedEncoding: string;
  fileSizeBytes: number;
  rawSha256: string;
  normalizedSha256: string;
  normalizedCharCount: number;
  normalizedByteCount: number;
  chapterCount: number;
  parserVersion: string;
  normalizationVersion: string;
  sourceFilesJson?: string | null;
  isMultiFile?: boolean;
  fileCount?: number;
}
```

- [ ] **Step 6: 更新 insertSource 实现支持新字段**

修改 `insertSource`（行 175-212），SQL 加新列：

```typescript
export async function insertSource(
  db: SQLite.SQLiteDatabase,
  input: InsertSourceInput,
): Promise<number> {
  const ts = now();
  const result = await db.executeSql(
    `INSERT INTO continuation_sources (
        project_id, version, status, display_name, original_file_name,
        mime_type, detected_encoding, file_size_bytes, raw_sha256,
        normalized_sha256, normalized_char_count, normalized_byte_count,
        chapter_count, parser_version, normalization_version,
        source_files_json, is_multi_file, file_count,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.projectId,
      input.version,
      input.status,
      input.displayName,
      input.originalFileName,
      input.detectedEncoding,
      input.fileSizeBytes,
      input.rawSha256,
      input.normalizedSha256,
      input.normalizedCharCount,
      input.normalizedByteCount,
      input.chapterCount,
      input.parserVersion,
      input.normalizationVersion,
      input.sourceFilesJson ?? null,
      input.isMultiFile ? 1 : 0,
      input.fileCount ?? 1,
      ts,
      ts,
    ],
  );
  return result[0].insertId;
}
```

- [ ] **Step 7: 跑 typecheck 确认所有调用方都传了 fileIndex**

Run: `npx tsc --noEmit`
Expected: 编译错误指向 `continuationImportService.ts` 的 `parsedChapterToInput` 和 `insertChunks`/`insertChapters` 调用处（因为它们还没传 `fileIndex`）。这些会在 Task 4 修复。**临时**在 `parsedChapterToInput` 里加 `fileIndex: 0` 占位以通过 typecheck，Task 4 再改成动态值。

查看 `continuationImportService.ts` 中 `parsedChapterToInput` 函数，加 `fileIndex: 0`：

```typescript
// 在 parsedChapterToInput 返回对象里加 fileIndex: 0
// （Task 4 会改成动态 fileIndex）
```

同时找出 `runPipelineToReview` 里 `insertChunks` 的调用处，给 `chunks.map` 里加 `fileIndex: 0`。

- [ ] **Step 8: 跑现有续写测试确认无回归**

Run: `npx jest __tests__/continuationSourceReader.test.ts __tests__/continuationSourceActivation.test.ts`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add src/services/continuation/continuationSourceRepository.ts src/services/continuation/continuationImportService.ts
git commit -m "feat(continuation): Repository 加 file_index + multi-file meta 支持"
```

---

## Task 3: LLM 排序服务

**Files:**
- Create: `src/services/continuation/continuationOrderingService.ts`
- Test: `__tests__/continuationOrderingService.test.ts`

- [ ] **Step 1: 写排序服务测试（TDD）**

创建 `__tests__/continuationOrderingService.test.ts`：

```typescript
import {
  orderSourceFiles,
  type OrderingInputFile,
} from '../src/services/continuation/continuationOrderingService';

// Mock callLLMResult
jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(),
}));

import { callLLMResult } from '../src/services/llm';

const mockCallLLMResult = callLLMResult as jest.MockedFunction<typeof callLLMResult>;

const baseFiles: OrderingInputFile[] = [
  { index: 0, fileName: 'volume2.txt', fileSizeBytes: 100000, headSample: '第二卷 开始', tailSample: '第二卷 结束' },
  { index: 1, fileName: 'volume1.txt', fileSizeBytes: 100000, headSample: '第一卷 开始', tailSample: '第一卷 结束' },
  { index: 2, fileName: 'volume3.txt', fileSizeBytes: 100000, headSample: '第三卷 开始', tailSample: '第三卷 结束' },
];

describe('orderSourceFiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns LLM-ordered indexes on success', async () => {
    mockCallLLMResult.mockResolvedValueOnce({
      text: JSON.stringify({
        order: [1, 0, 2],
        confidence: 0.9,
        reasoning: '按卷标记排序：第一卷在前，第二卷次之，第三卷最后',
      }),
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });

    const result = await orderSourceFiles(baseFiles, 1);

    expect(result.method).toBe('llm');
    expect(result.orderedFileIndexes).toEqual([1, 0, 2]);
    expect(result.confidence).toBe(0.9);
    expect(result.reasoning).toContain('第一卷');
  });

  it('falls back to filename sort when LLM throws', async () => {
    mockCallLLMResult.mockRejectedValueOnce(new Error('network'));

    const result = await orderSourceFiles(baseFiles, 1);

    expect(result.method).toBe('fallback_filename');
    expect(result.orderedFileIndexes).toEqual([1, 0, 2]); // volume1 < volume2 < volume3
    expect(result.confidence).toBe(0);
  });

  it('falls back when LLM returns invalid JSON', async () => {
    mockCallLLMResult.mockResolvedValueOnce({
      text: 'not json at all',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    const result = await orderSourceFiles(baseFiles, 1);

    expect(result.method).toBe('fallback_filename');
  });

  it('falls back when LLM returns incomplete indexes', async () => {
    mockCallLLMResult.mockResolvedValueOnce({
      text: JSON.stringify({ order: [0, 1], confidence: 0.8, reasoning: '...' }),
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    const result = await orderSourceFiles(baseFiles, 1);

    expect(result.method).toBe('fallback_filename');
  });

  it('falls back when LLM returns duplicate indexes', async () => {
    mockCallLLMResult.mockResolvedValueOnce({
      text: JSON.stringify({ order: [0, 0, 2], confidence: 0.8, reasoning: '...' }),
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    const result = await orderSourceFiles(baseFiles, 1);

    expect(result.method).toBe('fallback_filename');
  });

  it('falls back when LLM returns out-of-range indexes', async () => {
    mockCallLLMResult.mockResolvedValueOnce({
      text: JSON.stringify({ order: [0, 1, 5], confidence: 0.8, reasoning: '...' }),
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    const result = await orderSourceFiles(baseFiles, 1);

    expect(result.method).toBe('fallback_filename');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest __tests__/continuationOrderingService.test.ts`
Expected: FAIL — `Cannot find module '../src/services/continuation/continuationOrderingService'`

- [ ] **Step 3: 实现排序服务**

创建 `src/services/continuation/continuationOrderingService.ts`：

```typescript
import { callLLMResult } from '../llm';

/**
 * Input file for ordering. `index` is the original selection order (0-based).
 */
export interface OrderingInputFile {
  index: number;
  fileName: string;
  fileSizeBytes: number;
  headSample: string;
  tailSample: string;
}

/**
 * Ordering result. `orderedFileIndexes` are original indexes in the new order.
 */
export interface OrderingResult {
  orderedFileIndexes: number[];
  confidence: number;
  reasoning: string;
  method: 'llm' | 'fallback_filename';
}

interface LlmOrderResponse {
  order: number[];
  confidence: number;
  reasoning: string;
}

/**
 * Order multiple TXT files by analyzing head/tail samples with an LLM.
 * Falls back to filename sort on any LLM failure or invalid response.
 */
export async function orderSourceFiles(
  files: OrderingInputFile[],
  modelConfigId: number,
): Promise<OrderingResult> {
  if (files.length <= 1) {
    return {
      orderedFileIndexes: files.map(f => f.index),
      confidence: 1,
      reasoning: '单个文件无需排序',
      method: 'fallback_filename',
    };
  }

  try {
    const prompt = buildOrderingPrompt(files);
    const response = await callLLMResult(
      [{ role: 'user', content: prompt }],
      1024,
      {
        responseFormat: 'json_object',
        temperature: 0.1,
        queueClass: 'normal',
        queuePriority: 'normal',
        scenario: 'continuation_source_ordering',
      },
    );

    const parsed = parseOrderResponse(response.text, files.length);
    if (!parsed) {
      return filenameFallback(files, 'LLM 返回结果无法解析');
    }

    return {
      orderedFileIndexes: parsed.order,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      method: 'llm',
    };
  } catch (e: any) {
    return filenameFallback(files, e?.message || 'LLM 调用失败');
  }
}

function buildOrderingPrompt(files: OrderingInputFile[]): string {
  const fileDescriptions = files
    .map(
      f => `【文件索引 ${f.index}】
文件名: ${f.fileName}
文件大小: ${f.fileSizeBytes} 字节
头部采样:
${f.headSample}
---
尾部采样:
${f.tailSample}`,
    )
    .join('\n\n================\n\n');

  return `你是一个小说编辑助手。用户要把多个 TXT 文件按原著阅读顺序拼接成一本完整的小说。请根据以下信息判断正确的阅读顺序。

${fileDescriptions}

排序规则（按优先级）:
1. 如果文件名或内容中存在明确的卷/部标记（如"第一卷""第二部""卷一""卷二"），优先按卷标记排序
2. 关注"承接关系"：文件 N 的尾部与文件 M 的开头是否能拼上（剧情连续性、人物对话中断、场景衔接、时间线推进）
3. 综合文件名和内容采样判断

请输出严格 JSON，格式如下:
{
  "order": [索引数组，按正确阅读顺序排列],
  "confidence": 0到1之间的置信度,
  "reasoning": "简要说明排序理由"
}

注意:
- order 数组必须包含所有 ${files.length} 个文件索引（0到${files.length - 1}），不能遗漏或重复
- 索引值是上面【文件索引 N】中的 N
- 只输出 JSON，不要其他文字`;
}

function parseOrderResponse(
  text: string | null,
  expectedCount: number,
): LlmOrderResponse | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 尝试从 markdown fence 或 prose 中剥离
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const order = obj.order;
  const confidence = obj.confidence;
  const reasoning = obj.reasoning;

  if (!Array.isArray(order)) return null;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) return null;
  if (typeof reasoning !== 'string') return null;

  // 校验索引完整性
  if (order.length !== expectedCount) return null;
  const sorted = [...order].sort((a, b) => a - b);
  for (let i = 0; i < expectedCount; i++) {
    if (sorted[i] !== i) return null;
  }
  // 校验无重复
  const unique = new Set(order);
  if (unique.size !== expectedCount) return null;

  return {
    order: order.map(n => Math.floor(n)),
    confidence,
    reasoning,
  };
}

function filenameFallback(
  files: OrderingInputFile[],
  reason: string,
): OrderingResult {
  const sorted = [...files].sort((a, b) =>
    a.fileName.localeCompare(b.fileName, 'zh-CN'),
  );
  return {
    orderedFileIndexes: sorted.map(f => f.index),
    confidence: 0,
    reasoning: `LLM 排序失败（${reason}），已按文件名排序`,
    method: 'fallback_filename',
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx jest __tests__/continuationOrderingService.test.ts`
Expected: PASS（6 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add src/services/continuation/continuationOrderingService.ts __tests__/continuationOrderingService.test.ts
git commit -m "feat(continuation): LLM 排序服务 + 文件名回退"
```

---

## Task 4: 多文件流式串联导入

**Files:**
- Modify: `src/services/continuation/continuationImportService.ts:205-522`
- Test: `__tests__/continuationMultiFileImport.test.ts`

- [ ] **Step 1: 扩展 StartImportInput 为文件数组**

修改 `src/services/continuation/continuationImportService.ts` 行 205-212：

```typescript
export interface ImportInputFile {
  /** App-private absolute path of the file copy (caller copies via picker). */
  localPath: string;
  originalFileName: string;
  /** User-confirmed encoding when detection was low-confidence; else auto-detect. */
  encodingOverride?: string;
}

export interface StartImportInput {
  projectId: number;
  /** Single file (backward compat) or multiple files (multi-file import). */
  files: ImportInputFile[];
}
```

**向后兼容**：原有调用方传 `{ projectId, localPath, originalFileName }` 的地方都要改成 `{ projectId, files: [{ localPath, originalFileName }] }`。搜索 `startContinuationImport` 的所有调用方并更新（主要是 `ContinuationSourceChaptersScreen.tsx` 和 `replaceContinuationSource`）。

- [ ] **Step 2: 重构 startContinuationImport 支持多文件**

修改 `startContinuationImport`（行 218-303）。核心改动：

1. **总大小预检**：累加所有文件大小，超过 `MAX_IMPORT_FILE_BYTES` 拒绝
2. **每文件独立 detectEncoding**（用各自的 encodingOverride 或探测结果）
3. **多文件合并复制**：把所有文件内容追加复制到 `${importDir}/${jobId}.txt`（用 RNFS.appendFile），或保留多文件路径数组
4. **insertSource 时传 multi-file 元数据**：`isMultiFile: files.length > 1`，`fileCount: files.length`，`sourceFilesJson` 先传 null（收尾时填）

```typescript
export async function startContinuationImport(
  input: StartImportInput,
): Promise<ImportJob> {
  const db = await getDb();
  await ensureSettingsRow(db, input.projectId);

  if (input.files.length === 0) {
    throw new Error('未选择任何文件。');
  }

  // Guard against leftover interrupted job
  const leftover = await getActiveImportJob(input.projectId);
  if (leftover && leftover.state === 'interrupted') {
    await cancelContinuationImport(leftover.id);
  }

  const mod = requireContinuationTextImport();

  // 预检每个文件 + 累加总大小
  const fileMetas: Array<{
    localPath: string;
    originalFileName: string;
    encoding: string;
    fileSizeBytes: number;
  }> = [];
  let totalSize = 0;
  for (const f of input.files) {
    const meta = await mod.readFileMeta(f.localPath);
    if (meta.errorCode === 'file_too_large' || meta.fileSizeBytes > MAX_IMPORT_FILE_BYTES) {
      const mb = (MAX_IMPORT_FILE_BYTES / (1024 * 1024)).toFixed(0);
      throw new Error(`文件 ${f.originalFileName} 过大（上限 ${mb} MB）。`);
    }
    if (totalSize + meta.fileSizeBytes > MAX_IMPORT_FILE_BYTES) {
      const mb = (MAX_IMPORT_FILE_BYTES / (1024 * 1024)).toFixed(0);
      throw new Error(`原著总大小超过 ${mb} MB 限制，请减少文件数量或按章节拆分。`);
    }
    if (!meta.canRead) {
      throw new Error(`无法读取文件 ${f.originalFileName}，请重新选择。`);
    }
    const detected = await mod.detectEncoding(f.localPath);
    const encoding = f.encodingOverride ?? detected.encoding;
    fileMetas.push({
      localPath: f.localPath,
      originalFileName: f.originalFileName,
      encoding,
      fileSizeBytes: meta.fileSizeBytes,
    });
    totalSize += meta.fileSizeBytes;
  }

  // 合并复制到单个文件（保持流式 resume 兼容）
  const importDir = `${RNFS.DocumentDirectoryPath}/continuation-imports`;
  await RNFS.mkdir(importDir);
  const jobId = uuidv4();
  const inputCopyRelativePath = `continuation-imports/${jobId}.txt`;
  const copyAbs = `${RNFS.DocumentDirectoryPath}/${inputCopyRelativePath}`;
  // 先清空目标文件，再逐个 append
  await RNFS.writeFile(copyAbs, '', 'utf8');
  for (const fm of fileMetas) {
    const content = await RNFS.readFile(fm.localPath, 'utf8');
    await RNFS.appendFile(copyAbs, content, 'utf8');
  }

  // 构造 sourceFilesJson 元数据
  const sourceFilesMeta = fileMetas.map((fm, idx) => ({
    originalFileName: fm.originalFileName,
    fileSizeBytes: fm.fileSizeBytes,
    detectedEncoding: fm.encoding,
    fileIndex: idx,
  }));
  const isMultiFile = input.files.length > 1;

  // Create staging source + job in one transaction.
  const sourceVersion = await nextSourceVersionInTx(db, input.projectId);
  const displayName = isMultiFile
    ? `${stripExtension(fileMetas[0].originalFileName)} 等 ${fileMetas.length} 个文件`
    : stripExtension(fileMetas[0].originalFileName);
  const sourceId = await insertSource(db, {
    projectId: input.projectId,
    version: sourceVersion,
    status: 'staging',
    displayName,
    originalFileName: fileMetas[0].originalFileName,
    detectedEncoding: fileMetas[0].encoding,
    fileSizeBytes: totalSize,
    rawSha256: 'pending',
    normalizedSha256: 'pending',
    normalizedCharCount: 0,
    normalizedByteCount: 0,
    chapterCount: 0,
    parserVersion: PARSER_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    sourceFilesJson: JSON.stringify(sourceFilesMeta),
    isMultiFile,
    fileCount: fileMetas.length,
  });
  await insertJob(db, {
    id: jobId,
    projectId: input.projectId,
    sourceId,
    sourceVersion,
    state: 'running',
    stage: 'reading',
    parserVersion: PARSER_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    inputCopyRelativePath,
  });

  try {
    await runPipelineToReview(db, jobId, sourceId, fileMetas, totalSize);
    return (await getJob(db, jobId))!;
  } catch (e: any) {
    await updateJob(db, jobId, {
      state: 'failed',
      errorCode: classifyError(e),
      errorMessage: sanitizeError(e?.message),
    });
    await updateSourceStatus(db, sourceId, 'failed', {
      errorCode: classifyError(e),
      errorMessage: sanitizeError(e?.message),
    });
    throw e;
  }
}
```

**注意**：这里用 `RNFS.appendFile` 合并文件，合并后 `copyAbs` 是单文件，`runPipelineToReview` 的 resume 逻辑（基于 `inputCopyRelativePath` 重跑）天然兼容。但合并阶段会一次性把所有文件读入内存——对于大文件不理想。**优化方案**（可选）：保留多文件路径数组，`runPipelineToReview` 改成多文件流式串联（见 Step 3）。

如果走"合并为单文件再走原管线"的简化方案，`runPipelineToReview` 签名不变（仍接受单个 `absPath`），但所有文件的 `file_index` 都会是 0（因为管线不知道文件边界）。**这违背了 spec 的 `file_index` 来源标记要求**。

**因此推荐 Step 3 的多文件流式串联方案**，让 `runPipelineToReview` 接受文件数组，逐文件流式处理但 normalizer/parser/hasher 跨文件共享。

- [ ] **Step 3: 重构 runPipelineToReview 为多文件流式串联**

修改 `runPipelineToReview`（行 334-522）。核心改动：

1. **签名改成接受文件数组**：`async function runPipelineToReview(db, jobId, sourceId, files: Array<{localPath, encoding, fileSizeBytes, originalFileName}>, totalSizeBytes)`
2. **外层加文件循环**：`for (let fileIndex = 0; fileIndex < files.length; fileIndex++)`
3. **normalizer/parser/rawHasher/fallbackHasher 跨文件共享**（在循环外实例化）
4. **chunkIndex/char_offset/position 跨文件累加**
5. **每文件的 chunks/chapters 标记 fileIndex**
6. **checkpoint_json 加 fileIndex 字段**

```typescript
async function runPipelineToReview(
  db: any,
  jobId: string,
  sourceId: number,
  files: Array<{
    localPath: string;
    encoding: string;
    fileSizeBytes: number;
    originalFileName: string;
  }>,
  totalSizeBytes: number,
): Promise<void> {
  const mod = requireContinuationTextImport();
  const CHUNK_BYTES = 192 * 1024;
  const CHUNK_CHAR_TARGET = Math.floor((192 * 1024) / 3);

  // 跨文件共享的流式状态
  const rawHasher = new Sha256Stream();
  const fallbackHasher = new Sha256Stream();
  const normalizer = createStreamingNormalizer();
  const parser = createStreamingChapterParser();

  let byteCursor = 0;          // 当前文件内的字节游标
  let normalizedCharCursor = 0; // 全局规范化字符游标（跨文件累加）
  let chunkBand = '';
  let chunkBandStart = 0;
  let chunkIndex = 0;           // 全局 chunk 索引（跨文件累加）
  let chapterCount = 0;         // 全局章节计数（跨文件累加）
  let pendingLine = '';
  let pendingLineStartOffset = 0;
  let globalParagraphCount = 0;

  const progressTotal = Math.max(1, Math.ceil(totalSizeBytes / CHUNK_BYTES));
  await updateJob(db, jobId, { stage: 'decoding', progressTotal });

  const flushChapterBatch = async (chapters: ParsedChapter[], fileIndex: number) => {
    if (chapters.length === 0) return;
    await insertChapters(
      db,
      sourceId,
      chapters.map(c => ({ ...parsedChapterToInput(c), fileIndex })),
    );
    chapterCount += chapters.length;
  };

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    byteCursor = 0; // 每文件重置字节游标

    while (byteCursor < file.fileSizeBytes) {
      const decoded = await mod.decodeChunk(
        file.localPath,
        file.encoding,
        byteCursor,
        CHUNK_BYTES,
        null,
      );

      rawHasher.updateString(decoded.text);
      const normalizedBlock = normalizer.push(decoded.text);
      fallbackHasher.updateString(normalizedBlock);

      // 按 \n 切分喂 parser（处理跨 chunk 的 partial line）
      const lines = normalizedBlock.split('\n');
      // 第一段接上 pendingLine
      if (pendingLine) {
        lines[0] = pendingLine + lines[0];
      }
      for (let i = 0; i < lines.length - 1; i++) {
        const chapters = parser.pushLine(lines[i], pendingLineStartOffset);
        await flushChapterBatch(chapters, fileIndex);
        pendingLineStartOffset += lines[i].length + 1; // +1 for \n
      }
      // 最后一段（不含 \n）留作 pendingLine
      pendingLine = lines[lines.length - 1];

      // 累积到 CHUNK_CHAR_TARGET 就 flush chunk
      chunkBand += normalizedBlock;
      while (chunkBand.length >= CHUNK_CHAR_TARGET) {
        const slice = chunkBand.slice(0, CHUNK_CHAR_TARGET);
        const sliceSha = sha256Hex(slice);
        await insertChunks(db, sourceId, [
          {
            chunkIndex,
            charStartOffset: asUtf16Offset(chunkBandStart),
            charEndOffset: asUtf16Offset(chunkBandStart + slice.length),
            content: slice,
            contentSha256: sliceSha,
            fileIndex,
          },
        ]);
        chunkBand = chunkBand.slice(CHUNK_CHAR_TARGET);
        chunkBandStart += CHUNK_CHAR_TARGET;
        chunkIndex++;
      }

      byteCursor = decoded.nextByteOffset;

      // 更新进度 + checkpoint（加 fileIndex）
      await updateJob(db, jobId, {
        progressCurrent: Math.min(
          progressTotal,
          Math.ceil(
            (files
              .slice(0, fileIndex)
              .reduce((s, f) => s + f.fileSizeBytes, 0) + byteCursor) /
              CHUNK_BYTES,
          ),
        ),
        checkpointJson: JSON.stringify({
          fileIndex,
          byteCursor,
          normalizedCharCursor,
          chunkIndex,
          chapterCount,
        }),
      });

      if (decoded.atEof) break;
    }

    // 文件末尾：flush 残行
    if (pendingLine) {
      const chapters = parser.pushLine(pendingLine, pendingLineStartOffset);
      await flushChapterBatch(chapters, fileIndex);
      pendingLine = '';
      pendingLineStartOffset += pendingLine.length + 1;
    }
  }

  // 收尾：flush 残 chunk band
  if (chunkBand.length > 0) {
    const sliceSha = sha256Hex(chunkBand);
    await insertChunks(db, sourceId, [
      {
        chunkIndex,
        charStartOffset: asUtf16Offset(chunkBandStart),
        charEndOffset: asUtf16Offset(chunkBandStart + chunkBand.length),
        content: chunkBand,
        contentSha256: sliceSha,
        fileIndex: files.length - 1, // 最后一个文件
      },
    ]);
    chunkIndex++;
  }

  const normMeta = normalizer.finalize();
  const parsedFinal = parser.finalize({
    fallbackSha256: fallbackHasher.digest(),
    fallbackParagraphCount: globalParagraphCount,
    totalCharCount: normMeta.normalizedCharCount,
  });
  await flushChapterBatch(parsedFinal.chapters, files.length - 1);

  await validateChunkContiguity(db, sourceId, normMeta.normalizedCharCount);

  const rawSha = rawHasher.digest();
  await db.executeSql(
    `UPDATE continuation_sources SET
      raw_sha256 = ?, normalized_sha256 = ?, normalized_char_count = ?,
      normalized_byte_count = ?, chapter_count = ?, detected_encoding = ?,
      status = 'needs_review', updated_at = ?
      WHERE id = ?`,
    [
      rawSha,
      normMeta.normalizedSha256,
      normMeta.normalizedCharCount,
      normMeta.normalizedByteCount,
      chapterCount,
      files[0].encoding, // 主编码（多文件可能不一致，记第一个）
      now(),
      sourceId,
    ],
  );
  await updateJob(db, jobId, {
    state: 'awaiting_review',
    stage: 'awaiting_review',
    progressCurrent: progressTotal,
  });
}
```

**注意**：上面的 `pendingLineStartOffset` 逻辑需要仔细对齐现有实现——阅读现有 `runPipelineToReview` 行 382-490 确认行切分和 offset 累加的精确逻辑，照搬过来再加 fileIndex 外层循环。**不要凭空重写**，要在现有实现基础上改。

- [ ] **Step 4: 更新 parsedChapterToInput 辅助函数**

找到 `continuationImportService.ts` 中的 `parsedChapterToInput` 函数，确认它返回的对象在 Task 2 已加 `fileIndex: 0`。现在因为 `flushChapterBatch` 会用 spread 覆盖 fileIndex，所以 `parsedChapterToInput` 里的 `fileIndex: 0` 会被覆盖成正确的值。**保持 `fileIndex: 0` 占位即可**。

- [ ] **Step 5: 更新 resumeContinuationImport 兼容多文件**

修改 `resumeContinuationImport`（行 902-941）。因为合并文件方案下 `inputCopyRelativePath` 仍是单文件路径，resume 逻辑基本不变，但 `runPipelineToReview` 的签名变了（接受文件数组），需要从 source 记录的 `sourceFilesJson` 重建文件数组——但 resume 时原始临时文件可能已清理，所以走"从合并文件重跑"的简化路径：

```typescript
export async function resumeContinuationImport(jobId: string): Promise<ImportJob> {
  const db = await getDb();
  const job = await getJob(db, jobId);
  if (!job) throw new Error('导入任务不存在。');
  if (job.state !== 'interrupted' && job.state !== 'failed') {
    throw new Error(`任务当前状态为 ${job.state}，无需恢复。`);
  }
  const source = await getSourceByIdInTx(db, job.sourceId);
  if (!source) throw new Error('原著源记录不存在。');

  const absPath = job.inputCopyRelativePath
    ? `${RNFS.DocumentDirectoryPath}/${job.inputCopyRelativePath}`
    : null;
  if (!absPath) {
    await updateJob(db, jobId, {
      state: 'failed',
      errorCode: 'source_changed',
      errorMessage: '导入临时文件已清理，请重新选择原著文件。',
    });
    throw new Error('导入临时文件已清理，请重新选择原著文件。');
  }

  // Reset staging data before re-running
  await db.executeSql('DELETE FROM continuation_source_text_chunks WHERE source_id = ?', [job.sourceId]);
  await db.executeSql('DELETE FROM continuation_source_chapters WHERE source_id = ?', [job.sourceId]);
  await updateJob(db, jobId, {
    state: 'running',
    stage: 'reading',
    errorCode: null,
    errorMessage: null,
  });

  try {
    // resume 时把合并文件当作单文件处理（file_index 全 0）
    // 因为原始多文件路径已不可用，只能从合并文件重跑
    const meta = await requireContinuationTextImport().readFileMeta(absPath);
    const files = [
      {
        localPath: absPath,
        encoding: source.detectedEncoding,
        fileSizeBytes: meta.fileSizeBytes,
        originalFileName: source.originalFileName,
      },
    ];
    await runPipelineToReview(db, jobId, job.sourceId, files, meta.fileSizeBytes);
    return (await getJob(db, jobId))!;
  } catch (e: any) {
    await updateJob(db, jobId, {
      state: 'failed',
      errorCode: classifyError(e),
      errorMessage: sanitizeError(e?.message),
    });
    throw e;
  }
}
```

**注意**：resume 后 `file_index` 全是 0（因为从合并文件重跑），但 `source_files_json` 仍保留原始多文件元数据。这是可接受的降级——resume 是异常恢复，file_index 精确性不是关键。

- [ ] **Step 6: 更新 replaceContinuationSource 签名**

找到 `replaceContinuationSource` 函数，把 `Omit<StartImportInput, 'projectId'>` 改成接受新的 `files` 数组结构。搜索所有调用方更新。

- [ ] **Step 7: 写多文件导入单元测试**

创建 `__tests__/continuationMultiFileImport.test.ts`：

```typescript
import {
  MAX_IMPORT_FILE_BYTES,
  classifyError,
  stripExtension,
} from '../src/services/continuation/continuationImportService';

describe('continuation multi-file import helpers', () => {
  it('MAX_IMPORT_FILE_BYTES is 200MB', () => {
    expect(MAX_IMPORT_FILE_BYTES).toBe(200 * 1024 * 1024);
  });

  it('stripExtension removes .txt', () => {
    expect(stripExtension('novel.txt')).toBe('novel');
    expect(stripExtension('novel')).toBe('novel');
  });

  it('classifyError categorizes errors', () => {
    expect(classifyError(new Error('network timeout'))).toBeTruthy();
  });
});
```

**注意**：完整的 DB 编排测试需要 mock `runPipelineToReview` 的所有依赖，工作量大。现有的 `continuationImportService.test.ts` 也只测纯 helper。这里保持同样策略——测 helper，DB 编排靠 `continuationSourceReader.test.ts` 和迁移测试覆盖。如果需要更深入的集成测试，可参考 `continuationSourceReader.test.ts` 的 mock DB 模式扩展。

- [ ] **Step 8: 跑 typecheck 修复所有调用方**

Run: `npx tsc --noEmit`
Expected: 所有 `startContinuationImport` / `replaceContinuationSource` 调用方都已更新为新的 `files` 数组签名。主要调用方在 `ContinuationSourceChaptersScreen.tsx`（Task 6 会改）和 `replaceContinuationSource` 内部调用。

- [ ] **Step 9: 跑现有续写测试确认无回归**

Run: `npx jest __tests__/continuationImportService.test.ts __tests__/continuationSourceReader.test.ts __tests__/continuationSourceActivation.test.ts`
Expected: PASS（如果有失败，多半是 `StartImportInput` 签名变化导致——更新测试 fixture）

- [ ] **Step 10: 提交**

```bash
git add src/services/continuation/continuationImportService.ts __tests__/continuationMultiFileImport.test.ts
git commit -m "feat(continuation): 多文件流式串联导入 + checkpoint 扩展"
```

---

## Task 5: 排序预览页 UI

**Files:**
- Create: `src/screens/continuation/ContinuationSourceOrderingScreen.tsx`
- Modify: `src/navigation/TabNavigator.tsx:99-120,287-338`
- Modify: `src/screens/continuation/ContinuationHomeScreen.tsx:231-235`

- [ ] **Step 1: 在 navigation 注册新屏幕**

修改 `src/navigation/TabNavigator.tsx`：

1. 顶部 import 区加：
```typescript
import { ContinuationSourceOrderingScreen } from '../screens/continuation/ContinuationSourceOrderingScreen';
```

2. `ResourceStackParamList`（行 99-120）加一行：
```typescript
export type ResourceStackParamList = {
  ContinuationHome: undefined;
  ContinuationSourceChapters: undefined;
  ContinuationSourceOrdering: {
    projectId: number;
    files: Array<{
      localPath: string;
      originalFileName: string;
      detectedEncoding: string;
      fileSizeBytes: number;
    }>;
  };
  ContinuationBoundary: undefined;
  // ... 其余不变
};
```

3. `ResourceStackScreen`（行 287-338）在 `ContinuationSourceChapters` 之后加：
```tsx
<ResourceStack.Screen
  name="ContinuationSourceOrdering"
  component={ContinuationSourceOrderingScreen}
/>
```

- [ ] **Step 2: 创建排序预览页屏幕**

创建 `src/screens/continuation/ContinuationSourceOrderingScreen.tsx`：

```typescript
import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { ChevronUp, ChevronDown, X, Check, Upload } from 'lucide-react-native';
import { useThemeStore } from '../stores/themeStore';
import { orderSourceFiles, type OrderingResult } from '../services/continuation/continuationOrderingService';
import { startContinuationImport, previewParsedSource, confirmContinuationSource } from '../services/continuation/continuationImportService';
import { useSettingsStore } from '../stores/settingsStore';
import Toast from 'react-native-toast-message';
import type { ResourceStackParamList } from '../navigation/TabNavigator';

type OrderingRouteProp = RouteProp<ResourceStackParamList, 'ContinuationSourceOrdering'>;

interface FileItem {
  localPath: string;
  originalFileName: string;
  detectedEncoding: string;
  fileSizeBytes: number;
  headSample: string;
  tailSample: string;
}

export const ContinuationSourceOrderingScreen: React.FC = () => {
  const navigation = useNavigation();
  const route = useRoute<OrderingRouteProp>();
  const theme = useThemeStore(s => s.theme);
  const settings = useSettingsStore();

  const { projectId, files: rawFiles } = route.params;

  const [files, setFiles] = useState<FileItem[]>(rawFiles.map(f => ({
    ...f,
    headSample: '',
    tailSample: '',
  })));
  const [ordering, setOrdering] = useState<OrderingResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  // 采样头尾各 ~1500 字（简化版：用 RNFS.readFile 读首尾）
  const sampleFile = useCallback(async (localPath: string, fileSizeBytes: number) => {
    // 实际实现需要用 ContinuationTextImportModule.decodeChunk 读头部
    // 尾部用 seek + decodeChunk 读最后 1500 字
    // 这里给出骨架，具体实现见 Step 3
    return { headSample: '', tailSample: '' };
  }, []);

  // 初始化：采样 + 排序
  useState(() => {
    (async () => {
      try {
        const sampled = await Promise.all(
          rawFiles.map(async f => {
            const { headSample, tailSample } = await sampleFile(f.localPath, f.fileSizeBytes);
            return { ...f, headSample, tailSample };
          }),
        );
        setFiles(sampled);

        // 是否配了 LLM
        const llmConfigId = settings.activeLlmConfigId;
        if (llmConfigId) {
          const result = await orderSourceFiles(
            sampled.map((f, idx) => ({
              index: idx,
              fileName: f.originalFileName,
              fileSizeBytes: f.fileSizeBytes,
              headSample: f.headSample,
              tailSample: f.tailSample,
            })),
            llmConfigId,
          );
          // 应用排序
          const ordered = result.orderedFileIndexes.map(i => sampled[i]);
          setFiles(ordered);
          setOrdering(result);
        } else {
          setOrdering({
            orderedFileIndexes: sampled.map((_, i) => i),
            confidence: 0,
            reasoning: '未配置 LLM，按选择顺序排列',
            method: 'fallback_filename',
          });
        }
      } catch (e: any) {
        Toast.show({ type: 'error', text1: '初始化失败', text2: e?.message });
      } finally {
        setLoading(false);
      }
    })();
  });

  const moveUp = useCallback((index: number) => {
    if (index === 0) return;
    setFiles(prev => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }, []);

  const moveDown = useCallback((index: number) => {
    setFiles(prev => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleConfirm = useCallback(async () => {
    if (files.length === 0) return;
    setImporting(true);
    try {
      const job = await startContinuationImport({
        projectId,
        files: files.map(f => ({
          localPath: f.localPath,
          originalFileName: f.originalFileName,
        })),
      });
      const preview = await previewParsedSource(job.id);
      Alert.alert(
        '解析完成',
        `已识别 ${preview.chapterCount} 章、${files.length} 个文件。\n将以原著末尾作为默认续写起点。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '确认导入',
            onPress: async () => {
              try {
                await confirmContinuationSource(job.id, { mode: 'end_of_source' });
                Toast.show({ type: 'success', text1: '原著导入完成' });
                navigation.navigate('ContinuationHome', {});
              } catch (e: any) {
                Toast.show({ type: 'error', text1: '确认导入失败', text2: e?.message });
              }
            },
          },
        ],
      );
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '导入失败', text2: e?.message || '请重试' });
    } finally {
      setImporting(false);
    }
  }, [files, projectId, navigation]);

  const renderItem = useCallback(
    ({ item, index }: { item: FileItem; index: number }) => (
      <View style={[styles.fileCard, { backgroundColor: theme.colors.surface }]}>
        <View style={styles.fileHeader}>
          <Text style={[styles.fileIndex, { color: theme.colors.primary }]}>
            #{index + 1}
          </Text>
          <Text style={[styles.fileName, { color: theme.colors.textPrimary }]} numberOfLines={1}>
            {item.originalFileName}
          </Text>
          <Text style={[styles.fileSize, { color: theme.colors.textSecondary }]}>
            {(item.fileSizeBytes / 1024).toFixed(0)} KB
          </Text>
        </View>

        {item.headSample ? (
          <Text style={[styles.sample, { color: theme.colors.textSecondary }]} numberOfLines={3}>
            头部: {item.headSample.slice(0, 200)}...
          </Text>
        ) : null}
        {item.tailSample ? (
          <Text style={[styles.sample, { color: theme.colors.textSecondary }]} numberOfLines={3}>
            尾部: ...{item.tailSample.slice(-200)}
          </Text>
        ) : null}

        <View style={styles.buttonRow}>
          <TouchableOpacity onPress={() => moveUp(index)} disabled={index === 0} style={styles.iconBtn}>
            <ChevronUp size={20} color={index === 0 ? theme.colors.textMuted : theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => moveDown(index)}
            disabled={index === files.length - 1}
            style={styles.iconBtn}
          >
            <ChevronDown
              size={20}
              color={index === files.length - 1 ? theme.colors.textMuted : theme.colors.primary}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => removeFile(index)} style={styles.iconBtn}>
            <X size={20} color={theme.colors.error} />
          </TouchableOpacity>
        </View>
      </View>
    ),
    [files.length, moveUp, moveDown, removeFile, theme.colors],
  );

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
          正在分析文件顺序...
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
          排序原著文件
        </Text>
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
          共 {files.length} 个文件
        </Text>
      </View>

      {ordering?.method === 'fallback_filename' ? (
        <View style={[styles.warningBar, { backgroundColor: theme.colors.warningBg }]}>
          <Text style={[styles.warningText, { color: theme.colors.warningText }]}>
            {ordering.reasoning}，可手动调整
          </Text>
        </View>
      ) : ordering ? (
        <View style={[styles.reasoningBar, { backgroundColor: theme.colors.infoBg }]}>
          <Text style={[styles.reasoningText, { color: theme.colors.infoText }]}>
            LLM 排序理由: {ordering.reasoning}
          </Text>
        </View>
      ) : null}

      <FlatList
        data={files}
        renderItem={renderItem}
        keyExtractor={(_, idx) => String(idx)}
        contentContainerStyle={styles.list}
      />

      <View style={[styles.footer, { backgroundColor: theme.colors.surface }]}>
        <TouchableOpacity
          style={[styles.confirmBtn, { backgroundColor: theme.colors.primary }]}
          onPress={handleConfirm}
          disabled={importing || files.length === 0}
        >
          {importing ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Check size={20} color="#fff" />
              <Text style={styles.confirmBtnText}>确认顺序并导入</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 16 },
  title: { fontSize: 20, fontWeight: '700' },
  subtitle: { fontSize: 14, marginTop: 4 },
  warningBar: { padding: 12, marginHorizontal: 16, borderRadius: 8 },
  warningText: { fontSize: 13 },
  reasoningBar: { padding: 12, marginHorizontal: 16, borderRadius: 8 },
  reasoningText: { fontSize: 13 },
  list: { padding: 16, paddingTop: 8 },
  fileCard: { padding: 16, borderRadius: 12, marginBottom: 12 },
  fileHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  fileIndex: { fontSize: 16, fontWeight: '700', marginRight: 8 },
  fileName: { flex: 1, fontSize: 14, fontWeight: '600' },
  fileSize: { fontSize: 12 },
  sample: { fontSize: 12, marginBottom: 4, fontStyle: 'italic' },
  buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 },
  iconBtn: { padding: 8, marginLeft: 8 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.05)' },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    borderRadius: 12,
  },
  confirmBtnText: { color: '#fff', fontSize: 16, fontWeight: '600', marginLeft: 8 },
  loadingText: { textAlign: 'center', marginTop: 12, fontSize: 14 },
});
```

**注意**：上面的 `useState(() => {...})` 是错误的 React 模式——应该用 `useEffect`。修正：

```typescript
import { useEffect } from 'react';

// 替换 useState(() => {...}) 为：
useEffect(() => {
  (async () => {
    // ... 采样 + 排序逻辑
  })();
}, []);
```

- [ ] **Step 3: 实现采样函数**

把 `sampleFile` 的骨架实现替换为真实采样逻辑。用 `ContinuationTextImportModule.decodeChunk` 读头部 ~1500 字，用 seek 读尾部 ~1500 字：

```typescript
import { requireContinuationTextImport } from '../native/ContinuationTextImportModule';

const sampleFile = useCallback(async (localPath: string, fileSizeBytes: number) => {
  const mod = requireContinuationTextImport();
  const SAMPLE_BYTES = 4096; // ~1500 中文字符 ≈ 4096 字节（UTF-8）

  // 头部采样
  let headSample = '';
  try {
    const headDecoded = await mod.decodeChunk(localPath, 'utf-8', 0, SAMPLE_BYTES, null);
    headSample = headDecoded.text;
  } catch {
    // 忽略采样失败
  }

  // 尾部采样
  let tailSample = '';
  try {
    const tailOffset = Math.max(0, fileSizeBytes - SAMPLE_BYTES);
    const tailDecoded = await mod.decodeChunk(localPath, 'utf-8', tailOffset, SAMPLE_BYTES, null);
    tailSample = tailDecoded.text;
  } catch {
    // 忽略采样失败
  }

  return { headSample, tailSample };
}, []);
```

**注意**：尾部采样用 UTF-8 硬编码，实际应该用 `detectEncoding` 的结果。但 `rawFiles` 已经有 `detectedEncoding` 字段，传入即可：

```typescript
const { headSample, tailSample } = await sampleFile(f.localPath, f.fileSizeBytes, f.detectedEncoding);
```

- [ ] **Step 4: 更新 ContinuationHomeScreen 隐私说明**

修改 `src/screens/continuation/ContinuationHomeScreen.tsx` 行 231-235 的隐私说明文字：

```tsx
<Text style={[styles.privacy, { color: theme.colors.textMuted }]}>
  · 支持UTF-8、GBK、GB18030、UTF-16 编码{'\n'}
  · 支持一次导入多个 TXT，由 LLM 智能排序{'\n'}
  · 原著仅保存在本设备，Phase 1 不会上传{'\n'}
  · 请确认你拥有该原著的合法使用权
</Text>
```

- [ ] **Step 5: 跑 typecheck**

Run: `npx tsc --noEmit`
Expected: PASS（如果有 TS 错误，修复类型不匹配）

- [ ] **Step 6: 跑 lint**

Run: `npx eslint src/screens/continuation/ContinuationSourceOrderingScreen.tsx src/navigation/TabNavigator.tsx`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/screens/continuation/ContinuationSourceOrderingScreen.tsx src/navigation/TabNavigator.tsx src/screens/continuation/ContinuationHomeScreen.tsx
git commit -m "feat(continuation): 排序预览页 + navigation 注册"
```

---

## Task 6: handleImport 多选改造

**Files:**
- Modify: `src/screens/continuation/ContinuationSourceChaptersScreen.tsx:180-243`

- [ ] **Step 1: 改 handleImport 支持多选 + 跳转排序页**

修改 `src/screens/continuation/ContinuationSourceChaptersScreen.tsx` 行 180-243 的 `handleImport`：

```typescript
const handleImport = async () => {
  if (!currentProject) return;
  if (currentProject.mode !== 'continuation') {
    Alert.alert('无法导入', '只有原著续写项目可以导入原著。');
    return;
  }
  try {
    const selected = await pick({
      mode: 'import',
      type: [types.plainText, types.allFiles],
      allowMultiSelection: true,
    });
    if (!selected || selected.length === 0) return;

    // 全部必须是 .txt
    for (const f of selected) {
      if (f.name && !f.name.toLowerCase().endsWith('.txt')) {
        Alert.alert('无法导入', `文件 ${f.name} 不是 .txt 格式，请只选择 TXT 文件。`);
        return;
      }
    }

    setImporting(true);

    // 逐个 keepLocalCopy
    const fileInfos: Array<{
      localPath: string;
      originalFileName: string;
      detectedEncoding: string;
      fileSizeBytes: number;
    }> = [];
    for (const f of selected) {
      const [copy] = await keepLocalCopy({
        files: [{ uri: f.uri, fileName: f.name || 'original.txt' }],
        destination: 'cachesDirectory',
      });
      if (copy.status === 'error') {
        throw new Error(copy.copyError || `复制文件 ${f.name} 失败。`);
      }
      const localPath = localFileUriToPath(copy.localUri);
      const encodingOverride = await confirmEncodingIfNeeded(localPath);
      if (encodingOverride === null) return; // user cancelled

      const mod = requireContinuationTextImport();
      const detected = await mod.detectEncoding(localPath);
      const detectedEncoding = encodingOverride ?? detected.encoding;
      const meta = await mod.readFileMeta(localPath);
      fileInfos.push({
        localPath,
        originalFileName: f.name || 'original.txt',
        detectedEncoding,
        fileSizeBytes: meta.fileSizeBytes,
      });
    }

    // 总大小预检
    const totalSize = fileInfos.reduce((s, f) => s + f.fileSizeBytes, 0);
    if (totalSize > MAX_IMPORT_FILE_BYTES) {
      const mb = (MAX_IMPORT_FILE_BYTES / (1024 * 1024)).toFixed(0);
      Alert.alert('无法导入', `原著总大小超过 ${mb} MB 限制。`);
      return;
    }

    if (fileInfos.length === 1) {
      // 单文件：走原路径
      const job = await startContinuationImport({
        projectId: currentProject.id,
        files: [
          {
            localPath: fileInfos[0].localPath,
            originalFileName: fileInfos[0].originalFileName,
          },
        ],
      });
      const preview = await previewParsedSource(job.id);
      Alert.alert(
        '解析完成',
        `已识别 ${preview.chapterCount} 章、${fileInfos[0].detectedEncoding} 编码。\n将以原著末尾作为默认续写起点;之后可在"续写起点"中调整。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '确认导入',
            onPress: async () => {
              try {
                await confirmContinuationSource(job.id, { mode: 'end_of_source' });
                await reload();
                Toast.show({ type: 'success', text1: '原著导入完成' });
              } catch (e: any) {
                Toast.show({ type: 'error', text1: '确认导入失败', text2: e?.message });
              }
            },
          },
        ],
      );
    } else {
      // 多文件：跳转排序预览页
      navigation.navigate('ContinuationSourceOrdering', {
        projectId: currentProject.id,
        files: fileInfos,
      });
    }
  } catch (e: any) {
    if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) return;
    Toast.show({ type: 'error', text1: '导入失败', text2: e?.message || '请重试' });
  } finally {
    setImporting(false);
  }
};
```

**注意**：需要在文件顶部加 import：

```typescript
import { requireContinuationTextImport } from '../native/ContinuationTextImportModule';
import { MAX_IMPORT_FILE_BYTES } from '../services/continuation/continuationImportService';
```

- [ ] **Step 2: 跑 typecheck 和 lint**

Run: `npx tsc --noEmit && npx eslint src/screens/continuation/ContinuationSourceChaptersScreen.tsx`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/screens/continuation/ContinuationSourceChaptersScreen.tsx
git commit -m "feat(continuation): handleImport 改多选 + 跳转排序页"
```

---

## Task 7: 集成验证 + 回归测试

**Files:**
- 无新文件，全流程验证

- [ ] **Step 1: 跑完整 verify 门禁**

Run: `npm run verify`
Expected: PASS（lint + typecheck + verify:version + test:ci 全绿）

如果有测试失败，逐个修复：
- `StartImportInput` 签名变化导致的测试 fixture 失败 → 更新 fixture
- `insertChunks`/`insertChapters` 缺少 `fileIndex` 参数 → 补上
- migration 测试失败 → 检查 `migrationTestUtils.ts` 是否漏加列

- [ ] **Step 2: 跑续写域全部测试**

Run: `npx jest __tests__/continuation`
Expected: PASS

- [ ] **Step 3: 跑迁移矩阵测试**

Run: `npx jest __tests__/migrationMatrix.test.ts __tests__/migrationCoverage.test.ts __tests__/migrationFixtures.test.ts`
Expected: PASS

- [ ] **Step 4: 手动验证单文件回归（真机/模拟器）**

1. 启动 app，进入续写项目
2. 点"导入 TXT 原著"
3. 选择单个 TXT 文件
4. 验证走原路径（不跳排序页），直接进章节解析预览
5. 确认导入，验证 source 激活成功
6. 验证 `is_multi_file = 0`、`file_count = 1`、`source_files_json` 为 null（单文件场景）

- [ ] **Step 5: 手动验证多文件导入（真机/模拟器）**

1. 启动 app，进入续写项目
2. 点"导入 TXT 原著"
3. 选择 3 个 TXT 文件（顺序故意打乱）
4. 验证跳转到排序预览页
5. 验证 LLM 排序结果（若已配 LLM）或文件名排序（未配 LLM）
6. 上移/下移调整顺序
7. 点"确认顺序并导入"
8. 验证章节解析预览显示合并后的章节
9. 确认导入，验证 source 激活成功
10. 验证 `is_multi_file = 1`、`file_count = 3`、`source_files_json` 含 3 个文件元数据
11. 验证 `continuation_source_text_chunks` 和 `continuation_source_chapters` 的 `file_index` 字段正确标记来源

- [ ] **Step 6: 手动验证 LLM 排序回退（真机/模拟器）**

1. 配置一个无效的 LLM（错误 base_url）
2. 导入多个 TXT
3. 验证排序预览页显示黄条"LLM 排序失败，已按文件名排序"
4. 验证可手动调整顺序

- [ ] **Step 7: 手动验证章节重号处理（真机/模拟器）**

1. 准备 2 个 TXT，都含"第一章"开头
2. 导入这 2 个文件
3. 验证章节解析预览显示两个"第一章"（detected_title 保留原文）
4. 验证 position 全局连续递增（0, 1, 2, ...）
5. 验证高亮提示"该标题在全文中重复"（如果实现了）

- [ ] **Step 8: 最终提交 + 推送**

```bash
git push
```

---

## Self-Review 检查清单

实现完成后，对照 spec 验收标准逐项确认：

- [ ] 单文件导入路径完全不变（回归通过）
- [ ] 多文件导入后，`continuation_sources` 有且仅有 1 行 `status='ready'`
- [ ] 多文件导入后，`file_count` 与实际文件数一致，`source_files_json` 完整
- [ ] 多文件导入后，`continuation_source_text_chunks` 和 `continuation_source_chapters` 的 `file_index` 正确标记来源
- [ ] 多文件导入后，章节 `position` 全局连续递增
- [ ] 多文件导入后，`normalized_sha256` 与拼接后整体文本的 SHA-256 一致
- [ ] LLM 排序失败时正确回退文件名排序
- [ ] 排序预览页可上移/下移/移除文件
- [ ] Schema v28 → v29 迁移后旧数据默认值正确
- [ ] Canon 分析可正常在多文件 source 上运行

---

## 风险与注意事项

1. **`runPipelineToReview` 改造是最复杂的一步**：现有实现行 334-522 的单文件 while 循环逻辑需要仔细迁移到多文件外层 for 循环。**务必在改之前完整阅读现有实现**，照搬行切分和 offset 累加逻辑，不要凭空重写。

2. **`StartImportInput` 签名变化影响所有调用方**：搜索 `startContinuationImport` 和 `replaceContinuationSource` 的所有调用方，全部更新为新的 `files` 数组结构。

3. **migration 必改 4 处**：`v28-to-v29.ts` + `createCurrentSchema.ts` + `schemaManifest.ts` + `migrationTestUtils.ts`，漏一处都会导致测试失败或备份/恢复丢字段。

4. **resume 后 file_index 降级**：resume 从合并文件重跑，file_index 全 0，但 `source_files_json` 保留原始元数据。这是可接受的降级。

5. **LLM 排序的 prompt 调优**：当前 prompt 是初版，实际效果可能需要迭代。测试时关注 LLM 是否能正确识别"第一卷/第二卷"和尾部-头部承接关系。
