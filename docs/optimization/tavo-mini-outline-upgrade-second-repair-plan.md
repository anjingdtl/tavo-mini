# Tavo Mini 大纲模式第二轮缺漏修复方案

> 用途：交给本地编码 Agent，对第一轮大纲模式修复后的剩余缺口进行核查、修复和回归验证。  
> 远端静态审计参考基线：`anjingdtl/tavo-mini` 的 `main` 分支，审计时最新提交为 `154423ba90d5f0fa43d83c4f0adb2e9e53bb3980`。  
> **最终施工基线始终是本地仓库。远端提交、本文路径、Schema 版本和类型名称仅作为定位线索。**

---

## 1. 本轮目标

第一轮已经基本完成：

- `outlineAssessment` 类型与校验；
- Review / Fact Check / Proof 全阶段完整大纲；
- 大纲拼装、token 和指纹统一；
- Schema 38 流水线上下文快照字段；
- 请求窗口最终检查；
- 大纲执行报告；
- 排序、导入和若干防御性校验。

第二轮不再扩展功能面，而是修复以下系统级闭环问题：

1. 让持久化快照真正发生在第一次 LLM 调用之前；
2. 让跨进程恢复在产品流程上真正可用；
3. 让 `full` 模式恢复时使用与正常流程相同的审核上下文；
4. 让窗口检查使用实际请求模型，而不是重新读取“当前活动模型”；
5. 冻结 Pipeline 模式、阶段预算、预设和模型配置，避免恢复时漂移；
6. 建立“大纲优先，普通资料让位”的统一动态预算；
7. 严格验证持久化快照的版本、结构、任务归属和完整性；
8. 让上下文预览等于真实 Draft 请求；
9. 让结构化错误码贯穿 Builder、Runner 和 UI；
10. 补齐空正文启用、预算未知、项目包位置和关闭建议精度等边界问题。

---

# 2. 施工原则

## 2.1 本地仓库是唯一事实来源

Agent 开始前必须记录：

```text
当前分支
当前 HEAD
git status --short
未提交和未跟踪文件
当前数据库 schema
Pipeline 任务状态定义
冷启动任务处理入口
Pipeline 首次运行入口
Pipeline Resume 入口
任务中心或恢复按钮入口
LLM requestConfig 结构
Context Preview 入口
```

禁止：

```text
git reset --hard
git checkout .
git clean -fd
未经判断直接 git pull
覆盖用户未提交修改
为了通过测试删除原测试
用 any、ts-ignore、吞异常掩盖问题
```

## 2.2 动态版本规则

不得假设本地 Schema 一定是 38。

若本地当前版本为 `N`，需要新增字段时执行：

```text
N -> N+1
```

必须同步：

- 迁移注册；
- 当前 Schema 常量；
- 全新安装建表；
- Schema manifest；
- 备份和恢复；
- 历史迁移测试；
- 兼容旧任务。

## 2.3 先核查后修改

每一项先确认本地是否已经有等价实现：

```text
存在问题：补失败测试后修复
已经修复：核实测试覆盖，不重复建设
架构不同：按本地架构实现等价不变量
无法复现：记录证据和判断
```

---

# 3. 优先级总览

| 优先级 | 问题 | 风险 |
|---|---|---|
| P0 | 冷启动把可恢复任务直接终态化 | 跨进程恢复在产品上不可用 |
| P0 | 快照写库未 await | 首次 LLM 已开始但快照尚未落盘 |
| P0 | `full` 模式只持久化基础快照 | 恢复后审核上下文与正常流程不同 |
| P0 | 窗口检查重新读取活动模型 | 检查模型与实际请求模型不一致 |
| P1 | Pipeline 配置和预设未冻结 | Resume 可能改变执行拓扑和参数 |
| P1 | 统一预算只做最终阻断 | 可压缩普通资料却直接失败 |
| P1 | 快照结构校验过弱 | 错任务、错版本或缺字段仍可能通过 |
| P1 | Context Preview 仍不是实际 Draft 请求 | UI 展示与真实发送内容不一致 |
| P1 | OutlineContextError 未贯穿 UI | 仍依赖中文正则识别错误 |
| P2 | 空正文可从列表重新启用 | 可能注入无效大纲 |
| P2 | 模型未配置显示 `/ 0 tokens` | 用户误解预算状态 |
| P2 | 编辑离开无未保存确认 | 内容可能丢失 |
| P2 | 项目包 position 校验不足 | 负数、小数和空正文启用可进入 |
| P2 | 建议关闭算法为近似值 | 可能多关或少关一份大纲 |

