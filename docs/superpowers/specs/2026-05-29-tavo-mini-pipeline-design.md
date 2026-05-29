# tavo-mini 多角色流水线编写正文功能 — 设计文档

日期：2026-05-29

## 1. 背景与目标

将 tavo-maker 桌面版的「多角色流水线编写正文」能力移植到 tavo-mini 移动端。该功能通过模拟出版社编辑团队（初稿作者 -> 审阅编辑 + 事实核查员并行 -> 终审校对员）的工作流，使用 4 次独立 LLM 调用生成高质量小说正文，显著优于单次 AI 续写的输出质量。

## 2. 设计约束

| 约束项 | 决策 |
|--------|------|
| 流水线配置范围 | 全局统一（所有项目共用） |
| 执行模式 | 前台异步（不阻塞 UI），用户可切换 Tab |
| 任务持久化 | 内存队列（Zustand），App 重启后清空 |
| 结果决策 | 混合通知（Toast 可点击 + 任务中心 + 章节页 badge） |
| 预设绑定 | 每个阶段绑定一个 Preset（风格 + 模型参数） |
| 审阅/核查 Prompt | 固定角色定义，不依赖 Preset |
| App 切出恢复 | 不自动恢复，回前台后弹 Alert 提示手动检查 |

## 3. 数据模型

### 3.1 新增类型（`src/types/pipeline.ts`）

```typescript
export type PipelineStageName = 'draft' | 'review' | 'factCheck' | 'proof';
export type PipelineTaskStatus = 'idle' | 'drafting' | 'reviewing' | 'proofing' | 'completed' | 'cancelled' | 'failed';

export interface PipelineConfig {
    draftPresetId: number | null;
    reviewPresetId: number | null;
    factCheckPresetId: number | null;
    proofPresetId: number | null;
    draftMaxTokens: number;
    reviewMaxTokens: number;
    factCheckMaxTokens: number;
    proofMaxTokens: number;
}

export interface PipelineStageResult {
    stage: PipelineStageName;
    text: string;
    status: 'success' | 'failed';
    error?: string;
    tokens?: { input: number; output: number; total: number };
    durationMs: number;
}

export interface PipelineTask {
    id: string;
    targetType: 'chapter' | 'freeform';
    targetId: number;
    status: PipelineTaskStatus;
    stageResults: PipelineStageResult[];
    finalText: string | null;
    error: string | null;
    createdAt: number;
    updatedAt: number;
    resolvedAt: number | null;
}
```

### 3.2 流水线配置持久化

`PipelineConfig` 以 JSON 存入 SQLite `settings` 表，key=`pipeline_config`。首次使用时提供默认值：
- 4 个阶段均绑定项目 default Preset
- token 预算：`4000 / 1500 / 1500 / 4000`

## 4. 执行层架构（`src/services/pipelineRunner.ts`）

### 4.1 状态机

```
idle -> drafting -> reviewing --> proofing --> completed
           |         |                      |
           |         \-- factCheck (并行)   |
           |                                |
           \-------- cancelled/failed <------/
```

### 4.2 四阶段执行细节

**Stage 1 -- 初稿作者（串行）**
- 复用 `buildContext()`，传入 `draftPreset`
- system prompt = Preset 内容
- user message 追加角色指令：「你是初稿作者...专注于创造力...」
- 调用 `callLLMResult(draftMaxTokens)`
- 成功 -> `draftText = result`

**Stage 2a -- 审阅编辑（并行）**
- system prompt = 固定审阅角色（不依赖 Preset）
- user message = 初稿文本
- 要求输出 JSON：`{ strengths, issues, suggestions }`
- 调用 `callLLMResult(reviewMaxTokens)`

**Stage 2b -- 事实核查员（并行）**
- system prompt = 固定核查角色
- user message = 初稿文本 + 上下文
- 要求输出 JSON：`{ errors, warnings, confirmed }`
- 调用 `callLLMResult(factCheckMaxTokens)`

**Stage 3 -- 终审校对员（串行）**
- system prompt = 固定终审角色
- user message = 初稿 + 审阅意见/「未能完成」 + 核查结果/「未能完成」
- 调用 `callLLMResult(proofMaxTokens)`
- 成功 -> `finalText = result`；失败 -> 回退到 `draftText`

