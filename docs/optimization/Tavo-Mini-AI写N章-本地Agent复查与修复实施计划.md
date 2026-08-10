# Tavo Mini AI 写 N 章：本地 Agent 复查、修复与发布实施方案

> 适用对象：本地代码 Agent / Codex / 开发负责人 / 测试负责人  
> 功能范围：`AI 写 N 章`、多章节批次状态机、单章 Pipeline、重试、预算、恢复、采用、通知  
> 建议目标版本：`V2.11.34` 或更高  
> 核心原则：**本地复查验真优先；只修复真实存在的问题；保持状态机边界清晰；禁止通过测试注入最终状态绕过生产链路。**

---

## 1. 目标

本方案用于建立 AI 写 N 章功能的完整修复闭环：

1. 复查历史 P0/P1 问题在本地最新代码中是否真实存在；
2. 重新建立 UI → Store → Batch Reconciler → Pipeline → SQLite 的完整调用链；
3. 修复安全重试断链；
4. 修复跨 run 用量漏算和预算不硬；
5. 修复错误 attempt 选择；
6. 修复暂停、冷启动和租约恢复竞态；
7. 修复采用结果崩溃窗口；
8. 强化项目尾部漂移保护；
9. 修复前台通知所有权和伪心跳；
10. 建立可验证的真机端到端门禁；
11. 确保修复不扩散到普通单章写作和续写模式。

---

## 2. 范围边界

### 2.1 本轮允许修改

- `src/services/multiChapterBatch/**`
- `src/store/multiChapterBatchStore.ts`
- `src/data/repositories/multiChapterBatchRepository.ts`
- `src/data/repositories/pipelineStageAttemptRepository.ts`
- `src/services/pipeline/**`
- `src/services/pipelineRunner.ts`
- `src/screens/MultiChapterBatchScreen.tsx`
- `src/services/featureFlags.ts`
- 与上述模块直接相关的类型、迁移和测试

### 2.2 默认禁止修改

除非验真证据证明必须修改，否则不要改：

- 普通章节编辑器核心交互；
- 续写模式；
- 人物卡和世界书；
- 备份恢复；
- 主题系统；
- 全局导航结构；
- LLM Provider 通用协议；
- React Native 和 SQLite 依赖版本。

### 2.3 禁止的修复方式

- 手工把 Item SQL 改成 `waiting_retry` 让测试通过；
- 用 `setTimeout` 永久轮询替代持久化调度；
- 将所有失败都重试；
- 将 `outcome_unknown` 自动重试；
- 失败时直接从头重跑整章；
- 用内存 Set 代替 SQLite 所有权；
- 只看 `stageResults` 统计请求；
- 通过放宽断言隐藏正文或修订链错误；
- 将批量逻辑复制一套到 UI 层。

---

## 3. 已知风险假设

Agent 必须重新验真，不得直接当作事实。

| ID | 级别 | 风险假设 |
|---|---:|---|
| BN-01 | P0 | `safe_retry` attempt 被阶段 `failed` 状态提前阻断，自动重试函数无法执行 |
| BN-02 | P0 | Batch `wait_until` 没有持久化为 `waiting_retry`，看门狗依赖的状态生产路径不存在 |
| BN-03 | P1 | Task A 失败后解绑并创建 Task B，批次用量只统计当前 Task B |
| BN-04 | P1 | 批次预算不是每次请求前校验，不能形成硬上限 |
| BN-05 | P1 | `getLatestAttemptByTask` 按 `attempt_no` 优先排序，跨 Stage 可能选错 |
| BN-06 | P1 | `paused_*` 批次冷启动后可能残留死进程 lease |
| BN-07 | P1 | 采用结果存在“正文已写、pipeline 修订未写”的崩溃窗口 |
| BN-08 | P1 | 项目尾部漂移只比较 position，没有核对 expectedTailChapterId |
| BN-09 | P1 | 心跳与主循环同时 CAS 续租，存在 rowVersion 竞态 |
| BN-10 | P1 | 计时器停止后已开始的异步心跳仍可能重新写 lease |
| BN-11 | P2 | Batch 子 Task 仍启动独立前台通知 |
| BN-12 | P2 | 运行页“最后更新”只是本地时钟，不代表真实进度 |
| BN-13 | P1 | Feature Flag 开启后，异常路径可能让普通用户进入未完成状态机 |
| BN-14 | P1 | 恢复失败 Task 时可能错误选择“续写”或“新 run”策略 |
| BN-15 | P1 | 暂停、取消、结果未知、额度不足、预算不足的 UI 操作语义不一致 |