---

# 4. 第一阶段：建立失败测试

在修改生产代码前，至少补以下失败测试。

## 4.1 快照落盘竞态

模拟：

```text
setTaskPipelineContext 被调用
SQLite 写入 Promise 尚未完成
LLM 调用准备开始
```

期望：

```text
LLM 调用不得发生
必须等待快照持久化成功
```

再模拟 SQLite 写入失败：

```text
Pipeline 失败
不会调用 LLM
错误明确说明冻结上下文保存失败
```

## 4.2 冷启动恢复

场景 A：

```text
已有成功 Draft
有合法快照
任务状态为 reviewing / factChecking / proofing
应用冷启动
```

期望：

```text
任务变为 interrupted / recoverable
resolvedAt 仍为空
任务中心可继续
```

场景 B：

```text
没有成功 Draft
```

期望：

```text
任务失败且不可恢复
```

场景 C：

```text
有 Draft，但快照缺失或损坏
```

期望：

```text
任务失败
展示“无法安全恢复”
```

## 4.3 `full` 模式审核快照

模拟：

```text
基础 snapshot 无命中 A
Draft 触发 post-draft retrieval 命中 A
auditContext 包含 A
应用在 Review 前中断
恢复
```

期望：

```text
Review / Fact Check / Proof 仍看到 A
```

## 4.4 实际模型窗口

模拟：

```text
任务启动时 requestConfig.contextWindow = 32000
任务中途活动模型切换到 128000
```

期望：

```text
窗口检查仍使用 32000
```

反向场景同样测试。

## 4.5 Pipeline 配置冻结

任务启动后修改：

```text
pipelineMode
reviewMaxTokens
proofMaxTokens
presetId
活动模型
```

恢复时必须仍按任务启动时配置执行，或明确提示原配置不可用。

---

# 5. 第二阶段：让快照持久化真正同步完成

## 5.1 当前风险

如果 Store 方法只更新内存并异步排队写库，Runner 随即调用 LLM，则存在：

```text
内存已有快照
SQLite 还没有
LLM 已开始
进程被杀
冷启动找不到快照
```

## 5.2 推荐实现

不要依赖吞错式通用 `persistTask()` 作为关键边界。

增加专用 Repository 方法：

```ts
export async function updatePipelineTaskContext(
  taskId: string,
  snapshot: {
    json: string;
    version: number;
    hash: string;
  },
): Promise<void>
```

SQL 参考：

```sql
UPDATE pipeline_tasks
SET pipeline_context_json = ?,
    pipeline_context_version = ?,
    pipeline_context_hash = ?,
    updated_at = ?
WHERE id = ?
```

必须检查：

```text
受影响行数为 1
```

否则抛错。

## 5.3 Runner 调用顺序

```ts
const persisted = serializePipelineContextSnapshot(snapshot);

await db.updatePipelineTaskContext(taskId, {
  json: persisted.pipelineContextJson,
  version: persisted.pipelineContextVersion,
  hash: persisted.pipelineContextHash,
});

store.applyPersistedContextToMemory(taskId, persisted);

await callLLMResult(...);
```

关键要求：

```text
先落盘
后更新为可运行状态
最后调用 LLM
```

SQLite 写入失败时：

```text
任务失败
通知失败
不调用模型
```

## 5.4 Store 调整

