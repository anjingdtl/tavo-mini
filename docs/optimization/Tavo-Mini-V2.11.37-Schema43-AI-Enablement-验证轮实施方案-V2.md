# Tavo Mini — AI 写 N 章正式 Enablement 验证轮实施方案 V2（Schema 43 基线）

> 适用基线：远端 `anjingdtl/tavo-mini` 当前 `main` 最新审计 HEAD  
> `e47fa2d4ac24ad48b78a416c41c7e25c6782a130`
>
> 当前应用版本标识仍为 `V2.11.37 / 2113700`，但数据库已经演进到 `Schema 43`。
>
> 本轮目标：**先关闭 Schema43 迁移兼容边界，再完成 AI 写 N 章的正式 Enablement 验证。只有全部 Gate 达到 A，最后一笔 production commit 才允许默认开启 AI 写 N 章。**
>
> 最高原则：**当前本地生产代码、真实 SQLite、自动测试、Android 设备和真实 HTTP 行为优先于本文、远端 commit message、历史审计和代码注释。**

---

# 0. 当前远端事实

当前远端最新审计基线：

- Repo：`anjingdtl/tavo-mini`
- Branch：`main`
- HEAD：`e47fa2d4ac24ad48b78a416c41c7e25c6782a130`
- versionName：`V2.11.37`
- versionCode：`2113700`
- SCHEMA_VERSION：`43`
- MIN_COMPATIBLE_SCHEMA_VERSION：`3`
- `multi_chapter_batch_enabled`：当前仍为显式 `true` 才开启，缺省 OFF
- `elastic_budget_v2_enabled`：独立实验开关，继续 OFF-by-default

最新新增 Schema43 迁移：

```sql
UPDATE project_story_memory_policy
SET interval_chapters = 10
WHERE mode = 'smart';
```

它会把所有旧 `smart` policy 的 2～9 章间隔全部改成 10。

当前 Story Memory UI 中，`smart` 和 `fixed` 两种模式都允许用户手工编辑“固定间隔”，因此旧的 `smart/5`、`smart/7` 等**可能是用户明确配置，而不只是旧默认值**。

同时历史代码的产品变更事实是：

```text
旧默认 smart interval = 3
新默认 smart interval = 10
```

并曾明确表达“新 policy 使用 10，已有用户配置保留”。

因此 Schema43 当前迁移属于本轮第一个必须验真的 **P2 用户配置兼容问题**。

---

# 1. Release identity 现状

V2.11.37 的 release bump 发生在 Schema43 提交之前。

因此仓库历史中已经存在：

```text
V2.11.37 / 2113700 + Schema42
```

以及当前代码：

```text
V2.11.37 / 2113700 + Schema43
```

两个不同生产行为却使用相同版本标识。

这不等于数据库已经损坏，但意味着：

> **最终 Enablement Candidate 绝不能继续使用 V2.11.37 / 2113700。**

如果本轮有任何 production code/migration/flag/UI 变化，最终正式候选至少应：

```text
V2.11.38
versionCode = 2113800
```

如果执行时本地已经高于该版本，则使用下一个合理版本，禁止回退版本号。

版本 bump 必须放在所有代码收口之后，一次完成。

---

# 2. 执行起点：本地仓库才是唯一事实

本地项目：

```text
F:\ClaudeWorkSpace\projects\TAVO-MINI
```

