# 续写目标汉字数与 Repair 安全优化：模拟器穿测报告

## 1. 测试概况

- 测试日期：2026-08-02
- 测试分支：`fix/continuation-repair-coverage`
- 测试包：`com.shinewriter`，`V2.11.14`，versionCode `2111400`
- 测试设备：Android Emulator，adb serial `emulator-5554`
- 测试项目：`QA_Continuation`
- 测试原著：`continuation-sample`，导入 3 章
- Canon 前置条件：快速分析 `2/2` 完成，并启用为当前原著资料
- 目标章节汉字数：`3000`
- 动态合法范围：`2500–3500`，边界包含

本报告只记录本次模拟器穿测结果。自动化测试用于验证可重复的边界和流程行为，不能由一次真实 LLM 返回结果替代。

## 2. 验证到的流程

标准流程按以下顺序完成：

```text
Writer → LLM Checker → 标准 Repair → Repair 后本地复检 → awaiting_user
```

用户确认额外 Repair 后，流程为：

```text
额外 Repair → 本地复检
```

额外 Repair 没有再次调用 LLM Checker，也没有发生第三次 Repair。

Writer 的第一次请求发生超时，随后按现有规则自动重试 1 次并成功；这属于既有的 Writer 一次传输错误重试规则，本次未修改该行为。

## 3. 标准流程结果

数据库中本次 run 的关键结果如下：

| 阶段 | 请求次数 | 结果 |
| --- | ---: | --- |
| Writer | 2 | 第 1 次超时，第 2 次重试成功 |
| LLM Checker | 1 | 完成，发现长度和语义问题 |
| 标准 Repair | 1 | 生成候选并进入本地复检 |
| Repair 后本地复检 | 0 次 LLM | 仍有长度问题，进入 `awaiting_user` |

标准 Repair 前的 Writer artifact 本地检查结果为：

- 汉字数：`1057`
- 下限：`2500`
- 状态：`chapter_length_under_target`，`error`
- 另有语义检查问题和若干 warning

标准 Repair 生成的 Repair artifact 汉字数为 `2114`，比原候选更接近目标，但仍低于 `2500` 下限，因此长度问题继续保持 `open`。这说明候选安全策略允许“改善但未达标”的标准 Repair 候选继续进入本地复检，同时没有错误关闭长度问题。

## 4. 额外 Repair 结果

用户点击“额外修正一次（增加 1 次 LLM）”后，数据库记录显示：

- Repair 总请求次数：`2`
- `additionalRequestCount`：`1`
- 额外 Repair 用时：约 `6961 ms`
- 本次额外请求：`2577 prompt tokens / 1200 completion tokens`
- LLM Checker 总请求次数仍为：`1`
- 额外 Repair 后本地复检：`requestCount = 0`
- 本地复检备注：额外 Repair 后未进行第二次 LLM Checker

因此，额外 Repair 并非本地瞬间完成，也不是被 Checker 或本地流程短路；它确实调用了 Repair LLM。之所以界面很快恢复，是因为模型响应约 7 秒返回，随后补丁安全校验很快完成。

本次额外 Repair 的返回结果未覆盖任何待处理的普通严重问题，且没有把章节长度带入 `2500–3500` 合法范围。系统记录了以下安全结果：

```text
Repair 补丁没有覆盖任何普通严重问题，且未将章节长度带入合法范围，已保留调用前正文。
```

因此没有保存额外 Repair 的不合格候选，当前安全 artifact 保持不变。额外 Repair 的一次性额度已经消耗，后续不能再次 Repair，也不能再次调用 Checker。

## 5. 当前存在的问题

### 5.1 Repair 未能完成长度目标

本次真实模型输出将正文从 `1057` 汉字改善到 `2114` 汉字，但仍低于下限 `2500`。额外 Repair 返回的 patch 又未通过问题覆盖校验，最终无法继续改善。

这不是长度契约被绕过：长度问题仍为本地确定性 `error`，并保持 `open`。当前问题属于本次模型输出没有提供足够、且与严重问题绑定的有效补丁。

### 5.2 额外 Repair 失败后的界面反馈不够持久

额外 Repair 调用失败时，代码会通过 Toast 显示失败原因，并重新加载结果页；由于一次性额度已消耗，额外 Repair 按钮也会消失。用户如果错过 Toast，只能看到仍待处理的结果，不能直接从结果页确认“本次 LLM 已调用但 patch 被安全拒绝、原 artifact 已保留”。

建议后续在结果页增加持久化的 Repair 状态，例如：

- `额外 Repair 已调用，但补丁未覆盖待处理问题，已保留原候选`；
- 显示最后一次 Repair 的失败原因；
- 显示“已消耗额外 Repair，不可再次调用”。

这属于可观测性/交互问题，不应通过放宽补丁覆盖校验来解决。

### 5.3 本次提供的 `docs/deepseek.txt` 凭据不可用

对 `docs/deepseek.txt` 中的凭据进行了不输出密钥内容的只读连通性检查，DeepSeek `/models` 返回 HTTP `401`。本次模拟器实际使用的是应用安全存储中已有的有效配置，未覆盖该配置，也未把密钥写入报告。

该文件已加入 `.gitignore`，不会进入 Git 提交。后续若要用该文件替换模拟器配置，需要先更换有效凭据，并通过应用设置写入安全存储。

### 5.4 模拟器显示 Android 16KB 兼容性提示

首次启动 Debug APK 时出现 Android 16KB page-size compatibility warning。提示被关闭后应用能够继续运行，续写流程没有因该提示失败。

这属于当前构建/设备兼容性提示，不属于本次 Repair 流程逻辑失败；Android 模拟器兼容性和原生构建整改仍需另行处理。

## 6. 安全性结论

本次穿测确认以下安全约束有效：

- 额外 Repair 确实只调用 1 次 LLM；
- 额外 Repair 后没有第二次 Checker；
- 无关 patch 未能关闭全部严重问题；
- 补丁覆盖校验失败时保留调用前 artifact；
- 低于长度下限的问题没有被错误标记为已修复；
- 没有接受模型返回的摘要文本作为完整章节；
- 没有发生第三次 Repair。

## 7. 后续建议

1. 保留当前补丁覆盖和候选保留策略，不因模型补丁无关而放宽安全校验。
2. 增加 Repair 调用结果的持久化状态和失败原因展示，降低用户对“是否调用 LLM”的疑惑。
3. 使用有效 DeepSeek 凭据重新进行一次包含长度、知识边界和未来信息泄漏的可控穿测。
4. 继续用自动化测试覆盖多问题联合处理、部分 patch 覆盖、无关 patch、额外 Repair 失败和长度边界；真实模型穿测只作为补充证据。
