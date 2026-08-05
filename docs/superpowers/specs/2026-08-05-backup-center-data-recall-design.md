# 备份中心「召回潜在数据」功能设计

> 日期：2026-08-05
> 仓库：`F:\ClaudeWorkSpace\projects\TAVO-MINI`（分支 `feat/backup-center-data-recall`）
> 状态：已与用户确认方案 1（轻量诊断+修复+跨源合并三段式，仅备份中心手动入口）

---

## 1. 背景与定位

### 1.1 用户现象

部分用户从 V2.11.13 升级安装到 V2.11.24 后，报告项目/角色卡/世界书/笔记/预设"全部不见"。

### 1.2 经代码核实的真实根因

**绝大多数情况下，用户的资料并没有真的丢失，而是完好地躺在 `shine_writer.db` 里。** 现象是"显示为空"，本质是：

1. **启动链路中途崩溃**（最常见）：`canon_evidence` 缺列等 schema 漂移导致引用该列的查询抛 `no such column`，中断 `initializeDatabase`，UI 来不及读到仍然完好的资料表。旧版 UI 把"读取失败"渲染成假空态"还没有角色卡"。
2. **V2.11.24 启动崩在新位置**：恢复备份写失败（`RECOVERY_BACKUP_FAILED`）、召回快照不一致（`USER_DATA_RECALL_MISMATCH`）、记录的 `schema_version > 40`——均 fail-closed，数据保留但启动受阻。
3. **数据真的缺失**（少见）：用户按过"清除数据"，或当前库某些表确实被清。

代码证据：
- 5 个资料表（`projects` / `characters` / `worldbook_*` / `notes` / `presets`）**无任何软删除列**，不可能被"隐藏"——见各 repository。
- v25→v40 的 11 个迁移里**没有任何 `DROP TABLE` / `ALTER` / 重命名触及这 5 张用户内容表**。
- 启动是 fail-closed（`throw`），不重建空库；覆盖安装物理保留 `/data/data/<pkg>/databases/shine_writer.db`。

### 1.3 V2.11.24 已有的自动召回子系统（不暴露给 UI）

| 模块 | 作用 |
|---|---|
| `schemaDriftInspector` | 只读检测 `canon_evidence` 漂移 |
| `knownSchemaRepairs` | 幂等补缺列/索引 |
| `userDataRecallSnapshot` | 抓取 9 张核心表前后 ID 集合严格比对 |
| `schemaRecoveryBackup` | 改 schema 前写恢复备份到 `Documents/schema-recovery/` |
| `backupService.readAndValidateBackup` | 解析+校验备份 JSON |

这些子系统在**启动链路**里运行。但启动链路一旦崩溃，用户没有手动入口重新触发诊断与修复，也没有跨源（schema-recovery / 用户备份）召回的能力——这正是本功能要补的缺口。

### 1.4 功能价值定位

**一个手动、按需、绕过启动链只读扫描的「召回体检台」**，放在备份中心。它做三件事：
1. 扫描当前库只读诊断（源 A）；
2. 扫描所有备份源（源 B schema-recovery + 源 C 用户备份 JSON）；
3. 让用户确认后幂等合并/修复到当前库。

**入口范围（已确认）**：仅备份中心手动按钮。不触碰启动链，不接管启动错误。

---

## 2. 范围边界

### 2.1 召回源（已确认）

- **源 A — 当前库诊断+修复**（必选）：只读扫描当前 `shine_writer.db`，诊断启动为何读不到，统计资料表实际行数，必要时调 `repairKnownSchemaDrift()` 修漂移让数据重新可读。覆盖最常见的"数据还在但读不到"场景。
- **源 B — schema-recovery 恢复点**：扫描 `${DocumentDirectoryPath}/schema-recovery/*.json`（V2.11.24 自己写的恢复点），提取缺失行合并回当前库。
- **源 C — 用户备份 JSON**：扫描 `${ExternalDirectoryPath}/backups/*.json`，提取缺失行合并。
- **源 D — 外部 .db 文件**：不实现（应用从不往公共目录写 .db，收益极低、技术难度高）。

### 2.2 交互流程（已确认）

扫描 → 预览（按源×表列明细）→ 勾选 → 合并。不是一键全自动，也不是纯诊断。

