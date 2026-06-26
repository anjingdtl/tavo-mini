# 中低危 BUG 全面修复计划

> 日期：2026-06-26
># 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

|# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 build# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
|# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) |# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
|# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolved# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 fact# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'fact# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 '# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyze# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voice# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogue# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # |# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudio# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigation# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSup# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup |# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
|# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | started# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 |# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| Freeform# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| Resource# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save +# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenter# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch |# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 |# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | Context# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | ContextConfig.tsx | Number() \|\| 默认值误判 0 | 改 ?? |
| 10.5 | Draft# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | ContextConfig.tsx | Number() \|\| 默认值误判 0 | 改 ?? |
| 10.5 | DraftPreviewScreen.tsx | formatTime 未校验 Invalid Date | 加 isNaN 判断 |
| 10.6 | PipelineConfigScreen.tsx# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | ContextConfig.tsx | Number() \|\| 默认值误判 0 | 改 ?? |
| 10.5 | DraftPreviewScreen.tsx | formatTime 未校验 Invalid Date | 加 isNaN 判断 |
| 10.6 | PipelineConfigScreen.tsx | parseInt 空字符串卡住 | 允许空临时态 |
| 10.7 | ChapterEditor.tsx | seenTerminalRef# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | ContextConfig.tsx | Number() \|\| 默认值误判 0 | 改 ?? |
| 10.5 | DraftPreviewScreen.tsx | formatTime 未校验 Invalid Date | 加 isNaN 判断 |
| 10.6 | PipelineConfigScreen.tsx | parseInt 空字符串卡住 | 允许空临时态 |
| 10.7 | ChapterEditor.tsx | seenTerminalRef 永不清理 | cleanup 中清空 |
| 10.8 | ContextPreviewScreen.tsx | 颜色硬编码 | 接入# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | ContextConfig.tsx | Number() \|\| 默认值误判 0 | 改 ?? |
| 10.5 | DraftPreviewScreen.tsx | formatTime 未校验 Invalid Date | 加 isNaN 判断 |
| 10.6 | PipelineConfigScreen.tsx | parseInt 空字符串卡住 | 允许空临时态 |
| 10.7 | ChapterEditor.tsx | seenTerminalRef 永不清理 | cleanup 中清空 |
| 10.8 | ContextPreviewScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.9 | ContextPreviewScreen.tsx | keyExtractor 用下标 | 用内容 hash |
| 10.10# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | ContextConfig.tsx | Number() \|\| 默认值误判 0 | 改 ?? |
| 10.5 | DraftPreviewScreen.tsx | formatTime 未校验 Invalid Date | 加 isNaN 判断 |
| 10.6 | PipelineConfigScreen.tsx | parseInt 空字符串卡住 | 允许空临时态 |
| 10.7 | ChapterEditor.tsx | seenTerminalRef 永不清理 | cleanup 中清空 |
| 10.8 | ContextPreviewScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.9 | ContextPreviewScreen.tsx | keyExtractor 用下标 | 用内容 hash |
| 10.10 | UpgradeScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.11 | UsageStatsScreen.tsx | useState<any> | 定义# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | ContextConfig.tsx | Number() \|\| 默认值误判 0 | 改 ?? |
| 10.5 | DraftPreviewScreen.tsx | formatTime 未校验 Invalid Date | 加 isNaN 判断 |
| 10.6 | PipelineConfigScreen.tsx | parseInt 空字符串卡住 | 允许空临时态 |
| 10.7 | ChapterEditor.tsx | seenTerminalRef 永不清理 | cleanup 中清空 |
| 10.8 | ContextPreviewScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.9 | ContextPreviewScreen.tsx | keyExtractor 用下标 | 用内容 hash |
| 10.10 | UpgradeScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.11 | UsageStatsScreen.tsx | useState<any> | 定义接口 |
| 10.12 | FreeformEditor.tsx | FlatList 嵌套 ScrollView | 改 ScrollView + map |
| 10# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | ContextConfig.tsx | Number() \|\| 默认值误判 0 | 改 ?? |
| 10.5 | DraftPreviewScreen.tsx | formatTime 未校验 Invalid Date | 加 isNaN 判断 |
| 10.6 | PipelineConfigScreen.tsx | parseInt 空字符串卡住 | 允许空临时态 |
| 10.7 | ChapterEditor.tsx | seenTerminalRef 永不清理 | cleanup 中清空 |
| 10.8 | ContextPreviewScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.9 | ContextPreviewScreen.tsx | keyExtractor 用下标 | 用内容 hash |
| 10.10 | UpgradeScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.11 | UsageStatsScreen.tsx | useState<any> | 定义接口 |
| 10.12 | FreeformEditor.tsx | FlatList 嵌套 ScrollView | 改 ScrollView + map |
| 10.13 | RevisionHistoryScreen.tsx | restore 无 isMounted | 加 isMountedRef |
| 10.14 |# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | ContextConfig.tsx | Number() \|\| 默认值误判 0 | 改 ?? |
| 10.5 | DraftPreviewScreen.tsx | formatTime 未校验 Invalid Date | 加 isNaN 判断 |
| 10.6 | PipelineConfigScreen.tsx | parseInt 空字符串卡住 | 允许空临时态 |
| 10.7 | ChapterEditor.tsx | seenTerminalRef 永不清理 | cleanup 中清空 |
| 10.8 | ContextPreviewScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.9 | ContextPreviewScreen.tsx | keyExtractor 用下标 | 用内容 hash |
| 10.10 | UpgradeScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.11 | UsageStatsScreen.tsx | useState<any> | 定义接口 |
| 10.12 | FreeformEditor.tsx | FlatList 嵌套 ScrollView | 改 ScrollView + map |
| 10.13 | RevisionHistoryScreen.tsx | restore 无 isMounted | 加 isMountedRef |
| 10.14 | PipelineConfigScreen.tsx | useEffect 无 cleanup | 加 isMountedRef |