### 4.3 错误处理

| 场景 | 行为 |
|------|------|
| Stage 1 失败 | 终止，标记 `failed` |
| Stage 2a 或 2b 单个失败 | 记录，继续 Stage 3（降级） |
| Stage 2a + 2b 都失败 | 终止，回退到初稿，标记 `completed`（可采纳初稿） |
| Stage 3 失败 | 回退到初稿，标记 `completed` |

### 4.4 取消机制

`cancelTask(taskId)` 设置 `cancelled = true`。`runPipeline` 每阶段开始前检查，若 true 则提前返回。已发出的 fetch 无法中断，结果丢弃。

## 5. UI 层

### 5.1 触发入口

- `ChapterEditor` toolbar：新增「流水线」按钮（`GitBranch` 图标）
- `FreeformEditor` toolbar：新增「流水线续写」按钮

### 5.2 配置页面（`PipelineConfigScreen`）

从 `SettingsScreen` 进入。4 个阶段卡片，每阶段：
- Preset 下拉选择（从项目 Preset 列表）
- Max Tokens 数字输入

### 5.3 任务中心（`PipelineTaskScreen`）

列表展示所有内存任务：
- 状态指示（进行中 / 已完成 / 已失败）
- 目标章节/文档名称
- 阶段进度（X/4）或耗时
- 「查看进度/结果/详情」入口

底部「清空已完成」按钮。

### 5.4 结果详情页（`PipelineResultScreen`）

顶部：总耗时 + 总 token 消耗

中间：4 个可折叠阶段卡片：
- 初稿/终稿：展示文本，字数 + 用时
- 审阅/核查：格式化 JSON，用时

底部操作：
- 「放弃」-> 标记 resolved，返回任务中心
- 「采纳」-> `mergeChapterGenerationResult()` -> 写库 -> Toast -> 返回编辑器

## 6. 导航注册

`EditorStackParamList` 新增：`PipelineResult: { taskId: string }`

`SettingsStackParamList` 新增：
- `PipelineConfig: undefined`
- `PipelineTask: undefined`

## 7. 通知与交互

### 7.1 Toast 通知

| 时机 | 内容 |
|------|------|
| Stage 1 完成 | 「初稿已完成，正在并行审阅与核查...」 |
| Stage 2 全部完成 | 「审阅与核查完成，正在终审...」 |
| Stage 3 完成 | 「流水线完成！点击查看结果」（可点击跳转） |
| 失败 | 「流水线在第 X 阶段失败：原因」 |

### 7.2 Badge

`SettingsScreen` 的「流水线任务」入口显示未处理/进行中任务数 badge。

### 7.3 App 切出恢复

回到前台时，若检测到 `running` 状态任务，弹出 Alert：「检测到未完成的流水线任务。由于系统限制，切换应用可能导致中断。请检查任务中心确认状态。」不自动恢复执行。

## 8. 文件清单

| 文件 | 动作 | 说明 |
|------|------|------|
| `src/types/pipeline.ts` | 新增 | Pipeline 相关类型定义 |
| `src/store/pipelineTaskStore.ts` | 新增 | Zustand 内存任务队列 |
| `src/services/pipelineRunner.ts` | 新增 | 4 阶段执行核心 |
| `src/services/pipelineMessages.ts` | 新增 | 各阶段 prompt 模板 |
| `src/screens/PipelineConfigScreen.tsx` | 新增 | 配置页面 |
| `src/screens/PipelineTaskScreen.tsx` | 新增 | 任务中心 |
| `src/screens/PipelineResultScreen.tsx` | 新增 | 结果详情页 |
| `src/screens/ChapterEditor.tsx` | 修改 | 新增「流水线」按钮 |
| `src/screens/FreeformEditor.tsx` | 修改 | 新增「流水线续写」按钮 |
| `src/screens/SettingsScreen.tsx` | 修改 | 新增配置入口 + 任务入口 + badge |
| `src/navigation/TabNavigator.tsx` | 修改 | 注册新页面 |
| `src/services/database.ts` | 修改 | 新增 `getPipelineConfig` / `setPipelineConfig` |
