# Tavo Mini / ShineWriter 优化建设执行方案

## 1. 文档用途

本方案用于指导编程 Agent 对 `anjingdtl/tavo-mini` 仓库进行系统性优化。

项目当前为 React Native Android 小说创作软件，已经具备章节编辑、自动保存、角色资料、世界书、笔记、AI 流水线、在线模型、本地 GGUF 模型、TTS、备份恢复等功能。

本轮建设目标不是继续增加大型功能，而是优先完成以下事项：

1. 保证用户小说数据不会因升级、恢复或异常退出而丢失。
2. 修复数据库事务和迁移机制中的结构性风险。
3. 建立可持续的测试、构建和发布流程。
4. 降低数据库、编辑器、AI 模块的维护复杂度。
5. 统一项目版本、文档和实际功能。
6. 为后续正式发布建立稳定基础。

---

# 2. Agent 总体指令

## 2.1 执行原则

Agent 必须遵守以下原则：

- 不得在本轮建设中新增与目标无关的大型产品功能。
- 不得删除或重置现有用户数据库。
- 不得修改已有表或字段含义，除非提供完整迁移方案。
- 数据库迁移必须支持从历史版本升级。
- 所有涉及数据写入的修改必须有回归测试。
- 所有提交必须通过 lint、TypeScript 检查和 Jest 测试。
- 修改 Android 原生代码后，必须完成 Android Debug 构建。
- 修改发布配置后，必须验证缺少密钥时构建会明确失败。
- 不得把 API Key、签名密码、keystore 或测试账号提交到仓库。
- 不得仅通过增加 `try/catch` 隐藏错误。
- 不得把数据库迁移错误继续交给 `ensureSchemaCompatibility` 静默兜底。
- 每完成一个独立任务，单独提交一次 Git Commit。
- 不得一次性进行大规模无关重构。

## 2.2 工作方式

每个任务按照以下顺序执行：

1. 阅读相关代码。
2. 描述当前问题和根因。
3. 编写或补充失败测试。
4. 实施最小修复。
5. 运行目标测试。
6. 运行全量测试。
7. 检查 lint 和 TypeScript。
8. 更新相关文档。
9. 创建单独提交。
10. 输出变更摘要和剩余风险。

## 2.3 禁止行为

Agent 不得：

- 使用 `database.transaction(async tx => {...})`。
- 在 SQLite transaction callback 中执行 `await`。
- 通过删除旧数据库解决升级问题。
- 把恢复操作拆成无事务的逐表删除和插入。
- 静默忽略备份或恢复失败。
- 在 Release 构建中使用默认签名密码。
- 把测试数量硬编码到 README。
- 把未验证的 APK 标记为正式发布版本。
- 在没有测试的情况下删除兼容代码。
- 修改数据库 Schema 后不升级 `SCHEMA_VERSION`。

---

# 3. 当前已知问题

## 3.1 数据库事务实现不统一

项目已经明确记录：`react-native-sqlite-storage` 的 transaction callback 需要同步安排 SQL，不能在 callback 中使用 `async/await`。项目普通业务代码已经引入 `runInTransactionSafe`。

但迁移框架仍使用：

```ts
await db.transaction(async tx => {
  await migration.migrate(...);
  await execute(...);
});
```

备份恢复同样使用异步 transaction callback。

这是本轮最高优先级问题。

## 3.2 备份表清单不完整

数据库存在 `character_collections` 等表，但当前备份清单没有完整覆盖所有业务表。

因此备份文件可能验证成功，但恢复后仍缺少部分数据或引用关系。

## 3.3 迁移前执行兼容修复

当前数据库初始化顺序为：

```text
createTables
ensureSchemaCompatibility
seedDefaults
migrate
```

兼容修复发生在正式迁移之前，可能掩盖迁移遗漏，使 Schema 状态难以追踪。

## 3.4 文档与代码不一致

当前应用版本已经达到 `2.4.3`，但 README 和 CHANGELOG 仍描述旧版本、旧测试数量和 LiteRT-LM 模型方案。实际代码已经使用 GGUF 和 llama.cpp。

## 3.5 Release 签名存在默认密码

Release 配置允许在环境变量不存在时使用仓库中可见的固定密码。

该行为必须删除。

---

# 4. 总体建设阶段

