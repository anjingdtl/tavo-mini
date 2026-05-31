# 智能升级安装系统 - 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现智能 APK 升级安装机制——自动版本管理、安装类型检测、增量数据库迁移、升级前自动备份、升级提示 UI。

**Architecture:** Gradle 构建时自动从 git/package.json 生成 versionCode/versionName 和 `version.json`。App 启动时通过 `settings` 表对比存储版本与当前版本，判断 fresh/upgrade/same。增量迁移引擎按 schema version 逐步执行迁移，breaking 变更触发自动备份。升级 UI 仅在 breaking 升级时显示。

**Tech Stack:** React Native 0.85, TypeScript, SQLite (react-native-sqlite-storage), react-native-fs, Gradle/Groovy, Jest

**Spec:** `docs/superpowers/specs/2026-05-31-smart-upgrade-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `android/app/build.gradle` | versionCode/versionName 自动化 + 调用 version.json 生成 |
| `scripts/generate-version-json.js` | Node 脚本，读取 package.json + git 生成 version.json |
| `src/constants/version.json` | 构建生成的版本信息（gitignore） |
| `src/services/migrations/types.ts` | Migration 接口定义 |
| `src/services/migrations/v3-to-v4.ts` | 迁移：填充 project_resources 关联表 |
| `src/services/migrations/v4-to-v5.ts` | 迁移：为孤立 worldbook_entries 创建默认 collection |
| `src/services/migrations/index.ts` | 迁移注册表 + 执行引擎 |
| `src/services/backupService.ts` | 备份/恢复服务 |
| `src/services/database.ts` | 重构 migrate() → 集成安装类型检测 + 调用迁移引擎 |
| `src/screens/UpgradeScreen.tsx` | 升级提示全屏对话框 |
| `src/main/index.tsx` | 启动流程集成升级检测 |
| `__tests__/migrationEngine.test.ts` | 迁移引擎测试 |
| `__tests__/installTypeDetection.test.ts` | 安装类型检测测试 |
| `__tests__/backupService.test.ts` | 备份服务测试 |

---

### Task 1: 版本自动化脚本

**Files:**
- Create: `scripts/generate-version-json.js`
- Create: `src/constants/version.json`

- [ ] **Step 1: 创建 generate-version-json.js 脚本**

```js
// scripts/generate-version-json.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const pkg = require(path.join(projectRoot, 'package.json'));

let versionCode;
try {
  versionCode = parseInt(
    execSync('git rev-list --count HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim(),
    10,
  );
} catch {
  const parts = pkg.version.split('.');
  versionCode = parseInt(parts[0], 10) * 10000 + parseInt(parts[1], 10) * 100 + parseInt(parts[2], 10);
}

const versionJson = {
  versionName: `V${pkg.version}`,
  versionCode,
  buildTime: new Date().toISOString(),
};

const outDir = path.join(projectRoot, 'src', 'constants');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'version.json'),
  JSON.stringify(versionJson, null, 2) + '\n',
);

console.log(`version.json: versionName=${versionJson.versionName}, versionCode=${versionJson.versionCode}`);
```

- [ ] **Step 2: 手动运行脚本验证**

Run: `node scripts/generate-version-json.js`
Expected: 控制台输出 `version.json: versionName=V1.3.2, versionCode=<数字>`，且 `src/constants/version.json` 文件已生成。

- [ ] **Step 3: 将 version.json 加入 .gitignore**

在 `.gitignore` 中添加：

```
src/constants/version.json
```

- [ ] **Step 4: 在 package.json 中添加 prebuild 脚本**

在 `scripts` 中添加：

```json
"prebuild": "node scripts/generate-version-json.js"
```

同时修改 `apk:debug` 和 `apk:release` 脚本，在构建前先运行 prebuild：

```json
"apk:debug": "npm run prebuild && node scripts/build-apk.js debug",
"apk:release": "npm run prebuild && node scripts/build-apk.js release"
```

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-version-json.js .gitignore package.json
git commit -m "feat: add version.json generation script and prebuild hook"
```

---

### Task 2: Gradle 版本自动化

**Files:**
- Modify: `android/app/build.gradle:81-87`

- [ ] **Step 1: 修改 build.gradle 的 defaultConfig 块**

将 `android/app/build.gradle` 的 `defaultConfig` 块替换为：

