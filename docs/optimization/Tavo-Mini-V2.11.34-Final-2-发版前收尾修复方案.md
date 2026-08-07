# Tavo Mini V2.11.34 Final-2 发版前收尾修复方案

> 项目：Tavo Mini / ShineWriter  
> 项目目录：`D:\\AiWorkSpace\\tavo-mini`（若本地实际路径不同，以本地仓库实际路径为准）  
> 适用版本：当前 V2.11.34 RC  
> 文档定位：**最后一轮发版收口，仅修复当前已确认的剩余工程缺口，不扩散功能、不重做已关闭项。**

---

## 1. 本轮目标

当前 V2.11.34 已完成 safe_retry 真实生产链、初始化失败安全状态机、内容级指纹、真实 StartupPhase、BatchLeaseSession、实时硬预算、Adoption 单事务主体、Backup sidecar、Schema Recovery 去重复 IO、Foreground owner 调用级隔离、Release APK/签名/覆盖安装等建设。

当前状态应视为：

```text
高质量 RC ≠ 最终公开 Release
```

本轮只关闭以下 Final-2 项目：

| ID | 优先级 | 问题 |
|---|---:|---|
| F2-01 | P1 | Atomic Adoption 的 `adoptedRevisionId` 没有可靠写入 batch item |
| F2-02 | P1 | Adoption 后 task resolve / Story Memory 仍在事务外，存在 crash window |
| F2-03 | P1 | UserContentFingerprint 在迁移新增列场景下可能丢失 row-key 关联 |
| F2-04 | P1/P2 | Schema Recovery backup metadata 使用目标 Schema，而非源 DB Schema |
| F2-05 | P2 | legacy backup sidecar backfill 并发过高，deleteBackup 不清理 sidecar |
| F2-06 | P1 | V2.11.24 → 当前版真实覆盖升级证据仍缺失 |
| F2-07 | P1 | AI 写 N 章真实模型真机矩阵仍缺 N01/N02/N06/N07/N08 |
| F2-08 | P2 | 远端没有最小 CI release gate |

---

## 2. 执行总原则

1. **当前本地代码是唯一事实来源**。
2. 先记录 branch、HEAD、worktree、版本、Schema、测试基线。
3. 不直接相信本方案、上一轮审计或提交说明。
4. F2-01～F2-08 每项先在本地重新验真。
5. 每个确认存在的问题先补充失败测试。
6. 测试必须走真实 SQLite / Repository / 状态转换路径。
7. 禁止源码正则作为核心验收。
8. 禁止手工 SQL 直接伪造“最终已修复状态”。
9. 禁止 mock 掉本问题真正需要验证的边界。
10. 修改必须最小、可回滚。
11. 不做全仓重构、无关依赖升级、无关格式化。
12. 保留现有未提交改动。
13. 禁止 `git reset --hard`、`git clean -fd`。
14. 每项独立测试、独立提交。
15. 完成后重新跑全量回归、覆盖升级、真机和 Release Gate。

---

## 3. Phase 0：重新建立本轮基线

执行并记录：

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -15 --oneline
git remote -v
```

记录：`versionName`、`versionCode`、`SCHEMA_VERSION`、`MIN_COMPATIBLE_SCHEMA_VERSION`、Node、npm、Java、AGP、compileSdk、targetSdk。

执行：

```bash
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
```

保存 suites / passed / skipped / failed / lint warnings / 完整错误日志。

---

## 4. F2-01：修复 adoptedRevisionId 原子回填

### 4.1 风险

Atomic Adoption 当前大致为：

```text
INSERT old revision
UPDATE chapter.content
INSERT pipeline revision
UPDATE batch item
UPDATE batch counters
```

如果 batch item 的 `adopted_revision_id` 在事务构造阶段被预先写成 `null`，而 pipeline revision 的 insertId 只能在执行到第三条 SQL 后取得，那么 item 最终可能仍保存 NULL。

### 4.2 先写失败测试

测试必须断言：

```text
pipeline revision.id
===
multi_chapter_batch_items.adopted_revision_id
```

并检查：

```text
source = 'pipeline'
source_ref = pipelineTaskId
revision.content == chapter.content
```

必须真实走 `adoptPipelineTaskResultAtomic → executeTransaction → content_revisions → batch item`。不得手工更新 `adopted_revision_id`。

### 4.3 推荐修复

优先使用同事务 SQL：

```sql
adopted_revision_id = last_insert_rowid()
```

但必须确认该值引用的是刚插入的 pipeline revision，而不是 old-body revision。若现有顺序不适合，可调整语句顺序、预生成稳定 revision ID，或改造事务接口。

### 4.4 验收

覆盖 oldContent 非空、oldContent 为空、重复 adoption、crash injection、恢复重试、adoptedRevisionId 一致。

---

## 5. F2-02：Adoption durable close-loop

### 5.1 风险

当前主事务完成后才进行：

```text
resolveTask()
markStoryMemoryDirtyIfCovered()
```

若事务提交后进程崩溃，可能出现 batch 已 completed，但 task 未 durable resolved、Story Memory 未 dirty。终态 batch 冷启动时未必会再次进入 adoption。

### 5.2 目标

至少保证：

```text
pipeline task resolved DB 状态
story-memory dirty intent
```

不会依赖一次 best-effort JS 调用。

### 5.3 推荐实现

**Task resolve**：优先将 `pipeline_tasks.resolved_at / resolved_action` 直接纳入 Adoption SQLite 事务，事务后 Zustand 只刷新 memory。

**Story Memory**：使用已有通用 outbox 或新增最小幂等 outbox：

```text
adoption transaction
→ INSERT OR IGNORE story-memory dirty outbox
→ COMMIT
→ cold-start / foreground consumer
```

要求幂等 key、crash safe、cold start 扫描、重复消费安全、batch completed 后仍可消费。

### 5.4 测试

注入：commit 后 resolve 前 crash、resolve 后 story dirty 前 crash、outbox 写入后消费前 crash、消费中 crash、重复消费。冷启动后最终必须达到 task resolved、story memory dirty、batch completed、chapter/revision/item 一致。

---

## 6. F2-03：Fingerprint 必须保持 row-key 绑定

### 6.1 隐藏风险

迁移新增列时，如果比较退化为“每个 column 的值 hash → sort → aggregate”，会丢失值属于哪一行。

反例：

```text
before:
id=1 content=A
id=2 content=B