---

## 4. Phase 0：本地基线和调用链重建

### 4.1 基线命令

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -20 --oneline
node --version
npm --version
java -version
```

执行：

```bash
npm ci
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
```

记录真实测试数量，不得只复制历史报告。

### 4.2 重建两条调用链

#### 批量创建链路

```text
OutlineEditor
→ MultiChapterBatchScreen
→ createDraftBatch
→ runPlanner
→ saveEditedPlan
→ start
→ reconcileMultiChapterBatch
```

#### 单章执行链路

```text
reconcileMultiChapterBatch
→ createPipelineTaskForBatchItem
→ runChapterPipeline / resumePipeline
→ reconcilePipelineTask
→ determineNextPipelineAction
→ executeClaimedStage
→ callLLMResult
→ pipeline_stage_attempts
→ checkpoint
→ finalText
→ adoptPipelineTaskResult
→ commitBatchItemAdoption
```

Agent 必须画出状态和数据写入点，不得只列函数名。

---

## 5. Phase 1：生产路径验真测试

## 5.1 BN-01/02 安全重试端到端验真

测试必须从真实错误对象开始：

```text
LLM 第一次请求抛出 safe_retry
→ attempt 写入 safe_to_retry
→ checkpoint 状态变化
→ batch/item 状态变化
→ next_retry_at 持久化
→ 进程退出
→ 到期后重新进入
→ 自动重试同一冻结请求
→ 成功采用
```

禁止测试直接执行：

```sql
UPDATE multi_chapter_batch_items
SET status='waiting_retry'
```

断言：

- `outcome_unknown` 不自动重试；
- `safe_retry` 和 `rate_limit` 才可自动重试；
- 到期前不请求；
- 到期后只请求一次；
- 使用同一 `requestFingerprint`；
- 已成功阶段不重跑；
- 最大重试次数有效；
- Retry-After 有效；
- 重启后调度仍有效。

## 5.2 BN-03 跨 run 用量验真

构造：

```text
Task A:
- draft request 成功
- review request 失败
- 用户选择恢复并创建 Task B