执行开始先记录：

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git fetch --all --prune
git rev-parse origin/main
git log -12 --oneline --decorate
git diff --stat HEAD..origin/main
git diff --stat origin/main..HEAD
```

同时记录：

- versionName
- versionCode
- SCHEMA_VERSION
- MIN_COMPATIBLE_SCHEMA_VERSION
- Node / npm / Java
- 当前未提交修改
- Feature Flag 当前语义
- CI workflow
- 当前 migration chain

如果本地已经比远端更新：

> 以本地最新生产代码为准，不机械回退到本计划所描述的实现。

---

# 3. 工作区安全边界

严禁：

```bash
git reset --hard
git clean -fd
git clean -fdx
git checkout -- .
git restore .
```

不得：

- 清空用户数据库；
- 删除 App data；
- 为了“验证升级”先卸载旧 App；
- 删除旧 task / attempt / revision；
- 覆盖用户未提交文件；
- 擅自 stash/drop 用户修改。

如果本地工作区不干净：

1. 记录；
2. 识别本轮相关与无关修改；
3. 避开用户修改；
4. 只做最小范围变更。

---

# 4. 本轮边界

允许修改：

- Schema43 Story Memory migration（仅当真实证据证明边界有误）
- Story Memory 与 AI Batch 的直接交界
- AI 写 N 章 Feature Flag
- AI 写 N 章 Settings / navigation / entry
- MultiChapterBatchScreen
- multiChapterBatchStore
- multiChapterBatch state machine / repository / service
- 与 Batch resume/retry 直接相关的 Pipeline 代码
- 本轮测试
- release audit
- 最终版本文件

禁止扩大到：

- 整体 Pipeline 重构；
- 整体 Story Memory 重写；
- continuation 架构；
- Canon；
- Backup 格式；
- TTS；
- import；
- React Native / SQLite / Zustand 大版本升级；
- 全局 UI 重构；
- 全量 lint cleanup；
- `npm audit fix --force`；
- 把 Batch 最大章节数提高到 10 以上；
- 改最近原始全文最多 10 章；
- 改 Story Memory 默认 10 章 trigger；
- 把 Story Memory 单次 LLM batch 从 3 改成 10；
- 自动开启 elastic budget v2。

发现 unrelated P2/P3：

> 写入 Remaining Risks，不顺手修。

只有直接阻断 Enablement 的 P0/P1 才允许最小修复。

---

# 5. AE-00：先建立完整基线

执行：

```bash
npm ci
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
```

记录真实：

- suites passed / skipped / failed
- tests passed / skipped / failed
- lint errors / warnings
- typecheck
- version check

再构建：

```bash
cd android
./gradlew assembleDebug --no-daemon
```

如果基线出现以下任一：

- migration failure；
- 用户内容 fingerprint mismatch；
- Frozen Context loss；
- duplicate chapter；
- duplicate revision；
- duplicate billing；
- Adoption mismatch；
- Story Memory 错误假 clean；
- safe_retry/outcome_unknown 分类错误；

暂停 Enablement。

---

# 6. AE-01：Schema43 迁移语义必须先收口

这是新版计划新增的最高优先级前置 Gate。

## 6.1 先验证历史事实

不要直接修改 SQL。

先通过本地 git history、旧代码、UI 和真实 DB fixture 证明：

1. Schema42 以前 Smart 的默认 interval 到底是多少；
2. 用户是否能手动修改 smart interval；
3. 是否存在能识别“系统旧默认”与“用户手工修改”的 provenance 字段；
4. `updated_at` 是否足够可靠用于区分；
5. 是否有历史版本曾把 smart 默认设置为 2/4/5/...；
6. 是否有 migration 已经写过来源标识。

如果没有可靠 provenance，而旧默认明确为 3：

推荐迁移语义：

```sql
UPDATE project_story_memory_policy
SET interval_chapters = 10
WHERE mode = 'smart'
  AND interval_chapters = 3;
