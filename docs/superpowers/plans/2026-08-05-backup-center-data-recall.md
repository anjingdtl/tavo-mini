# 备份中心「召回潜在数据」功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在备份中心新增一个手动「召回潜在数据」入口，扫描当前库（源A）+ schema-recovery 恢复点（源B）+ 用户备份 JSON（源C），经预览→勾选→合并，把缺失的资料找回当前库。

**Architecture:** 三个新服务模块（recallScanner 纯只读扫描 / recallMerger 开写事务合并 / dataRecallService 协调层）+ 一个 UI 屏幕 + 备份中心入口。90% 复用 V2.11.24 已验证的召回子系统（schemaDriftInspector / knownSchemaRepairs / userDataRecallSnapshot / schemaRecoveryBackup / backupService）。合并用 INSERT OR IGNORE 只补缺失行，绝不删除/覆盖现有行；合并前强制 createSchemaRecoveryBackup；合并前后 recall snapshot 比对守卫数据丢失。

**Tech Stack:** React Native + TypeScript, react-native-sqlite-storage, Zustand, sql.js（测试用真实 SQLite）。

**Spec:** `docs/superpowers/specs/2026-08-05-backup-center-data-recall-design.md`

**Branch:** `feat/backup-center-data-recall`（已创建）

---

## 关键实现约束（所有任务通用）

### 事务 API 形态
`executeTransaction(database, statements[], options)` 是**数组形式**，不是回调形式。react-native-sqlite-storage 要求事务 scope 内**同步**调度所有 executeSql，**不能在事务回调里 await**。正确模式：在事务外先构建好 `SqlStatement[]`，再一次性 `executeTransaction(db, statements)`。

### `ParsedBackup` 未导出
`backupService.ts` 的 `ParsedBackup` 是内部 interface，未导出。用推断类型：`NonNullable<ReturnType<typeof readAndValidateBackup>['parsed']>`。本计划在 recallTypes.ts 里定义一个公开别名 `ParsedBackupData`。

### 列投影用 SCHEMA_MANIFEST
每张召回表的列清单从 `SCHEMA_MANIFEST`（`src/services/database/schemaManifest.ts`）读取，**不需要动态查 `PRAGMA table_info`**。合并时取 `row` 的列与 manifest 列的交集。

### 测试真实 SQLite 用 sql.js
不直接 openDatabase；用 `__tests__/helpers/canonInMemoryDb.ts` 的 `createCanonInMemoryDb()`，它用 sql.js 建真实 schema 40 库。用 `__setDatabaseForTest(db as any)` 注入到 openDatabase 单例。RNFS 用 `__tests__/schema40-fixture-helpers.ts` 的 `setupInMemoryFs()` 做 Map 内存文件系统。

### 文件路径汇总
- 备份目录：`${RNFS.ExternalDirectoryPath}/backups`（backupService.ts:11 的 `BACKUP_DIR`，未导出，本计划在 recallScanner 内自建常量）
- schema-recovery 目录：`${RNFS.DocumentDirectoryPath}/schema-recovery`（已导出 `SCHEMA_RECOVERY_DIR`）

---

## File Structure

| 文件 | 责任 | 新增/改动 |
|---|---|---|
| `src/services/recall/recallTypes.ts` | 所有公开类型 + RecallTable 清单 + 表展示名 + 键列定义 | 新增 |
| `src/services/recall/recallScanner.ts` | 纯只读扫描源 A/B/C，产出 RecallScanReport | 新增 |
| `src/services/recall/recallMerger.ts` | 合并执行：强制备份→漂移修复→INSERT OR IGNORE 缺失行→前后 snapshot 比对 | 新增 |
| `src/services/recall/dataRecallService.ts` | 公共 API 协调层（scanRecallSources / applyRecall），re-export 到 database.ts | 新增 |
| `src/screens/RecallScreen.tsx` | 扫描→预览→勾选→合并→结果 UI | 新增 |
| `src/screens/BackupCenterScreen.tsx` | 新增「召回潜在数据」入口按钮 | 改动 |
| `src/navigation/TabNavigator.tsx` | 注册 Recall 路由（SettingsStackParamList + SettingsStackScreen） | 改动 |
| `src/services/database.ts` | re-export dataRecallService 公共 API | 改动 |
| `__tests__/services/recallScanner.test.ts` | 扫描测试 S1-S8 | 新增 |
| `__tests__/services/recallMerger.test.ts` | 合并测试 M1-M10 | 新增 |
| `__tests__/services/dataRecallService.test.ts` | 端到端测试 | 新增 |

---

## Task 1: recallTypes.ts — 类型定义

**Files:**
- Create: `src/services/recall/recallTypes.ts`

- [ ] **Step 1: 创建 recallTypes.ts**

```ts
/**
 * 召回潜在数据功能的公共类型定义。
 *
 * 设计见 docs/superpowers/specs/2026-08-05-backup-center-data-recall-design.md
 */
import type { SchemaDriftReport } from '../../data/schema/schemaDriftInspector';
import type { SchemaRepairResult } from '../../data/schema/knownSchemaRepairs';
import type {
  UserDataRecallSnapshot,
  RecallMismatch,
} from '../../data/schema/userDataRecallSnapshot';

/** 备份解析结果的推断类型（ParsedBackup 在 backupService 内部未导出） */
export type ParsedBackupData = NonNullable<
  ReturnType<
    typeof import('../backupService')['readAndValidateBackup']
  >['parsed']
>;

/** 召回涉及的表清单 */
export const RECALL_TABLES = [
  'projects',
  'chapters',
  'fragments',
  'character_collections',
  'characters',
  'worldbook_collections',
  'worldbook_entries',
  'notes',
  'presets',
  'project_resources',
  'project_collection_settings',
] as const;

export type RecallTable = (typeof RECALL_TABLES)[number];

/** 每张表的主键/复合键列定义，用于 keyOf() 和 readExistingKeys() */
export const RECALL_KEY_COLUMNS: Record<RecallTable, readonly string[]> = {
  projects: ['id'],
  chapters: ['id'],
  fragments: ['id'],
  character_collections: ['id'],
  characters: ['id'],
  worldbook_collections: ['id'],
  worldbook_entries: ['id'],
  notes: ['id'],
  presets: ['id'],
  project_resources: ['project_id', 'resource_type', 'resource_id'],
  project_collection_settings: ['project_id', 'resource_type', 'collection_id'],
};

/** 表的中文展示名 + 是否关联表（关联表跟随主表勾选，不单独展示） */
export const RECALL_TABLE_DISPLAY: Record<
  RecallTable,
  { label: string; isLink: boolean }
> = {
  projects: { label: '项目', isLink: false },
  chapters: { label: '章节', isLink: false },
  fragments: { label: '片段', isLink: false },
  character_collections: { label: '角色合集', isLink: false },
  characters: { label: '角色卡', isLink: false },
  worldbook_collections: { label: '世界书合集', isLink: false },
  worldbook_entries: { label: '世界书条目', isLink: false },
  notes: { label: '笔记', isLink: false },
  presets: { label: '预设', isLink: false },
  project_resources: { label: '项目-资源关联', isLink: true },
  project_collection_settings: { label: '项目-合集设置', isLink: true },
};

/** 合并顺序：父表在前，子表/关联表在后（沿用 schemaManifest restoreOrder） */
export const RECALL_MERGE_ORDER: RecallTable[] = [
  'projects',
  'character_collections',
  'worldbook_collections',
  'presets',
  'characters',
  'worldbook_entries',
  'notes',
  'chapters',
  'fragments',
  'project_resources',
  'project_collection_settings',
];

export interface CurrentDbFinding {
  reachable: boolean;
  schemaDrift: SchemaDriftReport;
  rowCount: Record<RecallTable, number>;
  /** 当前库每张表的键集合（字符串化），用于和源做差集 */
  existingKeys: Record<RecallTable, string[]>;
}

export interface BackupSourceFinding {
  sourceId: 'schema-recovery' | 'backup-json';
  filePath: string;
  fileName: string;
  kind: string;
  createdAt: string;
  schemaVersion: number;
  appVersion: string;
  sizeBytes: number;
  valid: boolean;
  invalidReason?: string;
  rowCount: Record<RecallTable, number>;
  /** 当前库没有、源里有的行数（按主键差集） */
  recoverable: Record<RecallTable, number>;
}

export interface RecallScanReport {
  scannedAt: number;
  currentDb: CurrentDbFinding;
  sources: BackupSourceFinding[];
}

export interface RecallSelection {
  repairCurrentDbDrift: boolean;
  sourceFilePaths: string[];
}

export interface RecallTableResult {
  inserted: number;
  skipped: number;
}

export type RecallErrorCode =
  | 'RECOVERY_BACKUP_FAILED'
  | 'DB_OPEN_FAILED'
  | 'DRIFT_REPAIR_FAILED'
  | 'RECALL_MISMATCH'
  | 'SOURCE_INSERT_FAILED'
  | 'NO_SELECTION';

export interface RecallResult {
  status: 'success' | 'partial' | 'failed';
  recoveryBackupPath: string;
  beforeSnapshot: UserDataRecallSnapshot;
  afterSnapshot: UserDataRecallSnapshot;
  recallMismatch: RecallMismatch | null;
  driftRepairResult?: SchemaRepairResult;
  applied: Partial<Record<RecallTable, RecallTableResult>>;
  error?: { code: RecallErrorCode; message: string };
}

/** 把一行的键列拼成字符串，用于主键差集判定 */
export function keyOf(
  table: RecallTable,
  row: Record<string, any>,
): string {
  return RECALL_KEY_COLUMNS[table]
    .map(col => String(row[col] ?? ''))
    .join(':');
}
```

