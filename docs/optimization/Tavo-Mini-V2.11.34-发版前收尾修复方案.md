# Tavo Mini V2.11.34 发版前收尾修复方案

> 适用对象：本地代码 Agent / Codex / 开发负责人 / QA  
> 项目目录：`D:\AiWorkSpace\tavo-mini`  
> 文档定位：**发版前最后一轮工程闭环。只关闭当前仍存在的阻滞问题，不扩展新功能，不做无关重构。**

---

## 1. 总原则

本轮仍然坚持：**本地代码实际 > 历史审计 > 提交说明 > 代码注释。**

Agent 必须先验真，再修复：

1. 记录当前 Git 分支、HEAD、版本、Schema、工作区未提交改动；
2. 先运行 lint / typecheck / version verify / 全量测试并保存原始结果；
3. 对本方案每个 CL 问题重新沿生产代码调用链复查；
4. 每个确认存在的问题，先新增一个修复前稳定失败的**真实行为测试**；
5. 禁止通过源码正则、手工 SQL 预设最终状态、mock 掉关键状态转换来证明修复有效；
6. 只修改问题直接相关模块，禁止全仓重构、依赖升级和无关格式化；
7. 不覆盖用户未提交改动，不执行 `git reset --hard`；
8. 每项修复独立提交、可回滚、带定向测试；
9. 全部修复完成后再跑完整回归、历史版本覆盖升级、真机和 Release APK 验收；
10. 若方案描述与本地最新实现不一致，以本地代码、SQLite 状态、日志和可重复测试为准，并在最终报告中说明差异。

---

## 2. 收尾问题矩阵

| ID | 级别 | 问题 | 发版要求 |
|---|---:|---|---|
| CL-01 | P0 | `safe_retry` 仍可能被 `STAGE_FAILED` 提前阻断 | 必须关闭 |
| CL-02 | P0 | 初始化失败时 `ready/initError` 渲染逻辑可能仍进入主界面 | 必须关闭 |
| CL-03 | P0 | 用户数据完整性仍主要依赖 ID/count，缺内容指纹 | 必须关闭 |
| CL-04 | P1 | 启动仍缺真实 StartupPhase + 动态进度条 | 必须关闭 |
| CL-05 | P1 | Batch 长 LLM 请求缺可靠 lease 心跳续租 | 必须关闭 |
| CL-06 | P1 | 批次预算不是 `used + upcoming <= cap` 的真实硬门禁 | 必须关闭 |
| CL-07 | P1 | Adoption 仍存在正文 / revision / batch counter 半提交窗口 | 必须关闭 |
| CL-08 | P1 | Backup Center 仍可能全量读取并解析所有备份 | 必须关闭 |
| CL-09 | P1 | Schema Recovery 存在重复大文件 IO | 必须关闭 |
| CL-10 | P2 | Foreground owner 若使用 module-global，存在跨 Task 污染 | 建议关闭 |
| CL-11 | P1 | 真机、真实模型、覆盖升级、Release APK 证据不足 | 必须关闭 |
| CL-12 | P2 | 远端 CI / release gate 缺少独立可核验结果 | 建议关闭 |

---

## 3. Phase 0：重新建立本地基线

执行并保存：

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -15 --oneline
git remote -v

npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
```

记录：

```text
versionName / versionCode
Schema version
Node / npm / Java
Test Suites / Tests / skipped / failed
```

若基线已有失败，先标明是否与本轮相关；禁止直接跳过失败测试进入修复。

---

# 4. CL-01：真正打通 safe_retry 生产链路

## 4.1 先验真

测试必须真实经过：

```text
LLMRequestError(safe_retry)
→ runStageAttempt
→ pipeline_stage_attempts.status=safe_to_retry
→ executeClaimedStage
→ checkpoint.status=failed
→ task 持久化失败态
→ 再次 reconcile
→ 自动重试
```

重点确认：

```text
determineNextPipelineAction 是否先返回 STAGE_FAILED
maybeAutoRetryStage / retry disposition 是否实际可达
```

### 禁止

- mock 整个 `runPipeline`；
- 手工把 checkpoint 留成 pending；
- 直接 SQL 写 `waiting_retry`；
- 只测试 batch action 函数。

## 4.2 推荐修复

把 retry disposition 放在失败终态之前：

```text
checkpoint=failed
→ latest attempt=safe_to_retry/rate_limit
    → 未到期：WAIT_RETRY
    → 到期且未超限：RESET_PENDING_AND_RETRY
    → 超限：MANUAL_PAUSE
