# Tavo Mini Schema 40 用户资料召回与数据库漂移修复计划

> 适用仓库：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
> 远端审计基线：`anjingdtl/tavo-mini main @ 09b5330f23970669eaf66718578aa901b2ead914`  
> 现场版本：V2.11.23 release APK；当前远端数据库版本：Schema 39  
> 目标：用户覆盖安装修复版时自动修复物理 Schema，并召回原有角色卡、世界书、合集、章节及项目关联。禁止清库、重建空数据库、卸载重装。

## 1. 事故判断

用户升级 V2.11.23 后，资料页显示角色卡和世界书为空，导入世界书提示：

```text
no such column: source_origin
(code 1 SQLITE_ERROR)
```

`source_origin` 属于 `canon_evidence`，不是角色卡或世界书字段。角色卡实际保存在：

```text
characters
character_collections
```

世界书实际保存在：

```text
worldbook_entries
worldbook_collections
```

项目关联保存在：

```text
project_resources
project_collection_settings
```

本事故优先按以下模型处理：

```text
用户资料仍在原表
+ settings.schema_version / app_version 已推进
+ canon_evidence 物理结构缺列或部分迁移
+ 初始化/全库操作失败
+ UI 把读取错误展示成空数据
```

未拿到用户数据库前，不把单一猜测写成唯一根因；修复必须覆盖记录版本与物理结构不一致的所有已知形态。


## 2. 最新远端实际情况

基线 `09b5330f` 已完成上一轮 Pipeline 修复：

- `pipeline_tasks` 与 `pipeline_stage_checkpoints` 原子创建；
- `createTask()` 异步化；
- `savePipelineTask()` 使用安全 UPSERT；
- 最终消息只回收 optional allocation；
- 已增加真实 sql.js 外键测试。

本轮不得重新扩张 Pipeline 架构。

当前仍为：

```ts
export const SCHEMA_VERSION = 39;
```

当前初始化顺序大致是：

```text
打开数据库
→ 读取记录 Schema
→ 按记录版本迁移
→ 严格 validateSchemaBeforeStartup
→ repairKnownSchemaDefects（当前只是日志）
→ seedDefaults
→ 最终 validateSchema
→ 写 app_version
```

该顺序无法处理：

```text
recorded schema = 39
actual canon_evidence.source_origin missing
```

因为 32→33 不会再运行，严格校验又发生在 repair 之前。

`runMigrations()` 虽然预留 `onBackup`，但 `initializeDatabase()` 当前没有接入升级前备份。


## 3. 五个最高优先级不变量

### 3.1 用户原数据库是唯一事实来源

禁止：

```text
删除数据库
重建空数据库
清空用户表
覆盖安装时替换数据库文件
把 schema_version 改小后重跑全部历史迁移
让用户卸载或清除应用数据
```

### 3.2 先备份，再改变 Schema

```text
只读诊断
→ 创建恢复备份
→ 校验备份包含核心资料
→ 才执行 ALTER/CREATE INDEX/迁移
```

备份失败时默认不修复，保留原数据库并显示可操作错误。

### 3.3 修复前后必须比较主键集合

至少覆盖：

```text
projects
chapters
character_collections
characters
worldbook_collections
worldbook_entries
notes
project_resources
project_collection_settings
```

角色卡、世界书和合集的 ID 集合必须严格相等；项目和章节不得减少。

### 3.4 物理结构优先于记录版本

必须使用：

```sql
PRAGMA table_info(...)
PRAGMA index_list(...)
PRAGMA foreign_key_check
```

不能仅相信 `settings.schema_version`。

### 3.5 读取错误不得显示为空数据

资料 Store/UI 必须区分：

```text
loading
loaded-empty
error
repairing
recovered
```

数据库读取失败时不得设置空数组并显示“还没有资料”。


## 4. 目标模块

推荐新增窄范围模块：

```text
src/data/schema/schemaDriftInspector.ts
src/data/schema/knownSchemaRepairs.ts
src/services/migrations/v39-to-v40.ts
src/services/schemaRecoveryBackup.ts（或安全复用 backupService）
```

接口示例：

```ts
interface SchemaDriftReport {
  recordedSchemaVersion: number;
  canonEvidenceExists: boolean;
  sourceOriginExists: boolean;
  rescanOperationIdExists: boolean;
  rescanIndexExists: boolean;
  needsRepair: boolean;
  repairCodes: string[];
}

async function inspectKnownSchemaDrift(
  db: SQLite.SQLiteDatabase,
): Promise<SchemaDriftReport>;

async function repairKnownSchemaDrift(
  db: SQLite.SQLiteDatabase,
  report: SchemaDriftReport,
): Promise<SchemaRepairResult>;
```

该层只能修复白名单中的已知发布缺陷，不得演变成第二套无限制迁移系统。


## 5. Schema 40 设计

