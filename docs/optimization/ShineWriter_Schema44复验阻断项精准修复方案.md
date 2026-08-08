# ShineWriter Schema 44 复验阻断项精准修复方案

> 文档状态：待实施  
> 编制依据：本地提交 `23d31f81`、模拟器数据库与 2026-08-08 完整门禁复验  
> 当前应用版本：V2.11.38  
> 目标发布版本：V2.11.39  
> 当前 Schema：44（本方案不升级 Schema）  
> 适用平台：Android-only React Native  
> 目标：修复结果页续跑破坏版本冻结的问题，并使 lint、版本一致性、coverage、完整 verify 全部真实通过

---

## 1. 执行结论

本轮不是重新设计 Pipeline，也不回退已经落地的默认能力。以下产品行为保持不变：

- “一键写 N 章”默认可用；
- 弹性上下文预算 V2 默认启用；
- Outline Workflow V2 默认启用；
- 旧任务、旧批次继续按冻结版本后台兼容；
- 原著续写继续使用独立 generation runner；
- 不恢复任何实验开关，不增加灰度开关或模块级可变布尔。

需要修复四个阻断项：

| 编号 | 级别 | 问题 | 当前证据 | 完成标准 |
|---|---|---|---|---|
| R1 | P1 | 结果页手动续跑把任务行版本从 `2/2` 写成 `1/1` | 模拟器任务 `pt_mskgmeny_115`、`pt_mskh20wg_116` 的 row=`1/1`、snapshot=`2/2` | V1/V2 任务续跑前后行版本逐字节不变 |
| R2 | P1 | 新增回归测试存在未使用变量，lint 失败 | `useChapterPipelineRetryProgress.test.tsx:159` | `npm run lint` 退出码 0 |
| R3 | P1 | CHANGELOG 已到 2.11.39，应用与 APK 仍为 2.11.38 | `npm run verify:version` 退出码 1 | 所有版本元数据统一为 2.11.39 |
| R4 | P2 | 全局覆盖率达标，但 6 个文件未达文件级阈值 | `npm run test:coverage` 退出码 1 | 不降低阈值、不加忽略，coverage 退出码 0 |

最终交付必须同时满足：

```text
npm run lint          => 0
npm run typecheck     => 0
npm run verify:version=> 0
npm run test:ci       => 0
npm run test:coverage => 0
npm run verify        => 0
模拟器续跑验收         => 任务行版本不变、成功阶段不重发、无崩溃
```

---

## 2. R1：修复结果页续跑破坏版本冻结

### 2.1 根因链

问题链路位于：

```text
PipelineResultScreen.handleResumeFailed
  → 直接 SQL：只把数据库任务状态改成 interrupted
  → registerPersistedTask(手工拼装的不完整 PipelineTask)
  → 对象缺少 outlineWorkflowVersion / contextBudgetVersion
  → resumePipeline 更新任务
  → pipelineTaskStore.persistTask
  → savePipelineTask 全量 UPSERT
  → undefined ?? 1
  → 已有 V2 行被覆盖成 Legacy 1/1
```

运行时之所以仍表现为 V2，是因为冻结 Snapshot 的权威级别高于任务行。这只能防止协议降级，不能证明任务行版本冻结正确。

### 2.2 修改一：结果页使用已有定向更新 API

文件：`src/screens/PipelineResultScreen.tsx`

当前文件已经通过 `import * as db from '../services/database'` 使用数据库 facade，而 `src/services/database.ts` 已导出 `updatePipelineTaskResumeState()`。因此：

1. 删除结果页对 `execute` 和 `openDatabase` 的直接导入；
2. 删除 `handleResumeFailed` 中手写的 `UPDATE pipeline_tasks ...`；
3. 改为调用 `db.updatePipelineTaskResumeState(task.id, resumedAt)`；
4. Store 内存态必须基于完整的原任务对象更新，禁止重新手工枚举字段。

目标代码形态：

```ts
const resumedAt = Date.now();

await resetFailedStageCheckpointsForResume(task.id);
await db.updatePipelineTaskResumeState(task.id, resumedAt);

usePipelineTaskStore.getState().registerPersistedTask({
  ...task,
  status: 'interrupted',
  error: null,
  updatedAt: resumedAt,
  resolvedAt: null,
  resolvedAction: null,
});

await resumePipeline(task.id, chapter);
```