建议将：

```ts
setTaskPipelineContext(...): void
```

改成：

```ts
persistTaskPipelineContext(...): Promise<void>
```

或把关键写入完全放在 Repository / Runner 中，Store 只同步内存。

不要让关键错误进入：

```ts
.catch(() => console.warn(...))
```

## 5.5 验收标准

- 第一次 Draft LLM 调用前数据库已有快照；
- 写入失败时模型调用次数为 0；
- Store 和 SQLite 内容一致；
- 快照 hash 与 JSON 一致；
- 连续状态写不会覆盖快照字段。

---

# 6. 第三阶段：真正开放跨进程恢复

## 6.1 冷启动分类

当前不应把所有 active 任务统一 `resolvedAction = reject`。

建议定义：

```ts
type PipelineTaskStatus =
  | ...
  | 'interrupted';
```

也可以保留 `failed`，增加：

```ts
recoverable?: boolean;
interruptionReason?: string;
```

更推荐独立状态，UI 语义更清楚。

## 6.2 可恢复判定

```ts
function classifyInterruptedTask(task): {
  recoverable: boolean;
  reason: string;
}
```

规则建议：

### 可恢复

```text
存在成功 Draft stage
存在合法 pipelineContextJson
snapshot hash 正确
snapshot 版本受支持
任务未被用户主动取消
```

### 不可恢复

```text
没有成功 Draft
快照缺失
快照损坏
快照版本不支持
目标章节不存在
任务已被用户取消
```

## 6.3 冷启动行为

### 可恢复任务

```text
status = interrupted
resolvedAt = null
resolvedAction = null
error = “运行被中断，可继续后续阶段”
```

### 不可恢复任务

```text
status = failed
resolvedAt 可保持 null 供用户查看
error = 具体原因
```

不要自动 `resolvedAt = now`，否则任务可能从任务中心消失。

## 6.4 UI 入口

任务中心或结果页增加：

```text
继续任务
重新开始
放弃
```

“继续任务”调用：

```ts
resumePipeline(task.id, chapter, ...)
```

只有 `recoverable` 任务显示。

## 6.5 前台 stale 处理

`markStaleTasksAsFailed()` 同样需要区分：

```text
前台运行超时
真正进程中断
可恢复阶段
```

不应把有成功 Draft 和合法快照的任务永久判死。

## 6.6 验收标准

- 冷启动后可恢复任务仍未 resolved；
- 用户能从任务中心继续；
- 没有 Draft 的任务不允许继续；
- 用户主动取消的任务不会变成可恢复；
- Resume 成功后原任务继续写入，不创建第二份任务。

---

# 7. 第四阶段：持久化 `full` 模式审核上下文

## 7.1 问题

正常 `full` 模式：

```text
基础 pipelineContext
→ Draft
→ post-draft retrieval
→ auditContext
→ Review / Fact Check / Proof
```

只保存基础上下文会导致恢复后缺少 Draft 触发的新命中。

## 7.2 推荐方案

扩展持久化快照结构：

```ts
interface PersistedPipelineTaskContextV2 {
  version: 2;

  draftContext: PipelineContextSnapshot;
  auditContext?: PipelineContextSnapshot;

  execution: PipelineExecutionSnapshot;
  createdAt: number;
  draftCompletedAt?: number;
  auditContextCreatedAt?: number;
}
```

或者新增字段：

```text
pipeline_audit_context_json
pipeline_audit_context_version
pipeline_audit_context_hash
```

两种方式选择与本地架构更一致的一种。

## 7.3 写入时机

```text
构建 draftContext
→ 同步落盘
→ 调用 Draft
→ Draft 成功持久化
→ 构建 auditContext
→ 同步落盘 auditContext
→ 调用 Review / Fact Check
```

若 post-draft retrieval 设计为非阻断：

```text
成功：auditContext = 增强快照
失败：auditContext = draftContext，并记录 fellBack=true
```