```groovy
    defaultConfig {
        applicationId "com.tavomini"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion

        def gitCommitCount = {
            try {
                return Integer.parseInt("git rev-list --count HEAD".execute(null, rootDir).text.trim())
            } catch (Exception e) {
                def pkg = new groovy.json.JsonSlurper().parse(file("../../package.json"))
                def parts = pkg.version.split("\\.")
                return Integer.parseInt(parts[0]) * 10000 + Integer.parseInt(parts[1]) * 100 + Integer.parseInt(parts[2])
            }
        }()

        def pkgVersion = new groovy.json.JsonSlurper().parse(file("../../package.json")).version

        versionCode gitCommitCount
        versionName "V${pkgVersion}"
    }
```

- [ ] **Step 2: 在 build.gradle 末尾添加 preBuild 钩子**

在 `android/app/build.gradle` 文件末尾（`dependencies` 块之后）添加：

```groovy
task generateVersionJson(type: Exec) {
    workingDir "../../"
    commandLine "node", "scripts/generate-version-json.js"
}

preBuild.dependsOn generateVersionJson
```

- [ ] **Step 3: 验证 Gradle 配置**

Run: `cd android && gradlew.bat tasks --all | findstr generateVersionJson`
Expected: 能看到 `generateVersionJson` task。

- [ ] **Step 4: Commit**

```bash
git add android/app/build.gradle
git commit -m "feat: auto versionCode/versionName from git and package.json in Gradle"
```

---

### Task 3: 迁移类型定义

**Files:**
- Create: `src/services/migrations/types.ts`

- [ ] **Step 1: 创建 types.ts**

```ts
// src/services/migrations/types.ts
import type SQLite from 'react-native-sqlite-storage';

export interface Migration {
  from: number;
  to: number;
  breaking: boolean;
  migrate: (db: SQLite.SQLiteDatabase) => Promise<void>;
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  migrationsRun: number;
  hadBreaking: boolean;
  backupPath: string | null;
}

export type InstallType = 'fresh' | 'upgrade' | 'same';

export interface InstallInfo {
  installType: InstallType;
  currentVersion: string;
  previousVersion: string | null;
  firstInstallVersion: string;
  schemaVersion: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/migrations/types.ts
git commit -m "feat: add migration type definitions"
```

---

### Task 4: 迁移步骤文件

**Files:**
- Create: `src/services/migrations/v3-to-v4.ts`
- Create: `src/services/migrations/v4-to-v5.ts`

- [ ] **Step 1: 创建 v3-to-v4.ts**

```ts
// src/services/migrations/v3-to-v4.ts
import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

export async function migrateV3toV4(db: SQLite.SQLiteDatabase): Promise<void> {
  await execute(
    db,
    "INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled) SELECT project_id, 'character', id, 1 FROM characters WHERE project_id > 0",
  );
  await execute(
    db,
    "INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled) SELECT project_id, 'worldbook', id, enabled FROM worldbook_entries WHERE project_id > 0",
  );
  await execute(
    db,
    "INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled) SELECT project_id, 'note', id, 1 FROM notes WHERE project_id > 0",
  );
  await execute(
    db,
    "INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled) SELECT project_id, 'preset', id, 1 FROM presets WHERE project_id > 0",
  );
}
```

- [ ] **Step 2: 创建 v4-to-v5.ts**

```ts
// src/services/migrations/v4-to-v5.ts
import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

function now(): string {
  return new Date().toISOString();
}

export async function migrateV4toV5(db: SQLite.SQLiteDatabase): Promise<void> {
  const existing = await execute(db, 'SELECT id FROM worldbook_collections ORDER BY id ASC LIMIT 1');
  let collectionId: number | null = existing.rows.length > 0 ? existing.rows.item(0).id : null;
  if (!collectionId) {
    const result = await execute(
      db,
      'INSERT INTO worldbook_collections (project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (?, ?, 1, 50000, 0, ?)',
      [0, '未分组/手动条目', now()],
    );
    collectionId = result.insertId!;
  }
  await execute(db, 'UPDATE worldbook_entries SET collection_id = ? WHERE collection_id = 0', [collectionId]);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/migrations/v3-to-v4.ts src/services/migrations/v4-to-v5.ts
git commit -m "feat: extract existing migrations into per-version files"
```

---

### Task 5: 迁移引擎

**Files:**
- Create: `src/services/migrations/index.ts`
- Create: `__tests__/migrationEngine.test.ts`

- [ ] **Step 1: 编写迁移引擎测试**

