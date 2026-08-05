# Tavo Mini 大纲模式升级缺漏修复方案

> 用途：交给本地编码 Agent，对已经完成的大纲模式升级进行核查、修复和回归验证。  
> 远端审计参考基线：`anjingdtl/tavo-mini` 的 `main` 分支，审计时最新提交为 `b2bb0cf195e2250a529a46681e22813467d56e2b`。  
> **最终事实来源必须是本地仓库，远端代码和本文中的路径、版本号、类型名都只能作为定位线索。**

---

## 1. 任务目标

本次不是重新建设大纲功能，而是在现有实现基础上修复正确性缺口，使“大纲是一等资源、最高创作约束、全流水线共用同一冻结快照”的设计真正成立。

最终应满足：

1. 大纲在 Draft、Review、Fact Check、Proof 四阶段保持同一份完整内容；
2. 大纲不在任何阶段被静默截断；
3. `outlineAssessment` 能被模型输出、校验、保存和展示；
4. 应用退出或任务中断后恢复，仍使用任务启动时的冻结大纲和上下文；
5. 大纲读取失败、预算未知或请求超窗时采用 fail-closed，不得静默退化为“无大纲生成”；
6. 所有输入分区和输出预留受统一模型窗口预算约束；
7. 大纲标题、正文、顺序、启用状态和合同文本变化都能被指纹检测；
8. 管理页、上下文预览和真实流水线使用同一个大纲拼装与 token 计算结果；
9. 非大纲模式、原著续写模式和自由写作模式不得产生行为回归；
10. 所有迁移、协议版本和文件位置都根据本地仓库动态判断。

---

## 2. 施工强制规则

### 2.1 本地仓库优先

Agent 开始前必须记录：

```text
当前分支
当前 HEAD
git status --short
未提交和未跟踪文件
数据库当前 schema 版本
项目包当前协议版本
实际流水线入口
实际任务恢复入口
实际上下文构建入口
当前测试命令
```

决策优先级：

```text
本地运行行为
> 本地数据库和类型约束
> 本地未提交改动
> 本地测试
> 本地现有架构
> 远端 main
> 本文示例
```

禁止：

```text
git reset --hard
git checkout .
git clean -fd
未经判断直接 git pull
覆盖用户现有未提交修改
为了通过测试删除旧测试
通过 any、ts-ignore 或吞异常规避问题
```

### 2.2 动态版本规则

不得假设本地 schema 一定是 37，也不得假设项目包一定是 v4。

若本地当前 schema 为 `N`，需要新增迁移时应创建：

```text
N -> N+1
```

同时更新：

- 迁移注册；
- 当前 schema 常量；
- 全新安装建表路径；
- schema manifest、备份和恢复；
- 历史迁移测试中的版本断言；
- 必要的兼容读取逻辑。

项目包协议同理。仅在数据格式确实发生不兼容变化时递增，不得无意义升版。

### 2.3 先核查、后修改

每个问题都应先确认本地是否已经修复。若本地已有等价实现，不要重复建设。

每项结论必须能回答：

```text
实际入口在哪里？
问题能否在当前代码中复现？
是否存在第二套流水线或旁路入口？
修复会影响哪些模式？
是否需要数据库迁移？
是否需要兼容旧任务或旧项目包？
```

---

## 3. 已识别问题总览

| 优先级 | 问题 | 主要风险 |
|---|---|---|
| P0 | `outlineAssessment` 与 Review 校验器不兼容 | 正确输出会被判失败，评估结果丢失 |
| P0 | Review / Fact Check / Proof 固定裁剪大纲 | 四阶段看到的不是同一份大纲 |
| P0 | PipelineContextSnapshot 未持久化 | 重启恢复后读取新资料或空资料 |
| P0 | 大纲读取异常被吞并返回空上下文 | 大纲模式可能无声地不注入大纲 |
| P0 | 大纲预算未纳入统一模型窗口预算 | 最终请求可能超过 context window |
| P1 | 指纹未覆盖标题和最终拼装文本 | 标题或合同变化可能检测不到 |
| P1 | UI token 与真实拼装 token 不一致 | 管理页显示可用，生成却阻断 |
| P1 | 多条 system 消息兼容性不确定 | 部分兼容接口可能降权或丢失大纲 |
| P1 | 上下文预览不等于真实 Draft 请求 | 用户看到的“实际请求”不真实 |
| P2 | 结果页没有大纲执行报告 | 结构化评估无法直接使用 |
| P2 | 大纲 trace 缺少逐份明细 | 难以定位顺序、版本和超预算来源 |
| P2 | 编辑、导入、排序边界不足 | 空内容、非法顺序、失败明细体验差 |