新增：

```text
Schema 39 → 40
```

并更新：

```ts
export const SCHEMA_VERSION = 40;
```

### 5.1 动态、幂等补列

先检查：

```sql
SELECT name FROM sqlite_master
WHERE type='table' AND name='canon_evidence';

PRAGMA table_info(canon_evidence);
PRAGMA index_list(canon_evidence);
```

仅补实际缺失项：

```sql
ALTER TABLE canon_evidence
ADD COLUMN source_origin TEXT NOT NULL DEFAULT 'batch';

ALTER TABLE canon_evidence
ADD COLUMN rescan_operation_id TEXT;

UPDATE canon_evidence
SET source_origin = 'batch'
WHERE source_origin IS NULL OR TRIM(source_origin) = '';

CREATE INDEX IF NOT EXISTS idx_canon_evidence_rescan_op
ON canon_evidence(
  snapshot_id,
  analysis_run_id,
  source_origin,
  rescan_operation_id
);
```

Android SQLite 不依赖 `ADD COLUMN IF NOT EXISTS`，必须先查 `PRAGMA table_info`。

### 5.2 保护 Canon evidence 身份

修复前后读取：

```text
COUNT(*)
MIN(id)
MAX(id)
SUM(id)
```

并断言证据行身份不变。补列和建索引不得删除 evidence。

### 5.3 整表缺失时禁止创建空表

若记录版本要求存在 `canon_evidence`，但整张表缺失：

```text
不要创建空表伪装修复
保留数据库与备份
停止启动
进入恢复失败状态
```

### 5.4 32→33 迁移也必须幂等化

仅新增 39→40 不够。部分迁移数据库可能是：

```text
recorded schema=32
只存在一个 provenance 字段
字段都存在但索引缺失
```

应实现自定义：

```ts
migrateV32ToV33(db)
```

内部：

```text
ensure provenance columns
→ Canon 去重与 evidence link 重绑
→ 创建业务唯一索引
→ 创建 provenance 索引
→ 验证
```

`runMigrations()` 对 32→33 调用逻辑迁移，不再固定执行两个 ALTER。


## 6. 启动修复顺序

推荐初始化流程：

```text
1. 打开数据库
2. PRAGMA foreign_keys=ON
3. 确认 settings
4. 读取安装类型和记录 Schema
5. 读取用户资料召回快照
6. 检查已知 Schema 漂移
7. 如为升级或存在漂移：创建并校验 schema recovery 备份
8. 执行 pre-migration known repair
9. 运行正式迁移到 Schema 40
10. 再执行一次幂等 known repair
11. 严格 Schema 校验
12. seed defaults
13. 最终 Schema 校验
14. 比较修复前后用户资料主键
15. 全部成功后才写 app_version / repair success
16. 打开 Store 和 UI
```

必须把当前：

```text
validateSchemaBeforeStartup
→ repairKnownSchemaDefects
```

改为：

```text
inspect/backup/repair
→ validateSchemaBeforeStartup
```

同时覆盖：

```text
recorded schema=40，但恢复旧备份后物理列再次缺失
```

因此 known repair 要在每次启动严格校验前做幂等检查。


## 7. 升级前恢复备份

新增备份类型：

```ts
type BackupKind =
  | 'automatic'
  | 'manual'
  | 'pre_restore'
  | 'pre_migration'
  | 'schema_recovery';
```

恢复备份优先写入应用内部目录：

```text
RNFS.DocumentDirectoryPath/schema-recovery/
```

成功后可复制到 ExternalDirectory 供用户导出。

### 7.1 旧/漂移 Schema 容错

当前备份必须改成：

```text
核心表缺失：失败并阻止修复
非核心新表缺失：记录 diagnostics 后跳过
表存在但缺少新列：SELECT * 备份现有列
```

恢复时只插入备份中实际存在的字段，新字段使用 Schema 40 默认值。

### 7.2 必须包含的核心资料

```text
projects
chapters
fragments
plotlines
project_plotlines
character_collections
characters
worldbook_collections
worldbook_entries
note_collections
notes
presets
project_resources
project_collection_settings
settings
freeform_documents
content_revisions
generation_drafts
outlines
```

Canon/续写表存在时一并备份，但它们的异常不能阻止核心创作资料备份。

### 7.3 写后校验

备份写入后重新读取并验证：

```text
JSON 可解析
checksum 正确
角色卡数量一致
角色合集数量一致
世界书条目数量一致
世界书合集数量一致
项目/章节数量一致
```

只有验证成功才允许修改 Schema。


## 8. 用户资料召回快照

新增：

```ts
interface UserDataRecallSnapshot {
  projects: IdentitySummary;
  chapters: IdentitySummary;
  characterCollections: IdentitySummary;
  characters: IdentitySummary;
  worldbookCollections: IdentitySummary;
  worldbookEntries: IdentitySummary;
  notes: IdentitySummary;
  projectResources: LinkSummary;
  projectCollectionSettings: LinkSummary;
}
```

