# 续写目标汉字数与 Repair 安全优化建设方案

## 已确认的产品行为

- 用户只在续写生成配置中输入目标章节汉字数。
- 每次运行从冻结的 `targetChapterChars` 派生允许范围：目标值 ±500 汉字。
- 汉字数只统计 CJK 汉字，不统计标点、空白、数字和英文字母。
- 标准 LLM 流程保持 `Writer → Checker → Repair`，不新增固定调用。
- 本地长度检查与 LLM Checker 并发执行，并合并为同一组 Repair issues。
- 长度偏差是确定性的 `error`，不会被无证据降级，也不受“文风检查关闭”影响。
- Repair 继续使用局部 JSON patch；允许 `start === end` 表示纯插入。
- 补丁解析失败时绝不把模型原始输出当完整正文。
- 首次 Repair 后只做本地复检；仍有长度或其他严重问题时保留安全候选，进入原有用户决策环节。
- 用户可主动额外调用一次 Repair；额外 Repair 不再调用 Checker，失败时保留调用前候选。

## 代码范围

新增：

- `continuationLengthContract.ts`
- `continuationRepairPatch.ts`
- `continuationLengthRepair.test.ts`

修改：

- `continuationChecker.ts`
- `continuationPromptCompiler.ts`
- `continuationGenerationRunner.ts`

## 关键安全门禁

1. 已处于目标范围的章节，Repair 后不得跌出目标范围。
2. 原本不在范围的 Writer 候选，允许首次 Repair 产生更接近目标但仍未完全合格的安全候选，供用户选择额外 Repair。
3. Repair 候选不得发生灾难性收缩，也不得明显远离目标。
4. 非法 JSON、越界、重叠或重复插入补丁一律拒绝。
5. 未通过安全验证的 Repair 结果不得创建新的正文 artifact。

## 验证范围

- TypeScript 严格类型检查。
- 汉字统计与 ±500 边界测试。
- 纯插入 patch 测试。
- 非法/重叠 patch 测试。
- 3000 字正文坍缩为 600 字时拒绝。
- 合法 Writer 被 Repair 改到范围外时拒绝。
- 过短 Writer 被首次 Repair 安全改善时允许保留，以支持用户额外 Repair。

模拟器和 Android 端交互验证留给本地仓执行。