# 第一阶段：建立本地基线与复现测试

## 4. 阶段目标

在修改生产代码前，建立能稳定暴露问题的失败测试。

## 4.1 必须定位的模块

根据本地结构寻找等价模块，不要强依赖下列路径：

```text
大纲 Repository
大纲拼装和预算 Builder
通用上下文 Builder
Draft / Review / Fact Check / Proof 消息 Builder
审核结果 Validator
Pipeline Runner
Pipeline Task Repository / Store
Resume / Retry / Recovery
Pipeline Result Screen
Context Preview
Resource Library / Outline Management
项目导入导出
数据库迁移和当前 schema
```

远端参考路径：

```text
src/data/repositories/outlineRepository.ts
src/services/outlineContextBuilder.ts
src/services/contextBuilder.ts
src/services/pipelineMessages.ts
src/services/pipelineAuditValidator.ts
src/services/pipelineRunner.ts
src/types/pipelineContext.ts
src/types/pipelineAudit.ts
src/data/repositories/pipelineTaskRepository.ts
src/store/pipelineTaskStore.ts
src/screens/PipelineResultScreen.tsx
src/screens/ContextPreviewScreen.tsx
src/screens/OutlineListBody.tsx
src/services/exportService.ts
src/services/projectImport.ts
```

## 4.2 先补失败测试

至少先写出以下测试，并确认修改前能够失败：

1. 有大纲时，包含 `outlineAssessment` 的 Review JSON 应通过校验；
2. 无大纲时，不带 `outlineAssessment` 的旧格式仍通过；
3. 大纲超过旧的 6000-token 上限时，四阶段仍获得完整大纲，或者明确阻断；
4. Pipeline 任务重启恢复后使用旧快照，而不是当前数据库中的新大纲；
5. `getEnabledOutlinesByProject()` 抛错时，大纲模式生成必须失败；
6. 最终编译请求超过模型窗口时，在 LLM 调用前阻断；
7. 只修改大纲标题时，输入指纹发生变化；
8. 管理 UI 和生成 Pipeline 对同一组大纲计算出相同 token 与关闭建议。


# 第二阶段：修复 `outlineAssessment` 数据契约

## 5. 问题说明

当前 Review Prompt 在存在大纲时要求返回：

```json
{
  "strengths": [],
  "issues": [],
  "suggestions": [],
  "outlineAssessment": {
    "status": "aligned",
    "fulfilledBeats": [],
    "missingBeats": [],
    "deviations": [],
    "prematureBeats": [],
    "factRollbackRisks": []
  }
}
```

但旧 Review Validator 通常只允许：

```text
strengths
issues
suggestions
```

结果是模型按要求返回新字段后反而被判定为非法。

## 5.1 类型定义

在本地审核类型中增加等价定义：

```ts
export type OutlineAssessmentStatus =
  | 'aligned'
  | 'partial'
  | 'deviated'
  | 'over_advanced';

export interface OutlineAssessment {
  status: OutlineAssessmentStatus;
  fulfilledBeats: string[];
  missingBeats: string[];
  deviations: string[];
  prematureBeats: string[];
  factRollbackRisks: string[];
}

export interface ReviewReport {
  strengths: string[];
  issues: string[];
  suggestions: string[];
  outlineAssessment?: OutlineAssessment;
}
```

## 5.2 校验规则

### 有大纲时

建议 `outlineAssessment` 必填，避免模型忽略大纲核查任务。

必须校验：

```text
根节点是对象
仅允许约定字段
status 为枚举值
五个明细字段必须是数组
数组元素必须是非空字符串
不得塞入大段正文
不得出现未知字段
```

### 无大纲时

保持旧格式兼容：

```text
outlineAssessment 可缺省
若出现，也可以选择拒绝或忽略
```

推荐拒绝无大纲时的 `outlineAssessment`，因为这通常表示模型误判。

## 5.3 修复提示词同步