Task B:
- review request 成功
- proof request 成功
- 采用完成
```

断言批次总用量包括：

```text
Task A 全部 attempts
+ Task B 全部 attempts
```

并且重复 reconcile 不会重复记账。

## 5.3 BN-04 预算硬上限验真

构造剩余预算不足以发起下一次请求。

断言：

- 请求发起前阻断；
- 不创建 HTTP attempt；
- 不产生费用；
- Batch/Item 落入明确暂停状态；
- 用户增加预算后可以继续；
- 不重跑成功阶段。

## 5.4 BN-05 最新 attempt 选择验真

构造：

```text
draft attempt 1
draft attempt 2
review attempt 1（最后发生）
```

断言最新失败必须是 review attempt 1。

不允许按 Stage 内 attemptNo 进行全 Task 排序。

## 5.5 BN-06 冷启动 lease 验真

覆盖：

- `running + live-looking dead lease`
- `waiting_retry + dead lease`
- `paused_user + dead lease`
- `paused_timeout_unknown + dead lease`
- `ready + execution traces + dead lease`
- pristine `ready` 无执行痕迹

冷启动后：

- 所有非终态旧 lease 清理；
- 需要恢复的状态进入可解释暂停；
- pristine ready 不被误暂停；
- 用户点击继续不出现“线程被占用”。

## 5.6 BN-07 采用崩溃窗口验真

注入崩溃点：

```text
A. 写旧正文修订前
B. 写旧正文修订后
C. 写 chapter.content 后
D. 写 pipeline 修订后
E. commit item adoption 前
F. commit item adoption 后
```

恢复后断言：

- chapter.content 正确；
- 旧正文修订最多一条；
- pipeline 正文修订恰好一条；
- `adoptedRevisionId` 指向 pipeline 修订；
- completionCount 不重复；
- 故事记忆 dirty 标记不重复或幂等；
- Pipeline task 只 resolve 一次。

## 5.7 BN-08 尾部漂移验真

覆盖：

- 用户新增尾部章节；
- 用户删除尾部章节；
- 用户删除后创建相同 position 的新章节；
- 用户重排章节；
- Batch 自己创建但未采用的章节；
- Batch 已完成前几章后的预期尾部。

断言同时比较：

```text
position
chapterId
batch ownership
completedCount
```

## 5.8 BN-09/10 lease 心跳验真

必须用可控 fake clock 或长请求测试真实触发心跳。

覆盖：

- 主循环和心跳并发；
- 心跳 CAS 失败；
- lease 被其他 owner 抢占；
- clear timer 时异步心跳正在执行；
- 退出后不得重新写 lease；
- lost lease 后不得继续发起 LLM。

---

## 6. Phase 2：修复设计

## 6.1 统一 Pipeline 重试决策顺序

必须确保“可重试 attempt”判断发生在“阶段失败终态”之前。

推荐流程：

```text
读取 checkpoint + latest attempt
→ 若 checkpoint=failed 且 latest attempt=safe_to_retry
    → 未到期：返回 waiting_retry
    → 已到期且未超限：checkpoint CAS reset pending
    → 继续状态机
→ 若 outcome_unknown：返回人工确认暂停
→ 其他 failed：进入失败终态
```

建议新增纯函数：

```ts
determineRetryDisposition({
  checkpoint,
  latestAttempt,
  now,
  maxAttempts,
})
```

返回：

```ts
type RetryDisposition =
  | { type: 'not_retryable' }
  | { type: 'wait'; nextRetryAt: number }
  | { type: 'retry_now' }
  | { type: 'manual_confirmation' }
  | { type: 'exhausted' };
