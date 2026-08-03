# Continuation V4 FULL-Control 脱敏验收报告

日期：2026-08-03
版本：`V2.11.15`（本次仅提升版本元数据，未按要求重新打包 APK）
分支：`codex/continuation-full-control-v4`
基线：`58079f9`

本报告只记录可复核的结构化结果，不包含 API Key、完整 endpoint、完整 Prompt、模型思考过程或完整生成正文。

## 自动化门禁

- `npm ci`：通过。
- `npm run verify`：通过；220 个测试套件、1,798 项测试通过，3 项既有跳过；ESLint 0 error，typecheck 与版本校验通过。
- `npm run test:coverage`：通过；statements 68.70%、branches 57.65%、functions 70.72%、lines 70.72%。
- `npm run apk:debug`：通过。
- Debug APK：`dist/apk/debug/ShineWriter-V2.11.14-debug.apk`，56,202,274 bytes，SHA-256 `A35C2F4FB323B2739FAB350BB162A692F583B80E9D16F080A2C7798BD7F8267A`。

## 真实 Android / LLM 验收

设备为在线 Android x86_64 模拟器，使用本地测试配置文件中的真实 OpenAI-compatible 配置；配置值本身未写入报告或日志。测试项目为独立的 `V4-QA-Novel`，原著导入、Canon 分析和 Style Profile 均先达到 ready。

最终验收运行结果（run `ct_a18546720ddd47339b4b34fb2bdeda2e`）：

- Writer：1 次请求成功；客户端本地 Han 计数 2,133，动态目标 3,000，合法区间 2,500–3,500；Writer artifact 为 `eligible`。
- Checker：1 次请求成功，报告绑定 Writer artifact hash，`issues=[]`；不是未执行。Checker 的 `error/blocking` 反例自动化测试确认：即使 Control 为 `keep`，仍会调用 Repair。
- Control：1 次请求成功；`currentHan=2133`、`targetHan=3000`、`allowedMinHan=2500`、`allowedMaxHan=3500`，本地指标为真值，模型只提供动作建议；本次动作是 `expand`，无额外建议项。
- Repair：1 次请求成功，返回完整终稿 envelope；本地 Han 计数 2,429，相比 Writer 增长并满足 Control 的 `expand` 方向，Checker/Control 合规检查为空，Repair artifact 为 `eligible`。
- Local Final Gate：零请求成功；`passed=true`，仅保留 `chapter_length_under_target` 作为 warning，不阻断 Repair 采纳；结果保持待用户采纳，不自动覆盖章节正文。
- 物理 LLM 请求：4/4，未发生第 5 次请求。

该运行同时证明“Checker 已执行但无 issue 时仍正常结束”“Control 的本地汉字数是最终真值”“Repair 实际执行了 Control 要求的扩写方向”，以及“Repair 即使未达到篇幅下限，只要质量修订和安全检查通过，仍可作为默认候选”。

## 关键约束核验

- Writer 动态目标同时出现在提示词头部和输出前最后检查；目标、最低线和上限由本次上下文自动化策略、冻结模型能力和实际需求解析，V4 路径没有阶段 token 硬编码。
- Control 的 Han 数、合法区间和本地安全指标由客户端计算；LLM 返回的数字不会覆盖本地值。
- Checker / Control 只读取 run 创建时冻结的 stage views；Checker 的 Canon 依据来自冻结上下文，Canon 访问仍只经过 `CanonQueryService`。
- 外部资料只使用冻结的 `external_supplement` binding；Control 不接收原始外部资料。
- Repair 只接受完整终稿 envelope，不接受 offset Patch；完整终稿还要通过 JSON/泄漏/坍缩/重复/overlap/future leakage 等本地安全门禁。篇幅区间仍由本地计算并触发 Repair，但在 Local Final Gate 仅作为 warning，不再单独阻断合规 Repair。
- Checker 顶层 `warnings` 会被保留为非 Repair-actionable 的审阅结果；只有有完整证据的 `error/blocking` 才消耗唯一 Repair 请求，warning 不会被静默丢弃。

## 已知限制

本轮交付的是 Debug APK，未执行正式签名 Release 构建。模拟器安装时显示 16 KB 原生库兼容性提示；因此本报告不把 x86_64 模拟器结果表述为真机兼容性或完整 16 KB 验收。原始 UI / 数据库证据保存在 `test-logs/continuation-full-control-v4-20260803/`，未纳入版本控制。