Review 首次请求和格式修复请求必须使用相同 schema。

有大纲时，repair prompt 不得再要求只有三个旧字段。无大纲时仍使用旧格式。

## 5.4 结果持久化和展示

确认以下链路不丢字段：

```text
LLM 原始结果
→ Validator normalizedText
→ Pipeline stage result
→ SQLite
→ Store 冷启动加载
→ 结果页解析
```

建议结果页增加独立卡片：

```text
大纲一致性状态
已完成节点
遗漏节点
偏离主线
提前发生节点
历史回滚风险
```

不要只显示原始 JSON。

## 5.5 验收标准

- 正确的 `outlineAssessment` 不再触发格式重试；
- 非法状态值或非法数组元素会被拒绝；
- repair 后仍保留 `outlineAssessment`；
- 任务重启后结果页仍能显示大纲评估；
- 无大纲项目的旧 Review 行为不变。


# 第三阶段：取消后续阶段的大纲静默截断

## 6. 问题说明

大纲在 Draft 构建时可能完整注入，但 Review、Fact Check、Proof 又用固定值裁剪，例如：

```ts
outline: 6000
```

这违反：

```text
同一任务四阶段共享同一冻结大纲
大纲不能静默截断
```

## 6.1 禁止的修复方式

不要只把常量从 6000 改成 12000 或更大。

固定常量无法适配不同模型窗口、输出预留、初稿长度和阶段 Prompt。

## 6.2 推荐实现：阶段请求编译器

为每个阶段建立统一编译流程：

```ts
compileStageRequest({
  stage,
  model,
  frozenContext,
  draftText,
  reviewText,
  factCheckText,
  maxOutputTokens,
})
```

输出：

```ts
interface CompiledStageRequest {
  messages: ChatMessage[];
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  effectiveContextWindow: number;
  fits: boolean;
  blockingReason?: string;
  allocations: StageAllocationTrace[];
}
```

预算优先级建议：

```text
协议和 system 规则
> 完整大纲
> 当前已发生事实和近期正文
> 当前章节目标
> 初稿或待修正文
> 审核报告
> 角色卡 / 世界书
> 笔记和风格辅助
```

大纲不得裁剪。若无法完整放入：

```text
先压缩或省略低优先级普通资料
仍不足则阻断该阶段
```

## 6.3 阶段要求

### Review

必须完整看到大纲、待审初稿、当前章节目标和必要事实。

### Fact Check

完整大纲用于识别“未来规划”，但事实依据仍是正文、近期桥接、Story Memory、Episodic Memory、世界书和人物状态。

### Proof

必须完整看到大纲、待修初稿、有效 Review、有效 Fact Check 和核心事实约束。

若 Proof 无法容纳完整大纲和待修正文，不得静默裁大纲。应阻断并保留初稿，给出明确错误。

## 6.4 验收标准

- 大纲不再经过通用 `clip()`；
- 四阶段使用的 `outlineText` 字节级一致；
- 超窗时在模型调用前失败；
- 错误信息说明阶段、缺少 token 和用户可采取的操作；
- 非大纲项目不增加不必要阻断。


# 第四阶段：持久化完整 PipelineContextSnapshot

## 7. 问题说明

只在内存中保存大纲快照无法支持应用被杀、退出、暂停和任务恢复。恢复时重新调用 `buildContext()` 会读取当前资料，不是任务启动时的资料。

## 7.1 数据库设计

根据本地 schema 动态新增字段。推荐至少：

```sql
ALTER TABLE pipeline_tasks
ADD COLUMN pipeline_context_json TEXT;

ALTER TABLE pipeline_tasks
ADD COLUMN pipeline_context_version INTEGER;

ALTER TABLE pipeline_tasks
ADD COLUMN pipeline_context_hash TEXT;
```

如果本地已有通用任务快照表，应优先复用。

### 推荐快照结构

```ts
interface PersistedPipelineContextSnapshotV1 {
  version: 1;

  presetText: string;
  storyMemoryText: string;
  characterText: string;
  noteText: string;
  worldbookText: string;
  episodicMemoryText: string;
  recentBridgeText: string;
  currentInstructionText: string;
  retrievalUserPrompt: string;

  outlineText: string;
  outlineFingerprint: string;
  outlineIds: number[];
  outlineVersions?: Array<{
    id: number;
    position: number;
    updatedAt: number;
    hash: string;
  }>;
  outlineComplete: boolean;
  outlineEstimatedTokens: number;

  projectId: number;
  chapterId: number;
  chapterUpdatedAt: string | number;
  selectedPresetIds?: {
    draft?: number | null;
    review?: number | null;
    factCheck?: number | null;
    proof?: number | null;
  };

  createdAt: number;
}
```