| 阶段 | 目标 | 优先级 |
|---|---|---|
| Phase 0 | 建立基线和保护措施 | P0 |
| Phase 1 | 修复数据库事务和迁移系统 | P0 |
| Phase 2 | 修复备份与恢复系统 | P0 |
| Phase 3 | 修复发布安全和构建流程 | P0 |
| Phase 4 | 建立 CI 和质量门禁 | P1 |
| Phase 5 | 拆分核心架构 | P1 |
| Phase 6 | 优化 AI 和后台任务可靠性 | P1 |
| Phase 7 | 更新文档和发布规范 | P1 |
| Phase 8 | 产品级数据可靠性验证 | P2 |

必须按顺序执行 Phase 0 至 Phase 4。

Phase 5 以后可根据风险和开发时间分批完成。

---

# 5. Phase 0：建立优化基线

## 任务 0.1：创建工作分支

### 操作

创建分支：

```bash
git checkout main
git pull
git checkout -b refactor/data-reliability
```

### 验收标准

- 当前分支为 `refactor/data-reliability`。
- 工作区无未提交变更。
- 记录当前提交 SHA。

### 建议提交

无需提交。

---

## 任务 0.2：运行项目基线检查

### 执行命令

```bash
npm install
npm run lint
npx tsc --noEmit
npm test -- --runInBand
npm run apk:debug
```

### 输出文件

创建：

```text
docs/optimization/baseline.md
```

记录：

- Node.js 版本。
- Java 版本。
- Android SDK 版本。
- 当前应用版本。
- 当前 Schema 版本。
- Jest Suite 数量。
- Jest Test 数量。
- lint 错误数量。
- TypeScript 错误数量。
- Debug APK 是否成功生成。
- APK 大小。
- 当前失败测试及原因。

### 验收标准

- 基线结果被写入文档。
- 不得在此任务中顺手修复无关问题。
- 后续优化结果必须与该基线比较。

### Commit

```text
docs: add optimization baseline
```

---

## 任务 0.3：增加独立 TypeScript 命令

修改 `package.json`：

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test:ci": "jest --runInBand --ci",
    "verify": "npm run lint && npm run typecheck && npm run test:ci"
  }
}
```

### 验收命令

```bash
npm run verify
```

### Commit

```text
chore: add unified verification commands
```

---

# 6. Phase 1：数据库事务和迁移系统重构

## 任务 1.1：建立统一 SQLite 事务执行器

### 目标

所有 SQLite 事务必须使用统一封装，禁止 transaction callback 内出现 `async/await`。

### 新建文件

```text
src/services/database/transaction.ts
```

### 建议接口

```ts
export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