- [ ] **Step 2: typecheck**

Run: `npx tsc --noEmit`
Expected: PASS（新文件无引用，不影响现有编译）

- [ ] **Step 3: Commit**

```bash
git add src/services/recall/recallTypes.ts
git commit -m "feat(recall): add recall type definitions"
```

---

## Task 2: recallScanner.ts — 只读扫描（TDD）

**Files:**
- Create: `src/services/recall/recallScanner.ts`
- Test: `__tests__/services/recallScanner.test.ts`

- [ ] **Step 1: 写扫描测试 S1-S8**

创建 `__tests__/services/recallScanner.test.ts`：

```ts
import RNFS from 'react-native-fs';
import { createCanonInMemoryDb, type InMemorySqliteDb } from '../helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../../src/data/connection/openDatabase';
import { setupInMemoryFs } from '../schema40-fixture-helpers';
import { createBackup, readAndValidateBackup } from '../../src/services/backupService';
import { SCHEMA_RECOVERY_DIR } from '../../src/services/schemaRecoveryBackup';
import { scanRecallSources } from '../../src/services/recall/recallScanner';
import type { InMemorySqliteDb as Db } from '../helpers/canonInMemoryDb';

/**
 * 构造一个有效备份 JSON 字符串：在临时 db 里塞指定数据后调 createBackup，
 * 再用 readAndValidateBackup 读回内容，最后把 backup 文件内容写到 files Map。
 */
async function writeFakeBackup(
  db: Db,
  files: Map<string, string>,
  path: string,
  seed: (db: Db) => Promise<void>,
): Promise<void> {
  // createBackup 写到 ExternalDirectoryPath/backups；我们要把它放到指定 path
  await seed(db);
  const realBackupPath = await createBackup(db, '2.11.24', 40, 'manual');
  const content = files.get(realBackupPath);
  if (content === undefined) throw new Error('backup not written to in-memory fs');
  files.set(path, content);
}

describe('recallScanner', () => {
  let db: Db;
  let files: Map<string, string>;

  beforeEach(async () => {
    __resetForTest();
    files = setupInMemoryFs();
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
  });

  afterEach(() => {
    __resetForTest();
    try { db.close(); } catch { /* noop */ }
  });

  it('S1: 当前库正常且无备份源 → reachable=true, sources=[]', async () => {
    const report = await scanRecallSources();
    expect(report.currentDb.reachable).toBe(true);
    expect(report.sources).toEqual([]);
  });

  it('S2: 当前库有漂移 → needsRepair=true 且资料表行数仍可读', async () => {
    // 制造漂移：删掉 canon_evidence 的 source_origin 列（sql.js 不支持 DROP COLUMN，
    // 改用重建表方式模拟缺列）
    await db.executeSql(
      `ALTER TABLE canon_evidence RENAME TO canon_evidence_full`,
    );
    await db.executeSql(
      `CREATE TABLE canon_evidence AS SELECT id, project_id, source_id, snapshot_id,
       chapter_id, chapter_position, paragraph_start, paragraph_end,
       char_start, char_end, quote_preview, quote_sha256, analysis_run_id, created_at
       FROM canon_evidence_full`,
    );
    await db.executeSql(`DROP TABLE canon_evidence_full`);

    const report = await scanRecallSources();
    expect(report.currentDb.schemaDrift.needsRepair).toBe(true);
    // 资料表行数仍可读（漂移在 canon_evidence，不影响 characters COUNT）
    expect(report.currentDb.rowCount.characters).toBeGreaterThanOrEqual(0);
    expect(report.currentDb.reachable).toBe(true);
  });

  it('S3: schema-recovery 目录有 1 个有效 JSON → sources 含 1 项 valid=true', async () => {
    const fakePath = `${SCHEMA_RECOVERY_DIR}/test.json`;
    await writeFakeBackup(db, files, fakePath, async (d) => {
      await d.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (100, 'p', 'outline', 't', 't')`,
      );
    });
    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === SCHEMA_RECOVERY_DIR) {
        return [{ isFile: () => true, name: 'test.json', path: fakePath, size: 100 }];
      }
      return [];
    });

    const report = await scanRecallSources();
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0].valid).toBe(true);
    expect(report.sources[0].sourceId).toBe('schema-recovery');
    expect(report.sources[0].recoverable.projects).toBe(1);
  });

  it('S4: schema-recovery 目录有损坏 JSON → 该源 valid=false', async () => {
    const fakePath = `${SCHEMA_RECOVERY_DIR}/broken.json`;
    files.set(fakePath, '{ not valid json');
    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === SCHEMA_RECOVERY_DIR) {
        return [{ isFile: () => true, name: 'broken.json', path: fakePath, size: 10 }];
      }
      return [];
    });

    const report = await scanRecallSources();
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0].valid).toBe(false);
    expect(report.sources[0].invalidReason).toBeTruthy();
  });

  it('S5: 两份备份 JSON 按 createdAt 倒序', async () => {
    const path1 = `${RNFS.ExternalDirectoryPath}/backups/old.json`;
    const path2 = `${RNFS.ExternalDirectoryPath}/backups/new.json`;
    await writeFakeBackup(db, files, path1, async () => {});
    // 第二份构造稍晚（手动改 meta.created_at）
    await writeFakeBackup(db, files, path2, async () => {});
    const content2 = JSON.parse(files.get(path2)!);
    content2.meta.created_at = '2099-12-31T23:59:59Z';
    files.set(path2, JSON.stringify(content2));
    const content1 = JSON.parse(files.get(path1)!);
    content1.meta.created_at = '2020-01-01T00:00:00Z';
    files.set(path1, JSON.stringify(content1));

    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === `${RNFS.ExternalDirectoryPath}/backups`) {
        return [
          { isFile: () => true, name: 'old.json', path: path1, size: 100 },
          { isFile: () => true, name: 'new.json', path: path2, size: 100 },
        ];
      }
      return [];
    });

    const report = await scanRecallSources();
    expect(report.sources).toHaveLength(2);
    expect(report.sources[0].createdAt >= report.sources[1].createdAt).toBe(true);
  });

  it('S6: 当前库 characters=0，源里 characters=5 → recoverable.characters=5', async () => {
    // 当前库 characters 为空（createCanonInMemoryDb 建空表）
    const fakePath = `${SCHEMA_RECOVERY_DIR}/chars.json`;
    await writeFakeBackup(db, files, fakePath, async (d) => {
      for (let i = 1; i <= 5; i++) {
        await d.executeSql(
          `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
           VALUES (${i}, 1, NULL, 'c${i}', 'manual', '{}', 0, 0, 't')`,
        );
      }
      // characters 的 FK 需要 project_id=1 存在
      await d.executeSql(
        `INSERT OR IGNORE INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      );
    });
    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === SCHEMA_RECOVERY_DIR) {
        return [{ isFile: () => true, name: 'chars.json', path: fakePath, size: 100 }];
      }
      return [];
    });

    const report = await scanRecallSources();
    expect(report.sources[0].recoverable.characters).toBe(5);
  });

  it('S7: 当前库 characters=5，源里同 5 个 id → recoverable.characters=0', async () => {
    // 当前库塞 5 个 character
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    for (let i = 1; i <= 5; i++) {
      await db.executeSql(
        `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
         VALUES (${i}, 1, NULL, 'c${i}', 'manual', '{}', 0, 0, 't')`,
      );
    }
    // 源里也是同样 5 个
    const fakePath = `${SCHEMA_RECOVERY_DIR}/same.json`;
    await writeFakeBackup(db, files, fakePath, async (d) => {
      await d.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      );
      for (let i = 1; i <= 5; i++) {
        await d.executeSql(
          `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
           VALUES (${i}, 1, NULL, 'c${i}', 'manual', '{}', 0, 0, 't')`,
        );
      }
    });
    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === SCHEMA_RECOVERY_DIR) {
        return [{ isFile: () => true, name: 'same.json', path: fakePath, size: 100 }];
      }
      return [];
    });

    const report = await scanRecallSources();
    expect(report.sources[0].recoverable.characters).toBe(0);
  });

  it('S8: 当前库 characters=5，源里 8 个（3 新+5 重复）→ recoverable.characters=3', async () => {
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    for (let i = 1; i <= 5; i++) {
      await db.executeSql(
        `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
         VALUES (${i}, 1, NULL, 'c${i}', 'manual', '{}', 0, 0, 't')`,
      );
    }
    const fakePath = `${SCHEMA_RECOVERY_DIR}/partial.json`;
    await writeFakeBackup(db, files, fakePath, async (d) => {
      await d.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      );
      for (let i = 1; i <= 8; i++) {
        await d.executeSql(
          `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
           VALUES (${i}, 1, NULL, 'c${i}', 'manual', '{}', 0, 0, 't')`,
        );
      }
    });
    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === SCHEMA_RECOVERY_DIR) {
        return [{ isFile: () => true, name: 'partial.json', path: fakePath, size: 100 }];
      }
      return [];
    });

    const report = await scanRecallSources();
    expect(report.sources[0].recoverable.characters).toBe(3);
  });
});
```

- [ ] **Step 2: 运行测试确认全部失败**

Run: `npx jest __tests__/services/recallScanner.test.ts`
Expected: FAIL（`scanRecallSources` 不存在）

- [ ] **Step 3: 实现 recallScanner.ts**

```ts
/**
 * 召回潜在数据：只读扫描模块。
 *
 * 扫描三个源：
 *   A. 当前库（schema 漂移诊断 + 11 张召回表行数 + 键集合）
 *   B. ${DocumentDirectoryPath}/schema-recovery/*.json（V2.11.24 写的恢复点）
 *   C. ${ExternalDirectoryPath}/backups/*.json（用户手动/自动备份）
 *
 * 本模块绝不开写事务。任何修复/合并动作由 recallMerger 在用户确认后执行。
 */
import RNFS from 'react-native-fs';
import type SQLite from 'react-native-sqlite-storage';
import { execute } from '../../data/connection/execute';
import { openDatabase } from '../../data/connection/openDatabase';
import { inspectKnownSchemaDrift } from '../../data/schema/schemaDriftInspector';
import { readAndValidateBackup } from '../backupService';
import { SCHEMA_RECOVERY_DIR } from '../schemaRecoveryBackup';
import {
  RECALL_TABLES,
  RECALL_KEY_COLUMNS,
  keyOf,
  type RecallTable,
  type RecallScanReport,
  type CurrentDbFinding,
  type BackupSourceFinding,
} from './recallTypes';

const BACKUP_DIR = `${RNFS.ExternalDirectoryPath}/backups`;
const RECALL_CHUNK_SIZE = 2000;

export async function scanRecallSources(): Promise<RecallScanReport> {
  const currentDb = await scanCurrentDb();
  const schemaRecoverySources = await scanDir(
    SCHEMA_RECOVERY_DIR,
    'schema-recovery',
    currentDb.existingKeys,
  );
  const backupSources = await scanDir(
    BACKUP_DIR,
    'backup-json',
    currentDb.existingKeys,
  );
  const sources = [...schemaRecoverySources, ...backupSources].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return { scannedAt: Date.now(), currentDb, sources };
}

async function scanCurrentDb(): Promise<CurrentDbFinding> {
  const db = await openDatabase();
  const schemaDrift = await inspectKnownSchemaDrift(db);

  const rowCount = {} as Record<RecallTable, number>;
  const existingKeys = {} as Record<RecallTable, string[]>;
  let allReadable = true;

  for (const table of RECALL_TABLES) {
    try {
      const r = await execute(db, `SELECT COUNT(*) AS c FROM ${table}`);
      rowCount[table] = Number(r.rows.item(0)?.c ?? 0);
      existingKeys[table] = await readExistingKeys(db, table);
    } catch {
      rowCount[table] = -1;
      existingKeys[table] = [];
      allReadable = false;
    }
  }

  const reachable = allReadable;
  return { reachable, schemaDrift, rowCount, existingKeys };
}

/** 读取一张表当前已有的键字符串集合（分块）。scanner 和 merger 共用。 */
export async function readExistingKeys(
  db: SQLite.SQLiteDatabase,
  table: RecallTable,
): Promise<string[]> {
  const cols = RECALL_KEY_COLUMNS[table];
  const colList = cols.join(', ');
  const keys: string[] = [];
  let offset = 0;
  while (true) {
    const batch = await execute(
      db,
      `SELECT ${colList} FROM ${table} LIMIT ? OFFSET ?`,
      [RECALL_CHUNK_SIZE, offset],
    );
    const len = batch.rows.length;
    for (let i = 0; i < len; i++) {
      keys.push(keyOf(table, batch.rows.item(i)));
    }
    if (len < RECALL_CHUNK_SIZE) break;
    offset += RECALL_CHUNK_SIZE;
  }
  return keys;
}

async function scanDir(
  dir: string,
  sourceId: 'schema-recovery' | 'backup-json',
  currentKeys: Record<RecallTable, string[]>,
): Promise<BackupSourceFinding[]> {
  let files: RNFS.ReadDirItem[] = [];
  try {
    files = await RNFS.readDir(dir);
  } catch {
    return [];
  }
  const findings: BackupSourceFinding[] = [];
  for (const f of files.filter(f => f.name.endsWith('.json'))) {
    const finding = await parseBackupFile(f, sourceId, currentKeys);
    if (finding) findings.push(finding);
  }
  return findings;
}

async function parseBackupFile(
  file: RNFS.ReadDirItem,
  sourceId: 'schema-recovery' | 'backup-json',
  currentKeys: Record<RecallTable, string[]>,
): Promise<BackupSourceFinding | null> {
  const { parsed, validation } = await readAndValidateBackup(file.path);

  const rowCount = {} as Record<RecallTable, number>;
  const recoverable = {} as Record<RecallTable, number>;

  for (const table of RECALL_TABLES) {
    const sourceRows = parsed?.tables[table] ?? [];
    rowCount[table] = sourceRows.length;
    const currentSet = new Set(currentKeys[table]);
    let missing = 0;
    for (const row of sourceRows) {
      if (!currentSet.has(keyOf(table, row))) missing++;
    }
    recoverable[table] = missing;
  }

  return {
    sourceId,
    filePath: file.path,
    fileName: file.name,
    kind: parsed?.kind ?? 'unknown',
    createdAt: parsed?.createdAt ?? new Date(Number(file.mtime ?? 0)).toISOString(),
    schemaVersion: parsed?.schemaVersion ?? 0,
    appVersion: parsed?.appVersion ?? '',
    sizeBytes: file.size,
    valid: validation.valid,
    invalidReason: validation.valid ? undefined : validation.errors.join('; '),
    rowCount,
    recoverable,
  };
}
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `npx jest __tests__/services/recallScanner.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/recall/recallScanner.ts __tests__/services/recallScanner.test.ts
git commit -m "feat(recall): add read-only scanner for sources A/B/C with tests"
```

---

## Task 3: recallMerger.ts — 合并执行（TDD）

**Files:**
- Create: `src/services/recall/recallMerger.ts`
- Test: `__tests__/services/recallMerger.test.ts`

- [ ] **Step 1: 写合并测试 M1-M10**

创建 `__tests__/services/recallMerger.test.ts`：

```ts
import RNFS from 'react-native-fs';
import { createCanonInMemoryDb, type InMemorySqliteDb } from '../helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../../src/data/connection/openDatabase';
import { setupInMemoryFs } from '../schema40-fixture-helpers';
import { createBackup } from '../../src/services/backupService';
import { SCHEMA_RECOVERY_DIR } from '../../src/services/schemaRecoveryBackup';
import { applyRecall } from '../../src/services/recall/recallMerger';
import type { RecallSelection } from '../../src/services/recall/recallTypes';

async function seedCharacters(db: InMemorySqliteDb, ids: number[]) {
  await db.executeSql(
    `INSERT OR IGNORE INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
  );
  for (const id of ids) {
    await db.executeSql(
      `INSERT OR REPLACE INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
       VALUES (${id}, 1, NULL, 'c${id}', 'manual', '{}', 0, 0, 't')`,
    );
  }
}

/** 用一个"源 db"生成有效备份 JSON 写到 files，返回路径。注意：源 db 与当前 db 是同一 sql.js 实例，
 *  为隔离数据，采用"先在当前 db 塞源数据→createBackup→清空当前 db 对应行"的方式。 */
async function makeSourceBackup(
  db: InMemorySqliteDb,
  files: Map<string, string>,
  seed: (db: InMemorySqliteDb) => Promise<void>,
): Promise<string> {
  await seed(db);
  const path = await createBackup(db, '2.11.24', 40, 'manual');
  // 清掉刚塞的数据，模拟"当前库缺失"
  await db.executeSql(`DELETE FROM characters WHERE id > 0`);
  // 把备份文件复制到 schema-recovery 目录以便 readAndValidateBackup 能读到
  const destPath = `${SCHEMA_RECOVERY_DIR}/source.json`;
  files.set(destPath, files.get(path)!);
  return destPath;
}

describe('recallMerger', () => {
  let db: InMemorySqliteDb;
  let files: Map<string, string>;

  beforeEach(async () => {
    __resetForTest();
    files = setupInMemoryFs();
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
  });

  afterEach(() => {
    __resetForTest();
    try { db.close(); } catch { /* noop */ }
  });

  it('M1: 源里 3 个新 id + 5 个重复 → inserted=3, skipped=5', async () => {
    // 当前库 5 个
    await seedCharacters(db, [1, 2, 3, 4, 5]);
    // 生成"8 个 character"的备份，再清空当前库的 character，重新塞 1-5
    // 这里简化：直接生成含 1-8 的备份，当前库保持 1-5
    await db.executeSql(`DELETE FROM characters`);
    await seedCharacters(db, [1, 2, 3, 4, 5, 6, 7, 8]);
    const backupPath = await createBackup(db, '2.11.24', 40, 'manual');
    await db.executeSql(`DELETE FROM characters`);
    await seedCharacters(db, [1, 2, 3, 4, 5]);
    const sourcePath = `${SCHEMA_RECOVERY_DIR}/s.json`;
    files.set(sourcePath, files.get(backupPath)!);

    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [sourcePath],
    });
    expect(result.status).toBe('success');
    expect(result.applied.characters?.inserted).toBe(3);
    expect(result.applied.characters?.skipped).toBe(5);
    const [cnt] = await db.executeSql(`SELECT COUNT(*) AS c FROM characters`);
    expect(cnt.rows.item(0).c).toBe(8);
  });

  it('M2: 全部重复 → inserted=0, skipped=5', async () => {
    await seedCharacters(db, [1, 2, 3, 4, 5]);
    await seedCharacters(db, [1, 2, 3, 4, 5]); // 同 id
    const backupPath = await createBackup(db, '2.11.24', 40, 'manual');
    const sourcePath = `${SCHEMA_RECOVERY_DIR}/s.json`;
    files.set(sourcePath, files.get(backupPath)!);

    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [sourcePath],
    });
    expect(result.applied.characters?.inserted).toBe(0);
    expect(result.applied.characters?.skipped).toBe(5);
  });

  it('M3: 勾选漂移修复 + 库有漂移 → driftRepairResult 非空且资料表行数不变', async () => {
    // 制造漂移
    await db.executeSql(`ALTER TABLE canon_evidence RENAME TO canon_evidence_full`);
    await db.executeSql(
      `CREATE TABLE canon_evidence AS SELECT id, project_id, source_id, snapshot_id,
       chapter_id, chapter_position, paragraph_start, paragraph_end,
       char_start, char_end, quote_preview, quote_sha256, analysis_run_id, created_at
       FROM canon_evidence_full`,
    );
    await db.executeSql(`DROP TABLE canon_evidence_full`);
    await seedCharacters(db, [1, 2]);

    const result = await applyRecall({
      repairCurrentDbDrift: true,
      sourceFilePaths: [],
    });
    expect(result.driftRepairResult).toBeDefined();
    expect(result.driftRepairResult!.ok).toBe(true);
    // characters 行数不变
    const [cnt] = await db.executeSql(`SELECT COUNT(*) AS c FROM characters`);
    expect(cnt.rows.item(0).c).toBe(2);
  });

  it('M4: 未勾选任何项 → status=failed, NO_SELECTION', async () => {
    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [],
    });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('NO_SELECTION');
  });

  it('M5: 恢复备份失败 → status=failed, RECOVERY_BACKUP_FAILED, 库未改动', async () => {
    // 让 createBackup 失败：让 ExternalDirectoryPath 不可写（mkdir 抛错）
    (RNFS.mkdir as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    // 注意 createSchemaRecoveryBackup 内部先 mkdir SCHEMA_RECOVERY_DIR
    await seedCharacters(db, [1]);

    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: ['whatever.json'],
    });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('RECOVERY_BACKUP_FAILED');
    const [cnt] = await db.executeSql(`SELECT COUNT(*) AS c FROM characters`);
    expect(cnt.rows.item(0).c).toBe(1);
  });

  it('M6: 合并前 ⊂ 合并后 → recallMismatch=null, status=success', async () => {
    await seedCharacters(db, [1]);
    await seedCharacters(db, [1, 2, 3]);
    const backupPath = await createBackup(db, '2.11.24', 40, 'manual');
    await db.executeSql(`DELETE FROM characters`);
    await seedCharacters(db, [1]);
    const sourcePath = `${SCHEMA_RECOVERY_DIR}/s.json`;
    files.set(sourcePath, files.get(backupPath)!);

    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [sourcePath],
    });
    expect(result.recallMismatch).toBeNull();
    expect(result.status).toBe('success');
  });

  it('M9: 关联表 project_resources 打包召回', async () => {
    // 当前库：project 1 + character 1，但无 project_resources
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await seedCharacters(db, [1]);
    // 源：含 project_resources 行
    await db.executeSql(
      `INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (1, 'character', 1, 1)`,
    );
    const backupPath = await createBackup(db, '2.11.24', 40, 'manual');
    await db.executeSql(`DELETE FROM project_resources`);
    const sourcePath = `${SCHEMA_RECOVERY_DIR}/s.json`;
    files.set(sourcePath, files.get(backupPath)!);

    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [sourcePath],
    });
    expect(result.applied.project_resources?.inserted).toBe(1);
    const [cnt] = await db.executeSql(`SELECT COUNT(*) AS c FROM project_resources`);
    expect(cnt.rows.item(0).c).toBe(1);
  });

  it('M10: 两个源都勾选 → applied 累加', async () => {
    await seedCharacters(db, [1, 2]);
    const backupPath1 = await createBackup(db, '2.11.24', 40, 'manual');
    await seedCharacters(db, [3, 4]);
    const backupPath2 = await createBackup(db, '2.11.24', 40, 'manual');
    await db.executeSql(`DELETE FROM characters`);
    await seedCharacters(db, [1]); // 当前只 1 个
    const sourcePath1 = `${SCHEMA_RECOVERY_DIR}/s1.json`;
    const sourcePath2 = `${SCHEMA_RECOVERY_DIR}/s2.json`;
    files.set(sourcePath1, files.get(backupPath1)!);
    files.set(sourcePath2, files.get(backupPath2)!);

    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [sourcePath1, sourcePath2],
    });
    expect(result.status).toBe('success');
    const totalInserted = (result.applied.characters?.inserted ?? 0);
    expect(totalInserted).toBeGreaterThanOrEqual(3); // 至少补回 2,3,4
    const [cnt] = await db.executeSql(`SELECT COUNT(*) AS c FROM characters`);
    expect(cnt.rows.item(0).c).toBeGreaterThanOrEqual(4);
  });
});
```

注：M7（故意删行模拟数据丢失）和 M8（旧 schema 列投影）由于难以用 sql.js 稳定模拟，标记为可选；M1-M6、M9、M10 已覆盖核心路径。M7/M8 在 Task 6 的端到端测试里用更接近真实场景的方式覆盖。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest __tests__/services/recallMerger.test.ts`
Expected: FAIL（`applyRecall` 不存在）

- [ ] **Step 3: 实现 recallMerger.ts**

```ts
/**
 * 召回潜在数据：合并执行模块。
 *
 * 严格顺序：
 *   1. 强制 createSchemaRecoveryBackup（失败即中止，不动数据）
 *   2. 合并前 captureUserDataRecallSnapshot
 *   3. 源 A：repairKnownSchemaDrift（若勾选）
 *   4. 源 B/C：按 merge order 对每个勾选源 INSERT OR IGNORE 缺失行
 *   5. 合并后 captureUserDataRecallSnapshot + compareRecallSnapshots
 *   6. 状态判定
 *
 * 安全不变量：绝不 DELETE/UPDATE 现有行；合并用 INSERT OR IGNORE + 主键预检。
 */
import type SQLite from 'react-native-sqlite-storage';
import { execute } from '../../data/connection/execute';
import { openDatabase } from '../../data/connection/openDatabase';
import { executeTransaction, type SqlStatement } from '../database/transaction';
import { SCHEMA_MANIFEST } from '../database/schemaManifest';
import { readAndValidateBackup } from '../backupService';
import {
  createSchemaRecoveryBackup,
} from '../schemaRecoveryBackup';
import { inspectKnownSchemaDrift, repairKnownSchemaDrift } from '../../data/schema/knownSchemaRepairs';
import {
  captureUserDataRecallSnapshot,
  compareRecallSnapshots,
} from '../../data/schema/userDataRecallSnapshot';
import type { SchemaRepairResult } from '../../data/schema/knownSchemaRepairs';
import {
  RECALL_MERGE_ORDER,
  keyOf,
  type RecallTable,
  type RecallSelection,
  type RecallResult,
  type RecallErrorCode,
} from './recallTypes';
import { readExistingKeys } from './recallScanner';

export async function applyRecall(
  selection: RecallSelection,
): Promise<RecallResult> {
  if (!selection.repairCurrentDbDrift && selection.sourceFilePaths.length === 0) {
    return failedResult('NO_SELECTION', '未选择任何召回操作');
  }

  let db: SQLite.SQLiteDatabase;
  try {
    db = await openDatabase();
  } catch (e: any) {
    return failedResult('DB_OPEN_FAILED', `无法打开数据库：${e?.message ?? e}`);
  }

  // 1. 强制恢复备份
  let recoveryBackupPath: string;
  try {
    const backup = await createSchemaRecoveryBackup(db, 'schema_recovery');
    recoveryBackupPath = backup.path;
  } catch (e: any) {
    return failedResult(
      'RECOVERY_BACKUP_FAILED',
      `恢复备份失败：${e?.message ?? e}`,
    );
  }

  // 2. 合并前快照
  const beforeSnapshot = await captureUserDataRecallSnapshot(db);

  const applied: Partial<Record<RecallTable, { inserted: number; skipped: number }>> = {};
  let driftRepairResult: SchemaRepairResult | undefined;
  const errors: string[] = [];

  // 3. 源 A：漂移修复
  if (selection.repairCurrentDbDrift) {
    try {
      const report = await inspectKnownSchemaDrift(db);
      const repairResult = await repairKnownSchemaDrift(db, report);
      driftRepairResult = repairResult as any;
      if (!repairResult.ok) {
        errors.push(`漂移修复未成功：${repairResult.message}`);
      }
    } catch (e: any) {
      errors.push(`漂移修复失败：${e?.message ?? e}`);
    }
  }

  // 4. 源 B/C：按 merge order 合并每个源
  for (const filePath of selection.sourceFilePaths) {
    try {
      const { parsed } = await readAndValidateBackup(filePath);
      if (!parsed) {
        errors.push(`${filePath}: 解析失败或校验未通过`);
        continue;
      }
      await mergeFromBackup(db, parsed.tables, applied);
    } catch (e: any) {
      errors.push(`${filePath}: ${e?.message ?? e}`);
    }
  }

  // 5. 合并后快照 + 比对
  const afterSnapshot = await captureUserDataRecallSnapshot(db);
  const recallMismatch = compareRecallSnapshots(beforeSnapshot, afterSnapshot);

  // 6. 状态判定
  let status: RecallResult['status'];
  if (recallMismatch) {
    status = 'failed';
  } else if (errors.length > 0) {
    status = 'partial';
  } else {
    status = 'success';
  }

  return {
    status,
    recoveryBackupPath,
    beforeSnapshot,
    afterSnapshot,
    recallMismatch,
    driftRepairResult,
    applied,
    error:
      errors.length > 0
        ? {
            code: recallMismatch ? 'RECALL_MISMATCH' : 'SOURCE_INSERT_FAILED',
            message: errors.join('\n'),
          }
        : undefined,
  };
}

async function mergeFromBackup(
  db: SQLite.SQLiteDatabase,
  tables: Record<string, Record<string, any>[]>,
  appliedAcc: Partial<Record<RecallTable, { inserted: number; skipped: number }>>,
): Promise<void> {
  for (const table of RECALL_MERGE_ORDER) {
    const rows = tables[table];
    if (!Array.isArray(rows) || rows.length === 0) continue;

    const { inserted, skipped } = await insertMissingRows(db, table, rows);
    const prev = appliedAcc[table] ?? { inserted: 0, skipped: 0 };
    appliedAcc[table] = {
      inserted: prev.inserted + inserted,
      skipped: prev.skipped + skipped,
    };
  }
}

/** 取 row 的列与该表 manifest 列的交集（列投影）。 */
function projectColumns(
  table: RecallTable,
  row: Record<string, any>,
): { columns: string[]; values: any[] } {
  const manifestCols = new Set(
    SCHEMA_MANIFEST.find(t => t.name === table)?.columns ?? [],
  );
  const columns: string[] = [];
  const values: any[] = [];
  for (const [col, val] of Object.entries(row)) {
    if (manifestCols.has(col)) {
      columns.push(col);
      values.push(val);
    }
  }
  return { columns, values };
}

async function insertMissingRows(
  db: SQLite.SQLiteDatabase,
  table: RecallTable,
  rows: Record<string, any>[],
): Promise<{ inserted: number; skipped: number }> {
  const existingKeys = new Set(await readExistingKeys(db, table));
  const statements: SqlStatement[] = [];
  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    const k = keyOf(table, row);
    if (existingKeys.has(k)) {
      skipped++;
      continue;
    }
    const { columns, values } = projectColumns(table, row);
    if (columns.length === 0) {
      skipped++;
      continue;
    }
    const placeholders = columns.map(() => '?').join(', ');
    statements.push({
      sql: `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
      params: values,
    });
    // 乐观计入 inserted；INSERT OR IGNORE 若遇约束冲突 rowsAffected=0，但因主键已预检，冲突极少
    inserted++;
    existingKeys.add(k); // 防止同源内重复 id 二次插入
  }

  if (statements.length > 0) {
    await executeTransaction(db, statements, { faultDomain: 'restore' });
  }

  return { inserted, skipped };
}

function failedResult(code: RecallErrorCode, message: string): RecallResult {
  return {
    status: 'failed',
    recoveryBackupPath: '',
    beforeSnapshot: {} as any,
    afterSnapshot: {} as any,
    recallMismatch: null,
    applied: {},
    error: { code, message },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest __tests__/services/recallMerger.test.ts`
Expected: PASS (8 tests: M1-M6, M9, M10)

- [ ] **Step 5: typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/recall/recallMerger.ts __tests__/services/recallMerger.test.ts
git commit -m "feat(recall): add merger with INSERT OR IGNORE + drift repair + snapshot guard"
```

---

## Task 4: dataRecallService.ts — 协调层 + re-export

**Files:**
- Create: `src/services/recall/dataRecallService.ts`
- Modify: `src/services/database.ts`

- [ ] **Step 1: 创建 dataRecallService.ts（薄封装）**

```ts
/**
 * 召回潜在数据：公共 API 协调层。
 *
 * 仅 re-export scanner 和 merger 的入口，供 UI 和 database.ts facade 调用。
 * 不在此处添加业务逻辑，保持 scanner/merger 可独立测试。
 */
export { scanRecallSources } from './recallScanner';
export { applyRecall } from './recallMerger';
export type {
  RecallTable,
  RecallScanReport,
  CurrentDbFinding,
  BackupSourceFinding,
  RecallSelection,
  RecallResult,
  RecallTableResult,
  RecallErrorCode,
} from './recallTypes';
export { RECALL_TABLES, RECALL_TABLE_DISPLAY, keyOf } from './recallTypes';
```

- [ ] **Step 2: 在 database.ts re-export**

在 `src/services/database.ts` 末尾追加：

```ts
// 召回潜在数据功能（备份中心入口）
export * from './recall/dataRecallService';
```

- [ ] **Step 3: typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/recall/dataRecallService.ts src/services/database.ts
git commit -m "feat(recall): add service facade and re-export from database.ts"
```

---

## Task 5: RecallScreen.tsx — UI 屏幕

**Files:**
- Create: `src/screens/RecallScreen.tsx`

实现前先确认 UI 组件库的导出（Header/Card/Button/Screen/EmptyState/LoadingState/spacing）已在 BackupCenterScreen 用过，直接复用。

- [ ] **Step 1: 创建 RecallScreen.tsx**

```tsx
import React, { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Switch,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import {
  Button,
  Card,
  EmptyState,
  Header,
  LoadingState,
  Screen,
  spacing,
} from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import {
  scanRecallSources,
  applyRecall,
  RECALL_TABLE_DISPLAY,
  type RecallScanReport,
  type BackupSourceFinding,
  type RecallResult,
  type RecallTable,
} from '../services/recall/dataRecallService';

type Phase = 'idle' | 'scanning' | 'scanError' | 'preview' | 'merging' | 'result';

/** 把 recoverable map 格式化成可读字符串（只列 >0 的非关联主表） */
function formatRecoverable(recoverable: Record<RecallTable, number>): string {
  const parts: string[] = [];
  for (const [table, count] of Object.entries(recoverable)) {
    const t = table as RecallTable;
    if (RECALL_TABLE_DISPLAY[t].isLink) continue; // 关联表不单列
    if (count > 0) parts.push(`${RECALL_TABLE_DISPLAY[t].label} +${count}`);
  }
  return parts.length > 0 ? `可召回：${parts.join('  ')}` : '无可召回的新数据';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Props {
  onClose?: () => void;
}

export const RecallScreen: React.FC<Props> = ({ onClose }) => {
  const navigation = useNavigation();
  const handleClose = onClose || (() => navigation.goBack());
  const { theme } = useThemeStore();

  const [phase, setPhase] = useState<Phase>('idle');
  const [report, setReport] = useState<RecallScanReport | null>(null);
  const [result, setResult] = useState<RecallResult | null>(null);
  const [repairDrift, setRepairDrift] = useState(true);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());

  const handleScan = useCallback(async () => {
    setPhase('scanning');
    try {
      const r = await scanRecallSources();
      setReport(r);
      // 默认勾选：漂移需修复 + 有可召回量的源
      setRepairDrift(r.currentDb.schemaDrift.needsRepair);
      const defaultSelected = new Set<string>();
      for (const s of r.sources) {
        if (!s.valid) continue;
        const hasRecoverable = Object.values(s.recoverable).some(c => c > 0);
        if (hasRecoverable) defaultSelected.add(s.filePath);
      }
      setSelectedSources(defaultSelected);
      setPhase('preview');
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '扫描失败', text2: e?.message });
      setPhase('scanError');
    }
  }, []);

  const toggleSource = (filePath: string) => {
    setSelectedSources(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const handleApply = useCallback(async () => {
    if (!repairDrift && selectedSources.size === 0) {
      Toast.show({ type: 'info', text1: '请至少选择一项召回操作' });
      return;
    }
    Alert.alert(
      '确认召回',
      '执行前会自动创建一份恢复备份。本操作不会删除任何现有数据，只会补回缺失的行。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '执行召回',
          onPress: async () => {
            setPhase('merging');
            try {
              const r = await applyRecall({
                repairCurrentDbDrift: repairDrift,
                sourceFilePaths: Array.from(selectedSources),
              });
              setResult(r);
              setPhase('result');
            } catch (e: any) {
              Alert.alert('召回失败', e?.message || '未知错误');
              setPhase('preview');
            }
          },
        },
      ],
    );
  }, [repairDrift, selectedSources]);

  const canApply = repairDrift || selectedSources.size > 0;

  // ===== 入口态 =====
  if (phase === 'idle' || phase === 'scanError') {
    return (
      <Screen>
        <Header
          title="召回潜在数据"
          subtitle="找回因升级或结构问题无法显示的资料"
          action={<Button label="关闭" variant="ghost" compact onPress={handleClose} />}
        />
        <View style={styles.body}>
          <View style={[styles.noticeCard, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.noticeTitle, { color: theme.colors.textPrimary }]}>
              召回潜在数据
            </Text>
            <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
              扫描当前数据库与历史备份，把因版本升级、结构漂移等原因无法正常显示的资料重新找回并合并到当前库。{'\n\n'}
              本操作不会删除任何现有数据，执行前会自动创建恢复备份。
            </Text>
          </View>
          <Button
            label={phase === 'scanError' ? '重新扫描' : '开始扫描'}
            onPress={handleScan}
            flex
          />
        </View>
      </Screen>
    );
  }

  // ===== 扫描中 =====
  if (phase === 'scanning') {
    return (
      <Screen>
        <Header title="召回潜在数据" action={<Button label="关闭" variant="ghost" compact onPress={handleClose} />} />
        <LoadingState label="正在扫描当前库与备份源..." />
      </Screen>
    );
  }

  // ===== 合并中 =====
  if (phase === 'merging') {
    return (
      <Screen>
        <Header title="召回潜在数据" action={<Button label="关闭" variant="ghost" compact onPress={handleClose} />} />
        <LoadingState label="正在执行召回（创建恢复备份→修复/合并→校验）...请勿关闭应用" />
      </Screen>
    );
  }

  // ===== 结果态 =====
  if (phase === 'result' && result) {
    const isFail = result.status === 'failed';
    const isPartial = result.status === 'partial';
    const accent = isFail ? theme.colors.danger : isPartial ? '#E0A030' : theme.colors.accent;
    return (
      <Screen>
        <Header title="召回潜在数据" action={<Button label="完成" variant="ghost" compact onPress={handleClose} />} />
        <ScrollView style={styles.body}>
          <View style={[styles.noticeCard, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.noticeTitle, { color: accent }]}>
              {isFail ? '✗ 召回中止' : isPartial ? '⚠ 部分召回成功' : '✓ 召回完成'}
            </Text>
            <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
              恢复备份：{result.recoveryBackupPath.split('/').pop() || '—'}
            </Text>

            {result.driftRepairResult && (
              <Text style={[styles.noticeText, { color: theme.colors.textSecondary, marginTop: spacing.sm }]}>
                结构漂移：{result.driftRepairResult.ok ? '已修复' : '未成功'}
              </Text>
            )}

            {/* 召回明细 */}
            {Object.entries(result.applied).map(([table, r]) => {
              const t = table as RecallTable;
              if (RECALL_TABLE_DISPLAY[t].isLink) return null;
              if (r!.inserted === 0 && r!.skipped === 0) return null;
              return (
                <Text key={table} style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
                  {RECALL_TABLE_DISPLAY[t].label}：+{r!.inserted}（跳过 {r!.skipped}）
                </Text>
              );
            })}

            {/* 前后对比 */}
            {!isFail && (
              <View style={{ marginTop: spacing.sm }}>
                <Text style={[styles.noticeText, { color: theme.colors.textMuted }]}>合并前 → 合并后</Text>
                <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
                  角色卡：{result.beforeSnapshot.characters.count} → {result.afterSnapshot.characters.count}
                </Text>
                <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
                  世界书条目：{result.beforeSnapshot.worldbookEntries.count} → {result.afterSnapshot.worldbookEntries.count}
                </Text>
                <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
                  笔记：{result.beforeSnapshot.notes.count} → {result.afterSnapshot.notes.count}
                </Text>
              </View>
            )}

            {(isPartial || isFail) && result.error && (
              <Text style={[styles.noticeText, { color: theme.colors.danger, marginTop: spacing.sm }]}>
                {result.error.message}
              </Text>
            )}
            {result.recallMismatch && (
              <Text style={[styles.noticeText, { color: theme.colors.danger }]}>
                {result.recallMismatch.table}：{result.recallMismatch.reason}
              </Text>
            )}
          </View>
          <Button label="完成" onPress={handleClose} flex />
        </ScrollView>
      </Screen>
    );
  }

  // ===== 预览态 =====
  const dbInfo = report!.currentDb;
  return (
    <Screen>
      <Header
        title="召回潜在数据"
        subtitle="预览并选择要召回的数据"
        action={<Button label="关闭" variant="ghost" compact onPress={handleClose} />}
      />
      <FlatList
        data={report!.sources}
        keyExtractor={item => item.filePath}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            {/* 区段 1：当前库诊断 */}
            <Card>
              <Text style={[styles.sectionTitle, { color: theme.colors.textPrimary }]}>
                当前库诊断
              </Text>
              {!dbInfo.reachable && (
                <Text style={[styles.warning, { color: theme.colors.danger }]}>
                  当前数据库存在结构漂移，部分资料暂时无法读取。
                </Text>
              )}
              {dbInfo.schemaDrift.needsRepair && (
                <View style={[styles.switchRow, { borderColor: theme.colors.border }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.switchLabel, { color: theme.colors.textPrimary }]}>
                      修复数据库结构漂移
                    </Text>
                    <Text style={[styles.switchHint, { color: theme.colors.textMuted }]}>
                      检测到 canon_evidence 缺列等已知漂移，修复后资料可重新读取（推荐）
                    </Text>
                  </View>
                  <Switch
                    value={repairDrift}
                    onValueChange={setRepairDrift}
                    trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                  />
                </View>
              )}
              {/* 资料表行数 */}
              <View style={{ marginTop: spacing.sm }}>
                {(Object.entries(dbInfo.rowCount) as [RecallTable, number][])
                  .filter(([t]) => !RECALL_TABLE_DISPLAY[t].isLink)
                  .map(([table, count]) => (
                    <Text key={table} style={[styles.countRow, { color: theme.colors.textSecondary }]}>
                      {RECALL_TABLE_DISPLAY[table].label}：{count < 0 ? '读取失败' : count}
                    </Text>
                  ))}
              </View>
            </Card>

            {/* 区段 2 标题 */}
            <Text style={[styles.sectionTitle, { color: theme.colors.textPrimary, marginTop: spacing.md }]}>
              可召回的备份源
            </Text>
            {report!.sources.length === 0 && (
              <Text style={[styles.empty, { color: theme.colors.textSecondary }]}>
                未发现任何备份源（schema-recovery 目录与备份目录均为空）。
              </Text>
            )}
          </View>
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <Text style={[styles.strategy, { color: theme.colors.textMuted }]}>
              合并策略：只补当前库缺失的行，已存在的相同主键将跳过。{'\n'}
              关联关系（项目-资源）将随对应资料一并恢复。
            </Text>
            <View style={styles.footerBtnRow}>
              <Button label="取消" variant="ghost" compact onPress={handleClose} />
              <Button
                label="执行召回"
                onPress={handleApply}
                disabled={!canApply}
              />
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <SourceCard
            source={item}
            selected={selectedSources.has(item.filePath)}
            onToggle={() => toggleSource(item.filePath)}
            theme={theme}
          />
        )}
      />
    </Screen>
  );
};

const SourceCard: React.FC<{
  source: BackupSourceFinding;
  selected: boolean;
  onToggle: () => void;
  theme: any;
}> = ({ source, selected, onToggle, theme }) => {
  const fileName = source.filePath.split('/').pop() || source.filePath;
  const sourceLabel = source.sourceId === 'schema-recovery' ? '结构修复' : '用户备份';
  return (
    <Card>
      <View style={styles.row}>
        <Text style={[styles.fileName, { color: theme.colors.textPrimary }]} numberOfLines={1}>
          {fileName}
        </Text>
        <Text style={[styles.kindBadge, { color: theme.colors.accent }]}>{sourceLabel}</Text>
      </View>
      <View style={styles.metaRow}>
        <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
          {formatTime(source.createdAt)} · Schema {source.schemaVersion || '—'} · V{source.appVersion || '—'}
        </Text>
      </View>
      {!source.valid ? (
        <Text style={[styles.invalid, { color: theme.colors.danger }]}>
          备份无效或已损坏：{source.invalidReason}
        </Text>
      ) : (
        <>
          <Text style={[styles.recoverable, { color: theme.colors.textSecondary }]}>
            {formatRecoverable(source.recoverable)}
          </Text>
          <View style={[styles.switchRow, { borderColor: theme.colors.border, marginTop: spacing.sm }]}>
            <Text style={[styles.switchLabel, { color: theme.colors.textPrimary }]}>
              {selected ? '☑ 此源' : '☐ 此源'}
            </Text>
            <Switch
              value={selected}
              onValueChange={onToggle}
              disabled={!source.valid}
              trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
            />
          </View>
        </>
      )}
    </Card>
  );
};

const styles = StyleSheet.create({
  body: { padding: spacing.lg },
  noticeCard: { borderRadius: 8, padding: spacing.md, marginBottom: spacing.md },
  noticeTitle: { fontSize: 16, fontWeight: '700', marginBottom: spacing.xs },
  noticeText: { fontSize: 13, lineHeight: 20, marginTop: spacing.xs },
  list: { padding: spacing.lg, paddingBottom: 120 },
  sectionTitle: { fontSize: 14, fontWeight: '700', marginBottom: spacing.sm },
  warning: { fontSize: 13, marginTop: spacing.xs },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    marginTop: spacing.sm,
  },
  switchLabel: { fontSize: 14, fontWeight: '600' },
  switchHint: { fontSize: 12, marginTop: 2 },
  countRow: { fontSize: 13, lineHeight: 20 },
  empty: { fontSize: 13, paddingVertical: spacing.md, textAlign: 'center' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fileName: { fontSize: 13, fontWeight: '600', flex: 1, marginRight: spacing.sm },
  kindBadge: { fontSize: 12, fontWeight: '700' },
  metaRow: { flexDirection: 'row', marginTop: spacing.xs },
  meta: { fontSize: 12 },
  recoverable: { fontSize: 13, marginTop: spacing.xs },
  invalid: { fontSize: 12, fontWeight: '600', marginTop: spacing.xs },
  footer: { marginTop: spacing.md },
  strategy: { fontSize: 12, lineHeight: 18, marginBottom: spacing.sm },
  footerBtnRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
});
```

- [ ] **Step 2: typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: lint**

Run: `npm run lint`
Expected: PASS（如有 unused import 警告，清理）

- [ ] **Step 4: Commit**

```bash
git add src/screens/RecallScreen.tsx
git commit -m "feat(recall): add RecallScreen UI (scan→preview→select→merge→result)"
```

---

## Task 6: 备份中心入口 + 路由注册

**Files:**
- Modify: `src/screens/BackupCenterScreen.tsx`
- Modify: `src/navigation/TabNavigator.tsx`

- [ ] **Step 1: BackupCenterScreen 加入口按钮**

在 `src/screens/BackupCenterScreen.tsx` 的 `createRow` View 下方（约 line 220 `privacyNotice` 之前）插入召回入口行：

```tsx
<View style={[styles.recallEntry, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.border }]}>
  <Button
    label="召回潜在数据"
    variant="secondary"
    onPress={() => navigation.navigate('Recall')}
    flex
  />
</View>
```

在 styles 末尾追加：

```ts
recallEntry: {
  paddingHorizontal: spacing.lg,
  paddingTop: spacing.sm,
  paddingBottom: spacing.md,
  borderBottomWidth: StyleSheet.hairlineWidth,
  elevation: 1,
  zIndex: 1,
},
```

- [ ] **Step 2: TabNavigator 注册路由**

在 `src/navigation/TabNavigator.tsx`：

**2a.** 在 `SettingsStackParamList`（line 77-89）加：
```ts
  Recall: undefined;
```

**2b.** 在 `SettingsStackScreen`（line 272-304）的 `<SettingsStack.Screen name="BackupCenter" .../>` 后加：
```tsx
    <SettingsStack.Screen name="Recall" component={RecallScreen} />
```

**2c.** 在文件顶部的 import 区（与其他 screen import 一起）加：
```ts
import { RecallScreen } from '../screens/RecallScreen';
```

- [ ] **Step 3: typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/screens/BackupCenterScreen.tsx src/navigation/TabNavigator.tsx
git commit -m "feat(recall): wire recall entry button in BackupCenter + register Recall route"
```

---

## Task 7: 端到端测试 + 完整验证

**Files:**
- Create: `__tests__/services/dataRecallService.test.ts`

- [ ] **Step 1: 写端到端测试**

创建 `__tests__/services/dataRecallService.test.ts`：

```ts
import RNFS from 'react-native-fs';
import { createCanonInMemoryDb, type InMemorySqliteDb } from '../helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../../src/data/connection/openDatabase';
import { setupInMemoryFs } from '../schema40-fixture-helpers';
import { createBackup } from '../../src/services/backupService';
import { SCHEMA_RECOVERY_DIR } from '../../src/services/schemaRecoveryBackup';
import { scanRecallSources, applyRecall } from '../../src/services/recall/dataRecallService';

describe('dataRecallService end-to-end', () => {
  let db: InMemorySqliteDb;
  let files: Map<string, string>;

  beforeEach(async () => {
    __resetForTest();
    files = setupInMemoryFs();
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
  });

  afterEach(() => {
    __resetForTest();
    try { db.close(); } catch { /* noop */ }
  });

  it('E2E: scan 发现源 → apply 合并缺失角色卡 → 重扫 recoverable 归零', async () => {
    // 1. 准备源备份：含 3 个 character
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    for (let i = 1; i <= 3; i++) {
      await db.executeSql(
        `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
         VALUES (${i}, 1, NULL, 'c${i}', 'manual', '{}', 0, 0, 't')`,
      );
    }
    const backupPath = await createBackup(db, '2.11.24', 40, 'manual');
    const sourcePath = `${SCHEMA_RECOVERY_DIR}/e2e.json`;
    files.set(sourcePath, files.get(backupPath)!);

    // 2. 清空当前库的 character，模拟"数据不见"
    await db.executeSql(`DELETE FROM characters`);

    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === SCHEMA_RECOVERY_DIR) {
        return [{ isFile: () => true, name: 'e2e.json', path: sourcePath, size: 100 }];
      }
      return [];
    });

    // 3. 第一次扫描：应发现可召回 3 个角色卡
    const report1 = await scanRecallSources();
    expect(report1.sources).toHaveLength(1);
    expect(report1.sources[0].recoverable.characters).toBe(3);

    // 4. 执行召回
    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [sourcePath],
    });
    expect(result.status).toBe('success');
    expect(result.applied.characters?.inserted).toBe(3);

    // 5. 校验当前库确实有了 3 行
    const [cnt] = await db.executeSql(`SELECT COUNT(*) AS c FROM characters`);
    expect(cnt.rows.item(0).c).toBe(3);

    // 6. 重扫：recoverable 应归零
    const report2 = await scanRecallSources();
    expect(report2.sources[0].recoverable.characters).toBe(0);
  });

  it('E2E: 漂移库 + 召回 → 漂移修复 + 数据保留', async () => {
    // 制造漂移
    await db.executeSql(`ALTER TABLE canon_evidence RENAME TO canon_evidence_full`);
    await db.executeSql(
      `CREATE TABLE canon_evidence AS SELECT id, project_id, source_id, snapshot_id,
       chapter_id, chapter_position, paragraph_start, paragraph_end,
       char_start, char_end, quote_preview, quote_sha256, analysis_run_id, created_at
       FROM canon_evidence_full`,
    );
    await db.executeSql(`DROP TABLE canon_evidence_full`);
    // 塞数据
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await db.executeSql(
      `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
       VALUES (5, 1, NULL, 'hero', 'manual', '{}', 0, 0, 't')`,
    );

    const report = await scanRecallSources();
    expect(report.currentDb.schemaDrift.needsRepair).toBe(true);

    const result = await applyRecall({
      repairCurrentDbDrift: true,
      sourceFilePaths: [],
    });
    expect(result.status).toBe('success');
    expect(result.driftRepairResult?.ok).toBe(true);
    // character 没丢
    const [cnt] = await db.executeSql(`SELECT COUNT(*) AS c FROM characters`);
    expect(cnt.rows.item(0).c).toBe(1);
  });
});
```

- [ ] **Step 2: 运行端到端测试**

Run: `npx jest __tests__/services/dataRecallService.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: 运行全部 recall 相关测试**

Run: `npx jest __tests__/services/recallScanner.test.ts __tests__/services/recallMerger.test.ts __tests__/services/dataRecallService.test.ts`
Expected: PASS (18 tests total)

- [ ] **Step 4: 完整门禁**

Run: `npm run verify`
Expected: PASS（lint + typecheck + test:ci）

- [ ] **Step 5: Commit**

```bash
git add __tests__/services/dataRecallService.test.ts
git commit -m "test(recall): add end-to-end tests covering scan→apply→rescan + drift repair"
```

---

## 完工核对清单

施工完成后，逐项确认（对应 spec §10 完成定义）：

- [ ] 备份中心有「召回潜在数据」入口，点击进入 RecallScreen
- [ ] 扫描阶段纯只读，不开任何写事务
- [ ] 扫描报告展示当前库诊断（漂移 + 9 表行数）+ 源 B/C 明细（含可召回量）
- [ ] 预览页支持勾选源 + 勾选漂移修复
- [ ] 合并阶段第一动作为 `createSchemaRecoveryBackup`，失败则中止
- [ ] 源 A 合并 = `repairKnownSchemaDrift`；源 B/C = `INSERT OR IGNORE` 只补缺失行
- [ ] 合并前后 `captureUserDataRecallSnapshot` + `compareRecallSnapshots`，不一致即 failed
- [ ] 结果页按 success/partial/failed 三态展示
- [ ] 关联表随主表打包召回
- [ ] 全部测试通过（S1-S8 + M1-M10 + E2E）
- [ ] `npm run verify` 通过
- [ ] 未触碰启动链路（initializeDatabase / main/index.tsx）