## 7.2 保存时机

推荐在 Draft 的 `buildContext()` 成功后、第一次 LLM 调用前持久化：

```text
构建冻结快照
→ 序列化并计算 hash
→ 保存到任务
→ 编译 Draft 请求
→ 调用模型
```

## 7.3 恢复规则

```text
有合法快照
→ 必须直接读取快照
→ 不重新读取当前大纲替换它
```

```text
无快照的旧任务
→ 不得静默假装一致
→ 显示兼容提示
→ 允许重新开始，或明确选择“按当前资料恢复”
```

```text
快照 JSON 损坏
→ 阻止恢复
→ 保留已有 Draft 和结果
→ 给出可操作错误
```

## 7.4 指纹基线

输入指纹基线应来自任务启动时保存的快照，不能在任务终态才重新读取当前大纲。

## 7.5 验收场景

1. 启动任务并完成 Draft；
2. 修改、关闭、删除或排序大纲；
3. 杀掉应用进程；
4. 重启并恢复任务。

期望：

```text
Review / Fact Check / Proof 仍使用旧冻结快照
采纳时提示当前资料已经变化
下一次新任务读取新大纲
```


# 第五阶段：大纲读取和模型配置改为 fail-closed

## 8.1 明确区分三种情况

### 合法空大纲

```text
项目不是 outline 模式
或
outline 模式但没有启用任何大纲
```

可返回空大纲上下文。

### 配置问题

```text
未配置活动模型
context_window 非法
无法确定阶段模型
```

真实生成时应阻断并提示配置模型。

上下文预览可显示“预算未知”，但不能把预算 0 当作无限制。

### 数据异常

```text
查询表失败
迁移缺失
数据库损坏
Repository 抛错
项目读取失败
```

必须抛出明确错误并阻止生成。

## 8.2 建议错误类型

```ts
class OutlineContextError extends Error {
  code:
    | 'OUTLINE_READ_FAILED'
    | 'OUTLINE_BUDGET_UNKNOWN'
    | 'OUTLINE_OVER_BUDGET'
    | 'OUTLINE_SNAPSHOT_INVALID';
  userAction?: 'open_outlines' | 'open_llm_settings' | 'restart_task';
}
```

UI 不要通过正则匹配中文错误，应使用结构化 `code`。

## 8.3 验收标准

- Repository 抛错时不会发出 LLM 请求；
- 无活动模型时真实生成不会绕过预算检查；
- 预览页能区分无大纲、预算未知、读取失败和超预算；
- continuation 和 freeform 行为不变。


# 第六阶段：建立统一的模型窗口预算

## 9.1 统一顶层公式

```text
effectiveContextWindow
= model.contextWindow
- providerSafetyMargin
```

```text
availableInputTokens
= effectiveContextWindow
- reservedOutputTokens
- fixedProtocolTokens
```

其中：

```text
reservedOutputTokens = 当前阶段真实 max output
fixedProtocolTokens = system 合同、JSON schema、角色说明等固定提示
```

然后：

```text
完整大纲先占用
→ 当前正文与历史事实
→ 当前章节目标
→ 普通资料按剩余预算分配
```

## 9.2 Draft 分配原则

不是直接预留固定 30%，而是：

```ts
outlineRequiredTokens = exactStitchedOutlineTokens;
remaining = availableInputTokens - outlineRequiredTokens;
```

若 `remaining < minimumRequiredNonOutlineTokens`，阻断并说明原因。

普通资料建议优先级：

```text
近期正文 / seam
Story Memory
Episodic
角色 / 世界书
笔记 / 风格辅助
```

## 9.3 最终编译检查

每次调用 LLM 前必须执行：

```ts
const actualInput = estimateTokensFromMessages(messages);

if (
  actualInput +
  reservedOutputTokens +
  safetyMargin >
  contextWindow
) {
  throw new ContextWindowExceededError(...);
}
```