关键是把最终决定使用的审核快照落盘。

## 7.4 恢复规则

```text
full 模式后续阶段：
优先使用 auditContext
```

若 Draft 已成功但 auditContext 尚未生成：

- 可以基于冻结的 Draft 文本和冻结 draftContext 重新执行本地检索；
- 但不得读取已经变化的实时启用资源作为新事实；
- 若本地检索本质依赖实时 DB，推荐阻止恢复并要求重新开始，或保存检索所需候选集合。

## 7.5 验收标准

- 正常运行和恢复运行的 Review messages 一致；
- Fact Check messages 一致；
- Proof constraints 一致；
- 中途修改人物卡、世界书、大纲不会改变已冻结任务；
- `auditContext` 损坏时明确阻断。

---

# 8. 第五阶段：冻结 Pipeline 执行配置

## 8.1 需要冻结的内容

```ts
interface PipelineExecutionSnapshot {
  pipelineMode: PipelineMode;

  draftMaxTokens: number;
  reviewMaxTokens: number;
  factCheckMaxTokens: number;
  proofMaxTokens: number;

  draftPresetId: number | null;
  reviewPresetId: number | null;
  factCheckPresetId: number | null;
  proofPresetId: number | null;

  llmConfigId: number;
  provider?: string;
  modelName?: string;
  contextWindow: number;

  createdAt: number;
}
```

如果每个阶段可使用不同模型，应按阶段冻结：

```ts
stageModels: {
  draft: FrozenModel;
  review: FrozenModel;
  factCheck: FrozenModel;
  proof: FrozenModel;
}
```

## 8.2 预设冻结

仅保存 presetId 不足，因为预设内容可能被编辑。

推荐保存每阶段实际解析后的 Prompt 或预设快照：

```ts
draftPresetSnapshot
reviewPresetSnapshot
factCheckPresetSnapshot
proofPresetSnapshot
```

至少保存：

```text
system_prompt
writing_style
extra_instructions
temperature
top_p
max_tokens
```

## 8.3 Resume 行为

Resume 不应重新调用当前：

```text
getPipelineConfig()
getPresetsByProject()
getActiveLLMConfig()
```

作为默认配置来源。

应该读取冻结执行配置。

原模型或 Provider 已删除时：

```text
明确提示
让用户选择替代模型
说明恢复环境会改变
```

不得静默换成当前活动模型。

## 8.4 验收标准

- 任务中途修改 pipelineMode 不改变恢复拓扑；
- 修改阶段 maxTokens 不影响旧任务；
- 修改预设正文不影响旧任务；
- 修改活动模型不影响旧任务；
- 原配置缺失时不会静默回退。

---

# 9. 第六阶段：窗口检查绑定实际请求模型

## 9.1 修改原则

当前阶段检查必须使用实际调用所使用的 requestConfig：

```ts
assertMessagesFitContextWindow({
  messages,
  reservedOutputTokens,
  contextWindow: requestConfig.contextWindow,
  stageLabel,
});
```

不得在检查函数内部重新调用：

```text
getActiveLLMConfig()
```

## 9.2 每阶段独立配置

如果不同阶段使用不同模型：

```text
Draft 使用 draftModel.contextWindow
Review 使用 reviewModel.contextWindow
Fact Check 使用 factCheckModel.contextWindow
Proof 使用 proofModel.contextWindow
```

## 9.3 必须覆盖的请求

```text
Draft 首次
Draft 空正文重试
Review 首次
Review repair
Fact Check 首次
Fact Check repair
Proof
Resume 中的所有阶段
```

## 9.4 验收标准

- 活动模型切换不影响已启动任务；
- 检查窗口与实际 requestConfig 一致；
- 模型窗口未知时 fail-closed；
- 日志显示阶段模型 ID、窗口、输入、输出预留和安全余量。

---

# 10. 第七阶段：建立真正的统一动态预算

## 10.1 当前问题