```ts
// __tests__/migrationEngine.test.ts
/* eslint-env jest */

type TableRows = Record<string, any>[];

const createRows = (rows: TableRows) => ({
  length: rows.length,
  item: (index: number) => rows[index],
  raw: () => rows,
});

function createMockDb(startSchemaVersion: string | null) {
  const settings = new Map<string, string>();
  if (startSchemaVersion !== null) {
    settings.set('schema_version', startSchemaVersion);
  }
  const executed: string[] = [];

  const executeSql = jest.fn(async (sql: string, params: any[] = []) => {
    executed.push(sql);
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT value FROM settings WHERE key = \?/i.test(normalized)) {
      const key = params[0];
      const value = settings.get(key);
      const rows = value !== undefined ? [{ value }] : [];
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(rows) }];
    }

    if (/^INSERT OR REPLACE INTO settings/i.test(normalized)) {
      settings.set(params[0], params[1]);
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
  });

  const db = {
    executeSql,
    transaction: jest.fn(async (scope: (tx: { executeSql: typeof executeSql }) => void) => {
      await scope({ executeSql });
    }),
  };

  return { db, settings, executed };
}

describe('migration engine', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('runs no migrations when already at latest version', async () => {
    const { db, settings } = createMockDb('5');
    const { runMigrations } = require('../src/services/migrations');
    const result = await runMigrations(db as any, 5);
    expect(result.migrationsRun).toBe(0);
    expect(result.hadBreaking).toBe(false);
    expect(settings.get('schema_version')).toBe('5');
  });

  test('runs only needed migrations from v3 to v5', async () => {
    const { db, settings } = createMockDb('3');
    const { runMigrations } = require('../src/services/migrations');
    const result = await runMigrations(db as any, 3);
    expect(result.fromVersion).toBe(3);
    expect(result.toVersion).toBe(5);
    expect(result.migrationsRun).toBe(2);
    expect(settings.get('schema_version')).toBe('5');
  });

  test('detects breaking migrations', async () => {
    const { db } = createMockDb('2');
    const { runMigrations } = require('../src/services/migrations');
    const result = await runMigrations(db as any, 2);
    expect(result.hadBreaking).toBe(true);
  });

  test('returns null backupPath when no breaking migration', async () => {
    const { db } = createMockDb('4');
    const { runMigrations } = require('../src/services/migrations');
    const result = await runMigrations(db as any, 4);
    expect(result.backupPath).toBeNull();
    expect(result.hadBreaking).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest __tests__/migrationEngine.test.ts`
Expected: FAIL — `Cannot find module '../src/services/migrations'`

- [ ] **Step 3: 实现迁移引擎**

```ts
// src/services/migrations/index.ts
import type SQLite from 'react-native-sqlite-storage';
import type { Migration, MigrationResult } from './types';
import { migrateV3toV4 } from './v3-to-v4';
import { migrateV4toV5 } from './v4-to-v5';

export const SCHEMA_VERSION = 5;
export const MIN_COMPATIBLE_SCHEMA_VERSION = 3;

const MIGRATIONS: Migration[] = [
  { from: 3, to: 4, breaking: false, migrate: migrateV3toV4 },
  { from: 4, to: 5, breaking: false, migrate: migrateV4toV5 },
];

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

export async function runMigrations(
  db: SQLite.SQLiteDatabase,
  fromVersion: number,
  onBackup?: () => Promise<string | null>,
): Promise<MigrationResult> {
  const needed = MIGRATIONS.filter(m => m.from >= fromVersion && m.to <= SCHEMA_VERSION);
  const hasBreaking = needed.some(m => m.breaking);

  let backupPath: string | null = null;
  if (hasBreaking && onBackup) {
    backupPath = await onBackup();
  }

  for (const migration of needed) {
    await db.transaction(async (tx) => {
      await migration.migrate(tx as unknown as SQLite.SQLiteDatabase);
      await execute(
        tx as unknown as SQLite.SQLiteDatabase,
        'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        ['schema_version', String(migration.to)],
      );
    });
  }

  return {
    fromVersion,
    toVersion: SCHEMA_VERSION,
    migrationsRun: needed.length,
    hadBreaking: hasBreaking,
    backupPath,
  };
}

export function hasBreakingMigration(fromVersion: number): boolean {
  return MIGRATIONS.some(m => m.from >= fromVersion && m.to <= SCHEMA_VERSION && m.breaking);
}

export function isIncompatibleUpgrade(fromVersion: number): boolean {
  return fromVersion < MIN_COMPATIBLE_SCHEMA_VERSION;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest __tests__/migrationEngine.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/migrations/index.ts __tests__/migrationEngine.test.ts
git commit -m "feat: add incremental migration engine with tests"
```

---

### Task 6: 备份服务