### Phase 11：死代码清理与性能优化（9 项）

| # |# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | ContextConfig.tsx | Number() \|\| 默认值误判 0 | 改 ?? |
| 10.5 | DraftPreviewScreen.tsx | formatTime 未校验 Invalid Date | 加 isNaN 判断 |
| 10.6 | PipelineConfigScreen.tsx | parseInt 空字符串卡住 | 允许空临时态 |
| 10.7 | ChapterEditor.tsx | seenTerminalRef 永不清理 | cleanup 中清空 |
| 10.8 | ContextPreviewScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.9 | ContextPreviewScreen.tsx | keyExtractor 用下标 | 用内容 hash |
| 10.10 | UpgradeScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.11 | UsageStatsScreen.tsx | useState<any> | 定义接口 |
| 10.12 | FreeformEditor.tsx | FlatList 嵌套 ScrollView | 改 ScrollView + map |
| 10.13 | RevisionHistoryScreen.tsx | restore 无 isMounted | 加 isMountedRef |
| 10.14 | PipelineConfigScreen.tsx | useEffect 无 cleanup | 加 isMountedRef |

### Phase 11：死代码清理与性能优化（9 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 11.1 | contextBuilder.ts | {{user}} 永远是# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | ContextConfig.tsx | Number() \|\| 默认值误判 0 | 改 ?? |
| 10.5 | DraftPreviewScreen.tsx | formatTime 未校验 Invalid Date | 加 isNaN 判断 |
| 10.6 | PipelineConfigScreen.tsx | parseInt 空字符串卡住 | 允许空临时态 |
| 10.7 | ChapterEditor.tsx | seenTerminalRef 永不清理 | cleanup 中清空 |
| 10.8 | ContextPreviewScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.9 | ContextPreviewScreen.tsx | keyExtractor 用下标 | 用内容 hash |
| 10.10 | UpgradeScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.11 | UsageStatsScreen.tsx | useState<any> | 定义接口 |
| 10.12 | FreeformEditor.tsx | FlatList 嵌套 ScrollView | 改 ScrollView + map |
| 10.13 | RevisionHistoryScreen.tsx | restore 无 isMounted | 加 isMountedRef |
| 10.14 | PipelineConfigScreen.tsx | useEffect 无 cleanup | 加 isMountedRef |