### 2.3 非目标

- 不接管/修改启动链路错误处理（`initializeDatabase` / `main/index.tsx`）。
- 不造新合并引擎（无字段级 diff、无自然键匹配、无 dry-run simulation）。
- 不引入第二个 SQLite 连接或 `ATTACH`；源 B/C 通过 `backupService` 已有的 JSON 解析读取。
- 不修改任何 schema 迁移逻辑。
- 不做增量断点续传；单次扫描单次合并。

---

## 3. 架构与模块拆分

遵循 AGENTS.md 分层（`data/schema` → `services` → `screens`），单向依赖。

### 3.1 文件清单

```
新增：
  src/services/recall/recallTypes.ts          类型定义
  src/services/recall/recallScanner.ts        只读扫描（源 A/B/C 三路）
  src/services/recall/recallMerger.ts         合并执行（源 A 修漂移 / 源 BC 补缺失行）
  src/services/recall/dataRecallService.ts    协调服务（公共 API 总入口）
  src/screens/RecallScreen.tsx                扫描→预览→勾选→合并 UI
  __tests__/services/dataRecallService.test.ts 真实 SQLite 测试

改动（小）：
  src/screens/BackupCenterScreen.tsx          新增「召回潜在数据」入口按钮 + 导航
  src/navigation/TabNavigator.tsx             注册 Recall 路由（SettingsStack 内）
  src/services/database.ts                    re-export dataRecallService 公共 API
```

### 3.2 模块职责与依赖（单向）

```
BackupCenterScreen ──入口──► RecallScreen
                                  │
                                  ▼
                          dataRecallService  (公共 API: scanRecallSources / applyRecall)
                           │          │
                  ┌────────┘          └────────┐
                  ▼                            ▼
            recallScanner                 recallMerger
            （纯只读，不开写事务）        （开写事务，合并）
                  │                            │
        ┌─────────┼─────────┐                  │
        ▼         ▼         ▼                  ▼
  [源A]      [源B]      [源C]          createSchemaRecoveryBackup（强制先备份）
  schema     SCHEMA_    readAnd        repairKnownSchemaDrift      （源A）
  Drift      RECOVERY_  Validate       INSERT OR IGNORE 缺失行     （源BC）
  Inspector  DIR 遍历   Backup         captureUserDataRecallSnapshot（前后对比）
  行数清点   校验 JSON  BACKUP_DIR/
             解析       遍历
```

### 3.3 关键边界（防越权）

- **recallScanner 绝不开写事务**——纯 `query` / `execute(SELECT)` + `readAndValidateBackup`。任何写操作走 recallMerger。
- **recallMerger 第一行必须是 `createSchemaRecoveryBackup`**——失败立即抛 `RECOVERY_BACKUP_FAILED`，不执行任何后续。
- **不造新合并引擎**：源 A 的"合并"= 调现有 `repairKnownSchemaDrift()`；源 B/C 的"合并"= `INSERT OR IGNORE`。两者都不引入新 SQL 语义。
- **关联表打包召回**：`characters` / `worldbook_*` / `notes` 的召回连带对应的 `project_resources` + `project_collection_settings` 行，避免"资料库看得见、项目里看不见"。遵守现有 plan §9"禁止盲目重建关联，只按备份原关联恢复"。

### 3.4 召回表清单（`RecallTable`）

聚焦用户提到的 5 类 + 必要关联表：

```ts
type RecallTable =
  | 'projects' | 'chapters' | 'fragments'              // 作品
  | 'characters' | 'character_collections'             // 角色卡
  | 'worldbook_entries' | 'worldbook_collections'      // 世界书
  | 'notes'                                            // 笔记
  | 'presets'                                          // 预设
  | 'project_resources' | 'project_collection_settings'; // 关联（打包召回）
```

---

## 4. 数据结构（recallTypes.ts）

### 4.1 扫描报告