```

而不是：

```sql
WHERE mode = 'smart'
```

原因：

```text
smart/3 可能是旧系统默认
smart/5、smart/7 等可能是用户明确选择
```

“默认改成 10”不等于“覆盖所有用户当前 Smart 配置”。

如果本地证据证明所有 smart 2～9 都从未能被用户配置，才允许保留当前全量迁移。

---

## 6.2 Schema43 必须新增/修订迁移矩阵

至少：

```text
M1 old-default smart/3  → smart/10
M2 custom smart/5       → smart/5
M3 custom smart/7       → smart/7
M4 smart/10             → smart/10
M5 fixed/3              → fixed/3
M6 fixed/7              → fixed/7
M7 manual               → unchanged
M8 every_chapter        → unchanged
M9 no policy            → no row created
M10 migration rerun     → idempotent
M11 post-upgrade smart/5 user edit survives reload
```

如果本地能证明其他旧默认值，也增加对应 case。

必须使用：

```text
真实 sql.js SQLite
+
真实 initializeDatabase migration chain
```

不得只检查 SQL 字符串。

---

## 6.3 数据安全断言

Schema42 → 43 前后必须保持：

- projects 行数/content
- chapters id/title/content/status/finalized_at
- outlines
- characters
- worldbook
- notes
- pipeline_tasks
- pipeline_stage_checkpoints
- pipeline_stage_attempts
- content_revisions
- batch / batch_items
- LLM configs
- backups metadata

除 Story Memory policy 的**允许字段**外不得漂移。

---

# 7. AE-02：Migration 升级链重新定义

由于当前目标 Schema 已经是 43，本轮升级矩阵必须重新跑。

最低覆盖：

### U1：Schema42 → Schema43

对应近期 V2.11.36 / V2.11.37-Schema42 用户。

验证：

- migration 正常；
- policy 兼容；
- content fingerprint MATCH。

### U2：精确 V2.11.37 Schema42 → 最终 Candidate Schema43

这是这次最关键的版本身份验证。

因为历史已经存在同版本号 Schema42 产物。

使用真实旧 APK：

```text
V2.11.37 release APK（Schema42）
→ 创建/保留真实数据
→ adb install -r 最终 Candidate
→ 冷启动
→ Schema43
```

不得通过卸载重装代替。

### U3：V2.11.24 / Schema40 → 最终 Candidate Schema43

复用之前的精确老用户升级 cohort：

```text
Schema40 → 41 → 42 → 43
```

必须：

- before/after fingerprint；
- 内容逐字节一致；
- migration recovery metadata 记录正确 source schema；
- Story Memory policy 符合收口后的迁移规则。

---

# 8. AE-03：V2.11.37 Story Memory partial-success 再验证

真实 SQLite：

```text
empty
→ pending 6 chapters
→ batch1(3章) success
→ batch1 checkpoint durable clean
→ batch2 failure
```

必须：

- DB status=clean；
- through=batch1 end；
- lastError=batch2 error；
- checkpoint usable；
- retry 只从 batch2 开始；
- batch1 不重复调用；
- generation/preview 仍能注入成功 checkpoint；
- dirty rebuild failure 不伪造 clean。

---

# 9. AE-04：验证 finalizeChapterMemory 返回态 P2 候选

必须通过真实：

```text
finalizeChapterMemory()
→ checkpoint batch1 success
→ batch2 failure
```

比较：

- persisted DB state
- function returned state
- returned patchId
- returned pendingCount
- UI/caller immediately displayed state

如果出现：

```text
DB through = 2
returned state through = -1
```

则只允许最小修：

- catch 后读取 latest persisted row；
- 返回 latest.state；
- patchId 从 latest.state 获取；
- pendingCount 按 latest through 重新计算或使用真实剩余量；
- dirty 语义不变。

禁止借机重写 Story Memory。

不能复现则：

```text
already correct / no code change required
```

---

# 10. AE-05：锁死 10章 / 3章 / raw 10章

必须继续保证：

```text
Smart 默认 trigger interval = 10
Story Memory 单次 LLM checkpoint batch = 3
Sliding raw chapter hard cap = 10
```

测试：

```text
recentChapterCount:
1
10
100
NaN
Infinity
-Infinity
非法 persisted 字符串/数字
```

sliding 模式最多 10 章 raw full text。

即使 context window = 1M，也不得把几十/上百章 raw 全量载入。

---

# 11. AE-06：AI 写 N 章 Feature Flag 正式语义

**此阶段仍不要改默认 ON。**

先测试当前 gate。

最终正式开放时目标：

```text
setting missing → ON
setting='true'  → ON
setting='false' → OFF
```

其中：

> `false` 是用户明确选择，必须长期保留。

不得通过 migration：

```sql
UPDATE settings SET value='true'
```

覆盖用户选择。

`elastic_budget_v2_enabled` 必须继续独立。

---

# 12. AE-07：产品入口正式化

只有 Enablement Gate 接近完成时再做。

AI 写 N 章通过后：

- 从“实验功能”风险文案迁出；
- 成为正式 AI 能力；
- Settings 仍提供用户总开关；
- 大纲模式主路径可发现；
- continuation 不出现；
- 页面内部继续二次检查 flag / project mode；
- deep link / stale navigation 不能绕过；
- elastic budget 仍保留“实验功能”。

不要重做整个 Settings UI。

---

# 13. AE-08：Batch Preflight

第一个付费章节请求之前必须验证：

1. project exists；
2. mode=outline；
3. outline 状态合法；
4. active LLM config 可用；
5. context window 合法；
6. N 在 1～10；
7. target words 合法；
8. planner output count=N；
9. 无冲突 active batch；
10. project tail anchor 一致；
11. hard budget 可计算；
12. background permission 状态真实；
13. elastic budget OFF 不阻止 Batch。

Preflight failure：

```text
LLM chapter call count = 0
```

---

# 14. AE-09：每章 Frozen Context / 串行承接

必须验证：

```text
Chapter1:
compile context A
→ pipeline
→ adoption