仅在最后检查是否超窗，会把原本可以通过压缩普通资料解决的任务直接阻断。

## 10.2 顶层预算公式

```text
effectiveWindow
= actualModel.contextWindow
- safetyMargin
```

```text
availableInput
= effectiveWindow
- reservedOutputTokens
- fixedProtocolTokens
```

```text
remainingAfterOutline
= availableInput
- fullOutlineTokens
```

若：

```text
remainingAfterOutline < minimumRequiredCoreTokens
```

则阻断。

## 10.3 分配优先级

建议：

```text
完整大纲
> 当前章节目标
> 近期正文 / seam
> Story Memory
> Episodic Memory
> 人物关键约束
> 世界书关键规则
> 项目笔记
> 风格辅助
```

大纲不裁剪。

普通资料可按剩余预算动态压缩。

## 10.4 阶段差异

### Draft

优先保留：

```text
大纲
当前章节目标
前章接缝
近期正文
```

### Review

优先保留：

```text
完整大纲
待审初稿
章节目标
近期正文
关键人物和世界规则
```

### Fact Check

优先保留：

```text
完整大纲（未来规划）
待核初稿
已发生事实
Story Memory
近期正文
世界书
```

### Proof

优先保留：

```text
完整大纲
待修正文
有效 Review
有效 Fact Check
已发生事实
```

## 10.5 最终检查

动态分配后仍执行最终消息级检查：

```text
estimate(actual messages)
+ reserved output
+ safety margin
<= context window
```

## 10.6 验收标准

- 普通资料先让位；
- 大纲不裁剪；
- 可以通过压缩低优先资料解决时不直接失败；
- 仍超窗时错误说明缺口和建议；
- Preview 展示每分区实际预算。

---

# 11. 第八阶段：严格解析持久化快照

## 11.1 版本化解析

建立：

```ts
parsePipelineTaskContextV1(...)
parsePipelineTaskContextV2(...)
```

未知版本必须拒绝。

## 11.2 必须验证

```text
根节点对象
snapshotVersion
pipelineContextVersion
projectId
chapterId
chapterUpdatedAt
所有必需字符串字段
outlineIds 为 number[]
outlineComplete 为 boolean
outlineEstimatedTokens 为非负有限数
createdAt 为有限时间
hash 正确
```

## 11.3 任务归属

解析时传入：

```ts
{
  expectedProjectId,
  expectedChapterId,
  expectedTaskId,
}
```

不匹配则阻断。

## 11.4 兼容旧任务

```text
无快照：明确不可安全恢复
旧 V1：按 V1 解析
新 V2：读取 draftContext / auditContext / execution
未知版本：拒绝
```

## 11.5 验收标准

- 错项目快照不能恢复；
- 错章节快照不能恢复；
- 缺字段不能恢复；
- 未知版本不能恢复；
- 合法旧版本按兼容规则运行。

---

# 12. 第九阶段：让 Context Preview 等于真实 Draft 请求

## 12.1 抽取公共编译器

建议：

```ts
compileDraftPipelineRequest({
  chapter,
  contextConfig,
  executionSnapshot,
  userPrompt,
  mode: 'preview' | 'generation',
})
```

返回：

```ts
interface CompiledDraftPipelineRequest {
  messages: ChatMessage[];
  pipelineContext: PipelineContextSnapshot;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  contextWindow: number;
  fits: boolean;
  blockingReason?: string;
  allocations: ContextAllocationTrace[];
}
```

## 12.2 共用内容

Preview 和真实运行必须共用：

```text
实际 draft preset
实际模型
实际章节目标
前章结尾
已有正文尾部
本轮用户要求
大纲拼装
普通资料预算
最终窗口检查
```

Preview 模式仅禁止：

```text
创建任务
写数据库
调用模型
更新 Story Memory
```

## 12.3 验收标准

同一输入下：

```text
Preview messages
===
真实 Draft messages
```

允许差异仅是运行态 ID 和时间戳。

---