**Files:**
- Create: `src/services/backupService.ts`
- Create: `__tests__/backupService.test.ts`

- [ ] **Step 1: 编写备份服务测试**

```ts
// __tests__/backupService.test.ts
/* eslint-env jest */

import RNFS from 'react-native-fs';

type TableRows = Record<string, any>[];

const createRows = (rows: TableRows) => ({
  length: rows.length,
  item: (index: number) => rows[index],
  raw: () => rows,
});

function createMockDb(tableData: Record<string, TableRows>) {
  const executeSql = jest.fn(async (sql: string, params: any[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    const selectAll = normalized.match(/^SELECT \* FROM (\w+)/i);
    if (selectAll) {
      const table = selectAll[1];
      const rows = tableData[table] || [];
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(rows) }];
    }

    const deleteFrom = normalized.match(/^DELETE FROM (\w+)/i);
    if (deleteFrom) {
      const table = deleteFrom[1];
      if (tableData[table]) tableData[table] = [];
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    const insertInto = normalized.match(/^INSERT INTO (\w+)/i);
    if (insertInto) {
      return [{ insertId: 1, rowsAffected: 1, rows: createRows([]) }];
    }

    return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
  });

  return { executeSql } as any;
}

describe('backupService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (RNFS.writeFile as jest.Mock).mockResolvedValue(undefined);
    (RNFS.readFile as jest.Mock).mockResolvedValue('{}');
    (RNFS.mkdir as jest.Mock).mockResolvedValue(undefined);
    (RNFS.readDir as jest.Mock).mockResolvedValue([]);
    (RNFS.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  test('createBackup exports all tables to JSON file', async () => {
    const mockDb = createMockDb({
      projects: [{ id: 1, name: '测试项目' }],
      chapters: [{ id: 1, project_id: 1, title: '第1章' }],
    });

    jest.resetModules();
    const { createBackup } = require('../src/services/backupService');
    const backupPath = await createBackup(mockDb, '1.2.0', '3');

    expect(backupPath).toBeTruthy();
    expect(RNFS.mkdir).toHaveBeenCalled();
    expect(RNFS.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('backup_v1.2.0_'),
      expect.any(String),
      'utf8',
    );

    const writtenJson = JSON.parse((RNFS.writeFile as jest.Mock).mock.calls[0][1]);
    expect(writtenJson.meta.app_version).toBe('1.2.0');
    expect(writtenJson.meta.schema_version).toBe('3');
    expect(writtenJson.tables.projects).toHaveLength(1);
    expect(writtenJson.tables.chapters).toHaveLength(1);
  });

  test('restoreFromBackup reads JSON and inserts into database', async () => {
    const backupData = {
      meta: { app_version: '1.2.0', schema_version: '3', backup_date: '2026-05-31T10:00:00Z', table_count: 2 },
      tables: {
        projects: [{ id: 1, name: '恢复项目' }],
        chapters: [],
      },
    };
    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify(backupData));

    const mockDb = createMockDb({ projects: [], chapters: [] });

    jest.resetModules();
    const { restoreFromBackup } = require('../src/services/backupService');
    await restoreFromBackup(mockDb, '/fake/path/backup.json');

    expect(RNFS.readFile).toHaveBeenCalledWith('/fake/path/backup.json', 'utf8');
  });

  test('cleanupOldBackups keeps only 3 most recent', async () => {
    const files = [
      { name: 'backup_v1.0.0_1.json', path: '/a/1.json', mtime: new Date('2026-01-01') },
      { name: 'backup_v1.1.0_2.json', path: '/a/2.json', mtime: new Date('2026-02-01') },
      { name: 'backup_v1.2.0_3.json', path: '/a/3.json', mtime: new Date('2026-03-01') },
      { name: 'backup_v1.3.0_4.json', path: '/a/4.json', mtime: new Date('2026-04-01') },
    ];
    (RNFS.readDir as jest.Mock).mockResolvedValue(files);

    jest.resetModules();
    const { cleanupOldBackups } = require('../src/services/backupService');
    await cleanupOldBackups();

    expect(RNFS.unlink).toHaveBeenCalledTimes(1);
    expect(RNFS.unlink).toHaveBeenCalledWith('/a/1.json');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest __tests__/backupService.test.ts`
Expected: FAIL — `Cannot find module '../src/services/backupService'`

- [ ] **Step 3: 更新 jest.setup.js 的 react-native-fs mock**

在 `jest.setup.js` 的 `react-native-fs` mock 中添加缺失的方法：