→ outcome_unknown：MANUAL_CONFIRM
→ 其他：STAGE_FAILED
```

推荐抽纯函数：

```ts
determineRetryDisposition(...)
```

并让 `determineNextPipelineAction` 或 reconciler 在 `blocked(STAGE_FAILED)` 之前消费结果。

## 4.3 验收

覆盖：

- safe_retry；
- rate_limit；
- Retry-After；
- outcome_unknown 不自动重试；
- 最大重试次数；
- 强杀后到期恢复；
- 成功阶段不重跑；
- retry 使用同一 frozen request / request fingerprint。

---

# 5. CL-02：初始化失败必须真正进入安全页

不要再用源码正则证明正确，必须 render App。

建议建立明确状态：

```ts
type AppStartupState =
  | 'splash'
  | 'initializing'
  | 'ready'
  | 'failed';
```

失败时必须满足：

```text
startupState=failed
NavigationContainer 不渲染
TabNavigator 不渲染
项目空列表不渲染
```

错误页必须明确：

```text
本地资料暂时无法载入
错误码
原数据库未删除
请勿卸载 / 清除应用数据
恢复 / 重试 / 导出诊断入口
```

测试：

```text
mock openDatabase/initializeDatabase throw
→ render App
→ assert error screen visible
→ assert NavigationContainer absent
```

同时覆盖 SchemaRecoveryError、INIT_FAILED、backup failure、fingerprint mismatch。

---

# 6. CL-03：内容级 UserContentFingerprint

现有 ID/count 校验不能证明正文未被改写。本轮必须建立内容级 fingerprint。

至少覆盖：

### projects

```text
id + name + mode
```

### chapters

```text
id + project_id + position + title + synopsis + content + summary_json
```

### characters

人物关键内容字段全部纳入。

### worldbook_entries

```text
id + collection_id + title/name + content
```

### notes

```text
id + collection_id + title + content
```

以及：

```text
project_resources
project_collection_settings
```

推荐：

```text
stable sort
→ 明确 normalize
→ per-row SHA-256
→ table aggregate SHA-256
```

必须区分 `null`、空字符串、缺失字段、0、false。

### Fail-closed

任何关键表读取失败必须抛错，禁止：

```ts
catch { return emptySnapshot }
```

迁移契约：

```text
before fingerprint
→ safety backup
→ migration / repair
→ after fingerprint
→ strict compare
```

非白名单内容 mismatch：保留原 DB 与安全备份，禁止进入主界面。

---

# 7. CL-04：真实启动动态进度条

必须真正实现用户此前要求的系统载入动态进度。

建议阶段：

```ts
type StartupPhase =
  | 'opening_database'
  | 'checking_schema'
  | 'capturing_fingerprint'
  | 'creating_backup'
  | 'migrating'
  | 'validating_schema'
  | 'verifying_content'
  | 'loading_settings'
  | 'recovering_tasks'
  | 'ready'
  | 'failed';