export async function executeTransaction(
  database: SQLite.SQLiteDatabase,
  statements: SqlStatement[],
): Promise<void>;
```

### 实现要求

- transaction callback 必须是同步函数。
- callback 内只调用 `tx.executeSql(...)`。
- Promise 只能由 transaction 的成功和失败回调完成。
- 支持空语句数组。
- SQL 失败必须 reject。
- 错误信息必须保留原始 SQLite 错误。
- 不得吞掉异常。

### 测试文件

```text
__tests__/databaseTransaction.test.ts
```

### 测试场景

1. 空 statements 直接成功。
2. 多条 SQL 按顺序提交。
3. 任意 SQL 失败时 Promise reject。
4. transaction 失败时不返回成功。
5. callback 不是 async function。
6. 参数能够正确传递。
7. 事务成功回调只触发一次。

### 验收标准

```bash
npm test -- databaseTransaction
npm run verify
```

### Commit

```text
refactor(database): add safe transaction executor
```

---

## 任务 1.2：重写 migration runner

### 目标

移除迁移系统中的异步 transaction callback。

### 修改文件

```text
src/services/migrations/index.ts
src/services/migrations/types.ts
src/services/migrations/*.ts
```

### 推荐方案

将每个 migration 改造成以下两种形式之一。

#### 方案 A：声明式 SQL

```ts
interface Migration {
  from: number;
  to: number;
  breaking: boolean;
  buildStatements: () => Promise<SqlStatement[]> | SqlStatement[];
}
```

迁移框架：

1. 在事务外构造 statements。
2. 调用统一 `executeTransaction`。
3. 最后一条语句更新 `schema_version`。
4. 只有整个事务成功才更新版本。

#### 方案 B：同步 transaction builder

仅在迁移需要回调结果时使用：

```ts
interface Migration {
  run: (
    tx: SQLite.Transaction,
    complete: () => void,
    fail: (error: Error) => void,
  ) => void;
}
```

优先使用方案 A。

### 迁移原子性要求

每个版本迁移必须满足：

```text
业务表变更
索引创建
数据转换
schema_version 更新
```

必须位于同一个事务中。

### 必须增加的测试

新建：

```text
__tests__/migrationMatrix.test.ts
__tests__/migrationAtomicity.test.ts
```

覆盖：

- Schema 3 → 当前版本。
- Schema 4 → 当前版本。
- Schema 5 → 当前版本。
- 一直覆盖到 Schema 13 → 14。
- 中间迁移失败时 `schema_version` 不得前进。
- 重复执行 migration 不得重复写入或破坏数据。
- 从旧版本升级后所有必要表和字段存在。
- 外键和索引存在。

### 验收标准

仓库中不得再出现：

```text
transaction(async
transaction(async (
```

检查命令：

```bash
grep -R "transaction(async" src android __tests__
```

Windows PowerShell：

```powershell
Get-ChildItem -Recurse src,__tests__ |
  Select-String "transaction\(async"
```

结果必须为空。

### Commit

```text
refactor(database): make migrations transaction-safe
```

---

## 任务 1.3：调整数据库初始化顺序

### 当前问题

目前在迁移之前执行建表、补列和默认数据写入。

### 目标顺序

建议调整为：

```text
open database
enable foreign keys
ensure metadata table
detect install type and schema version
create pre-migration backup when required
run migrations
validate current schema
run targeted compatibility repairs
seed default data
create indexes
repair derived data
mark database ready
```

### 修改文件

```text
src/services/database.ts
src/services/migrations/index.ts
```

### 要求

- 新安装可以直接创建最新 Schema。
- 老版本必须严格走 migration。
- `ensureSchemaCompatibility` 不得替代 migration。
- `ensureSchemaCompatibility` 应重命名为：

```text
repairKnownSchemaDefects
```

- 修复函数只处理已经确认存在的历史缺陷。
- 每项修复必须带版本范围或缺陷编号。
- 修复执行后必须写日志。
- 修复不得无条件扫描并修改所有表。

### 验收测试

1. Fresh install 创建 Schema 14。
2. Schema 8 升级到 Schema 14。
3. Schema 13 升级到 Schema 14。
4. 相同 app version 但旧 schema 可以补迁移。
5. migration 失败时不执行 seed。
6. migration 失败时 app/schema version 不被错误更新。
7. repair 函数不会在健康数据库执行 ALTER TABLE。

### Commit

```text
refactor(database): reorder initialization and schema repair
```

---

## 任务 1.4：增加 Schema 验证器

### 新建文件

```text
src/services/database/schemaManifest.ts
src/services/database/schemaValidator.ts
```

### Schema Manifest 至少包含

```ts
interface TableManifest {
  name: string;
  columns: string[];
  indexes?: string[];
  backup: boolean;
  restoreOrder: number;
}
```

### 验证内容

- 所有表存在。
- 所有必要字段存在。
- 所有必要索引存在。
- `schema_version` 与当前版本一致。
- 外键已开启。
- 当前激活 LLM 配置有效。
- 项目引用不存在孤儿记录。

### 验收标准

数据库打开完成前必须执行 Schema 验证。

验证失败时：

- 不得继续静默运行。
- 显示用户可理解的错误。
- 提供“导出诊断信息”和“从备份恢复”入口。
- 不得自动删除数据库。

### Commit

```text
feat(database): add runtime schema validation
```

---

# 7. Phase 2：备份与恢复系统重构

## 任务 2.1：统一备份表清单

### 目标

备份和恢复表清单必须从 Schema Manifest 自动生成。

### 必须检查的表

至少包括：

```text
projects
chapters
fragments
plotlines
project_plotlines
characters
character_collections
worldbook_collections
worldbook_entries
notes
presets
llm_config
settings
project_resources
llm_usage_logs
pipeline_tasks
freeform_documents
content_revisions
generation_drafts
project_note_config
note_style_profiles
local_llm_models
```

### 本地模型特殊规则

不得把 GGUF 模型文件直接写入普通 JSON 备份。

备份中应记录：

```json
{
  "local_model_reference": {
    "id": "...",
    "filename": "...",
    "sha256": "...",
    "file_size": 0,
    "included": false
  }
}
```

恢复时：

- 模型文件不存在则将模型状态标记为 `missing`。
- 引用该模型的 LLM 配置不得保持激活。
- UI 提示用户重新导入对应 GGUF 文件。
- 不得因为模型缺失导致整个小说备份恢复失败。

### Commit

```text
fix(backup): include all schema tables in backup manifest
```

---

## 任务 2.2：禁止 API Key 进入备份

### 要求

创建备份时，不仅恢复时过滤 `api_key`，写入备份前就必须删除：

```text
llm_config.api_key
```

同时扫描：

- 语音 API Key。
- Bearer Token。
- 自定义认证 Header。
- WebDAV 密码。
- 未来可能加入的云同步凭据。

### 测试

备份 JSON 中不得匹配：

```text
sk-
Bearer 
api_key":"非空值
password
token
```

注意：测试不得使用真实密钥。

### Commit

```text
security(backup): exclude credentials from backup files
```

---

## 任务 2.3：重写恢复事务

### 目标

恢复操作必须是真正原子的。

### 执行流程

1. 校验备份格式。
2. 校验 checksum。
3. 创建恢复前备份。
4. 在事务外解析所有行。
5. 构建删除 SQL。
6. 构建插入 SQL。
7. 使用统一 transaction executor 一次提交。
8. 执行外键完整性检查。
9. 执行 Schema 验证。
10. 重启数据库连接或重新加载 Store。
11. 标记恢复成功。

### 禁止

- transaction callback 内 `await`。
- 删除完成后再逐表异步插入。
- 恢复失败后保留半恢复状态。
- 恢复成功前删除恢复前备份。

### 测试

1. 正常恢复。
2. 中间插入失败时原数据库不变。
3. 缺少非核心表时按兼容策略处理。
4. 缺少核心表时拒绝恢复。
5. 错误字段类型时拒绝恢复。
6. 恢复后行数一致。
7. 恢复后外键无孤儿记录。
8. API Key 不被恢复。
9. 本地模型文件缺失时状态正确。
10. 恢复前备份被成功创建。

### Commit

```text
refactor(backup): make restore atomic and verifiable
```

---

## 任务 2.4：升级备份格式

### 新格式

将备份格式升级到：

```json
{
  "format": "shinewriter-backup",
  "format_version": 3,
  "meta": {
    "app_version": "",
    "schema_version": 14,
    "created_at": "",
    "kind": "manual",
    "checksum_algorithm": "sha256",
    "checksum": ""
  },
  "tables": {},
  "external_assets": []
}
```

### 要求

- 使用 SHA-256。
- 保持对 v1、v2 的只读恢复兼容。
- 新版本只生成 v3。
- checksum 必须覆盖表数据和关键 metadata。
- 不把 checksum 描述为加密保护。
- 对大备份避免在 JS 主线程进行长时间同步哈希。

### Commit

```text
feat(backup): introduce backup format v3
```

---

## 任务 2.5：备份隐私保护

### 最低实现

在备份中心明确显示：

```text
备份文件包含小说正文、人物、世界观和笔记等内容。
请勿将未加密备份上传到不可信位置。
```

### 推荐实现

增加加密导出：

- AES-256-GCM。
- 密码使用 PBKDF2、scrypt 或 Argon2 派生。
- 每个文件独立随机 salt。
- 每个文件独立随机 nonce。
- 密码不保存。
- 密码错误时不得泄露部分内容。

### Commit

基础提示：

```text
docs(security): warn users about backup privacy
```

加密功能：

```text
feat(backup): add password-encrypted exports
```

---

# 8. Phase 3：发布安全和构建流程

## 任务 3.1：删除 Release 默认签名密码

### 修改文件

```text
android/app/build.gradle
```

### 要求

以下环境变量必须存在：

```text
SHINE_WRITER_RELEASE_STORE_FILE
SHINE_WRITER_RELEASE_STORE_PASSWORD
SHINE_WRITER_RELEASE_KEY_ALIAS
SHINE_WRITER_RELEASE_KEY_PASSWORD
```

缺少任意变量时：

- Debug 构建不受影响。
- Release 构建立即失败。
- 错误信息明确指出缺少哪个变量。

不得提供默认值。

### 验收

```bash
npm run apk:debug
```

成功。

未设置环境变量：

```bash
npm run apk:release
```

必须失败。

设置正确环境变量后 Release 构建成功。

### Commit

```text
security(android): require release signing secrets
```

---

## 任务 3.2：启用 Release 压缩和资源优化评估

### 目标

评估：

```gradle
minifyEnabled true
shrinkResources true
```

### 要求

- 先完成本地模型、Keychain、React Native、SQLite 和原生模块 ProGuard 规则。
- 不得仅因构建成功就认为验证完成。
- 必须真机测试：
  - 启动。
  - 新建项目。
  - 编辑章节。
  - 在线 LLM。
  - 本地模型。
  - TTS。
  - 备份。
  - 恢复。

若短期无法安全启用，应记录阻塞原因，不得强行开启。

### Commit

```text
build(android): prepare release minification rules
```

---

## 任务 3.3：统一版本生成

### 目标

版本信息只能有一个事实来源。

推荐以 `package.json.version` 为主。

自动生成：

```text
versionName
versionCode
src/constants/version.json
APK 文件名
README 版本徽章
Release 标题
```

### versionCode 要求

不得完全依赖 Git Commit 数量。

建议：

```text
major * 1_000_000
+ minor * 10_000
+ patch * 100
+ build
```

或者使用 CI 构建号。

必须保证：

- 永远递增。
- 不因 shallow clone 变化。
- 不因 rebase 倒退。
- 本地和 CI 结果一致。

### Commit

```text
build: unify application version generation
```

---

# 9. Phase 4：建立 CI 和质量门禁

## 任务 4.1：建立 GitHub Actions

### 新建文件

```text
.github/workflows/verify.yml
```

### 触发条件

```yaml
on:
  push:
    branches: [main]
  pull_request:
```

### Job

#### Job 1：JavaScript 验证

执行：

```bash
npm ci
npm run lint
npm run typecheck
npm run test:ci
```

#### Job 2：Android Debug Build

执行：

```bash
npm ci
npm run prebuild
cd android
./gradlew assembleDebug
```

#### Job 3：Migration Matrix

执行数据库迁移专项测试：

```bash
npm test -- migration --runInBand
```

### 要求

- 使用 npm cache。
- 固定 Node 22。
- 固定 JDK 17。
- 不在日志中输出 Secrets。
- PR 只有全部 Job 通过才允许合并。

### Commit

```text
ci: add lint test typecheck and android build
```

---

## 任务 4.2：增加测试覆盖率门禁

### 修改 Jest 配置

增加：

```js
collectCoverageFrom: [
  'src/services/**/*.ts',
  'src/store/**/*.ts',
  'src/utils/**/*.ts',
  '!src/**/*.d.ts',
]
```

初始阈值建议：

```js
coverageThreshold: {
  global: {
    branches: 55,
    functions: 65,
    lines: 65,
    statements: 65,
  },
}
```

数据库、迁移、备份模块单独要求：

```text
lines >= 80%
branches >= 70%
```

若当前覆盖率不足：

- 先记录基线。
- 分阶段提高。
- 不得通过排除关键文件伪造覆盖率。

### Commit

```text
test: add coverage reporting and thresholds
```

---

## 任务 4.3：增加关键用户流程测试

优先采用 Maestro。

### 新建目录

```text
e2e/maestro/
```

### 必须覆盖

1. 首次启动。
2. 新建小说项目。
3. 新建章节。
4. 输入正文。
5. 退出章节。
6. 重新进入并确认正文存在。
7. 创建角色集合。
8. 创建角色。
9. 创建世界书。
10. 创建手动备份。
11. 修改正文。
12. 恢复备份。
13. 确认正文恢复。
14. 配置在线 LLM。
15. 测试连接。
16. 流水线开始、取消和失败提示。

### Commit

```text
test(e2e): cover core writing and backup flows
```

---

# 10. Phase 5：核心代码架构拆分

## 任务 5.1：拆分 database.ts

### 目标结构

```text
src/data/
├── connection/
│   ├── openDatabase.ts
│   ├── execute.ts
│   └── transaction.ts
├── schema/
│   ├── schemaManifest.ts
│   ├── schemaValidator.ts
│   └── repairKnownDefects.ts
├── migrations/
├── repositories/
│   ├── projectRepository.ts
│   ├── chapterRepository.ts
│   ├── characterRepository.ts
│   ├── worldbookRepository.ts
│   ├── noteRepository.ts
│   ├── presetRepository.ts
│   ├── llmConfigRepository.ts
│   ├── usageRepository.ts
│   └── pipelineTaskRepository.ts
└── backup/
```

### 迁移策略

不得一次性重写全部数据库代码。

按照以下顺序：

1. 抽取底层 execute 和 transaction。
2. 抽取 Schema 和 migration。
3. 抽取 backup。
4. 按业务域逐个抽取 repository。
5. 保留原 `database.ts` 作为临时兼容导出入口。
6. 所有调用方迁移完成后再删除兼容入口。

### 文件大小目标

- 单文件建议不超过 500 行。
- Repository 建议不超过 400 行。
- 超过限制时应按子领域继续拆分。

### Commit

每个 Repository 单独提交，例如：

```text
refactor(database): extract chapter repository
refactor(database): extract character repository
```

---

## 任务 5.2：拆分 ChapterEditor

### 目标结构

```text
src/screens/chapter-editor/
├── ChapterEditorScreen.tsx
├── ChapterToolbar.tsx
├── ChapterFields.tsx
├── ChapterPipelinePanel.tsx
├── ChapterTtsControls.tsx
└── hooks/
    ├── useChapterDocument.ts
    ├── useChapterAutoSave.ts
    ├── useChapterPipeline.ts
    ├── useChapterTts.ts
    └── useUnsavedChangesGuard.ts