```ts
export type RecallTable =
  | 'projects' | 'chapters' | 'fragments'
  | 'characters' | 'character_collections'
  | 'worldbook_entries' | 'worldbook_collections'
  | 'notes'
  | 'presets'
  | 'project_resources' | 'project_collection_settings';

/** 表的中文展示名 + 是否关联表（关联表跟随主表勾选，不单独展示） */
export const RECALL_TABLE_DISPLAY: Record<RecallTable, { label: string; isLink: boolean }> = {
  projects: { label: '项目', isLink: false },
  chapters: { label: '章节', isLink: false },
  fragments: { label: '片段', isLink: false },
  characters: { label: '角色卡', isLink: false },
  character_collections: { label: '角色合集', isLink: false },
  worldbook_entries: { label: '世界书条目', isLink: false },
  worldbook_collections: { label: '世界书合集', isLink: false },
  notes: { label: '笔记', isLink: false },
  presets: { label: '预设', isLink: false },
  project_resources: { label: '项目-资源关联', isLink: true },
  project_collection_settings: { label: '项目-合集设置', isLink: true },
};

export interface CurrentDbFinding {
  reachable: boolean;       // 当前能否正常读到库（影响 UI 话术）
  schemaDrift: SchemaDriftReport;          // 复用 schemaDriftInspector 的类型
  rowCount: Record<RecallTable, number>;   // 实际行数（-1 表示表读不到）
  /**
   * 当前库每张表的主键/复合键集合（用于和源做差集，精确计算可召回量）。
   * 主键表：id 数组；关联表：复合键字符串数组。
   * 表读不到时为空数组。
   */
  existingKeys: Record<RecallTable, string[]>;
}

export interface BackupSourceFinding {
  sourceId: 'schema-recovery' | 'backup-json';
  filePath: string;
  fileName: string;
  kind: string;            // automatic/manual/pre_restore/pre_migration/schema_recovery
  createdAt: string;       // ISO
  schemaVersion: number;
  appVersion: string;
  sizeBytes: number;
  valid: boolean;
  invalidReason?: string;
  /** 源里该表的行数 */
  rowCount: Record<RecallTable, number>;
  /** 当前库为 0 或缺失、但源里 > 0 的行数 = 可召回量 */
  recoverable: Record<RecallTable, number>;
}

export interface RecallScanReport {
  scannedAt: number;
  currentDb: CurrentDbFinding;
  sources: BackupSourceFinding[];   // 源 B + 源 C 合并，按 createdAt 倒序
}
```

### 4.2 选择与结果

```ts
export interface RecallSelection {
  /** 是否对源 A 执行 schema 漂移修复（当 currentDb.schemaDrift.needsRepair 为真时启用） */
  repairCurrentDbDrift: boolean;
  /** 勾选要合并的源 B/C 文件路径列表 */
  sourceFilePaths: string[];
}

export interface RecallTableResult {
  inserted: number;
  skipped: number;  // 主键/唯一键冲突跳过
}

export interface RecallResult {
  status: 'success' | 'partial' | 'failed';
  recoveryBackupPath: string;
  beforeSnapshot: UserDataRecallSnapshot;
  afterSnapshot: UserDataRecallSnapshot;
  recallMismatch: RecallMismatch | null;   // 非空 = 合并后比合并前少了数据（异常）
  /** 源 A 修复结果（仅 repairCurrentDbDrift=true 时存在） */
  driftRepairResult?: SchemaRepairResult;
  /** 源 B/C 每张表的插入/跳过计数 */
  applied: Partial<Record<RecallTable, RecallTableResult>>;
  error?: { code: RecallErrorCode; message: string };
}

export type RecallErrorCode =
  | 'RECOVERY_BACKUP_FAILED'
  | 'DB_OPEN_FAILED'
  | 'DRIFT_REPAIR_FAILED'
  | 'RECALL_MISMATCH'
  | 'SOURCE_INSERT_FAILED'
  | 'NO_SELECTION';
```

---

## 5. recallScanner.ts — 只读扫描

### 5.1 总入口

```ts
export async function scanRecallSources(): Promise<RecallScanReport> {
  const currentDb = await scanCurrentDb();
  const schemaRecoverySources = await scanSchemaRecoveryDir(currentDb.existingKeys);
  const backupSources = await scanBackupDir(currentDb.existingKeys);
  const sources = [...schemaRecoverySources, ...backupSources]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { scannedAt: Date.now(), currentDb, sources };
}
```

### 5.2 源 A：当前库诊断