```js
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp/documents',
  CachesDirectoryPath: '/tmp/cache',
  DownloadDirectoryPath: '/tmp',
  ExternalDirectoryPath: '/tmp/external',
  readFile: jest.fn(),
  writeFile: jest.fn(),
  copyFile: jest.fn(),
  mkdir: jest.fn(),
  readDir: jest.fn(),
  unlink: jest.fn(),
  exists: jest.fn(),
}));
```

- [ ] **Step 4: 实现备份服务**

```ts
// src/services/backupService.ts
import RNFS from 'react-native-fs';
import type SQLite from 'react-native-sqlite-storage';

const BACKUP_DIR = `${RNFS.ExternalDirectoryPath}/backups`;
const MAX_BACKUPS = 3;

const ALL_TABLES = [
  'projects',
  'chapters',
  'fragments',
  'plotlines',
  'project_plotlines',
  'characters',
  'worldbook_collections',
  'worldbook_entries',
  'notes',
  'presets',
  'llm_config',
  'settings',
  'project_resources',
  'llm_usage_logs',
  'pipeline_tasks',
  'freeform_documents',
];

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

async function allRows(db: SQLite.SQLiteDatabase, table: string): Promise<Record<string, any>[]> {
  const result = await execute(db, `SELECT * FROM ${table}`);
  const items: Record<string, any>[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    items.push(result.rows.item(i));
  }
  return items;
}

export async function createBackup(
  db: SQLite.SQLiteDatabase,
  appVersion: string,
  schemaVersion: string,
): Promise<string> {
  await RNFS.mkdir(BACKUP_DIR);

  const tables: Record<string, any[]> = {};
  for (const table of ALL_TABLES) {
    tables[table] = await allRows(db, table);
  }

  const backup = {
    meta: {
      app_version: appVersion,
      schema_version: schemaVersion,
      backup_date: new Date().toISOString(),
      table_count: ALL_TABLES.length,
    },
    tables,
  };

  const timestamp = Date.now();
  const fileName = `backup_v${appVersion}_${timestamp}.json`;
  const filePath = `${BACKUP_DIR}/${fileName}`;

  await RNFS.writeFile(filePath, JSON.stringify(backup), 'utf8');
  await cleanupOldBackups();

  return filePath;
}

export async function restoreFromBackup(
  db: SQLite.SQLiteDatabase,
  backupPath: string,
): Promise<void> {
  const content = await RNFS.readFile(backupPath, 'utf8');
  const backup = JSON.parse(content);

  for (const table of ALL_TABLES) {
    await execute(db, `DELETE FROM ${table}`);
  }

  for (const table of ALL_TABLES) {
    const rows: Record<string, any>[] = backup.tables?.[table] || [];
    for (const row of rows) {
      const keys = Object.keys(row);
      const placeholders = keys.map(() => '?').join(', ');
      const values = keys.map(k => row[k]);
      await execute(
        db,
        `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
        values,
      );
    }
  }
}

export async function cleanupOldBackups(): Promise<void> {
  try {
    const files = await RNFS.readDir(BACKUP_DIR);
    const backups = files
      .filter(f => f.name.startsWith('backup_') && f.name.endsWith('.json'))
      .sort((a, b) => {
        const timeA = a.mtime ? new Date(a.mtime).getTime() : 0;
        const timeB = b.mtime ? new Date(b.mtime).getTime() : 0;
        return timeB - timeA;
      });

    for (let i = MAX_BACKUPS; i < backups.length; i++) {
      await RNFS.unlink(backups[i].path);
    }
  } catch {
    // 目录不存在或读取失败，忽略
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx jest __tests__/backupService.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/backupService.ts __tests__/backupService.test.ts jest.setup.js
git commit -m "feat: add backup service with create/restore/cleanup and tests"
```

---

### Task 7: 安装类型检测 + 重构 database.ts migrate()

**Files:**
- Modify: `src/services/database.ts:25-27,415-459`
- Create: `__tests__/installTypeDetection.test.ts`

- [ ] **Step 1: 编写安装类型检测测试**

```ts
// __tests__/installTypeDetection.test.ts
/* eslint-env jest */

type TableRows = Record<string, any>[];

const createRows = (rows: TableRows) => ({
  length: rows.length,
  item: (index: number) => rows[index],
  raw: () => rows,
});

function createMockDb(existingSettings: Record<string, string> = {}) {
  const settings = new Map<string, string>(Object.entries(existingSettings));
  const executed: string[] = [];

  const executeSql = jest.fn(async (sql: string, params: any[] = []) => {
    executed.push(sql);
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT value FROM settings WHERE key = \?/i.test(normalized)) {
      const value = settings.get(params[0]);
      const rows = value !== undefined ? [{ value }] : [];
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(rows) }];
    }

    if (/^INSERT OR REPLACE INTO settings/i.test(normalized)) {
      settings.set(params[0], params[1]);
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^SELECT id FROM worldbook_collections/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([{ id: 1 }]) }];
    }

    return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
  });

  const db = {
    executeSql,
    transaction: jest.fn(async (scope: (tx: { executeSql: typeof executeSql }) => void) => {
      await scope({ executeSql });
    }),
  };

  return { db, settings, executed };
}