# 13. 第十阶段：结构化错误全链路

## 13.1 错误类型

继续使用或完善：

```ts
type OutlineContextErrorCode =
  | 'OUTLINE_READ_FAILED'
  | 'OUTLINE_BUDGET_UNKNOWN'
  | 'OUTLINE_OVER_BUDGET'
  | 'OUTLINE_SNAPSHOT_INVALID'
  | 'OUTLINE_MODEL_UNAVAILABLE'
  | 'OUTLINE_SNAPSHOT_PERSIST_FAILED'
  | 'OUTLINE_EXECUTION_CONFIG_INVALID';
```

## 13.2 Builder 行为

超预算不要只返回：

```text
complete = false
blockingReason = ...
```

推荐直接抛结构化错误，或返回显式 Result 类型：

```ts
{ ok: false, error: OutlineContextError }
```

## 13.3 UI 行为

不要使用：

```ts
/大纲.*tokens|超出可用大纲空间/
```

应按：

```ts
error.code
error.userAction
```

映射：

```text
open_outlines
open_llm_settings
restart_task
open_task_center
```

## 13.4 验收标准

- 文案修改不会破坏错误识别；
- Preview、Runner、结果页统一处理；
- 日志保留 code；
- 用户操作按钮由 userAction 决定。

---

# 14. 第十一阶段：边界修复

## 14.1 空正文禁止启用

防线至少三层：

```text
UI
Repository
项目包导入
```

Repository 应执行：

```text
enabled=true 且 content.trim()===''
→ 拒绝
```

## 14.2 模型预算未知

大纲管理页不要显示：

```text
5000 / 0 tokens
```

改为：

```text
当前未配置可用模型，暂无法计算大纲预算
```

并提供“前往模型设置”。

## 14.3 未保存修改确认

编辑器维护 dirty state：

```text
title 或 content 或 enabled 改变
```

返回时弹窗：

```text
继续编辑
放弃修改
保存并返回
```

## 14.4 项目包 position

必须满足：

```ts
Number.isInteger(position)
position >= 0
```

重复位置使用稳定排序：

```text
position ASC
原数组 index ASC
```

## 14.5 项目包空正文启用

若导入项：

```text
enabled = true
content.trim() = ''
```

应拒绝整个导入或规范化为 disabled，并在预览中明确提示。推荐拒绝。

## 14.6 建议关闭算法

不要通过：

```text
总 token - 每份 renderedTokens
```

近似计算。

应对候选前缀重新拼装和重新估算，找出最长可容纳前缀：

```ts
for (let keep = enabled.length; keep >= 0; keep--) {
  const packing = computeOutlinePacking({
    outlines: enabled.slice(0, keep),
    budgetTokens,
  });
  if (packing.complete) return disabledTailIds;
}
```

## 14.7 验收标准

- 空正文从任何入口都不能启用；
- 未配置模型状态清晰；
- 编辑返回不会无提示丢内容；
- 负数和小数 position 被拒绝；
- 关闭建议经过真实重算。

---

# 15. 推荐施工顺序

```text
1. 本地基线与失败测试
2. 专用快照同步落盘
3. 冷启动可恢复状态和任务中心入口
4. full 模式 auditContext 持久化
5. PipelineExecutionSnapshot
6. 窗口检查绑定实际 requestConfig
7. 统一动态预算
8. 严格快照版本和结构校验
9. Preview 复用真实 Draft 编译器
10. OutlineContextError 全链路
11. 空正文、预算未知、dirty state、项目包 position
12. 关闭建议精确重算
13. 完整回归和 Android 构建
```

每一阶段：

```text
补失败测试
→ 最小实现
→ 相关测试
→ 类型检查
→ 完整测试
→ 记录结果
```

---

# 16. 回归测试矩阵

## 16.1 Pipeline 模式

```text
outline + noReview
outline + twoStage
outline + conditional
outline + full
freeform
continuation
```

## 16.2 中断时机

