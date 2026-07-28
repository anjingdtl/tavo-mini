# Agent 自主执行提示词：Canon 分析三连问题修复

> 用法：新开一个 Agent 会话，把下面代码块整段贴给它。工作区根目录 `F:\ClaudeWorkSpace\projects\TAVO-MINI`。

```text
# 任务：按既定 spec 修复续写原著 Canon 分析三连问题

你是 ShineWriter（Android-only React Native 0.85 + Hermes + TypeScript）项目的开发 Agent。
修复方案已评审定稿，唯一事实来源是这份 spec，先通读再动手，不得偏离其改动范围：

docs/superpowers/specs/2026-07-28-canon-analysis-fix-spec.md

三个待修问题（详见 spec 根因分析，含文件:行号证据）：
- S1：Canon 分析间歇报「LLM 未返回分析结果。请检查模型是否支持 JSON 输出后重试」
- S2：进度 100% 后概览页永久显示「正在汇总结果」
- S3：分析"成功"后世界观/人物画像/人物关系/人物经历全空，仅主线剧情有少量条目

## 开工前必读（按顺序）
1. 上述 spec 全文
2. AGENTS.md（工程约定）
3. 涉及源码：
   - src/services/continuation/canon/canonAnalysisService.ts
   - src/services/continuation/canon/canonJsonValidators.ts
   - src/services/continuation/canon/types.ts
   - src/services/llm/openAICompatibleProvider.ts
   - src/services/llm/types.ts
   - src/screens/continuation/canon/CanonAnalysisOverviewScreen.tsx

## 实施顺序（4 个独立提交，每个配齐单测后再做下一个）
1. test+fix(canon)：prompt 补齐元素级字段规范（抽共享常量 EXTRACTION_FIELD_SPEC /
   EVIDENCE_FIELD_SPEC 供 extractMaterialWithLlm 与旧版 extractWithLlm 共用）
   + canonJsonValidators 字段别名归一化（name→canonicalName、source/from→sourceName、
   target/to→targetName、character→characterName、fact→factKey、key|event→eventKey 等，
   只放宽不收紧）+ validateExtractionResultWithStats 丢弃统计，work item 写入 warning
2. test+fix(canon)：CanonAnalysisOverviewScreen 状态文案改为 run.state × stage 派生，
   抽 runStatusLabel 纯函数；awaiting_review 显示「分析完成，等待审核激活」
3. test+fix(llm)：openAICompatibleProvider 空响应分类（200 带 error body 抛真实错误 /
   content 数组 parts 拼接 / LLMResult 增加可选 emptyReason）+ extractMaterialWithLlm
   分类文案、finish_reason=length 时下一 attempt max_tokens 翻倍、基线 5000→8192 /
   8000→16384 + 失败 errorMessage 附 finishReason 与响应前 200 字符（不含 prompt/Key）
4. test+fix(canon)：startAnalysis 前置 token 预算检查（estimateMessagesTokens），
   本地模型窗口不足时自动降级（chaptersPerBatch=1、切片自适应收缩），仍不足则抛
   「本地模型上下文不足以执行 Canon 分析」的明确错误

## 硬性红线
- 不改 database schema、不新增 migration、不改 ANALYSIS_REQUEST_GROUPS 协议
- 校验器只放宽不收紧；validateExtractionResult 公开签名保持不变（probe 等旧调用不受影响）
- openAICompatibleProvider 是全 App 共享模块：新增字段必须可选，不得改变既有调用方行为
  （普通写作 pipeline、TTS 以外的 LLM 调用全部回归）
- 错误信息用中文；日志/错误信息不得包含 API Key、prompt 全文、章节正文大段内容
- 测试 mock 优先进 jest.setup.js；本任务原则上不需要新增依赖；若确实新增 RN 原生依赖，
  必须同步 jest.config.js 的 transformIgnorePatterns 白名单
- 代码风格：Prettier arrowParens 'avoid'、singleQuote、trailingComma 'all'
- 不动 ios/、dist/、src/constants/version.json；不发版、不改版本号

## 测试与门禁
- 先写失败测试再实现；相关既有测试（canonAnalysisService / canonJsonValidators /
  llm provider / 概览页）必须保持绿色
- 单文件验证：npx jest __tests__/<对应测试文件>
- 每个提交前跑：npm run verify（lint && typecheck && test:ci）全绿；覆盖率不得拉低
  jest.config.js 门禁
- 退避等待（waitForCanonRetry）测试用 fake timers 时，注意给派生 Promise  attach
  .catch，防止 unhandled rejection 让 jest 静默退出

## 验收（逐项对照 spec §1/§2/§3 的验收清单打勾）
- S1：mock 四类空响应场景（length 截断 / reasoning_only / 200 带 error body / 数组
  parts）各自抛出对应具体文案；length 场景第二次 attempt max_tokens 翻倍；
  startAnalysis 在 4096 窗口 + 3×6000 字输入时给出明确降级或拒绝
- S2：awaiting_review / failed / paused / running+finalizing 四种构造态文案正确，
  终态不再出现「正在汇总结果」
- S3：别名字段 mock JSON 归一化后各分类全部接受；received>0 且 accepted=0 时触发
  带统计信息的重试；集成回归（mock LLM）下 buildCoverage 的 categoryCounts 五类 >0

## 完成后汇报
1. 4 个提交的 hash 与一句话说明
2. npm run verify 最终结果（粘贴末尾摘要）
3. spec 验收清单逐项打勾结论；如有任何验收项未达成，说明原因并停手等待指示，
   不得擅自扩大改动范围
```

## 执行提示（给人类）

- 若 Agent 环境 Node 版本不一，提醒它用 **system Node ≥ 24.3.0**（managed 22.x 不满足 engines）。
- 建议一次会话只跑一个提交组，验收通过再贴下一段；或让 Agent 全程自主执行但在每个提交后暂停汇报。
- 真机回归（deepseek-reasoner 跑一轮 fast_continuation）需要在有真机/模拟器的会话里单独进行，Agent 沙箱做不了。