Chapter2:
compile NEW context B
→ B 可以看到 Chapter1 adoption 后正文/记忆
→ pipeline
→ adoption

Chapter3:
compile NEW context C
→ C 可承接 Chapter1/2
```

但同一个 task 内：

```text
draft
review
factCheck
proof
resume
```

必须一直复用同一 Frozen Context。

断言：

- taskId per chapter 不同；
- frozen context hash per chapter 可不同；
- 同一 task resume 前后 hash 不变；
- 成功 stage 不重复请求；
- 运行中编辑大纲/资料不改变已启动 task；
- 下一章尚未启动前，合法项目变化按当前设计处理；
- tail drift 触发 pause，不静默错位写章。

---

# 15. AE-10：真实 LLM 正常矩阵

最低：

| Case | 项目 | N | Pipeline |
|---|---|---:|---|
| N01 | 新大纲项目 | 1 | draft_only |
| N02 | 新大纲项目 | 3 | full |
| N03 | 10+章 | 3 | full |
| N04 | 20+章 | 5 | fast/full |
| N05 | 100+章长篇 | 3 | full |
| N06 | 长篇 | 10 | full 或成本可控合法模式 |

每个 Case 记录：

- batchId
- itemId
- taskId
- checkpoints
- attempts
- request fingerprint
- frozen context hash
- calls
- input/output tokens
- adoptedRevisionId
- revision id
- final chapter body
- Story Memory through/status

禁止记录 API Key / Authorization。

---

# 16. AE-11：真实 UI Pause → Resume

必须真正通过 Android UI：

```text
running
→ 点击暂停
→ paused_user / interrupted
→ 已成功 stage 保留
→ 用户从稳定入口点击继续
→ same task
→ same frozen context
→ only interrupted/failed stage
→ completed
→ adoption
→ batch continues
```

要求：

- 不是 cancel；
- 不是“终止全部”；
- 不是手工 SQL；
- pause 后不再启动新 chapter request；
- resume 后不重跑成功 stage；
- token 不重复计费。

若 Android Alert 按钮限制导致“继续”不可见：

只最小修 paused 恢复入口，不重构 Dialog 系统。

---

# 17. AE-12：Device-level safe_retry 自动闭环

本地 OpenAI-compatible fault gateway：

```text
HTTP #1:
503
Retry-After: 1