`IdentitySummary` 至少包含：

```text
count
minId
maxId
sumId
```

角色卡、世界书、合集必须分块读取完整 ID 集合并严格比较：

```text
after.characters.ids = before.characters.ids
after.characterCollections.ids = before.characterCollections.ids
after.worldbookEntries.ids = before.worldbookEntries.ids
after.worldbookCollections.ids = before.worldbookCollections.ids
```

关联表原有复合键不得减少。

召回不一致时：

```text
不写成功标记
不开放写操作
保留备份
报告 USER_DATA_RECALL_MISMATCH
```


## 9. 资料可见性与关联恢复

修复后执行：

```sql
SELECT COUNT(*) FROM characters;
SELECT COUNT(*) FROM character_collections;
SELECT COUNT(*) FROM worldbook_entries;
SELECT COUNT(*) FROM worldbook_collections;

SELECT resource_type, COUNT(*)
FROM project_resources
GROUP BY resource_type;
```

并验证 Repository：

```ts
await getAllCharacters();
await getCharacterCollections(currentProjectId);
await getAllWorldbookEntries();
await getWorldbookCollections(currentProjectId);
```

### 禁止盲目重建项目关联

若基础资料存在但 `project_resources` 缺失，不得把所有资料关联给所有项目。

只允许依据确定证据恢复：

1. 恢复备份中的原关联；
2. 旧记录存在明确非零 `project_id`；
3. 迁移日志能确定唯一项目；
4. 用户在恢复 UI 中明确选择。

无证据时先让资料在全局资料库可见，再让用户选择项目。


## 10. UI 防假空态

增加：

```ts
type DatabaseRecoveryState =
  | 'idle'
  | 'inspecting'
  | 'backing_up'
  | 'repairing'
  | 'validating'
  | 'recovered'
  | 'failed';
```

修复中显示：

```text
正在修复本地资料数据库
不会删除角色卡、世界书或章节，请勿关闭应用。
```

成功显示：

```text
本地资料已恢复
角色卡：X
角色合集：Y
世界书条目：Z
世界书合集：W
章节：N
恢复备份：<文件名>
```

失败显示：

```text
本地资料读取失败，但没有执行清库或删除。
已保留原数据库和恢复备份。
请不要卸载应用或清除应用数据。
```

提供：

```text
重试修复
导出恢复备份
复制诊断
```

资料页仅在 `loadState==='loaded'` 且确实为零时显示空态；错误时显示“资料暂时无法读取，数据可能仍然存在”。


## 11. 修复日志

使用 `settings` 保存非敏感元数据：

```text
schema40_repair_status
schema40_repair_started_at
schema40_repair_completed_at
schema40_repair_backup_path
schema40_repair_codes
schema40_repair_before_counts
schema40_repair_after_counts
schema40_repair_error
```

禁止保存角色卡、世界书、章节正文或 API Key。

日志应包含：

```text
app version
recorded schema
实际缺失字段/索引
SQLite version
修复步骤
备份路径
前后行数
```


## 12. 真实迁移测试矩阵

必须使用真实 SQLite fixture，并在 Android SQLite 上做覆盖安装验证。

### 正常升级

#### Case A：V2.11.15 / Schema 32

预置项目、章节、角色卡、世界书、合集、关联和 Canon evidence。升级到 40 后所有 ID 不变。

#### Case B：V2.11.16 / Schema 33

不得重复加列，不报 duplicate column。

#### Case C：V2.11.23 / Schema 39 正常库

39→40 无损完成。

### 漂移数据库

#### Case D

```text
recorded schema=39
两列都缺失
```

自动备份、补列、召回。

#### Case E

```text
recorded schema=39
只缺 source_origin
```

#### Case F

```text
recorded schema=39
只缺 rescan_operation_id
```

#### Case G

```text
列存在，索引缺失
```

只补索引。

#### Case H

```text
source_origin 存在但有 NULL/空值
```

修正为 `batch`，evidence ID/数量不变。

#### Case I

```text
recorded schema=32
已有一个或两个字段
```

32→33 幂等运行。

#### Case J

```text
recorded schema=40
物理列缺失
```

启动 known repair 仍生效。

### 安全失败

#### Case K：备份失败

断言不执行 ALTER、不更新版本、原数据不变。

#### Case L：补第二列时故障

断言下次启动可幂等继续，用户表不变。

#### Case M：索引创建失败

保留备份和失败状态，不删除数据。

#### Case N：召回快照不一致

断言阻止启动并报 `USER_DATA_RECALL_MISMATCH`。

#### Case O：canon_evidence 整表缺失

不得创建空表伪装修复，不显示空资料。


## 13. 备份恢复回归