```

### 职责划分

#### `useChapterDocument`

- 加载章节。
- 更新本地状态。
- 刷新章节。
- 处理数据库错误。

#### `useChapterAutoSave`

- 聚合字段修改。
- 防抖保存。
- flush。
- 保存状态。
- 失败重试。

#### `useUnsavedChangesGuard`

- 页面返回拦截。
- AppState 后台保存。
- 组件卸载保存。

#### `useChapterPipeline`

- 查找当前任务。
- 启动任务。
- 取消任务。
- 订阅任务状态。
- 跳转结果页。

#### `useChapterTts`

- 朗读。
- 停止。
- 播放状态。
- 播放结束提示。

### 验收标准

- 主屏幕文件不超过 350 行。
- 自动保存测试保持通过。
- 流水线测试保持通过。
- TTS 测试保持通过。
- 页面退出不丢失内容。
- 不使用 `@ts-ignore` 规避导航类型。

### Commit

```text
refactor(editor): split chapter editor responsibilities
```

---

# 11. Phase 6：AI 与后台任务可靠性

## 任务 6.1：限制在线 LLM 并发

当前并发限制为 250，应调整为移动端合理值。

### 建议值

```text
普通在线调用：3
同项目流水线：1
跨项目后台任务：2
连接测试：1
本地模型：1
```

### 要求

- 队列支持取消。
- 已取消任务不得继续发起 fetch。
- 队列项应带 taskId。
- 高优先级手动操作可以优先于后台任务。
- UI 显示“排队中”状态。
- App 进入低内存状态时暂停新任务。

### Commit

```text
fix(llm): enforce mobile-safe request concurrency
```

---

## 任务 6.2：统一 LLM 超时策略

### 当前问题

长篇生成和连接测试使用固定超时，可能不适合本地模型和不同云端服务。

### 建议策略

```text
连接测试：20 秒
普通短请求：60 秒
章节草稿：180 秒
多阶段流水线：每阶段独立超时
本地模型：使用无 token 进展超时，不使用单纯总时长
```

### 要求

- 超时配置集中管理。
- 每个任务记录开始时间、首 Token 时间、最后进展时间。
- 流式任务只要持续输出就不得超时。
- 用户取消优先于超时。
- 错误码区分：
  - `cancelled`
  - `connect_timeout`
  - `idle_timeout`
  - `total_timeout`
  - `network_error`
  - `provider_error`

### Commit

```text
refactor(llm): centralize timeout and cancellation policy
```

---

## 任务 6.3：统一 HTTP 和 HTTPS 行为

### 问题

Debug 构建允许 HTTP，Release 构建关闭明文流量，可能造成开发环境可用、正式版失败。

### 推荐方案

默认只允许 HTTPS。

局域网模型服务使用显式开关：

```text
允许不安全的局域网 HTTP 服务
```

开启时必须显示：

```text
API Key 和小说内容可能通过未加密网络传输。
仅应连接可信局域网设备。
```

### 实现要求

- 默认关闭。
- 只允许私有地址：
  - `127.0.0.1`
  - `10.0.0.0/8`
  - `172.16.0.0/12`
  - `192.168.0.0/16`
- 不允许对公网 HTTP 地址绕过。
- Release 使用 Network Security Config 精确控制。
- 配置测试和实际生成使用相同规则。

### Commit

```text
security(network): align cleartext policy across builds
```

---

# 12. Phase 7：文档与发布规范

## 任务 7.1：重写 README

README 必须准确反映当前项目。

### 必须包含

- 主产品名称。
- 项目定位。
- 当前版本。
- Android 支持范围。
- React Native 版本。
- 在线模型支持。
- GGUF 和 llama.cpp 本地模型支持。
- 数据存储位置。
- API Key 存储方式。
- 备份内容和隐私提示。
- 开发环境。
- 构建命令。
- 测试命令。
- Release 下载方式。
- 已知限制。
- 项目截图。

### 必须删除或修正

- LiteRT-LM。
- `.litertlm`。
- 已过时测试数量。
- 旧版本更新日志。
- 与实际功能不一致的模型描述。

### Commit

```text
docs: update readme for current architecture
```

---

## 任务 7.2：规范 CHANGELOG

采用 Keep a Changelog 结构：

```text
Unreleased
Added
Changed
Fixed
Security
Removed
```

补齐：

```text
2.4.0
2.4.1
2.4.2
2.4.3
```

每个版本至少记录：

- 功能变化。
- 数据库 Schema 变化。
- 升级风险。
- 本地模型变化。
- Bug 修复。
- 兼容性变化。

### Commit

```text
docs: rebuild changelog for 2.4 releases
```

---

## 任务 7.3：建立发布清单

创建：

```text
docs/RELEASE_CHECKLIST.md
```

内容至少包括：

```text
[ ] versionName 已更新
[ ] versionCode 递增
[ ] CHANGELOG 已更新
[ ] README 与当前功能一致
[ ] npm ci 成功
[ ] lint 通过
[ ] typecheck 通过
[ ] Jest 通过
[ ] migration matrix 通过
[ ] Android Debug 构建成功
[ ] Android Release 构建成功
[ ] 新安装测试通过
[ ] 老版本升级测试通过
[ ] 备份恢复测试通过
[ ] 在线模型测试通过
[ ] 本地模型测试通过
[ ] TTS 测试通过
[ ] 前后台切换测试通过
[ ] APK 签名证书正确
[ ] APK SHA-256 已生成
[ ] GitHub Release 已创建
```

### Commit

```text
docs: add release verification checklist
```

---

# 13. Phase 8：产品级可靠性验证

## 任务 8.1：历史数据库升级矩阵

创建历史数据库 Fixture：

```text
__tests__/fixtures/databases/
├── schema-3.db
├── schema-4.db
├── schema-5.db
├── ...
└── schema-13.db
```

每个 Fixture 必须包含：

- 至少两个项目。
- 多个章节。
- 角色和角色集合。
- 世界书和集合。
- 笔记。
- LLM 配置。
- 修订记录。
- 流水线任务。
- 特殊字符。
- 超长正文。
- 空字段。
- 中文和英文混合内容。

升级后验证：

- 所有内容存在。
- 行数正确。
- 引用关系正确。
- 当前项目正确。
- 无外键错误。
- 无重复记录。
- Schema 版本正确。

---

## 任务 8.2：故障注入测试

模拟以下故障：

1. migration 第三条 SQL 失败。
2. 恢复中途失败。
3. 磁盘空间不足。
4. 备份文件损坏。
5. 备份 checksum 错误。
6. App 在自动保存时被杀死。
7. App 在迁移时被杀死。
8. App 在恢复时被杀死。
9. GGUF 导入中被杀死。
10. 本地模型生成时内存不足。
11. 在线模型请求中断网。
12. TTS 播放中切后台。

### 验收要求

每个场景必须定义：

- 用户看到什么。
- 数据库处于什么状态。
- 是否可重试。
- 是否需要恢复备份。
- 是否会产生孤儿文件。
- 是否会产生卡死任务。
- 日志包含什么诊断信息。

---

# 14. Agent 每阶段输出格式

每完成一个阶段，Agent 必须输出：

```markdown
## 阶段完成报告