必须覆盖：

```text
Draft
Review
Fact Check
Proof
格式修复重试
Draft 空正文重试
Resume 重跑
```

## 9.4 安全余量

推荐：

```text
max(512 tokens, contextWindow 的 3%～5%)
```

具体值应结合本地 tokenizer 和模型适配层判断。

## 9.5 验收标准

- 任一阶段最终请求满足窗口约束；
- 大纲存在时普通资料预算相应减少；
- 大纲不因普通资料占满预算而被裁剪；
- 输出预留不会被大纲挤占；
- 重试请求重新执行窗口检查。


# 第七阶段：统一大纲拼装、token 和指纹

## 10.1 单一权威函数

建议建立纯函数：

```ts
computeOutlinePacking({
  outlines,
  budgetTokens,
  contractVersion,
})
```

返回：

```ts
interface OutlinePackingResult {
  stitchedText: string;
  totalTokens: number;
  sharedOverheadTokens: number;
  items: Array<{
    id: number;
    title: string;
    position: number;
    contentTokens: number;
    renderedTokens: number;
    renderedText: string;
    contentHash: string;
  }>;
  fingerprint: string;
  complete: boolean;
  overageTokens: number;
  suggestedDisableIds: number[];
}
```

以下模块必须共用：

```text
Pipeline
Context Preview
Outline Management
超预算关闭建议
测试
指纹计算
```

## 10.2 指纹建议

```ts
fingerprint = sha256(
  contractVersion + '
' + stitchedText
);
```

覆盖：

```text
标题变化
正文变化
顺序变化
启用集合变化
合同规则变化
渲染格式变化
```

## 10.3 关闭建议

应基于每份大纲完整渲染 token，而不是仅正文 token。

从最低优先级尾部开始建议关闭，保留列表前缀。

## 10.4 验收标准

- 标题变化改变指纹；
- 合同版本变化改变指纹；
- UI 与 Pipeline token 完全一致；
- 关闭建议保证剩余内容确实可放入；
- 多份同名或同内容大纲稳定区分。


# 第八阶段：统一 system 消息和 Provider 行为

## 11.1 推荐编译方式

将最高优先约束合并成首条 system：

```text
【项目大纲合同】
...

【项目大纲正文】
...

【写作预设】
...
```

优先级语义：

```text
不可回滚的已发生事实
> 项目大纲对未来剧情的规划
> 当前章节执行目标
> 用户本轮要求
> 普通资料
```

如果本地 LLM 适配层已经统一合并连续 system 消息，可在适配层实现；否则在 Pipeline 编译阶段生成单一 system。

## 11.2 验收标准

- 实际发出的首条 system 包含大纲合同；
- Provider 不会收到行为不确定的连续 system；
- 无大纲项目保持原预设行为；
- 上下文预览展示最终合并请求。


# 第九阶段：让上下文预览等于真实请求

## 12.1 抽取公共请求编译函数

建议：

```ts
compileDraftPipelineRequest({
  chapter,
  project,
  contextConfig,
  pipelineConfig,
  selectedPreset,
  modelConfig,
  userPrompt,
  mode: 'preview' | 'generation',
})
```

生成和预览必须调用同一函数。

预览模式只禁止：

```text
LLM 调用
数据库写入
Story Memory 重建
任务创建
```

不能改变请求内容。

## 12.2 预览内容

建议显示：

```text
最终消息列表
最终 input token
输出预留
安全余量
模型窗口
是否可发送
大纲总 token
每份大纲 token 和顺序
普通资料分配
阻断原因
```

## 12.3 逐份大纲 trace

增加大纲汇总 trace 和每份大纲独立 trace。每份显示：

```text
标题
ID
顺序
token
内容 hash / 版本
是否启用
是否建议关闭
```

## 12.4 验收标准

同一章节、同一配置下：

```text
预览 messages
===
真实 Draft 调用 messages
```

允许差异只能是运行态元数据，不能是 Prompt 内容。


# 第十阶段：编辑、导入和排序防御性增强

## 13.1 编辑器

建议规则：

```text
空标题：自动使用“未命名大纲”或阻止保存
空正文：可以保存为草稿，但不能启用
返回时有未保存修改：确认放弃
保存中禁止重复点击
启用后编辑成空正文：自动关闭或阻止保存
```