```

进度对象：

```ts
interface StartupProgress {
  phase: StartupPhase;
  percent: number;
  message: string;
  detail?: string;
}
```

推荐权重：

| 阶段 | 进度 |
|---|---:|
| 打开数据库 | 0-10% |
| 检查结构 | 10-20% |
| 内容指纹 | 20-30% |
| 安全备份 | 30-50% |
| 数据迁移 | 50-70% |
| Schema 校验 | 70-80% |
| 内容核验 | 80-92% |
| 恢复任务 | 92-98% |
| Ready | 100% |

要求：

- 进度由服务层真实阶段 callback 驱动；
- 禁止随机 timer 假进度；
- Splash 可设置最短显示时间，但 init 未完成时不得隐藏成白屏；
- 启动全程必须存在可见 UI；
- 长时间阶段显示当前正在做什么。

---

# 8. CL-05：建立真正的 Batch LeaseSession

不能用“删除 heartbeat”代替解决 lease 竞态。

如果 TTL 为 60 秒，而单章 LLM Pipeline 可能运行 120～180 秒，则必须在长请求中续租。

推荐：

```ts
class BatchLeaseSession {
  owner: string;
  lost: boolean;
  start(): Promise<void>;
  renew(): Promise<void>;
  assertOwned(): void;
  stop(): Promise<void>;
}
```

必须满足：

- 只有 LeaseSession 写 lease；
- renew 串行化；
- 同一时间最多一个 CAS；
- 使用最新 rowVersion；
- CAS 失败立即 `lost=true`；
- lost 后不得开始新的 LLM 请求；
- `stop()` 等待 in-flight renew 完成；
- release 后绝不能重新 renew；
- 长请求按 TTL 的约 1/3～1/2 周期续租。

测试：

```text
120s 长请求
180s 长请求
第二 executor 抢占
renew CAS conflict
暂停时 renew 正在执行
stop/release 后禁止回写
```

---

# 9. CL-06：批次预算真正硬门禁

正确判断必须是：

```text
used + upcoming reservation <= hard cap
```

不能只是：

```text
used < cap
```

请求前至少判断：

```text
usedCalls + 1 <= maxLlmCalls
usedInput + estimatedInput <= maxInputTokens
usedOutput + reservedOutput <= maxOutputTokens
```

并且 `used_*` 必须反映当前已发生 attempts，不能等整章 Adoption 后才更新。

Agent 可根据本地结构选择：

### 方案 A

使用 batch usage ledger，attempt 终态实时入账；

### 方案 B

请求前直接按 `batch item runs → pipeline_stage_attempts` 聚合当前真实用量。

前提都是：

- 幂等；
- 跨 Task / 跨 run；
- outcome_unknown 按已占用处理；
- budget check 与 request claim 位于同一所有权边界。

---

# 10. CL-07：Adoption 原子化

以下数据写入必须形成单事务或等价原子闭环：

```text
旧正文 revision
chapter.content
pipeline revision
item.adoptionFingerprint
item.adoptedRevisionId
batch.completedCount/currentOrdinal
pipeline task resolved 状态
```

若 Store 不能进事务：SQLite 为主事实源，事务提交后再刷新 Store。

Story Memory 建议使用幂等 outbox：

```text
adoption transaction
→ outbox(mark_story_memory_dirty)
→ commit
→ async consume
```

必须做崩溃注入：

```text
旧 revision 前/后
chapter update 后
pipeline revision 后
fingerprint 后
counter 后
task resolve 前/后
```

每个点恢复后核对正文、revision 数量、adoptedRevisionId、fingerprint、completedCount、currentOrdinal、task status。

---

# 11. CL-08：Backup Center 轻量索引

列表页禁止完整读每个备份 JSON。

实现 sidecar：

```text
backup_xxx.json
backup_xxx.meta.json
```

meta 至少包含：

```json
{
  "formatVersion": 1,
  "kind": "manual",
  "appVersion": "2.11.34",
  "schemaVersion": 42,
  "createdAt": "...",
  "size": 0,
  "checksum": "...",
  "validationState": "created"
}
```

`listBackups()` 只允许：

```text
readDir
stat
read small meta
```

禁止：

```text
read complete backup.json
JSON.parse complete backup.json
```

旧备份没有 sidecar 时：先用 filename / mtime / size 立即显示，再后台逐个建立 meta。

性能验收：

```text
10 × 100MB
30 × 20MB
Backup Center 首屏 P95 < 500ms
```

---

# 12. CL-09：Schema Recovery 去重复 IO

避免：

```text
createBackup
→ cleanup/list 全量读
→ readAndValidateBackup 再完整读
→ copyFile
```

推荐专用 recovery writer：

```text
serialize/write
→ 同时计算 checksum + row counts
→ close/fsync
→ atomic rename
→ return verified metadata
```

直接写入 schema recovery 目录，不先写普通 backup 再复制。

但不得降低安全标准：仍需 checksum、core row count、schema metadata 和可恢复性验证。

---

# 13. CL-10：Foreground owner 改为调用级状态

若当前仍使用：

```ts
let activeForegroundOwner
```

必须改为：

```ts
options.foregroundOwner
```

所有：

```text
start
updateProgress
notifyComplete
notifyFailed
stop
```

均显式读取当前 Task 的 options。

测试普通单章 Task A 与 Batch Task B 并发，确认互不污染。

---

# 14. 测试建设要求

本轮核心测试必须是**行为测试**。

源码正则测试可以保留为结构守卫，但不能作为主要验真证据。

必须增加：

### Startup

- App 真 render；
- init success；
- init failure；
- StartupPhase；
- Navigation gate。

### Migration

- 真实 SQLite fixture；
- breaking migration；
- before/after content fingerprint；
- single migration owner。

### Batch

- 真实 `reconcilePipelineTask`；
- 真实 `executeClaimedStage`；
- safe_retry checkpoint lifecycle；
- 长请求 lease；
- hard budget；
- adoption crash matrix。

### Backup

统计 RNFS `readFile` 调用，列表阶段完整 backup 文件读取次数必须为 0。

---

# 15. 历史版本覆盖升级

至少执行：

```text
V2.11.24 → V2.11.34+
V2.11.32 → V2.11.34+
V2.11.33 → V2.11.34+
```

每条路径：

1. 安装旧版；
2. 准备大型真实测试数据；
3. 保存原始 DB；
4. 生成 before fingerprint；
5. `adb install -r` 覆盖升级；
6. 全程录屏 + logcat；
7. 等待启动进度 100%；
8. 导出 after DB；
9. 比较 fingerprint；
10. 打开 Backup Center；
11. 抽查项目、章节、人物、世界书、笔记；
12. 再冷启动一次。

任意不可解释的内容 hash mismatch：**直接禁止发版。**

---

# 16. AI 写 N 章真机矩阵

至少：

| ID | 场景 |
|---|---|
| N01 | 新项目连续生成 3 章 |
| N02 | 旧项目连续生成 3 章 |
| N03 | safe_retry |
| N04 | 429 + Retry-After |
| N05 | outcome_unknown |
| N06 | 用户暂停 / 恢复 |
| N07 | 请求期间强杀 |
| N08 | 冷启动续跑 |
| N09 | 120s+ 长请求 lease |
| N10 | 批次预算不足 |
| N11 | 项目尾部变化 |
| N12 | Adoption 崩溃恢复 |
| N13 | 前后台切换 |
| N14 | 锁屏恢复 |
| N15 | 普通单章与 Batch 并发 |
| N16 | Feature Flag OFF 回归 |

核对 SQLite：

```text
chapters
content_revisions
pipeline_tasks
pipeline_stage_checkpoints
pipeline_stage_attempts
multi_chapter_batches
multi_chapter_batch_items
multi_chapter_batch_item_runs
usage
lease
```

---

# 17. Release 工程门禁

最终执行：

```bash
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
```

然后：

```text
Debug APK build
Release APK build
签名校验
fresh install
adb install -r 覆盖安装
```

正式 Release 必须提升到：

```text
V2.11.34 或更高
```

不得继续复用 V2.11.33。

若仓库已有 GitHub Actions，推送后必须记录 commit SHA 与 workflow 结果；若没有，建议至少建立 lint + typecheck + verify:version + test:ci 的最小远端 gate。

---

# 18. 建议提交拆分

```text
fix(pipeline): make safe retry reachable from failed checkpoints
test(pipeline): cover real safe-retry checkpoint lifecycle