after:
id=1 content=B
id=2 content=A
```

值集合仍是 `[A,B]`，但用户内容已经串行。

### 6.2 正确原则

即使 column set 不一致，也必须保持：

```text
rowKey + shared columns
```

推荐对每行生成：

```text
sharedRowHash = SHA256(stableKey + shared column/value pairs)
```

再按 stableKey 排序并聚合。新增列可忽略，但旧有列必须在同一 rowKey 下比较。collection_id allowlist 只剔除该列，其他 shared columns 仍保持 row-key 绑定。

### 6.3 必须新增反例测试

- 2 行 chapter content 互换 + 新增 summary_json → 必须 mismatch。
- 2 行 worldbook content 互换 + collection_id allowlist active → 必须 mismatch。
- 仅 collection_id 合法变化 → pass。
- 仅新增列默认值，旧字段不变 → pass。

---

## 7. F2-04：Schema Recovery backup 必须记录源 Schema

pre-migration backup 的 metadata 应描述备份内容的源 Schema，而不是当前 App 的目标 `SCHEMA_VERSION`。

例如源库 Schema 38、目标 App Schema 42，则 backup meta 必须是：

```text
schema_version = 38
```

`createSchemaRecoveryBackup` 应显式接收 `sourceSchemaVersion`，由 `installInfo.schemaVersion` 传入。

测试：Schema38 fixture → pre-migration backup → parse → meta.schema_version == 38；Schema42 recovery → meta.schema_version == 42。

---

## 8. F2-05：legacy sidecar backfill 限流 + 删除联动

### 8.1 backfill

列表已经可以先显示旧备份，这是正确的。但后台不能对全部 legacy backup 直接 `Promise.all` 做完整 read/parse。

引入轻量队列：

```text
concurrency = 1
```

或最多 2，默认优先 1。要求：列表立即显示、后台串行、单个失败不影响其他、已有 sidecar 跳过。

测试统计：

```text
max concurrent full read = 1
```

### 8.2 deleteBackup

删除 `backup.json` 时同步 best-effort 删除 `backup.json.meta.json`，不得留下 orphan sidecar。

---

## 9. F2-06：补真实 V2.11.24 覆盖升级

不要再用“更老版本迁移链更长”替代事故版本本身。尽量找到 V2.11.24 APK，可来自 dist/archive、Git tag、对应 commit 重构建、旧 release artifact。

若只能从旧 commit 重构建，必须使用独立 worktree 或其他不污染当前工作树的方式。禁止 reset 当前主工作树。

流程：安装旧版 → 构造真实数据 → 保存 before DB/fingerprint → `adb install -r` 当前 RC → 导出 after DB → 全量 fingerprint → 冷启动 → Backup Center → 人工抽查。

若最终确实无法获得 V2.11.24，审计报告必须明确写“未验证”，不得标记为等价完成。

---

## 10. F2-07：补真实 LLM 真机矩阵

Feature Flag 在完成前继续默认 OFF。

至少跑：

| ID | 场景 |
|---|---|
| N01 | 新项目 AI 写 3 章 |
| N02 | 旧项目 AI 写 3 章 |
| N06 | 用户暂停 → 恢复 |
| N07 | LLM 请求中强杀 App |
| N08 | 冷启动继续批次 |

建议补 N03 safe_retry、N04 429、N09 长请求 lease。若真实服务不方便稳定制造 429，可使用可控测试网关/代理，但必须是真实 HTTP + 真实 App + 真实 Device + 真实 SQLite，不得只用 Jest 代替。

每次记录 batch id、task id、request count、attempt rows、retry state、lease、usage、adoptedRevisionId、content revisions、final chapters、process kill 时间点、cold-start 恢复结果、logcat、关键截图/录屏。

---

## 11. F2-08：建立最小 GitHub CI Gate

新增 `.github/workflows/ci.yml`：

```text
push / pull_request
→ npm ci
→ npm run lint
→ npm run typecheck
→ npm run verify:version
→ npm run test:ci
```

要求 Node 版本明确、不上传 secrets、真实 LLM tests 不进 CI。Android Release build 暂不强制进 CI，除非已有稳定环境。当前 main 最新 SHA 必须得到远端 green run。

最终审计记录 commit SHA、workflow run、job result。

---

## 12. 测试标准

不能把以下形式作为核心证明：

```text
fs.readFileSync(source)
regex
manual SQL seed final state
mock whole runner
mock whole repository
```

可以 mock LLM 网络出口、RNFS、Android native notification、external API，前提是本问题核心状态转换仍走真实生产实现。

---

## 13. 建议提交切分

```text
fix(batch): persist adopted revision id atomically
test(batch): verify adopted revision binding