```ts
async function scanCurrentDb(): Promise<CurrentDbFinding> {
  const db = await openDatabase();   // 复用唯一连接
  const schemaDrift = await inspectKnownSchemaDrift(db);
  const rowCount: Record<RecallTable, number> = { ... };
  const existingKeys: Record<RecallTable, string[]> = { ... };
  for (const table of RECALL_TABLES) {
    try {
      const r = await execute(db, `SELECT COUNT(*) AS c FROM ${table}`);
      rowCount[table] = Number(r.rows.item(0)?.c ?? 0);
      // 读取主键/复合键集合（分块），供源做差集
      existingKeys[table] = await readExistingKeys(db, table);
    } catch {
      rowCount[table] = -1;          // 表读不到（漂移/缺失）
      existingKeys[table] = [];
    }
  }
  // reachable = 无漂移或漂移不阻断这些表的 COUNT（漂移在 canon_evidence，不在资料表）
  const reachable = !schemaDrift.needsRepair || Object.values(rowCount).every(c => c >= 0);
  return { reachable, schemaDrift, rowCount, existingKeys };
}

/**
 * 读取一张表当前已有的主键/复合键字符串集合（分块，避免大库一次性加载）。
 * 主键表用 id；project_resources 用 "project_id:resource_type:resource_id"；
 * project_collection_settings 用 "project_id:resource_type:collection_id"。
 * keyOf() 用同一规则把备份行映射成 key 字符串，从而可做差集。
 * merger 阶段的 readExistingKeys() 复用此函数。
 */
async function readExistingKeys(db, table: RecallTable): Promise<string[]> { /* ... */ }
function keyOf(table: RecallTable, row: Record<string, any>): string { /* ... */ }
```

**重要**：扫描阶段**不**调 `repairKnownSchemaDrift`——扫描纯只读，修复留到用户勾选后的 merger 阶段。即便 `needsRepair=true`，资料表的 `COUNT(*)` 通常仍可读（漂移在 `canon_evidence`），所以 `reachable` 多数为 true；只有当资料表本身读不到时才 false。

### 5.3 源 B：schema-recovery 目录

```ts
async function scanSchemaRecoveryDir(currentKeys): Promise<BackupSourceFinding[]> {
  const findings: BackupSourceFinding[] = [];
  let files: RNFS.ReadDirItem[] = [];
  try {
    await RNFS.mkdir(SCHEMA_RECOVERY_DIR);
    files = await RNFS.readDir(SCHEMA_RECOVERY_DIR);
  } catch { return []; }   // 目录不可读 = 无源，不报错
  for (const f of files.filter(f => f.name.endsWith('.json'))) {
    const finding = await parseBackupFile(f, 'schema-recovery', currentKeys);
    if (finding) findings.push(finding);
  }
  return findings;
}
```

### 5.4 源 C：用户备份目录

```ts
async function scanBackupDir(currentKeys): Promise<BackupSourceFinding[]> {
  const findings: BackupSourceFinding[] = [];
  let files: RNFS.ReadDirItem[] = [];
  try {
    files = await RNFS.readDir(BACKUP_DIR);   // ExternalDirectoryPath/backups
  } catch { return []; }
  for (const f of files.filter(f => f.name.endsWith('.json'))) {
    const finding = await parseBackupFile(f, 'backup-json', currentKeys);
    if (finding) findings.push(finding);
  }
  return findings;
}
```

### 5.5 备份文件解析（源 B/C 共用）