必须保留的字段包括但不限于：

```text
outlineWorkflowVersion
contextBudgetVersion
pipelineContextJson
pipelineContextVersion
pipelineContextHash
inputFingerprint
stageResults
finalText
createdAt
```

这里使用 `...task` 是为了让以后给 `PipelineTask` 增加冻结字段时，结果页续跑不会再次因为漏抄字段而清空数据。

### 2.3 修改二：让全量 UPSERT 永远不能改写冻结版本

文件：`src/data/repositories/pipelineTaskRepository.ts`

`savePipelineTask()` 当前在 `ON CONFLICT(id) DO UPDATE` 中覆盖：

```sql
outline_workflow_version = excluded.outline_workflow_version,
context_budget_version = excluded.context_budget_version
```

这与“任务版本一旦创建就不可变”冲突。应改成冲突更新时保留数据库已有值：

```sql
outline_workflow_version = pipeline_tasks.outline_workflow_version,
context_budget_version = pipeline_tasks.context_budget_version,
```

插入语义保持不变：

- 新 V2 任务必须显式传 `2/2`；
- 历史或测试调用缺省时仍插入 `1/1`；
- 已存在的 V1 行不能被写成 V2；
- 已存在的 V2 行不能被缺字段、`1/1` 或错误调用降为 V1。

不要通过下列方式修复：

- 不把 `?? 1` 全局改成 `?? 2`；
- 不根据项目创建时间猜测版本；
- 不在 Resume 时读取当前默认常量；
- 不把任务行强行同步为 Snapshot 版本；历史实验任务允许 row 与权威 Snapshot 不同；
- 不新增 Schema 45；
- 不扫描并批量改写历史任务；
- 不恢复 feature flag。

### 2.4 R1 单元与集成测试

#### A. 结果页调用链测试

文件：`__tests__/f207PipelineResultResume.test.tsx`

调整 mock：

- 为 `registerPersistedTask` 使用一个文件级稳定 mock，不能在每次 `getState()` 时临时创建新的 `jest.fn()`；
- mock `services/database.updatePipelineTaskResumeState`；
- 测试任务显式包含 `outlineWorkflowVersion: 2`、`contextBudgetVersion: 2`；
- 移除对底层 `execute/openDatabase` 的 mock，因为页面不应再绕过 database facade。

新增断言：

```ts
expect(mockUpdatePipelineTaskResumeState).toHaveBeenCalledWith(
  't1',
  expect.any(Number),
);
expect(mockRegisterPersistedTask).toHaveBeenCalledWith(
  expect.objectContaining({
    id: 't1',
    status: 'interrupted',
    outlineWorkflowVersion: 2,
    contextBudgetVersion: 2,
    pipelineContextJson: expect.anything(),
  }),
);
```

同时断言调用顺序：

```text
resetFailedStageCheckpointsForResume
  → updatePipelineTaskResumeState
  → registerPersistedTask
  → resumePipeline
```

数据库更新或 checkpoint 重置失败时不得调用 `resumePipeline`。

#### B. SQLite 冻结列不可变测试

优先扩展：`__tests__/pipelineWorkflowVersionPersistence.test.ts`

至少覆盖：

| 场景 | 初始行 | 再次 `savePipelineTask` 入参 | 期望行版本 |
|---|---:|---:|---:|
| V2 正常持久化 | 2/2 | 缺省/null | 2/2 |
| V2 遭错误 Legacy 写入 | 2/2 | 1/1 | 2/2 |
| V1 遭错误 V2 写入 | 1/1 | 2/2 | 1/1 |
| V2 定向 Resume | 2/2 | `updatePipelineTaskResumeState` | 2/2 |

定向 Resume 还必须断言以下字段不变：

```text
stage_results
final_text
input_fingerprint
pipeline_context_json
pipeline_context_version
pipeline_context_hash
created_at
outline_workflow_version
context_budget_version
```

仅允许变化：

```text
status = interrupted
error = NULL
resolved_at = NULL
resolved_action = NULL
updated_at = resumedAt
```

### 2.5 R1 模拟器验收