## 13.2 TXT 导入

保留：

```text
多文件
部分成功
新导入默认关闭
同名不静默覆盖
编码自动识别
```

补充：

```text
显示每个失败文件和原因
限制或校验文本类型
过大文件提前提示
空文件拒绝
数据库写入失败不影响其他文件
```

## 13.3 排序

`reorderOutlines(projectId, orderedIds)` 应验证：

```text
无重复 ID
ID 全部属于当前项目
传入集合等于项目全部大纲集合
数量完全一致
```

否则抛错，不要部分更新。

## 13.4 项目包导入

严格验证：

```text
title 为字符串
content 为字符串
enabled 可规范化为布尔
position 为有限非负整数
source_type 在白名单内
重复 position 使用稳定排序
异常数据不写入数据库
```

旧项目包无 outlines 时保持兼容。

## 13.5 验收标准

- 空正文大纲不能被启用；
- 导入失败明细可见；
- 非法排序不会造成重复 position；
- 导入异常按本地事务策略回滚；
- 合法旧项目包正常导入。


# 第十一阶段：迁移、兼容与回滚

## 14.1 快照迁移

若新增快照字段：

```text
纯 ADD COLUMN
默认 NULL
旧任务保持可读取
```

冷启动加载：

```text
NULL = legacy task
合法 JSON = frozen snapshot
非法 JSON = snapshot corrupted
```

不得把非法 JSON 当空快照。

## 14.2 schema manifest

确认并同步：

```text
备份列清单
恢复顺序
完整性检查
全新安装 schema
历史迁移测试
```

## 14.3 项目包版本

本次修复主要影响任务运行态，通常不需要项目包升版。

只有项目业务数据格式发生不兼容变化时才升版。`pipeline_tasks` 一般不属于项目导出，不应为快照字段随意升版。

## 14.4 回滚

迁移应向前兼容、纯追加：

```text
旧代码可忽略新增 nullable 字段
新代码可读取旧任务 NULL 字段
```


# 第十二阶段：测试计划

## 15.1 单元测试

### Review Validator

- 有大纲 + 合法 `outlineAssessment`；
- 缺失必需字段；
- 非法 status；
- 数组出现对象、数字、空字符串；
- 未知字段；
- 大段 Draft 回显；
- repair prompt schema 正确。

### Outline Packing

- 标题、正文、合同和分隔符都计 token；
- 顺序稳定；
- 同位置按 ID 兜底；
- 指纹覆盖标题；
- 指纹覆盖顺序；
- 指纹覆盖合同版本；
- 关闭建议保证剩余内容可放入。

### Budget

- Draft、Review、Fact Check、Proof 正常；
- 每个阶段超窗阻断；
- 格式修复重试超窗阻断；
- 安全余量生效；
- 大纲优先，普通资料先压缩。

### Snapshot

- 序列化/反序列化；
- hash 校验；
- legacy NULL；
- 损坏 JSON；
- 冷启动 Store 恢复；
- 中途修改资料不改变冻结快照。

## 15.2 集成测试

1. 创建 outline 项目；
2. 导入三份大纲；
3. 启用两份并排序；
4. 启动 full Pipeline；
5. Draft 完成后修改大纲；
6. 模拟应用重启；
7. 恢复 Review、Fact Check、Proof；
8. 验证四阶段大纲文本一致；
9. 采纳时显示资料变化提醒。

## 15.3 回归测试

```text
outline + noReview
outline + twoStage
outline + conditional
outline + full
continuation
freeform
旧数据库升级
全新数据库初始化
旧任务恢复
旧项目包导入
v4 大纲项目包往返
```

## 15.4 UI 测试

- 超预算管理页；
- 预算未知；
- 读取失败；
- 上下文预览跳转大纲管理；
- 导入部分失败；
- 未保存编辑确认；
- 结果页大纲执行报告；
- 小屏幕长标题和大量大纲列表。


# 第十三阶段：推荐施工顺序