覆盖：

```text
Schema 32 备份 → Schema 40
Schema 33 备份 → Schema 40
Schema 39 漂移备份 → Schema 40
Schema 40 正常备份 → Schema 40
```

断言：

```text
旧 evidence 行缺 source_origin 时可恢复
恢复后 source_origin 使用 batch 默认值
角色卡/世界书及合集 ID 不变
project_resources 复合键不变
恢复后运行 known repair + strict validation
```


## 14. 推荐施工顺序

### Phase 0：只读复现

1. 拉取最新 main；
2. 记录分支、HEAD、工作区；
3. 从 V2.11.15 构造 Schema 32 fixture；
4. 构造 recorded 39 / actual missing-column fixture；
5. 复现错误；
6. 证明角色卡/世界书原表仍有行。

### Phase 1：召回基础设施

1. Schema 漂移检查；
2. 用户资料快照；
3. schema recovery 备份；
4. 备份写后校验；
5. 结构化错误码。

### Phase 2：迁移

1. `ensureCanonEvidenceProvenanceSchema()`；
2. 32→33 逻辑迁移；
3. 39→40；
4. Schema version、fresh schema、manifest、文档同步。

### Phase 3：初始化

1. 备份前置；
2. repair 前置；
3. strict validation 后置；
4. 前后召回验证；
5. 成功后才写版本标记。

### Phase 4：UI

1. Store loading/error/recovered；
2. 错误不显示空态；
3. 恢复进度/成功/失败；
4. 成功后重载资料 Store。

### Phase 5：发布

1. 完整 Jest/TypeScript/Lint；
2. Android debug/release；
3. V2.11.15 和 V2.11.23 设备覆盖安装；
4. 自动备份、修复、数据重新出现；
5. 发布新 release APK。


## 15. 错误码

```ts
type SchemaRecoveryErrorCode =
  | 'SCHEMA_DRIFT_DETECTED'
  | 'RECOVERY_BACKUP_FAILED'
  | 'RECOVERY_BACKUP_INVALID'
  | 'CANON_EVIDENCE_TABLE_MISSING'
  | 'CANON_SOURCE_ORIGIN_MISSING'
  | 'CANON_RESCAN_OPERATION_ID_MISSING'
  | 'CANON_RESCAN_INDEX_MISSING'
  | 'KNOWN_SCHEMA_REPAIR_FAILED'
  | 'USER_DATA_RECALL_MISMATCH'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'RESOURCE_RELOAD_FAILED';
```

UI 使用错误码，不使用 SQLite 英文文案正则。


## 16. 发布要求

建议下一个补丁版本使用：

```text
Schema 40
V2.11.24 或本地规划中的下一个补丁版本
```

用户说明：

```text
请直接覆盖安装，不要卸载旧版本。
首次启动会自动备份并修复本地资料数据库。
角色卡、世界书和章节不会被清空。
修复期间不要强制结束应用。
```

验证：

```text
versionName/versionCode
历史签名证书一致
zipalign/apksigner
V2.11.15→新版覆盖安装
V2.11.23 漂移库→新版覆盖安装
```


## 17. 完成定义

以下全部成立才算完成：

- Schema 40；
- 32→33 幂等；
- 39→40 补缺列/索引；
- recorded 40 但物理缺列时启动 repair 仍生效；
- 修复前创建并验证恢复备份；
- 角色卡、世界书、合集、项目、章节 ID 不减少；
- 原项目关联不减少；
- 失败时不删除、不清库、不 seed 空数据掩盖错误；
- 资料读取错误不显示“暂无资料”；
- 修复成功后 Store 自动重载；
- 旧备份恢复到 40 后资料完整；
- 真实升级 fixture 和 Android 覆盖安装通过。


## 18. Agent 最终报告

```text
起始分支/HEAD
结束 HEAD
开工前后 git status

复现数据库来源
recorded schema
PRAGMA table_info(canon_evidence)
缺失字段/索引

Schema 40
32→33 幂等化
known drift inspector
recovery backup
召回快照
初始化顺序
UI 防假空态

项目 before/after
章节 before/after
角色合集 before/after
角色卡 before/after
世界书合集 before/after
世界书条目 before/after
project_resources before/after
project_collection_settings before/after

Schema 32/33/39/40 测试
漂移库测试
备份失败/迁移中断测试
旧备份恢复
完整 Jest
TypeScript
Lint
Android debug/release
真实设备覆盖安装

提交 SHA
是否推送
APK 路径/版本/签名
```


## 19. 受影响用户现场保护

修复版发布前，只建议用户：

```text
不要卸载应用
不要清除应用数据
不要安装旧版覆盖
不要反复新建同名空合集
保留当前手机和数据库
等待修复版后直接覆盖安装
```

手动备份可用时先备份；备份也失败时保持现状，不做清理。