```ts
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
    // 可召回 = 源里有、但当前库主键集合里没有的行数（主键差集）
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
    createdAt: parsed?.createdAt ?? new Date(file.mtime ?? 0).toISOString(),
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

**`recoverable` 计算口径**：对每张表，把源里每一行的主键/复合键（`keyOf`）与当前库已有键集合做差集，源里有但当前库没有的行数即为可召回量。这样无论当前库是"完全为空"还是"部分缺失"（例如当前 5 条、源 8 条，差 3 条），都能精确算出可召回数。已在当前库里的同主键行会在合并阶段被 `INSERT OR IGNORE` 跳过，不会重复计入。

---

## 6. recallMerger.ts — 合并执行

### 6.1 总入口（严格顺序）

```ts
export async function applyRecall(selection: RecallSelection): Promise<RecallResult> {
  if (!selection.repairCurrentDbDrift && selection.sourceFilePaths.length === 0) {
    return failedResult('NO_SELECTION', '未选择任何召回操作');
  }

  const db = await openDatabase();

  // 1. 强制恢复备份（任何写操作之前）。失败立即返回，不动数据。
  let recoveryBackupPath: string;
  try {
    const backup = await createSchemaRecoveryBackup(db, 'schema_recovery');
    recoveryBackupPath = backup.path;
  } catch (e) {
    return failedResult('RECOVERY_BACKUP_FAILED', `恢复备份失败：${e.message}`);
  }

  // 2. 合并前召回快照
  const beforeSnapshot = await captureUserDataRecallSnapshot(db);

  const applied: Partial<Record<RecallTable, RecallTableResult>> = {};
  let driftRepairResult: SchemaRepairResult | undefined;
  const errors: string[] = [];

  // 3. 源 A：漂移修复
  if (selection.repairCurrentDbDrift) {
    try {
      const report = await inspectKnownSchemaDrift(db);
      driftRepairResult = await repairKnownSchemaDrift(db, report);
    } catch (e) {
      errors.push(`漂移修复失败：${e.message}`);
    }
  }

  // 4. 源 B/C：按 restoreOrder（父表在前）合并每个勾选源
  //    合并顺序：先 collection 类，再 entry 类，再 link 类。
  for (const filePath of selection.sourceFilePaths) {
    try {
      const { parsed } = await readAndValidateBackup(filePath);
      if (!parsed) { errors.push(`${filePath}: 解析失败`); continue; }
      await mergeFromBackup(db, parsed, applied);   // 见 6.2
    } catch (e) {
      errors.push(`${filePath}: ${e.message}`);
    }
  }

  // 5. 合并后召回快照 + 比对
  const afterSnapshot = await captureUserDataRecallSnapshot(db);
  const recallMismatch = compareRecallSnapshots(beforeSnapshot, afterSnapshot);

  // 6. 状态判定
  let status: RecallResult['status'];
  if (recallMismatch) {
    status = 'failed';   // 合并后比合并前少了数据 = 严重异常
  } else if (errors.length > 0) {
    status = 'partial';
  } else {
    status = 'success';
  }

  return {
    status, recoveryBackupPath,
    beforeSnapshot, afterSnapshot, recallMismatch,
    driftRepairResult, applied,
    error: errors.length > 0
      ? { code: recallMismatch ? 'RECALL_MISMATCH' : 'SOURCE_INSERT_FAILED', message: errors.join('\n') }
      : undefined,
  };
}
```

### 6.2 单源合并：`mergeFromBackup`

```ts
async function mergeFromBackup(
  db: SQLite.SQLiteDatabase,
  parsed: ParsedBackup,
  appliedAcc: Partial<Record<RecallTable, RecallTableResult>>,
): Promise<void> {
  // 按 restoreOrder 合并：父表在前，子表/关联表在后。
  const ORDER: RecallTable[] = [
    'projects', 'character_collections', 'worldbook_collections', 'presets',
    'characters', 'worldbook_entries', 'notes', 'chapters', 'fragments',
    'project_resources', 'project_collection_settings',
  ];
  for (const table of ORDER) {
    const rows = parsed.tables[table];
    if (!Array.isArray(rows) || rows.length === 0) continue;

    // 仅插入当前库缺失的行（按主键判定），已存在则跳过。
    const { inserted, skipped } = await insertMissingRows(db, table, rows);

    // 累加到 applied
    const prev = appliedAcc[table] ?? { inserted: 0, skipped: 0 };
    appliedAcc[table] = { inserted: prev.inserted + inserted, skipped: prev.skipped + skipped };
  }
}
```

### 6.3 `insertMissingRows`：只补缺失行（核心安全语义）

```ts
async function insertMissingRows(
  db, table: RecallTable, rows: Record<string, any>[],
): Promise<{ inserted: number; skipped: number }> {
  // 拿到当前库已有的主键集合（SELECT id 或复合键）
  const existingKeys = await readExistingKeys(db, table);

  let inserted = 0, skipped = 0;
  // 用事务批量插入，避免逐行 IO
  await executeTransaction(async (tx) => {
    for (const row of rows) {
      const key = keyOf(table, row);   // 主键或复合键字符串
      if (existingKeys.has(key)) { skipped++; continue; }

      // 列集合 = row 的 key 与该表当前物理列的交集
      // （旧备份可能缺新列，或含已删列；只插入双方都有的列，缺失列用 Schema 默认值）
      const { columns, placeholders, values } = projectRowToCurrentSchema(table, row);
      try {
        await tx.executeSql(
          `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
          values,
        );
        inserted++;
      } catch (e) {
        // 单行失败不中断整体：记录后跳过（INSERT OR IGNORE 也会吞掉主键冲突）
        skipped++;
      }
    }
  }, { faultDomain: 'recall' });

  return { inserted, skipped };
}
```

**合并冲突默认策略（已确认）**：同主键已存在 → 跳过（当前库版本视为较新）。预览页展示"冲突 N 条已跳过"让用户知情。**不做字段级覆盖、不删当前库已有行。**

### 6.4 列投影：`projectRowToCurrentSchema`

旧 schema 的备份行可能：① 缺当前 schema 新增的列；② 含当前 schema 已删除的列。处理规则：
- **交集插入**：只写入 `row` 与当前表 `PRAGMA table_info(table)` 都存在的列。
- **缺失列用默认值**：当前 schema 新增的列若 `row` 没有，依赖列定义的 `DEFAULT`（不为缺失列显式填值，让 SQLite 用默认）。
- **已删列丢弃**：`row` 有但当前表没有的列直接忽略。

这与 `backupService.restoreFromBackup` 的容错策略一致（旧备份恢复到新 schema）。

---

## 7. UI — RecallScreen.tsx

### 7.1 状态机

```
idle ──[点击扫描]──► scanning ──► preview ──[勾选+确认]──► merging ──► result
                         │                                            │
                         └──(扫描异常)──► scanError                   └──(可重新扫描)
```

状态：`'idle' | 'scanning' | 'scanError' | 'preview' | 'merging' | 'result'`

### 7.2 三段式界面

#### §7.2.1 入口态（idle）

顶部说明卡：
```
召回潜在数据
扫描当前数据库与历史备份，把因版本升级、结构漂移等原因
无法正常显示的资料重新找回并合并到当前库。

本操作不会删除任何现有数据，执行前会自动创建恢复备份。
```

按钮：`[开始扫描]`（`Button variant="primary"`）

#### §7.2.2 预览态（preview）— 核心交互页

**区段 1：当前库诊断（源 A）**

展示 `currentDb`：
- `reachable=false` → 红色警告卡："当前数据库存在结构漂移，部分资料暂时无法读取。"
- `schemaDrift.needsRepair=true` → 提供复选框"☑ 修复数据库结构漂移（推荐）"，默认勾选。
- 资料表行数清单（9 张主表）：
  ```
  项目：12   章节：87   片段：240
  角色卡：42  角色合集：6
  世界书条目：158  世界书合集：4
  笔记：23   预设：5
  ```

**区段 2：可召回的备份源（源 B + C）**

每个 `BackupSourceFinding` 一张 `Card`：
```
┌─────────────────────────────────────────────┐
│ schemarecovery_v2.11.24_172284...json  结构修复│
│ 2026-08-04 14:32 · Schema 40 · V2.11.24 · 2.1MB│
│ ☑ 此源                                       │
│   可召回：角色卡 +8  世界书条目 +20  笔记 +3   │
└─────────────────────────────────────────────┘
```

- 复选框默认勾选规则：`recoverable` 有任意 > 0 的表 → 默认勾选；否则不勾。
- `valid=false` 的源：整卡置灰，显示"备份无效或已损坏：<invalidReason>"，不可勾选。
- 关联表（`project_resources` / `project_collection_settings`）的 `recoverable` 不单独展示行，在底部备注"关联关系将随对应资料一并恢复"。

**区段 3：合并冲突提示**

底部固定区：
```
合并策略：只补当前库缺失的行，已存在的相同主键将跳过。
执行前会自动创建一份恢复备份。
[取消]                              [执行召回]
```

`执行召回` 按钮禁用条件：未勾选任何源 **且** 未勾选漂移修复。

#### §7.2.3 执行态（merging）

复用备份中心的进度条样式（`progressTrack` / `progressFill`），阶段文案：
```
正在创建恢复备份... → 正在修复结构漂移... → 正在合并 [文件名]... → 正在校验...
```

#### §7.2.4 结果态（result）

**成功（status=success）**：
```
✓ 召回完成
恢复备份：schemarecovery_v2.11.24_172...json
─────────────────────
结构漂移：已修复
角色卡：+8（跳过 0）   世界书条目：+20（跳过 2）
笔记：+3（跳过 0）
─────────────────────
合并前 → 合并后
角色卡：42 → 50    世界书条目：158 → 178    笔记：23 → 26
[完成]
```

**部分成功（status=partial）**：同上 + 黄色警告条"部分源合并失败：<error.message>，其余已成功召回。"

**失败（status=failed，含 RECALL_MISMATCH）**：
```
✗ 召回中止
合并后比合并前少了数据，这通常是异常情况。
原数据库和恢复备份均未改动/已保留：
  恢复备份：schemarecovery_v2.11.24_172...json
详情：<recallMismatch.table> <reason>
[复制诊断]  [完成]
```

### 7.3 与备份中心的整合

`BackupCenterScreen.tsx` 在 `createRow`（"创建备份"按钮行）下方新增一行：

```tsx
<View style={styles.createRow}>
  <Button label={...} onPress={handleCreate} flex />
</View>
{/* 新增 */}
<View style={styles.recallRow}>
  <Button
    label="召回潜在数据"
    variant="secondary"
    onPress={() => navigation.navigate('Recall')}
    flex
  />
</View>
```

路由注册（`TabNavigator.tsx` SettingsStack）：
```tsx
<SettingsStack.Screen name="Recall" component={RecallScreen} />
```

---

## 8. 错误处理

### 8.1 错误码与 UI 话术映射

| 错误码 | 触发条件 | UI 话术 |
|---|---|---|
| `NO_SELECTION` | 未勾选漂移修复且未选任何源 | "请至少选择一项召回操作" |
| `RECOVERY_BACKUP_FAILED` | `createSchemaRecoveryBackup` 抛错 | "无法创建恢复备份，已中止，未修改任何数据。请检查存储空间后重试。" |
| `DB_OPEN_FAILED` | `openDatabase` 抛错 | "无法打开数据库，请重启应用后重试。" |
| `DRIFT_REPAIR_FAILED` | `repairKnownSchemaDrift` 抛错（errors 记录，不中止后续源合并） | 计入 partial 的 error.message |
| `SOURCE_INSERT_FAILED` | 某源 `readAndValidateBackup` 失败或事务抛错 | 计入 partial 的 error.message，其余源继续 |
| `RECALL_MISMATCH` | `compareRecallSnapshots` 返回非空 | "合并后数据比合并前少，已保留原库与恢复备份，请勿卸载应用。" |

### 8.2 不变性

- **任何失败路径都不删除用户现有数据**。恢复备份在写操作之前创建；合并用 `INSERT OR IGNORE` + 主键预检，绝不 `DELETE` 或 `UPDATE` 现有行。
- **恢复备份必留**：即便合并成功，恢复备份也保留在 `schema-recovery/`（不自动删），供用户回退。
- **召回快照不一致 = 立即标记 failed**：不允许"部分成功但丢了数据"静默通过。

---

## 9. 测试矩阵（`__tests__/services/dataRecallService.test.ts`）

用真实 SQLite（`PRAGMA foreign_keys = ON`），不 mock DB。

### 9.1 扫描测试

| Case | 场景 | 断言 |
|---|---|---|
| S1 | 当前库正常，无备份源 | `currentDb.reachable=true`，`sources=[]` |
| S2 | 当前库有漂移（mock `canon_evidence` 缺列） | `schemaDrift.needsRepair=true`，资料表行数仍可读 |
| S3 | schema-recovery 目录有 1 个有效 JSON | `sources` 含 1 项，`valid=true`，`recoverable` 正确 |
| S4 | schema-recovery 目录有 1 个损坏 JSON | 该源 `valid=false`，`invalidReason` 非空 |
| S5 | backups 目录有 2 个 JSON（一旧一新） | `sources` 按 `createdAt` 倒序 |
| S6 | 当前库 characters=0，源里 characters=5（全新 id） | 源的 `recoverable.characters=5` |
| S7 | 当前库 characters=5，源里 characters=5（同 id） | 源的 `recoverable.characters=0`（不算可召回） |
| S8 | 当前库 characters=5，源里 characters=8（3 个新 id + 5 个重复 id） | 源的 `recoverable.characters=3`（部分缺失场景） |

### 9.2 合并测试

| Case | 场景 | 断言 |
|---|---|---|
| M1 | 当前库 characters=5，源里 characters=8（3 个新 id） | `applied.characters.inserted=3, skipped=5`，合并后 characters=8 |
| M2 | 源里 5 个角色卡的 id 与当前库全部重复 | `inserted=0, skipped=5`，合并后行数不变 |
| M3 | 勾选漂移修复，库有漂移 | `driftRepairResult` 非空，漂移修复成功，资料表行数不变 |
| M4 | 未勾选任何项 | `status=failed, error.code=NO_SELECTION` |
| M5 | 恢复备份失败（mock RNFS 不可写） | `status=failed, error.code=RECOVERY_BACKUP_FAILED`，库未改动 |
| M6 | 合并前 characters.ids ⊂ 合并后 characters.ids | `recallMismatch=null, status=success` |
| M7 | 故意删掉合并后的某行（模拟数据丢失） | `recallMismatch` 非空，`status=failed` |
| M8 | 旧 schema 备份（缺当前新增列） | 列投影后插入成功，缺失列用默认值 |
| M9 | 关联表 `project_resources` 打包召回 | 主表 characters 召回后，对应 project_resources 行也召回 |
| M10 | 两个源都勾选 | `applied` 累加两源的 inserted/skipped |

### 9.3 测试夹具构造

- 构造一个"漂移库"：用真实 SQLite 建 schema 40 但手动 `DROP COLUMN` 模拟 `canon_evidence` 缺列（或直接建一个不含 provenance 列的 canon_evidence）。
- 构造"缺失库"：正常 schema 40，但 `characters` 表清空。
- 构造"源 JSON"：直接调 `createBackup` 在临时目录生成有效备份；手动写一个 `meta.checksum` 错的 JSON 作为损坏源。

---

## 10. 完成定义

以下全部成立才算完成：

- [ ] 备份中心有「召回潜在数据」入口，点击进入 RecallScreen。
- [ ] 扫描阶段纯只读，不开任何写事务。
- [ ] 扫描报告正确展示当前库诊断（含漂移状态 + 9 表行数）+ 源 B/C 明细（含可召回量）。
- [ ] 预览页支持勾选源 + 勾选漂移修复，冲突策略文案清晰。
- [ ] 合并阶段第一动作必为 `createSchemaRecoveryBackup`，失败则中止且不动数据。
- [ ] 源 A 合并 = 调 `repairKnownSchemaDrift`；源 B/C 合并 = `INSERT OR IGNORE` 只补缺失行，绝不删除/覆盖现有行。
- [ ] 合并前后调 `captureUserDataRecallSnapshot` + `compareRecallSnapshots`，不一致即 failed。
- [ ] 结果页按 success/partial/failed 三态正确展示，含恢复备份路径与前后行数对比。
- [ ] 关联表（project_resources / project_collection_settings）随主表打包召回。
- [ ] 旧 schema 备份（缺列/多列）通过列投影正确合并。
- [ ] 全部测试矩阵 S1–S7、M1–M10 通过（真实 SQLite）。
- [ ] `npm run verify`（lint + typecheck + test:ci）通过。
- [ ] 不触碰启动链路（`initializeDatabase` / `main/index.tsx`）任何代码。

---

## 11. 受影响用户的使用指引（发布时）

修复版发布后，对报告"升级后数据不见"的用户，引导：

```
1. 打开应用 → 设置 → 备份中心
2. 点击「召回潜在数据」
3. 点击「开始扫描」
4. 勾选建议项（结构漂移修复 + 可召回的备份源），点击「执行召回」
5. 等待完成，查看召回结果
6. 若召回量为 0 且仍显示空，点击结果页「复制诊断」并联系支持
```

强调：
- 本操作不删除现有数据；
- 执行前自动创建恢复备份；
- 若扫描显示"当前库资料表行数 > 0 但 UI 显示空"，说明是显示层问题，召回后重启应用即可恢复。