fix(batch): make adoption side effects durable
test(batch): cover post-commit crash recovery

fix(database): preserve row identity in migration fingerprints
test(database): cover cross-row content swaps

fix(backup): record source schema in recovery metadata
test(backup): verify pre-migration schema metadata

perf(backup): serialize legacy sidecar backfill
fix(backup): remove sidecar with backup

test(release): verify V2.11.24 covered upgrade
test(device): complete multi-chapter real-LLM recovery matrix

ci: add minimal release quality gate
```

---

## 14. Release Gate

### 核心 Release 公开发版条件

- [ ] F2-01 adoptedRevisionId 正确持久化
- [ ] F2-02 task resolve durable
- [ ] F2-02 Story Memory 有 durable outbox / 等价机制
- [ ] F2-03 fingerprint row-key 关联漏洞关闭
- [ ] F2-04 schema recovery source schema metadata 正确
- [ ] F2-05 backup backfill 限流
- [ ] F2-05 deleteBackup 清理 sidecar
- [ ] lint / typecheck / verify:version / test:ci 全绿
- [ ] Release APK + signing 通过
- [ ] 当前 RC 覆盖安装通过
- [ ] V2.11.24 覆盖升级通过，或唯一未验证风险由 Release Owner 显式接受
- [ ] GitHub CI green

### AI 写 N 章默认开启的额外条件

N01/N02/N06/N07/N08 全部真机通过。

如果核心 Release Gate 全部满足，但真实 LLM 矩阵未完成：

```text
允许发布核心版本
但 multi_chapter_batch_enabled 必须默认 OFF
```

---

## 15. 最终审计报告

生成：

```text
docs/release-audit/V2.11.34-final2-release-audit.md
```

必须包含：修复前/后 HEAD、worktree、F2-01～08 复现、失败测试、根因、修改文件、SQLite/Schema 变化、自动化测试、adoptedRevisionId 对账、Story Memory outbox 恢复、fingerprint cross-row swap、Schema Recovery metadata、Backup backfill concurrency、V2.11.24 覆盖升级、AI 写 N 章真机、APK + signing、GitHub CI、Remaining risks、最终结论。

最终结论只允许：

```text
A. 核心版本允许公开发版，AI 写 N 章可默认开启
B. 核心版本允许公开发版，AI 写 N 章保持默认关闭
C. 仅允许内部 RC / 灰度
D. 禁止发版
```

判定：任意 F2-01/02/03 未关闭 → D；核心门禁已关但缺 Release/覆盖升级/CI 基本证据 → C；核心全部通过但真实 LLM 矩阵未完成 → B；核心 + AI 真机全部通过 → A。

---

## 16. Agent 执行总指令

本轮目标不是继续“多修一些代码”，而是消除最后几个确定性工程缺口，并获得足够高等级的发版证据。

如果某问题在当前本地代码中已经不存在，不要为了匹配文档强行改代码，应写最小复现测试证明并标记 `already fixed / no code change required`。

如方案与本地代码实际冲突，以当前本地生产路径、真实 SQLite、真实设备和可重复测试证据为准，并在审计报告中解释差异。