```

纯函数先单测，再接入 reconciler。

---

## 6.2 持久化 waiting_retry

Batch 和 Item 必须落库：

```text
item.status = waiting_retry
item.next_retry_at = ...
batch.status = waiting_retry
batch.error_code = SAFE_RETRY_WAITING
```

到期驱动必须可跨进程：

- 页面前台轮询只是触发器；
- App 回前台触发 due retry 扫描；
- 冷启动扫描 due retry；
- 若已有前台服务，可由服务定时触发；
- 所有触发都调用同一个幂等 reconcile；
- SQLite 状态是唯一事实源。

不要依赖单一 React 页面 `setInterval`。

---

## 6.3 用量增量记账

不要在章节采用后读取当前 Task 汇总。

新增记账表或等价机制：

```text
batch_usage_ledger
- batch_id
- pipeline_attempt_id
- input_tokens
- output_tokens
- total_tokens
- call_count
- recorded_at
UNIQUE(batch_id, pipeline_attempt_id)
```

在 attempt 进入可计费终态时写入：

- succeeded；
- safe_to_retry；
- outcome_unknown；
- failed；
- cancelled（是否计费按是否已发出请求判断）。

事务内：

```text
INSERT OR IGNORE ledger
→ 若插入成功则累加 batch usage
```

这样可覆盖跨 run、跨 Task、崩溃恢复，并防止重复 reconcile 重复计数。

---

## 6.4 请求前预算硬门禁

在创建 attempt 和发出 HTTP 请求前：

```text
读取批次剩余 calls/input/output 预算
→ 估算本次最大预算
→ 不足则不 claim 请求
→ item/batch 持久化 paused_batch_budget
```

需要考虑：

- 模型最大输出；
- Stage 最大 tokens；
- 已产生但 token 未返回的 outcome_unknown；
- 同一批次只能串行请求；
- 预算检查和 attempt 创建尽量处于同一事务或同一所有权窗口。

---

## 6.5 latest attempt 查询修复

推荐接口：

```ts
getLatestAttemptForTaskStage(taskId, stage)
getLatestAttemptByTask(taskId)
```

全 Task 最新排序：

```sql
ORDER BY started_at DESC, completed_at DESC, id DESC
```

若当前失败 Stage 已知，优先按 Task + Stage 查询，避免跨 Stage 推断。

---

## 6.6 冷启动 lease 清理

冷启动意味着旧 JS 进程已经死亡。

因此：

```text
所有非终态 batch 的 lease_owner / lease_expires_at 清空
```

随后再按状态归一化。

但 Agent 必须先验证当前架构是否支持进程死亡后原生服务独立继续。如果不能，旧 lease 全部视为失效；如果能，必须引入原生执行所有权证明，不能凭时间猜测。

---

## 6.7 采用事务化

推荐将以下步骤纳入一个 SQLite 事务：

1. 读取并验证 Task finalText；
2. 检查 adoption fingerprint；
3. 创建旧正文修订；
4. 写 chapter.content；
5. 创建 pipeline 正文修订；
6. 更新 item adoption fingerprint 和 revision id；
7. 更新 batch completedCount/currentOrdinal/status；
8. 标记 task resolved。

故事记忆 dirty 标记若不能进入同一事务：

- 写入 outbox；
- 事务提交后处理；
- outbox 必须幂等。

采用幂等判断同时检查：

```text
fingerprint
chapter.content hash
pipeline revision source
pipeline revision source_ref
pipeline revision content hash
item.adopted_revision_id
```

---

## 6.8 尾部漂移保护

保存计划时冻结：

```text
startPosition
expectedTailChapterId
expectedTailDigest（可选）
```

每次创建下一章前：

```text
expected position = startPosition + completedCount
expected chapter id =
  completedCount == 0
    ? expectedTailChapterId
    : previous batch item's chapterId