### 已完成任务
- ...

### 修改文件
- ...

### 新增测试
- ...

### 执行结果
- npm run lint:
- npm run typecheck:
- npm test:
- npm run apk:debug:

### 关键设计决定
- ...

### 未解决风险
- ...

### Git Commit
- SHA:
- Message:

### 下一阶段
- ...
```

不得只回复“已经完成”。

---

# 15. Git Commit 规范

使用 Conventional Commits：

```text
fix(database):
refactor(database):
fix(backup):
feat(backup):
security(android):
security(network):
test:
ci:
docs:
build:
```

每个 Commit 应只处理一个明确问题。

禁止：

```text
update code
fix bugs
misc changes
final update
```

---

# 16. Pull Request 验收标准

PR 合并前必须满足：

## 数据库

- 仓库中不存在 `transaction(async`。
- 所有 migration 具有原子性。
- 所有历史 Schema 可以升级。
- migration 失败不会推进版本。
- Schema 验证通过。

## 备份

- 所有业务表进入备份清单。
- 角色集合可以恢复。
- API Key 不进入备份。
- 恢复是原子的。
- 恢复后无外键孤儿。
- 本地模型缺失可正确降级。

## 安全

- Release 无默认签名密码。
- Release 密钥不进入仓库。
- HTTP 行为在 Debug 和 Release 中一致。
- 明文备份有明确隐私提示。

## 工程

- lint 通过。
- TypeScript 通过。
- Jest 通过。
- Android Debug 构建通过。
- GitHub Actions 通过。
- README 与代码一致。
- CHANGELOG 已更新。

---

# 17. 完成定义

当以下条件全部满足时，本轮优化建设才算完成：

1. 用户从任意支持的旧版本升级时，小说数据完整保留。
2. 数据库迁移中途失败时，不产生半迁移状态。
3. 备份恢复中途失败时，原数据库保持不变。
4. 备份覆盖全部小说业务数据。
5. API Key 不进入数据库备份。
6. 章节退出、切后台和异常关闭时最大限度避免丢稿。
7. 每次 Pull Request 都自动执行 lint、typecheck、测试和 Android 构建。
8. Release 构建必须使用外部安全密钥。
9. README、CHANGELOG、版本号和实际功能保持一致。
10. 数据库、备份和章节编辑器的核心职责完成拆分。
11. 在线模型并发符合移动端资源限制。
12. 本地模型、TTS、后台任务和恢复流程均经过真机验证。

---

# 18. 第一批 Agent 执行指令

将以下内容直接交给编程 Agent：

```text
你正在维护 GitHub 仓库 anjingdtl/tavo-mini。

请严格按照 docs/OPTIMIZATION_EXECUTION_PLAN.md 开始执行 Phase 0 和 Phase 1。

本次只允许完成以下内容：

1. 建立当前项目测试和构建基线。
2. 增加 typecheck、test:ci 和 verify 命令。
3. 新建统一 SQLite transaction executor。
4. 移除 migration runner 中的 transaction(async ...)。
5. 为 Schema 3 到当前 Schema 建立迁移矩阵测试。
6. 调整数据库初始化顺序。
7. 将 ensureSchemaCompatibility 改造成只处理已知历史缺陷的 repairKnownSchemaDefects。
8. 增加运行时 Schema Validator。

约束：

- 不新增产品功能。
- 不删除任何已有数据库字段。
- 不重置用户数据库。
- 不修改备份功能，备份将在下一阶段单独处理。
- transaction callback 内禁止 async 和 await。
- 先写失败测试，再修复代码。
- 每个独立任务单独提交。
- 每次提交前执行 npm run verify。
- 最后执行 npm run apk:debug。
- 遇到已有测试失败时先判断是否为本次修改导致，不得直接删除测试。
- 不得用 try/catch 吞掉迁移错误。
- 不得通过 ensureColumn 代替正式 migration。
- 不得修改 Release 签名配置，该任务属于后续阶段。

完成后输出：
- 根因分析
- 修改文件
- 测试清单
- 测试结果
- Commit SHA
- 剩余风险
- 下一阶段建议
```