使用全新 V2 测试任务，不能仅检查旧的、已经被污染的任务行：

1. 覆盖安装修复后的 debug APK；
2. 在老大纲项目中新建章节任务，确认创建后 row=`2/2`、snapshot=`2/2`；
3. 让 Review 或 Proof 失败/中断；
4. 从结果页点击“从失败环节重启”；
5. Resume 启动后、任务完成后分别拉取数据库；
6. 两个时间点都必须满足 row=`2/2`、snapshot=`2/2`；
7. 对比 `pipeline_stage_attempts`：已成功阶段的成功请求数不增加；
8. V1 历史任务执行同样 Resume 后仍为 row=`1/1`；
9. 检查 crash buffer、SQLite 错误和 React Native JS error。

注意：本地现有 `pt_mskgmeny_115` 等污染任务不作为“自动修复成功”的验收依据。本方案是向前修复，不对历史行做推断式批量回填；其 Snapshot 仍是运行时权威。

---

## 3. R2：修复 lint 阻断

文件：`__tests__/useChapterPipelineRetryProgress.test.tsx`

当前：

```ts
const { result } = renderHook(() =>
```

该测试没有使用 `result`。改为：

```ts
renderHook(() =>
```

不要添加 eslint-disable，也不要用无意义断言消费变量。

验收：

```powershell
npx eslint __tests__/useChapterPipelineRetryProgress.test.tsx
npm run lint
```

两条命令都必须退出码 0。

---

## 4. R3：统一发布版本为 V2.11.39

CHANGELOG 顶部已经把本轮改造归入 `2.11.39`，因此本方案固定目标版本为 `2.11.39`，不把 CHANGELOG 降回 `2.11.38`。

### 4.1 修改顺序

1. 使用 npm 同步修改 `package.json` 和 `package-lock.json`：

   ```powershell
   npm version 2.11.39 --no-git-tag-version
   ```

2. 更新 `README.md` 中所有当前版本元数据：

   ```text
   当前版本：**V2.11.39**
   The current version is **V2.11.39**
   Version-V2.11.39-
   ShineWriter-V2.11.39-release.apk
   versionName=V2.11.39
   versionCode=2113900
   ```

3. 运行预构建生成版本文件：

   ```powershell
   npm run prebuild
   ```

4. 不得手改 `src/constants/version.json`；它必须由 `scripts/generate-version-json.js` 生成。

5. 验证：

   ```powershell
   npm run verify:version
   ```

### 4.2 APK 要求

修复完成后旧的 `ShineWriter-V2.11.38-debug.apk` 不能作为交付物。必须重新执行：

```powershell
npm run apk:debug
```

期望产物：

```text
dist/apk/debug/ShineWriter-V2.11.39-debug.apk
```

如果还要生成正式 APK，必须先完整阅读 `docs/RELEASE_APK_BUILD.md`，再按该文档执行 release 构建和签名验收。

---

## 5. R4：补齐文件级 coverage

### 5.1 原则

不允许通过以下方式让 coverage 变绿：

- 降低 `jest.config.js` 的阈值；
- 从 `collectCoverageFrom` 排除文件；
- 添加 istanbul ignore；
- 写没有业务断言、只调用函数的“刷行数”测试；
- 删除现有异常分支或 fail-closed 防御。

当前真实未达标文件为 6 个，不是 8 个：

| 文件 | Branches | Lines | 要求 |
|---|---:|---:|---:|
| `src/data/schema/userContentFingerprint.ts` | 62.96% | 75.67% | 70% / 80% |
| `src/services/migrations/v32-to-v33.ts` | 50% | 100% | 70% / 80% |
| `src/services/migrations/v36-to-v37.ts` | 100% | 50% | 70% / 80% |
| `src/services/migrations/v37-to-v38.ts` | 100% | 50% | 70% / 80% |
| `src/services/migrations/v38-to-v39.ts` | 1.92% | 35.29% | 70% / 80% |
| `src/services/migrations/v39-to-v40.ts` | 100% | 50% | 70% / 80% |

### 5.2 精确补测矩阵

#### `userContentFingerprint.ts`

扩展 `__tests__/cl03ContentFingerprint.test.ts` 与 `__tests__/f203UserContentFingerprintRowBinding.test.ts`，覆盖有业务价值的未测分支：