### Phase 11：死代码清理与性能优化（9 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 11.1 | contextBuilder.ts | {{user}} 永远是"读者" | 读取 user_name setting |
| 11.2 | chapterGeneration.ts | mergeChapterGeneration# 中低危 BUG 全面修复计划

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中低危 BUG
> 前置：已完成 Phase 1-6 共 40 个高危/中危修复（见 2026-06-26-full-project-bugfix-design.md）

## 一、审查概况

通过 3 个并行审查 agent 对 AI 管线、状态管理导航、屏幕层共 60+ 文件做深度静态分析，共发现 **95 个剩余问题**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线 (contextBuilder/pipelineRunner/llm/...) | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层 (25 个屏幕) | 30 | 10 | 40 |
| **合计** | **52** | **43** | **95** |

## 二、修复原则

1. **全面覆盖**：所有 95 个 BUG 全部修复
2. **不过度重构**：只修 BUG，不改 API 签名、不做架构调整
3. **增量验证**：每 Phase 测试通过才进下一步
4. **每 Phase 独立 commit**：确保可回滚
5. **死代码谨慎删除**：仅删确认无调用方的导出

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式 query 全空，LLM 检索根本不调用 | 透传 chapter.title/synopsis 进 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞，任务误标 failed/completed | 各阶段 catch 先判 aborted，取消则 cancelTask |
| 7.3 | pipelineRunner.ts | resume durationMs 写成时间戳(1.7e12) | 每阶段记录 start，写 Date.now()-start |
| 7.4 | llm.ts | 取消文案硬编码"朗读已取消"，管线场景误导 | 改为通用"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖 system_prompt/writing_style/extra_instructions | 对 resolvedSystemPrompt 也调 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿正文 | ensureTargetChapters 只挑无 content 的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²) 字符串前插 | 先反向累计找 startIdx，最后 slice |
| 7.8 | contextBuilder.ts | `||` 误用导致 max_tokens=0 被回退默认值 | 改 `??` |
| 7.9 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断 | 改用 reviewText.trim() 判空 |
| 7.10 | pipelineRunner.ts | conditional 模式 factCheck 阶段状态显示"审阅中" | 新增 'factChecking' 状态语义 |
| 7.11 | summaryGenerator.ts | generateSummary 不带 config，scenario 回退 'chat' | 传 { scenario:'chapter_summary', projectId } |
| 7.12 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容 | 入口判空，空内容直接返回 EMPTY_PROFILE |
| 7.13 | noteRetriever.ts | extractContextWindow 大小写敏感 | toLowerCase 后 indexOf |
| 7.14 | pipelineRunner.ts | resolvePreset 静默回退 presets[0] | 找不到时 Toast 提示 |
| 7.15 | batchChapterPipeline.ts | parseOutlineTitle 取冒号前段丢标题 | 优先匹配显式标题正则 |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf | 0 当无效，不混用 indexOf |

### Phase 8：状态管理与导航修复（30 项）

#### 中危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱，字段被静默清空 | 每帧同步 fieldsRef，emitChange 只合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，DB 异常卡白屏 | 包 try-catch + 错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态，isPlaying 永久卡死 | speak 前注册 done 监听 |
| 8.4 | voiceStore.ts | stop() 未 try-catch cancelTts | 包 try-catch + finally 清理 |
| 8.5 | main/index.tsx | 多 task 完成时旧 task 被覆盖 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB 吞错，DB 故障无反馈 | catch 中 console.warn + 保留 _loaded:false |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节"，freeform 误导 | 按 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享 | 改 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups | 切换时重新 parse |
| 8.10 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 8.11-8.13 | CharacterEditor.tsx | groups/greetings/tags 用 index 作 key | 用稳定 key |
| 8.14 | GenerationResultModal.tsx | taskId=null 提前返回导致 visible 状态脱节 | 改 Modal visible={visible && !!taskId} |
| 8.15 | TabNavigator.tsx | PipelineResult 重复注册 | 仅在一个 Stack 注册 |