fix(startup): use explicit startup failure state
feat(startup): add real initialization progress phases
test(startup): render startup failure and progress states

fix(database): add fail-closed user content fingerprints
test(database): verify covered-upgrade content hashes

fix(batch): add serialized lease session for long pipeline runs
test(batch): cover long-running lease ownership

fix(batch): enforce real-time hard budget reservation
test(batch): cover upcoming-request budget overflow

fix(batch): make adoption transactionally crash-safe
test(batch): add adoption crash injection matrix

perf(backup): add backup metadata sidecars
perf(backup): remove duplicate schema recovery IO
test(backup): enforce zero full-read listing

fix(pipeline): remove global foreground ownership state

test(release): add covered-upgrade and device QA evidence
chore(release): bump V2.11.34
```

---

# 19. 最终发版门禁

## P0 必须全部关闭

- [ ] safe_retry 真实生产状态链通过；
- [ ] 初始化失败绝不进入普通主界面；
- [ ] 内容级 fingerprint 已启用；
- [ ] fingerprint mismatch 会阻断升级进入主界面。

## P1 必须全部关闭

- [ ] 启动动态进度由真实阶段驱动；
- [ ] 全程无白屏空 Fragment；
- [ ] 长请求 lease 不过期；
- [ ] lease lost 后 fail-closed；
- [ ] 批次预算是真实硬门禁；
- [ ] Adoption 原子闭环；
- [ ] Backup Center 列表零完整 JSON 读取；
- [ ] Schema Recovery 无重复大文件 IO；
- [ ] 三个历史版本覆盖升级通过；
- [ ] AI 写 N 章真机矩阵通过；
- [ ] Release APK 构建 / 签名 / 覆盖安装通过；
- [ ] 版本号已提升。

## P2

- [ ] Foreground owner 无全局并发污染；
- [ ] 远端 CI 或等价质量 gate 可核验。

---

# 20. Agent 最终审计报告

完成后生成：

```text
docs/release-audit/V2.11.34-final-release-closure-audit.md
```

必须包含：

1. 修复前 / 后 HEAD；
2. 工作区状态；
3. CL-01～CL-12 每项验真结论；
4. 修复前失败测试；
5. 根因；
6. 修改文件；
7. Schema / migration 变化；
8. 自动化测试真实结果；
9. 启动阶段耗时；
10. 内容 fingerprint 结果；
11. Backup Center 性能；
12. 历史版本覆盖升级；
13. AI 写 N 章真机矩阵；
14. Release APK 信息；
15. CI 结果；
16. 未解决风险；
17. 最终结论。

最终结论只允许：

```text
A. 允许公开发版
B. 仅允许内部 RC / 灰度
C. 禁止发版
```

规则：

```text
任意 P0 未关闭 → 必须 C
P0 全关但缺真机 / Release / 覆盖升级证据 → 最多 B
全部门禁通过 → 才允许 A
```

---

# 21. 可直接交给 Agent 的总指令

```text
请执行 Tavo Mini 发版前最后一轮收尾修复。