- `normalizeFingerprintValue`：null/undefined、空字符串、普通字符串、NaN、普通数字、true/false、数组、对象键排序、兜底类型；
- PRAGMA 读取失败与 SELECT 失败必须 fail-closed；
- 表缺失与空表必须产生不同指纹；
- before/after 缺少某张表快照；
- 表出现、表消失、行数变化；
- 列删除；
- 相同列集合下：行缺失、新增行、同 key 内容改变；
- collection_id allowlist 开启与关闭；
- 列集合变化时的 row-key-bound 比较；
- 超过 row map cap 时的 column aggregate fallback 与无法安全比较的 fail-closed 分支。

每个 mismatch 测试至少断言 `table`、`reason`，有定位能力的场景同时断言 `rowKey` 或 `detail` 关键字。

#### `v32-to-v33.ts`

扩展 `__tests__/migrations-v32-v33.test.ts`：

- 直接调用 `migrateV32ToV33()`，不能只测 builder；
- 完整库、缺一列、缺两列、重复执行；
- 重复 Canon 事实存在时，证据链接重绑到 keeper、重复链接清理、非 keeper 删除；
- 无重复数据时数据不变；
- 断言六个 fresh schema index SQL 均存在且可重复执行。

#### `v36-to-v37.ts`

扩展 `__tests__/migrations-v36-v37.test.ts`：

- 执行 migration 后 `pipeline_tasks.input_fingerprint` 存在且旧行值为 NULL；
- `buildSchema37CreateSqls()` 精确返回空数组；
- 用户已有任务其他列字节不变。

#### `v37-to-v38.ts`

新增或扩展对应迁移测试：

- 三列全部新增；
- 旧行三列为 NULL；
- 其他任务字段字节不变；
- `buildSchema38CreateSqls()` 精确返回空数组；
- fresh Schema 44 的 `pipeline_tasks` 已内联包含三列。

#### `v38-to-v39.ts`

扩展 `__tests__/migrations-v38-v39.test.ts`，这是 coverage 的主要缺口：

- `stage_results` 为 NULL、`[]`、非法 JSON、合法但非数组；
- item 为 null、缺 stage；
- success/succeeded/skipped/failed/running/interrupted/未知状态映射；
- 同阶段多条记录按优先级选择，优先级相同时后者覆盖；
- text/error/tokens/durationMs 存在和缺失；
- completed_at 仅对 succeeded/failed/skipped 写入；
- 没有可回填项时不执行 upsert transaction；
- 超过 50 条 checkpoint 时按 50 分块；
- migration 重跑后 checkpoint 不重复、内容稳定；
- `buildSchema39CreateSqls()` 同时包含表和状态索引。

#### `v39-to-v40.ts`

扩展 Schema 40 迁移测试并直接导入目标模块：

- 调用 `migrateV39ToV40()`，验证它确实委托 `ensureCanonEvidenceProvenanceSchema()`；
- 缺两列、缺一列、两列齐全三种真实 SQLite 状态；
- 重复执行幂等；
- `buildV39toV40Statements()` 精确返回空数组。

### 5.3 coverage 验收方式

先定向运行新增测试，再跑完整 coverage：

```powershell
npx jest __tests__/cl03ContentFingerprint.test.ts __tests__/f203UserContentFingerprintRowBinding.test.ts __tests__/migrations-v32-v33.test.ts __tests__/migrations-v36-v37.test.ts __tests__/migrations-v37-v38.test.ts __tests__/migrations-v38-v39.test.ts __tests__/schema40-drift-matrix.test.ts --runInBand
npm run test:coverage
```

最终以命令退出码为准，不能只截图全局四个百分比。

---

## 6. 实施顺序

Agent 必须按以下顺序执行，避免同时改动后难以定位回归：

### Phase A：冻结版本修复

1. 修改 `PipelineResultScreen.tsx` 使用定向 Resume API；
2. 修改 Store 注册载荷为完整任务对象；
3. 加固 `savePipelineTask` 的冲突更新，不允许改写冻结版本；
4. 完成 UI mock 测试和真实 SQLite 冻结测试；
5. 先运行 R1 定向测试、lint、typecheck。