#### 低危 15 项

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.16 | pipelineTaskStore.ts | taskIdCounter 粗糙估算 | 从已有 ID 解析最大 counter |
| 8.17 | projectStore.ts | loadProjects 无 catch | 补 catch |
| 8.18 | projectStore.ts | loadProjects 回退未同步 DB | 回退时写 setSetting |
| 8.19 | settingsStore.ts | loadSettings 无 try-catch | 包 try-catch |
| 8.20 | voiceStore.ts | TtsAudioEmitter 模块顶层注册 | 提供 setup() 或用 subscription ref |
| 8.21 | voiceStore.ts | setMiniMaxApiKey 死代码 | 删除 |
| 8.22 | GenerationResultModal.tsx | 死代码无引用 | 确认后删除 |
| 8.23 | navigationRef.ts | taskId 覆盖 | 维护 pending 队列 |
| 8.24 | pipelinePromptSuppression.ts | 内存泄漏 | 终态时清理 |
| 8.25 | main/index.tsx | setTimeout 未 cleanup | 保存 timer id，cleanup clearTimeout |
| 8.26 | ThemeProvider.tsx | getSetting 无 catch | 补 .catch |
| 8.27 | AIStreamText.tsx | 无 ScrollView 限制 | 包 ScrollView 或 numberOfLines |
| 8.28 | ChapterCard.tsx | STATUS_LABELS 强转无 fallback | 加 ?? fallback |
| 8.29 | PipelineProgress.tsx | startedAt 依赖不稳定 | 用 useRef 锁定 |
| 8.30 | ui.tsx | paddingTop 重复 | 移除冗余 |

### Phase 9：屏幕层 async 错误处理批量补全（27 项）

机械性批量补全 onPress/async 函数的 try-catch + Toast：

| 范围 | 文件 | 数量 |
|------|------|------|
| ChapterEditor | loadChapter/clearContent/manualCheckpoint/toggleTts | 4 |
| FreeformEditor | loadData/addFragment/deleteFragment | 3 |
| NotesScreen | add | 1 |
| PresetScreen | add | 1 |
| ResourceLibrary | remove/toggleProjectUsage/setAllCharacters/toggleCollection | 4 |
| ContextConfig | save + useEffect 覆盖 draft | 2 |
| ChapterSummary | save | 1 |
| PlotlineManager | remove | 1 |
| BackupCenterScreen | load 补 catch | 1 |
| PipelineTaskScreen | resolveTask await + try-catch | 1 |
| PipelineResultScreen | cleanup resolveTask + 采纳 disabled | 2 |
| LLMSettingsScreen | activate/remove + useEffect 覆盖 | 3 |
| ProjectListScreen | confirmDelete try-catch | 1 |
| CharacterDetail/WorldbookDetail | loading + try-catch | 2 |

### Phase 10：屏幕层 UI 交互修复（14 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 依赖 chapter 对象导致订阅重建 | 改依赖 [chapterId] |
| 10.2 | UpgradeScreen.tsx | 无 disabled 防重复 | 加 disabled |
| 10.3 | VoiceSettingsScreen.tsx | 保存按钮无 disabled | 加 disabled={saving} |
| 10.4 | ContextConfig.tsx | Number() \|\| 默认值误判 0 | 改 ?? |
| 10.5 | DraftPreviewScreen.tsx | formatTime 未校验 Invalid Date | 加 isNaN 判断 |
| 10.6 | PipelineConfigScreen.tsx | parseInt 空字符串卡住 | 允许空临时态 |
| 10.7 | ChapterEditor.tsx | seenTerminalRef 永不清理 | cleanup 中清空 |
| 10.8 | ContextPreviewScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.9 | ContextPreviewScreen.tsx | keyExtractor 用下标 | 用内容 hash |
| 10.10 | UpgradeScreen.tsx | 颜色硬编码 | 接入 theme |
| 10.11 | UsageStatsScreen.tsx | useState<any> | 定义接口 |
| 10.12 | FreeformEditor.tsx | FlatList 嵌套 ScrollView | 改 ScrollView + map |
| 10.13 | RevisionHistoryScreen.tsx | restore 无 isMounted | 加 isMountedRef |
| 10.14 | PipelineConfigScreen.tsx | useEffect 无 cleanup | 加 isMountedRef |

### Phase 11：死代码清理与性能优化（9 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 11.1 | contextBuilder.ts | {{user}} 永远是"读者" | 读取 user_name setting |
| 11.2 | chapterGeneration.ts | mergeChapterGenerationResult status revision | 改 'draft' |
| 11.3 | llm.ts | callLLMStream 死代码 |