项目目录：
D:\AiWorkSpace\tavo-mini

先完整阅读 docs/optimization 下最新的“V2.11.34 发版前收尾修复方案”。

要求：
1. 以当前本地代码为唯一事实来源；
2. 先记录 Git / 版本 / Schema / 测试基线；
3. CL-01～CL-12 逐项重新验真，不直接相信历史审计和提交说明；
4. 每个确认问题先写真实生产路径失败测试；
5. 禁止 mock 掉关键 checkpoint / lease / adoption / budget 状态转换；
6. 禁止用源码正则测试代替行为测试；
7. 只做最小修复，不扩散到无关模块；
8. 不覆盖未提交改动，不 reset，不全仓格式化；
9. 每修一项跑定向测试；
10. 全部修复后跑完整回归；
11. 完成 V2.11.24 / V2.11.32 / V2.11.33 覆盖升级；
12. 完成 AI 写 N 章真机矩阵；
13. 完成 Release APK 构建、签名和覆盖安装；
14. 升级前后必须执行内容级 fingerprint；
15. 任意 P0 未关闭，禁止发布；
16. 最终输出 docs/release-audit/V2.11.34-final-release-closure-audit.md；
17. 最终结论只能是 A / B / C。

如果方案与当前本地实现存在差异，以本地代码、真实 SQLite 状态、真实测试和真机证据为准，并在审计报告中记录差异。
```