```

验证：

- 最大 position；
- 尾部 chapter id；
- 尾部是否属于当前项目；
- 前一个 Batch Item 的 chapter id；
- 不把 Batch 自己创建但未采用的章节误判为外部漂移。

---

## 6.9 单一 Lease Manager

不要让主循环和 `setInterval` 独立 CAS 同一 rowVersion。

推荐封装：

```ts
class BatchLeaseSession {
  owner: string;
  lost: boolean;
  renew(): Promise<void>;
  assertOwned(): Promise<void>;
  stop(): Promise<void>;
}
```

要求：

- 续租串行化；
- 同时只允许一个 renew Promise；
- CAS 失败设置 `lost=true`；
- lost 后禁止新 LLM 请求；
- `stop()` 等待正在执行的续租结束；
- release 只允许 owner 自己执行；
- 所有 lease 事件写诊断日志。

---

## 6.10 暂停、取消和结果未知语义

| 操作 | Pipeline Task | Checkpoint | Batch/Item | 是否可自动继续 |
|---|---|---|---|---|
| 用户暂停 | interrupted | interrupted | paused_user | 用户确认 |
| 用户取消 | cancelled | interrupted/cancelled | cancelled | 否 |
| safe retry | failed/pending | retryable | waiting_retry | 到期自动 |
| outcome unknown | unresolved | unknown | paused_timeout_unknown | 人工确认 |
| 额度不足 | blocked | 保留 | paused_account_quota | 配置后继续 |
| 批次预算不足 | 不发请求 | pending | paused_batch_budget | 调整预算后继续 |
| 项目漂移 | 不发请求 | 保留 | paused_project_changed | 人工处理 |

UI 不得把不同原因都显示成“确认后继续”。

---

## 6.11 前台通知所有权

Batch 模式应只有一个聚合通知。

传递：

```text
foregroundOwner='batch'
```

必须贯穿：

```text
runChapterPipeline
→ reconcilePipelineTask
→ action stage updates
```

Pipeline 内部所有 `start/stop/notifyFailed` 都应尊重 owner。

单章模式保持原行为，避免扩散回归。

---

## 6.12 真实进度和心跳

运行页显示真实值：

- Batch `updatedAt`；
- 当前 attempt `lastProgressAt`；
- 最近一次 lease renew 时间；
- 当前 Stage；
- 当前请求已运行时间。

禁止使用 UI 本地 `Date.now()` 每 2 秒伪装“最后更新”。

若超过阈值没有真实进度：

```text
显示“当前请求仍在等待服务端响应”
或
显示“可能已中断，请刷新状态”
```

---

## 7. Phase 3：测试结构

### 7.1 纯函数测试

- Batch action decision；
- Pipeline retry disposition；
- mode mapping；
- budget decision；
- drift decision；
- pause reason → allowed actions；
- progress calculation。

### 7.2 Repository 测试

- CAS claim；
- lease renew/release；
- usage ledger 幂等；
- adoption transaction；
- waiting_retry 持久化；
- cold-start lease cleanup；
- latest attempt ordering。

### 7.3 Store 测试

- start 非阻塞；
- 防重入；
- pause；
- resume；
- due retry re-drive；
- feature flag；
- screen reload；
- cold-start batch reload。

### 7.4 Pipeline 集成测试

使用真实 in-memory SQLite，不要只 mock Store。

覆盖：

```text
safe_retry → wait → restart → retry → success
outcome_unknown → manual confirm
pause during draft → resume same snapshot
Task A fail → Task B success → aggregate usage
crash during adoption → idempotent recovery
lease lost during request → stop before next call
```

### 7.5 UI 测试

- 入口显示；
- 规划页；
- 立即进入运行页；
- waiting_retry 页面；
- 额度不足页面；
- 结果未知页面；
- 项目漂移页面；
- 报告页；
- 真实更新时间；
- 不弹单章结果提示；
- 不出现子 Task 通知。

---

## 8. Phase 4：真机端到端矩阵

至少使用真实模型执行：

| 编号 | 场景 |
|---|---|
| N01 | 新项目连续生成 3 章，仅草稿 |
| N02 | 旧项目连续生成 3 章，完整流水线 |
| N03 | 第二章网络暂态失败后自动重试 |
| N04 | 第二章 429 + Retry-After |
| N05 | 结果未知，人工确认继续 |
| N06 | 生成中暂停、退出页面、重新进入继续 |
| N07 | 生成中强杀进程，冷启动继续 |
| N08 | 暂停后立即强杀，冷启动无 lease 冲突 |
| N09 | 预算不足，不发下一次请求 |
| N10 | 修改项目尾部，批次安全暂停 |
| N11 | 切后台、锁屏、恢复 |
| N12 | 完成后正文、修订链、计数、用量核对 |
| N13 | 功能开关关闭后普通单章流水线不受影响 |
| N14 | 功能开关开启后新旧项目入口均可见 |

每次记录：

- 真机录屏；
- Logcat；
- Batch 表；
- Item 表；
- Pipeline Task；
- Checkpoints；
- Attempts；
- Usage ledger；
- Content revisions；
- 最终章节正文哈希。

---

## 9. 修复提交建议

```text
test(batch): add production-path safe retry regression
fix(pipeline): resolve retry disposition before failed terminal
fix(batch): persist waiting_retry and due schedule
fix(batch): add idempotent attempt usage ledger
fix(batch): enforce pre-request budget gate
fix(attempts): select latest attempt by real chronology
fix(batch): clear stale leases across non-terminal cold-start states
fix(batch): make adoption atomic and revision-safe
fix(batch): validate tail identity, not position only
fix(batch): serialize lease renewal ownership
fix(batch): honor batch foreground notification ownership
fix(batch-ui): show persisted progress and reason-specific actions
test(batch): add crash, restart and long-running lease matrix
chore: bump version
```

每个提交必须：

- 有失败测试；
- 最小修改；
- 不格式化无关文件；
- 可独立回滚；
- 在报告中说明风险。

---

## 10. 发布策略

### 阶段 A：内部开发

```text
multi_chapter_batch_enabled=true
elastic_budget_v2_enabled=true
```

仅本地和开发设备。

### 阶段 B：真机候选

- 设置页显示“实验功能”；
- 默认开启；
- 明确标记测试功能；
- 可一键关闭；
- 收集状态机诊断。

### 阶段 C：正式发布

全部门禁通过后才默认开启。

保留紧急关闭开关，但不能因为存在开关就降低发版门槛。

---

## 11. 发版门禁

- [ ] safe_retry 生产路径自动重试成功；
- [ ] outcome_unknown 不自动重试；
- [ ] waiting_retry 跨进程持久化；
- [ ] Task A + Task B 用量完整且不重复；
- [ ] 每次请求前预算校验；
- [ ] latest attempt 选择正确；
- [ ] 所有非终态死 lease 可恢复；
- [ ] 采用全部崩溃点恢复正确；
- [ ] 修订链完整；
- [ ] 尾部 position + chapterId 双重校验；
- [ ] 长请求心跳真实测试通过；
- [ ] lease 丢失后不再发请求；
- [ ] Batch 仅一个聚合通知；
- [ ] UI 显示真实进度；
- [ ] 新旧项目入口可见；
- [ ] 单章 Pipeline 回归全绿；
- [ ] 真实模型 3 章端到端通过；
- [ ] 强杀、重启、锁屏、后台矩阵通过；
- [ ] Release APK 覆盖安装通过；
- [ ] 版本号提升。

---

## 12. Agent 最终报告

生成：

```text
docs/release-audit/V2.11.34-ai-n-chapters-audit.md
```

报告必须包含：

1. 本地 HEAD；
2. 工作区状态；
3. 原始测试结果；
4. 每项风险是否复现；
5. 失败测试证据；
6. 修复设计；
7. 修改文件；
8. 数据库 Schema 变更；
9. 新增迁移；
10. 自动化测试结果；
11. 真机测试结果；
12. 真实 LLM 请求记录；
13. 用量核对；
14. 未解决风险；
15. Feature Flag 建议；
16. 最终发布结论。

最终结论只能是：

```text
A. 可正式开放 AI 写 N 章
B. 仅允许内部/灰度开启
C. 必须保持关闭
```

---

## 13. Agent 执行总指令

```text
以当前本地仓库为唯一事实来源，不要直接相信历史审计文档、提交说明或测试注释。

先完成：
1. 记录 Git 基线和未提交改动；
2. 运行 lint、typecheck、version verify、完整测试；
3. 重建 AI 写 N 章从 UI 到 SQLite 的调用链；
4. 按 BN-01～BN-15 逐项复查；
5. 对每个确认问题先新增一个走真实生产状态转换的失败测试；
6. 只做最小修复；
7. 每修一项执行定向测试；
8. 全部修复后执行完整回归和真机矩阵；
9. 不得通过手工 SQL 预设最终状态来证明生产链路正确；
10. 不得修改无关模块或进行全仓库重构；
11. 不得覆盖用户未提交改动；
12. 输出完整审计报告和明确发版结论。
```
