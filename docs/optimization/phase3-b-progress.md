# Phase III-B 施工进度

更新时间：2026-08-27
当前状态：**IN PROGRESS / NOT SEALED**

## 范围约束

- 基线：`origin/main`（施工前 HEAD：`4f06fbb63ae6a3202febf0d024090b2dd2d0f615`）。
- B0-B5 保持既有行为；本轮只处理 B6、B7、B8，不启动 C 轮。
- 当前工作树包含本轮施工改动及既有用户未提交文件；最终提交只纳入本轮明确文件。

## 已完成施工

- B6 Final-Body State Proposal 单管线：Final==Draft 才可采用 QA proposals；Final!=Draft 时废弃 QA proposals，改读 Revision `finalStateProposals`，并严格绑定 `proposalSourceBodyFingerprint` 与 Final body fingerprint。
- B6 防双写：采纳阶段统一走 revision/final-body authority，正常路径不再另起 `extract_state`；显式 fallback/诊断入口保留。
- B7 Anchored Segment Repair：局部 finding 优先段级修复，失败回退 Full Revision，仍在既有 Revision stage 内。
- B8 预算合同：Fast=1、Standard/Quality Clean=2，Issue 最多 3；正常 Post-Writing State Extraction LLM 为 0。
- 上下文/输出预算接入 provider capability 与 elastic reservation；BigModel `/v4` 的 131072 是 provider wire contract，不是全局业务硬编码；缺失能力时 fail-closed。
- Continuation Schema 57 的 artifact stage-local 唯一约束及迁移已补齐。
- 已通过 B6/B7/B8 相关定向 Jest 与 TypeScript 检查；Debug APK 已编译并安装。

## 已取得的实测证据

- Outline Issue：3 次真实 Draft/QA/Revision 请求，段级修复成功，无正常 Post State LLM。
- Outline Clean：2 次真实请求。
- Outline Fast：1 次真实请求。
- Evidence QA：真实命中路径已跑通；当前命中样本 n=1，Draft/QA input p50 将按小样本事实披露，不外推为大样本结论。
- Continuation 已发现并修复两处真机收口问题：Continuation writing event 被错误拒绝，以及 `plot_thread` 未归一化导致 proposal 被 schema 静默丢弃。最新 APK 的定稿闭环仍待重新实测确认。

## 当前阻塞 / 下一步

1. 用最新 APK 重跑 Continuation：确认 Canon、Boundary、Seam、Story Memory 上下文没有未来泄漏，并确认 Final!=Draft 时 QA proposal 不入库。
2. 确认 Revision proposal 经过合法 subject ref 归一化后只入库一次，fingerprint 与最终正文一致，Story Memory outbox 完成。
3. 重跑完整 `npm run verify`、Debug build、`adb install -r`，更新最终报告。
4. 只有全部硬门禁通过，才将本文件更新为 `PHASE III-B FINAL SEALED / GO`，并执行 commit/push；否则保持 NOT SEALED 并明确失败项。

## Agent 交接点（2026-08-27）

- 本次已将最新 Debug APK 安装到 `emulator-5554`，包名 `com.shinewriter`。
- 真机当前停在 `E2E_CONTINUATION` 的续写工作台，下一步应点击“编辑第 4 章”并完成“AI 续写 → 采纳 → 定稿”。
- Continuation 测试基线：`test-logs/phase3-b-live-20260827/db-continuation-final-fixture.sqlite.b64`；模拟服务端脚本：`test-logs/phase3-b-live-20260827/mock-writing-server.mjs`；当前新日志目标：`test-logs/phase3-b-live-20260827/mock-writing-continuation-fixed.jsonl`。
- 之前失败的真机证据保留在 `db-live-continuation-finalized.sqlite`：失败原因已定位并修复，不能把该旧失败样本当作最终通过证据。
- 最新源码已通过定向 B6/B7/B8 Jest（3 suites / 55 tests）和 `npm run typecheck`；刚才的 Debug build 也成功，APK 为 `dist/apk/debug/ShineWriter-V2.21.1-debug.apk`。完整 `npm run verify` 尚未在最新源码收口后重跑。
- 交接时不要提交本目录中的用户未提交文件 `TAVO-MINI_Phase3_B_生产闭环与体验提效_20260826.md`、`scripts/qa/__pycache__/` 和 `emulator-5554` 测试目录。
- `rg` 仍会在 `src/store/settingsStore.ts`、`src/screens/LLMSettingsScreen.tsx` 及历史测试中看到 `max_output_tokens: 4000`；本轮已移除正常 provider transport 的 4000 fallback，但下一 agent 必须继续判定并处理这些 UI/持久化默认值是否也应改为 capability/elastic adapter，不能仅凭 transport 已切换就宣称全软件无硬编码。
- 当前设备数据库刚恢复为 Continuation fixture，应用停在续写工作台；交接后若需要恢复用户态，应使用既有 `db-current-live.sqlite` 快照并先核对项目/Schema，再执行恢复。

## 交接提交说明

- 本次提交是可接续的 WIP checkpoint，不代表 `PHASE III-B FINAL SEALED / GO`，不应据此发布或推送为最终封板。
- 下一 agent 首先完成 Continuation 真机定稿闭环与 Story Memory outbox 验证，再重跑完整 verify、Debug install、最终报告和硬门禁审计。