HTTP #2:
200 valid response
```

**用户不进行任何人工点击。**

必须发生：

```text
503
→ attempt=safe_to_retry
→ failure_class=safe_retry
→ next_retry_at persisted
→ retry due
→ reconcile/watchdog 自动驱动
→ SAME frozen request/fingerprint
→ HTTP #2
→ success
→ adoption / next chapter
```

断言：

- 仅新增一个 retry attempt；
- succeeded stage 不重跑；
- frozen request 一致；
- batch 不进入 outcome_unknown 人工确认。

另外制造：

```text
connection drop / uncertain timeout
```

必须：

```text
failure_class=outcome_unknown
next_retry_at=NULL
NO automatic retry
需要用户确认
```

---

# 18. AE-13：Force-stop / Cold-start / Resume

至少：

## K1 draft running force-stop

按当前安全语义：

- frozen context 保留；
- interrupted 正确；
- 若不可安全判断是否已执行，不静默重试；
- 不双扣费。

## K2 review/factCheck/proof running force-stop

必须设备端完整：

```text
successful checkpoints
→ am force-stop
→ cold start
→ interrupted
→ user resume
→ only interrupted stage
→ completed
→ adoption
```

本轮必须尽量拿到最终 `completed`，不能只停在“恢复成功但后续又网络失败”。

---

# 19. AE-14：Budget / Quota / Drift / Lease

必须覆盖：

### Context budget

mandatory over budget：

```text
HTTP count = 0
paused_context_budget
```

### Batch hard budget

始终：

```text
durable used + upcoming <= cap
```

不得先请求再暂停。

### 429 / quota

区分：

- rate-limit safe retry；
- account quota hard block。

### Project changed

tail drift：

```text
paused_project_changed
```

不得错误 adoption。

### Lease

覆盖：

- second coordinator
- heartbeat
- expiry
- rowVersion CAS loss

不得双执行同一个 batch。

---

# 20. AE-15：Atomic Adoption / Crash consistency

每一章：

```text
pipeline completed
→ adoption transaction
→ chapter body
→ pipeline revision
→ adoptedRevisionId
→ batch item/counters
→ durable task resolved
→ Story Memory durable intent/outbox
```

必须：

```text
item.adoptedRevisionId
==
content_revisions.id
where source='pipeline'
and source_ref=taskId
```

Crash points：

1. revision insert 前；
2. transaction commit 前；
3. commit 后 / outbox consume 前；
4. task resolve durable side effect 边界；
5. Story Memory dirty consume 前。

冷启动：

- 不重复 revision；
- 不重复章节；
- task 最终 resolved；
- outbox 可重放；
- Story Memory 不永久假 clean。

---

# 21. AE-16：Story Memory × Batch 专项

## M1 clean checkpoint + N=3

- 正常 adoption；
- raw/episodic 不重复污染；
- checkpoint usable。

## M2 第10章 trigger

trigger = 10；

memory LLM 内部仍：

```text
3 + 3 + 3 + 1
```

或当前等价的最多 3 章切批。

## M3 partial checkpoint failure

```text
memory batch1 success
memory batch2 failure
```

AI 写 N 章后续：

- 已成功 checkpoint 仍 usable；
- 不重复 batch1；
- 不因 status 错写而丢长期记忆。

## M4 dirty

编辑 covered old chapter：

- dirty 正确；
- stale checkpoint 不注入；
- rebuild failure 不假 clean；
- Batch 要么合法 fallback，要么明确 block。

---

# 22. AE-17：Flag + Upgrade 兼容矩阵

最终 candidate 必须验证：

| 安装来源 | multi flag | 期望 |
|---|---|---|
| fresh | missing | ON |
| old release | missing | ON |
| old release | true | ON |
| old release | false | OFF |

同时 Story Memory policy：

| Schema42 policy | Schema43 candidate |
|---|---|
| old default smart/3 | smart/10 |
| user custom smart/5 | 保持 5 |
| user custom smart/7 | 保持 7 |
| fixed/3 | 保持 3 |
| manual | 保持 |
| no row | 不提前创建 |

如果本地证据证明迁移语义不同，必须在 audit 中写出证据与理由。

---

# 23. AE-18：正式开启顺序

禁止提前默认 ON。

正确顺序：

### Phase A

Schema43 migration semantics 收口。

### Phase B

所有自动测试和 device matrix。

### Phase C

产品入口从实验功能迁出。

### Phase D

构建最终 candidate、升级测试、签名、CI。

### Phase E — 最后一笔 production change

只有全部达到 A：

```text
missing → ON
true → ON
false → OFF
```

才提交 default ON。

如果任何核心设备证据缺失：

> 保持 missing→OFF。

---

# 24. 最终版本要求

因为当前 V2.11.37 release 身份已经早于 Schema43 production code：

> 最终 candidate 必须新版本。

若本地尚未有更高版本：

```text
V2.11.38
versionCode 2113800
```

同步：

- `src/constants/version.json`
- `package.json`
- `package-lock.json`
- README
- CHANGELOG
- Android build metadata
- 项目当前 verify:version 所要求的全部来源

执行：

```bash
npm run verify:version
```

禁止继续发布另一份 `V2.11.37 / 2113700` APK。

---

# 25. 最终 Release Gate

执行：

```bash
npm ci
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
```

重点明确列出：

- Schema42→43 migration
- Schema40→43 chain
- F3 Frozen Context resume
- CL01 safe_retry real chain
- batch state machine/fault matrix
- atomic adoption
- outbox/durable close loop
- Story Memory partial success
- smart cadence 10
- LLM memory batch 3
- sliding raw cap 10
- Enablement flag compatibility
- pause/resume
- safe_retry/outcome_unknown contracts

Android：

```bash
cd android
./gradlew assembleDebug --no-daemon
./gradlew assembleRelease --no-daemon
```

验签：

```bash
apksigner verify --print-certs <release.apk>
```

记录：

- final APK filename
- size
- SHA-256
- signer cert SHA-256

---

# 26. GitHub Actions Gate

最终 **production HEAD** 必须真正有：

```text
JavaScript validation = success
Android Debug build = success
Migration matrix = success
```

当前远端 latest commit message 声称 full CI 2602 pass，但本轮最终审计不得只引用 commit message。

必须记录：

- final production SHA
- workflow run id
- job ids
- conclusions

如果 connector/CLI 无法确认：

> 不得写“GitHub CI 已验证全绿”。

---

# 27. npm audit 边界

如 `npm ci` 提示 vulnerabilities：

```bash
npm audit --json
```

分类：

- production reachable
- dev-only
- build-only
- transitive

不得直接：

```bash
npm audit fix --force
```

除非证明是本轮直接 P0/P1 blocker。

---

# 28. 最终判级

## D — 禁止开放

任一：

- 数据丢失；
- migration 覆盖用户明确配置且无法安全修正；
- duplicate chapter/revision/adoption；
- succeeded stage 重跑/重复收费；
- frozen context loss；
- outcome_unknown 自动重试；
- Story Memory 假 clean；
- lease 双执行；
- upgrade fingerprint mismatch。

结果：

```text
AI 写 N 章 default OFF
```

## C — 仅内部 RC

代码基本可用，但：

- migration 证据不足；
- CI 不全；
- Release/signing 不全；
- exact upgrade 不全。

## B — Core 可发，AI 继续 opt-in

自动化通过，但任一缺失：

- 真 UI pause→resume；
- 503 无人工 safe_retry；
- force-stop→resume→completed；
- N=3/5/10 real LLM；
- signed candidate；
- final HEAD CI。

结果：

```text
AI 写 N 章仍 missing→OFF
用户可主动开启
```

## A — 正式 Enablement

全部满足：

- Schema43 migration 尊重用户配置；
- Schema40/42 upgrade；
- automatic tests；
- Frozen Context；
- billing；
- adoption；
- Story Memory；
- raw 10章；
- memory batch 3；
- safe_retry；
- outcome_unknown；
- pause/resume；
- kill/resume；
- real LLM N matrix；
- signed Release；
- final production HEAD CI green。

才允许：

```text
missing → ON
explicit true → ON
explicit false → OFF
```

---

# 29. 最终审计报告

生成：

```text
docs/release-audit/<final-version>-ai-n-chapter-enablement-audit.md
```

必须包含：

1. start local HEAD
2. origin/main HEAD
3. worktree
4. version before/after
5. schema before/after
6. Schema43 migration semantic decision
7. smart/3 / smart/5 / smart/7 upgrade evidence
8. content fingerprints
9. Feature Flag matrix
10. Frozen Context
11. pause/resume
12. safe_retry
13. outcome_unknown
14. kill/resume
15. N=1/3/5/10 real LLM
16. Adoption
17. Story Memory×Batch
18. exact V2.11.37 Schema42 → candidate
19. V2.11.24 Schema40 → candidate
20. APK SHA-256
21. signer
22. final production SHA
23. GitHub Actions
24. Remaining Risks
25. A/B/C/D

---

# 30. Agent 执行纪律

所有“已关闭”结论必须能回答：

```text
哪条 production path？
哪张 SQLite table？
哪个 batchId/taskId？
before/after 值是什么？
HTTP 调用了几次？
哪个 stage 被重跑？
token 增量在哪？
Frozen Context hash 是否一致？
adoptedRevisionId 对应哪条 revision？
Story Memory through 到哪？
migration 改了哪些 policy？
final CI 对应哪个 SHA？
```

不能回答的：

> 不得标记 closed。

---

# 31. 一句话原则

> **先保护用户已有数据和配置，再证明批量写章在失败、暂停、强杀和重试情况下不会重复花钱、不会丢上下文、不会重复写章、不会污染 Story Memory；全部成立后，最后一笔提交才默认开启 AI 写 N 章。**