### Phase B：交付元数据修复

1. 删除测试未使用变量；
2. 统一版本到 2.11.39；
3. 运行 `npm run prebuild`；
4. 运行 `npm run verify:version`。

### Phase C：coverage 补齐

1. 按六文件矩阵增加真实分支测试；
2. 定向测试通过后运行完整 coverage；
3. 只根据 coverage 输出补剩余真实缺口，不修改阈值。

### Phase D：完整门禁与模拟器

1. `npm run verify`；
2. `npm run test:coverage`；
3. 构建 V2.11.39 debug APK；
4. 覆盖安装并执行 V1/V2 Resume 验收；
5. 将数据库、logcat、版本信息写入新的 `test-logs/schema44-resume-fix-*` 目录。

---

## 7. 必跑命令

```powershell
# 精确回归
npx jest __tests__/f207PipelineResultResume.test.tsx __tests__/pipelineWorkflowVersionPersistence.test.ts __tests__/useChapterPipelineRetryProgress.test.tsx --runInBand

# 静态门禁
npm run lint
npm run typecheck
npm run verify:version

# 全量测试与覆盖率
npm run test:ci
npm run test:coverage
npm run verify

# APK
npm run apk:debug
```

不得因为 `npm run test:ci` 全绿而跳过 `npm run test:coverage`；两者是不同门禁。

---

## 8. 最终数据库断言

模拟器拉取数据库后，至少执行以下查询。字段名按当前数据库 snake_case：

```sql
SELECT
  id,
  status,
  outline_workflow_version,
  context_budget_version,
  pipeline_context_json,
  pipeline_context_hash
FROM pipeline_tasks
WHERE id = ?;
```

V2 任务 Resume 前后：

```text
outline_workflow_version = 2
context_budget_version = 2
Snapshot.outlineWorkflowVersion = 2
Snapshot.contextBudgetVersion = 2
```

V1 历史任务 Resume 前后：

```text
outline_workflow_version = 1
context_budget_version = 1
历史 Snapshot 缺字段时继续解释为 V1
```

请求去重断言：

```sql
SELECT stage, status, COUNT(*) AS attempts
FROM pipeline_stage_attempts
WHERE task_id = ?
GROUP BY stage, status
ORDER BY stage, status;
```

已成功阶段在 Resume 后不得新增成功请求；仅失败/中断阶段允许新增 attempt。

---

## 9. 禁止事项

- 禁止新增任何“一键写 N 章 / 弹性预算 / Workflow V2”实验开关；
- 禁止把旧任务统一升级为 V2；
- 禁止让 V2 请求失败后自动改用 V1 重发；
- 禁止页面直接写 SQL；
- 禁止用全量 UPSERT 表达仅修改状态的 Resume；
- 禁止手改 `version.json`；
- 禁止降低 coverage 阈值或排除文件；
- 禁止使用现有已污染任务冒充修复后新任务证据；
- 禁止把 API Key、请求正文、用户小说正文写进验收日志。

---

## 10. Agent 交付报告模板

```markdown
# Schema 44 复验阻断项修复报告

## 代码修复
- [ ] 结果页改用 updatePipelineTaskResumeState
- [ ] registerPersistedTask 保留完整冻结字段
- [ ] savePipelineTask 冲突更新不改版本列
- [ ] lint 未使用变量已清理
- [ ] 版本统一为 V2.11.39
- [ ] 6 个文件级 coverage 缺口已用真实测试补齐

## 门禁
- lint：
- typecheck：
- verify:version：
- test:ci：__ suites / __ tests
- test:coverage：退出码；Statements / Branches / Functions / Lines
- verify：

## 模拟器
- 设备/API：
- APK 路径/SHA-256：
- 安装 versionName/versionCode：
- V2 Resume 前后 row/snapshot：
- V1 Resume 前后 row/snapshot：
- 成功阶段 attempt 是否增加：
- FATAL/ANR/SQLite/JS error：
- 原始证据目录：

## 遗留风险
- 无 / 列明非阻断项及理由
```

只有所有复选项完成、所有门禁退出码为 0、模拟器 V1/V2 版本冻结断言通过后，本轮才能标记为最终验收通过。