```text
快照写入前
快照写入后、Draft 请求前
Draft 请求中
Draft 成功后、auditContext 前
auditContext 成功后、Review 前
Review 成功后
Fact Check 成功后
Proof 中
```

## 16.3 配置漂移

```text
切换活动模型
删除原模型
修改 contextWindow
修改 pipelineMode
修改阶段 maxTokens
编辑阶段预设
修改大纲
修改人物卡
修改世界书
```

## 16.4 数据异常

```text
快照 JSON 损坏
hash 不匹配
未知 snapshot version
projectId 不匹配
chapterId 不匹配
快照写入失败
大纲读取失败
模型窗口未知
```

## 16.5 UI

```text
任务中心继续任务
不可恢复提示
预算未知
超预算跳转
空正文启用
未保存返回
导入负数 position
导入小数 position
```

---

# 17. 完成定义

- [ ] 第一次 LLM 前快照已同步落盘；
- [ ] 快照写入失败时不调用模型；
- [ ] 冷启动后可恢复任务不会被自动 resolve；
- [ ] 用户有明确 Resume 入口；
- [ ] `full` 模式恢复使用持久化 auditContext；
- [ ] Pipeline 模式、阶段预算、预设和模型已冻结；
- [ ] 窗口检查使用实际 requestConfig；
- [ ] 普通资料会为完整大纲让位；
- [ ] 最终消息仍执行窗口检查；
- [ ] 快照版本、结构和任务归属严格校验；
- [ ] Preview 等于真实 Draft 请求；
- [ ] 错误识别不依赖中文正则；
- [ ] 空正文无法启用；
- [ ] 模型未配置时显示预算未知；
- [ ] 编辑离开有 dirty 确认；
- [ ] 项目包 position 为非负整数；
- [ ] 建议关闭经过真实重算；
- [ ] outline / freeform / continuation 回归通过；
- [ ] 旧数据库升级通过；
- [ ] 全新数据库初始化通过；
- [ ] Jest / TypeScript / Lint / Android 构建通过；
- [ ] 未覆盖用户原有未提交修改。

---

# 18. Agent 最终报告模板

## 本地基线

```text
分支：
起始 HEAD：
结束 HEAD：
开工前 git status：
完工后 git status：
```

## 版本

```text
原 Schema：
新 Schema：
新增迁移：
快照协议原版本：
快照协议新版本：
```

## 核查结果

| 项目 | 是否存在 | 修复方式 | 测试 |
|---|---|---|---|
| 快照写库未 await |  |  |  |
| 冷启动不可恢复 |  |  |  |
| full auditContext 未持久化 |  |  |  |
| 窗口检查模型不一致 |  |  |  |
| Pipeline 配置未冻结 |  |  |  |
| 动态预算不足 |  |  |  |
| 快照校验过弱 |  |  |  |
| Preview 不是真实请求 |  |  |  |
| 错误码未贯穿 |  |  |  |
| 边界问题 |  |  |  |

## 关键设计

```text
快照同步落盘顺序：
冷启动分类规则：
可恢复状态：
auditContext 保存方式：
执行配置冻结方式：
阶段模型窗口来源：
动态预算算法：
快照版本校验：
Preview 公共编译器：
```

## 测试结果

```text
单元测试：
集成测试：
完整 Jest：
TypeScript：
Lint：
Android debug：
Android release：
真机冷启动恢复：
未执行项及原因：
```

## Git

```text
提交列表：
是否推送：
是否创建 PR：
是否混入用户原有修改：
```

---

# 结论

本轮最关键的不是继续增加 UI，而是确保以下四个不变量真正成立：

```text
第一次模型调用前，冻结快照已经可靠落盘
应用被杀后，可恢复任务仍能继续
正常运行和恢复运行使用相同审核上下文
窗口检查与实际请求模型完全一致
```

完成这些修复后，大纲模式的“冻结上下文、全阶段一致、严格预算”才形成真正可发布的闭环。