describe('install type detection', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('detects fresh install when no app_version exists', async () => {
    const { db, settings } = createMockDb({});
    const { detectInstallType } = require('../src/services/database');
    const info = await detectInstallType(db as any);
    expect(info.installType).toBe('fresh');
    expect(info.previousVersion).toBeNull();
    expect(settings.get('app_version')).toBeTruthy();
    expect(settings.get('install_type')).toBe('fresh');
    expect(settings.get('first_install_version')).toBeTruthy();
  });

  test('detects upgrade when stored version < current version', async () => {
    const { db, settings } = createMockDb({
      app_version: '1.0.0',
      schema_version: '3',
      first_install_version: '1.0.0',
    });
    const { detectInstallType } = require('../src/services/database');
    const info = await detectInstallType(db as any);
    expect(info.installType).toBe('upgrade');
    expect(info.previousVersion).toBe('1.0.0');
    expect(settings.get('previous_version')).toBe('1.0.0');
    expect(settings.get('install_type')).toBe('upgrade');
  });

  test('detects same version when stored version = current version', async () => {
    const { db, settings } = createMockDb({
      app_version: '1.3.2',
      schema_version: '5',
      first_install_version: '1.0.0',
    });
    const { detectInstallType } = require('../src/services/database');
    const info = await detectInstallType(db as any);
    expect(info.installType).toBe('same');
    expect(settings.get('install_type')).toBe('same');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest __tests__/installTypeDetection.test.ts`
Expected: FAIL — `detectInstallType` 不存在

- [ ] **Step 3: 在 database.ts 中添加 detectInstallType 函数并重构 migrate()**

在 `src/services/database.ts` 中，首先添加 import：

```ts
import { runMigrations, SCHEMA_VERSION, hasBreakingMigration, isIncompatibleUpgrade } from './migrations';
import { createBackup } from './backupService';
import appVersionJson from '../constants/version.json';
```

将 `SCHEMA_VERSION` 常量改为从迁移引擎导入（删除第 26 行的 `const SCHEMA_VERSION = '5';`）。

在 `migrate()` 函数之前添加 `detectInstallType` 函数：

```ts
export async function detectInstallType(database: SQLite.SQLiteDatabase): Promise<InstallInfo> {
  const currentVersion = appVersionJson.versionName.replace(/^V/, '');
  const storedVersionResult = await execute(database, 'SELECT value FROM settings WHERE key = ?', ['app_version']);
  const storedVersion = storedVersionResult.rows.length > 0 ? storedVersionResult.rows.item(0).value : null;

  const firstInstallResult = await execute(database, 'SELECT value FROM settings WHERE key = ?', ['first_install_version']);
  const firstInstallVersion = firstInstallResult.rows.length > 0 ? firstInstallResult.rows.item(0).value : currentVersion;

  let installType: InstallType;
  let previousVersion: string | null = null;

  if (!storedVersion) {
    installType = 'fresh';
    await execute(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['first_install_version', currentVersion]);
  } else if (storedVersion !== currentVersion) {
    installType = 'upgrade';
    previousVersion = storedVersion;
    await execute(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['previous_version', storedVersion]);
  } else {
    installType = 'same';
  }

  await execute(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['app_version', currentVersion]);
  await execute(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['app_version_code', String(appVersionJson.versionCode)]);
  await execute(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['install_type', installType]);

  const schemaVersionResult = await execute(database, 'SELECT value FROM settings WHERE key = ?', ['schema_version']);
  const schemaVersion = schemaVersionResult.rows.length > 0 ? parseInt(schemaVersionResult.rows.item(0).value, 10) : 0;

  return {
    installType,
    currentVersion,
    previousVersion,
    firstInstallVersion: storedVersion ? firstInstallVersion : currentVersion,
    schemaVersion,
  };
}
```

将现有的 `migrate()` 函数（第 415-426 行）替换为：

```ts
export let lastInstallInfo: InstallInfo | null = null;
export let lastMigrationResult: MigrationResult | null = null;

async function migrate(database: SQLite.SQLiteDatabase): Promise<void> {
  const installInfo = await detectInstallType(database);
  lastInstallInfo = installInfo;

  if (installInfo.installType === 'fresh') {
    await execute(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'schema_version', String(SCHEMA_VERSION),
    ]);
    return;
  }

  if (installInfo.installType === 'same') {
    return;
  }

  const fromSchema = installInfo.schemaVersion || 1;
  if (fromSchema >= SCHEMA_VERSION) {
    return;
  }

  if (hasBreakingMigration(fromSchema) || isIncompatibleUpgrade(fromSchema)) {
    return;
  }

  const migrationResult = await runMigrations(database, fromSchema);
  lastMigrationResult = migrationResult;
}
```

注意：breaking 升级在此处跳过，由 `UpgradeScreen` 的 `handleUpgradeConfirm` 回调执行。

在文件顶部的 import 区域添加类型导入：

```ts
import type { InstallInfo, InstallType, MigrationResult } from './migrations/types';
```

- [ ] **Step 4: 删除旧的迁移函数**

删除 `database.ts` 中的以下函数（已被迁移文件替代）：

- `migrateLegacyProjectResources` (第 428-445 行)
- `migrateLegacyWorldbookCollections` (第 447-459 行)

- [ ] **Step 5: 运行测试确认通过**

Run: `npx jest __tests__/installTypeDetection.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: 运行全部测试确认无回归**

Run: `npm test`
Expected: 全部 PASS（如果 `databaseMigration.test.ts` 失败，需要更新其 mock 以适配新的 migrate 流程）

- [ ] **Step 7: Commit**

```bash
git add src/services/database.ts __tests__/installTypeDetection.test.ts
git commit -m "feat: add install type detection and refactor migrate to use migration engine"
```

---

### Task 8: 升级提示 UI

**Files:**
- Create: `src/screens/UpgradeScreen.tsx`

- [ ] **Step 1: 创建 UpgradeScreen 组件**

```tsx
// src/screens/UpgradeScreen.tsx
import React from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface UpgradeScreenProps {
  visible: boolean;
  fromVersion: string;
  toVersion: string;
  onConfirm: () => void;
  status: 'waiting' | 'migrating' | 'success' | 'error';
  errorMessage?: string;
}

export const UpgradeScreen: React.FC<UpgradeScreenProps> = ({
  visible,
  fromVersion,
  toVersion,
  onConfirm,
  status,
  errorMessage,
}) => {
  return (
    <Modal visible={visible} transparent={false} animationType="fade">
      <View style={styles.container}>
        <Text style={styles.title}>版本升级</Text>
        <Text style={styles.subtitle}>
          V{fromVersion} → V{toVersion}
        </Text>

        {status === 'waiting' && (
          <>
            <Text style={styles.description}>
              本次升级涉及数据结构重大变更，将自动迁移您的数据。迁移前已自动备份。
            </Text>
            <TouchableOpacity style={styles.button} onPress={onConfirm}>
              <Text style={styles.buttonText}>开始升级</Text>
            </TouchableOpacity>
          </>
        )}

        {status === 'migrating' && (
          <>
            <ActivityIndicator size="large" color="#439EA6" style={styles.spinner} />
            <Text style={styles.description}>正在迁移数据，请勿关闭应用...</Text>
          </>
        )}

        {status === 'success' && (
          <Text style={styles.successText}>升级完成</Text>
        )}

        {status === 'error' && (
          <>
            <Text style={styles.errorText}>升级遇到问题</Text>
            <Text style={styles.description}>{errorMessage || '正在恢复备份...'}</Text>
          </>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#071827',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#D7F1F4',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#B0E0E3',
    marginBottom: 24,
  },
  description: {
    fontSize: 14,
    color: '#B0E0E3',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#439EA6',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  spinner: {
    marginVertical: 16,
  },
  successText: {
    fontSize: 18,
    color: '#439EA6',
    fontWeight: '600',
  },
  errorText: {
    fontSize: 18,
    color: '#E57373',
    fontWeight: '600',
    marginBottom: 8,
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add src/screens/UpgradeScreen.tsx
git commit -m "feat: add UpgradeScreen component for breaking upgrades"
```

---

### Task 9: App 启动流程集成

**Files:**
- Modify: `src/main/index.tsx`

- [ ] **Step 1: 修改 App 组件集成升级检测**

将 `src/main/index.tsx` 替换为：

```tsx
import React from 'react';
import { Alert, AppState, ImageBackground, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../components/ThemeProvider';
import { TabNavigator } from '../navigation/TabNavigator';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import Toast from 'react-native-toast-message';
import { openDatabase, lastInstallInfo, lastMigrationResult } from '../services/database';
import { hasBreakingMigration } from '../services/migrations';
import { UpgradeScreen } from '../screens/UpgradeScreen';
import appVersionJson from '../constants/version.json';

const splashImage = require('../assets/splash.png');
const SPLASH_VISIBLE_MS = 1200;

export const App: React.FC = () => {
  const [showSplash, setShowSplash] = React.useState(true);
  const [upgradeVisible, setUpgradeVisible] = React.useState(false);
  const [upgradeStatus, setUpgradeStatus] = React.useState<'waiting' | 'migrating' | 'success' | 'error'>('waiting');
  const [upgradeError, setUpgradeError] = React.useState('');
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    const init = async () => {
      await openDatabase();
      const info = lastInstallInfo;

      if (
        info?.installType === 'upgrade' &&
        info.previousVersion &&
        hasBreakingMigration(info.schemaVersion || 1)
      ) {
        setUpgradeVisible(true);
      } else {
        setReady(true);
        if (info?.installType === 'upgrade') {
          Toast.show({ type: 'info', text1: `已升级到 ${appVersionJson.versionName}`, visibilityTime: 1000 });
        }
      }
    };

    const timer = setTimeout(() => {
      setShowSplash(false);
      init();
    }, SPLASH_VISIBLE_MS);

    return () => clearTimeout(timer);
  }, []);

  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        const runningTasks = usePipelineTaskStore.getState().tasks.filter(
          (t) => t.status === 'idle' || t.status === 'drafting' || t.status === 'reviewing' || t.status === 'proofing'
        );
        if (runningTasks.length > 0) {
          Alert.alert(
            '流水线任务提醒',
            '检测到未完成的流水线任务。由于系统限制，切换应用可能导致任务中断。请检查任务中心确认状态。',
            [{ text: '知道了' }],
          );
        }
      }
    });
    return () => subscription.remove();
  }, []);

  const handleUpgradeConfirm = React.useCallback(async () => {
    setUpgradeStatus('migrating');
    try {
      const { runMigrations } = require('../services/migrations');
      const { createBackup } = require('../services/backupService');
      const database = await openDatabase();
      const fromSchema = lastInstallInfo?.schemaVersion || 1;
      await runMigrations(database, fromSchema, async () => {
        return createBackup(database, lastInstallInfo?.previousVersion || '', String(fromSchema));
      });
      setUpgradeStatus('success');
      setTimeout(() => {
        setUpgradeVisible(false);
        setReady(true);
      }, 1000);
    } catch (err: any) {
      setUpgradeStatus('error');
      setUpgradeError(err?.message || '未知错误');
    }
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        {showSplash ? (
          <ImageBackground source={splashImage} style={styles.splash} resizeMode="cover" />
        ) : (
          <>
            <UpgradeScreen
              visible={upgradeVisible}
              fromVersion={lastInstallInfo?.previousVersion || ''}
              toVersion={appVersionJson.versionName.replace(/^V/, '')}
              onConfirm={handleUpgradeConfirm}
              status={upgradeStatus}
              errorMessage={upgradeError}
            />
            {ready && (
              <NavigationContainer>
                <TabNavigator />
              </NavigationContainer>
            )}
          </>
        )}
        <Toast />
      </ThemeProvider>
    </SafeAreaProvider>
  );
};

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#071827',
  },
});
```

- [ ] **Step 2: 运行 lint 检查**

Run: `npm run lint`
Expected: 无新增 error

- [ ] **Step 3: 运行全部测试**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/index.tsx
git commit -m "feat: integrate upgrade detection and UpgradeScreen into app startup flow"
```

---

### Task 10: 最终验证

- [ ] **Step 1: 运行全部测试**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 2: 运行 lint**

Run: `npm run lint`
Expected: 无 error

- [ ] **Step 3: 构建 debug APK 验证**

Run: `npm run apk:debug`
Expected: 构建成功，APK 生成到 `dist/apk/debug/`

- [ ] **Step 4: 确认 version.json 已生成**

Run: `type src\constants\version.json`
Expected: 包含 versionName、versionCode、buildTime

- [ ] **Step 5: 最终 Commit**

```bash
git add -A
git commit -m "feat: smart upgrade install system - complete implementation"
```