```text
阶段 0：本地基线和失败测试
阶段 1：outlineAssessment 类型、校验、repair
阶段 2：统一 Outline Packing 和指纹
阶段 3：取消三阶段大纲裁剪
阶段 4：统一模型窗口预算和最终请求检查
阶段 5：持久化 PipelineContextSnapshot
阶段 6：恢复流程改读冻结快照
阶段 7：大纲读取 fail-closed
阶段 8：合并 system 消息
阶段 9：真实请求预览和逐份 trace
阶段 10：结果页结构化大纲报告
阶段 11：编辑、导入、排序防御性增强
阶段 12：完整回归、迁移和发布检查
```

每阶段执行：

```text
先补测试
→ 修改最小实现
→ 跑相关测试
→ 跑类型检查
→ 跑完整测试
→ 记录结果
```


# 第十四阶段：建议修改点清单

以下仅为远端结构参考，本地路径不同则以本地为准。

## 数据和类型

```text
PipelineContextSnapshot
PipelineTask
ReviewReport
OutlineAssessment
迁移文件
当前 schema
schema manifest
pipeline task repository
pipeline task store
```

## 大纲

```text
outline repository
outline packing / context builder
outline import
outline management UI
```

## 流水线

```text
context builder
pipeline message builders
pipeline audit validator
pipeline runner
resume / retry
LLM request compiler / caller
```

## UI

```text
context preview
pipeline result
resource library
outline editor
batch import result
```

## 导入导出

```text
project import parser
project import validator
project export
```


# 第十五阶段：完成定义

- [ ] `outlineAssessment` 全链路可用；
- [ ] 四阶段不静默截断大纲；
- [ ] 任一阶段超窗都会在 LLM 调用前阻断；
- [ ] Pipeline 快照已经持久化；
- [ ] 任务恢复使用旧冻结快照；
- [ ] 大纲读取错误不再静默降级；
- [ ] 模型配置未知时真实生成会阻断；
- [ ] 顶层输入预算包含大纲；
- [ ] 最终消息加输出预留不超过模型窗口；
- [ ] 指纹覆盖标题、正文、顺序和合同版本；
- [ ] UI 与 Pipeline 使用统一 token 计算；
- [ ] 预览等于真实 Draft 请求；
- [ ] 结果页有大纲执行报告；
- [ ] 排序和外部导入有严格校验；
- [ ] outline、continuation、freeform 回归通过；
- [ ] 旧数据库和新数据库测试通过；
- [ ] 完整测试套件通过；
- [ ] 没有引入无关改动；
- [ ] 未覆盖用户原有未提交修改。


# 第十六阶段：Agent 最终施工报告模板

## 1. 本地基线

```text
分支：
起始 HEAD：
结束 HEAD：
开工前 git status：
完工后 git status：
```

## 2. 版本变化

```text
原 schema：
新 schema：
新增迁移：
项目包协议是否变化：
原因：
```

## 3. 实际问题核查

| 问题 | 本地是否存在 | 修复方式 | 测试 |
|---|---|---|---|
| outlineAssessment 校验冲突 |  |  |  |
| 后续阶段裁剪大纲 |  |  |  |
| 快照未持久化 |  |  |  |
| 读取异常静默降级 |  |  |  |
| 全局预算超配 |  |  |  |
| 指纹不完整 |  |  |  |
| UI token 不一致 |  |  |  |
| system 多消息 |  |  |  |
| 预览不等于真实请求 |  |  |  |

## 4. 修改文件

```text
文件：
修改目的：
```

## 5. 最终预算算法

说明：

```text
模型窗口
输出预留
安全余量
固定协议
完整大纲
其余分区分配
最终编译校验
```

## 6. 快照与恢复

说明：

```text
保存时机
保存字段
版本和 hash
旧任务兼容
损坏快照处理
恢复读取规则
```

## 7. 测试结果

```text
单元测试：
集成测试：
完整测试：
类型检查：
Lint：
Android 构建：
真机或模拟器：
未执行项目及原因：
```

## 8. 已知问题

```text
问题：
影响：
临时处理：
建议后续：
```

## 9. Git 操作

```text
是否提交：
提交列表：
是否推送：
是否创建 PR：
是否混入用户原有改动：
```

---

## 结论

本轮修复的核心不是继续增加大纲功能数量，而是确保以下三条系统级不变量真正成立：

```text
大纲完整，不静默截断
同一任务全阶段使用同一冻结快照
所有请求都受真实模型窗口统一约束
```

只有这三条和 `outlineAssessment` 的完整数据链路修复后，大纲模式才具备稳定发布条件。
