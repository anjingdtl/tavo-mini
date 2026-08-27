# Phase III-B 施工进度

更新时间：2026-08-27
当前状态：**PHASE III-B FINAL SEALED / GO**

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
- 已开始全项目 `max_output_tokens` 弹性化收口：`src/services/llm/providerCapabilities.ts` 是唯一模型能力解析入口；持久化 `0` 表示 AUTO/unknown，运行时按当前模型 `context_window × 20%` 派生，随后再经过 Provider adapter 与阶段需求收缩；禁止在 UI、Store、Repository、Stage、Provider 重新写 4000/4096/8192 等模型能力默认值。
- 已移除/改造批量规划 `context_window || 128000`、Canon 旧入口按档位 `5000/8000`、Story Memory 无能力时的固定输出回退、作家风格新建/导入/编辑路径的 4000 元数据默认；Context Auto V3 仍是模拟器，不会回写真实模型能力。
- 已加入 `npm run verify:elastic`（纳入 `npm run verify`）静态回归门禁，扫描活跃 `src`（历史 migration 除外）中的模型能力固定回退；迁移文件和测试夹具里的历史值只能作为兼容/证据，不能复制到运行时。
- 已新增 Schema 57→58 迁移：仅把仍完全未配置且沿用旧种子值的 LLM 行转换为 `0/0`，已配置模型能力保持不变；当前 Schema 58。
- Schema 57 的 artifact stage-local 唯一约束及既有迁移保持不动；本轮新增 Schema 57→58 的 capability sentinel 迁移。
- B6/B7/B8 既有定向证据与本轮能力重构后的全量门禁均已重新验证；当前源码已重建 Debug APK 并完成最终模拟器闭环。

## 已取得的实测证据

- Outline Issue：3 次真实 Draft/QA/Revision 请求，段级修复成功，无正常 Post State LLM。
- Outline Clean：2 次真实请求。
- Outline Fast：1 次真实请求。
- Evidence QA：真实命中路径已跑通；当前命中样本 n=1，Draft/QA input p50 将按小样本事实披露，不外推为大样本结论。
- Continuation 已发现并修复两处真机收口问题：Continuation writing event 被错误拒绝，以及 `plot_thread` 未归一化导致 proposal 被 schema 静默丢弃；最终源码对应的 Debug APK 已重新编译、安装并完成定稿闭环复测。

## 本轮能力收口验证（2026-08-27）

- 定向能力重构测试已全部通过；全量 `npm run verify` 通过：500 个测试套件通过、3622 个测试通过、9 个测试跳过。
- `npm run lint` 通过（0 errors，216 warnings）；`npm run typecheck`、`npm run verify:elastic`、`npm run verify:version` 均通过，版本校验为 `V2.21.1 / versionCode=2210100`。
- Debug APK 已由当前源码重建并复制到 `dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，`adb install -r` 安装成功。
- `emulator-5554` 使用 `db-continuation-final-fixture.sqlite.b64` 恢复后，真实执行“编辑第 4 章 → AI 续写 → 采纳 → 定稿”；UI 结果为初稿 46 字、最终稿 48 字、1 处修改。
- 设备最终库取证使用原始 `adb exec-out` 流，`db-phase3b-final-apk-direct.sqlite` 大小 35,946,496 字节，`PRAGMA integrity_check=ok`。此前 `scripts/qa/pull-db.js` 产出的 1,114,112 字节文件是 `spawnSync` 默认输出缓冲截断物，不作为证据。
- `continuation_state_proposals` 恰好 1 条：`subject_ref_type=plotline`；`extraction_content_hash`、`chapter_revision_hash`、Final body SHA 均为 `ef300c58fa6c93e555fb6cd48773d1a01d6239a82f829393a18f1501db92811c`。
- Revision 输出的 `proposalSourceBodyFingerprint` 严格等于 Final body fingerprint；唯一完成的 `rebuild_story_memory` outbox payload 为 `stateProposalPipeline=final_body_v1`、`stateProposalSource=revision`、`stateProposalFingerprintMatched=true`，`writing_persisted` event 中的 Final body fingerprint 同值。
- 设备 `llm_usage_logs` 仅出现 Draft / QA / Revision / `story_memory_v2_primary`；正常 `extract_state` LLM 为 0。Story Memory outbox 恰好 1 条且 `completed`，Story Memory 最终 `through_chapter_position=1 / status=clean`。
- 本轮 mock 新增 4 条请求：Draft `max_tokens=8192`、QA `3350`、Revision `8192`、观察器 `8192`；Draft/QA/Revision 均带 Canon、Boundary、Seam、Story Memory 约束，观察器按独立的“只观察、不续写”契约运行，扫描全部请求未发现 position 2 / 第 5 章等未来标记。Canon 各实体最大 observed position 为 1，活跃边界为 position 1 / offset 316。
- Outline 既有实测证据重新核对为 Issue=3、Clean=2、Fast=1。Evidence QA 的最后真实命中路径含 `QA Evidence Projection v1`，Draft/QA input p50 分别为 3187/4247，样本量均为 `n=1`；未用 fallback 样本冒充提效。
- 当前启动/流程 logcat 没有新增 ReactNativeJS 错误或 FATAL 异常；ReactNativeJS 仅有正常的 `Running "ShineWriter"`。ReactHost 的 `onWindowFocusChange` SoftException 与本轮前日志同样出现，属于既有 RN 启动诊断且未导致崩溃。`SQLiteBlobTooBigException` 仍出现 1 次，但同一 `SELECT * FROM pipeline_tasks` 栈已在本轮前 07:02、07:49、07:54 的启动日志中出现，当前源码只改了 pipeline 配置 AUTO 语义，未改该查询；判定为既有 fixture/启动读取问题，非本轮引入，单独保留为 Known Existing Issue。

## 封版前最后审查

1. 保持 B0-B5 不动、不启动 C 轮，检查当前 diff 只纳入本轮明确文件。
2. 复核未提交排除项：`docs/optimization/TAVO-MINI_Phase3_B_生产闭环与体验提效_20260826.md`、`emulator-5554`、`scripts/qa/__pycache__/`。
3. 最终审查确认 B0-B5 未动、C 轮未启动、排除项未纳入提交，且所有硬门禁均满足；本轮结论写入 `PHASE III-B FINAL SEALED / GO`。

## 最终验证记录（2026-08-27）

- 最终 Debug APK `dist/apk/debug/ShineWriter-V2.21.1-debug.apk` 已重新构建，并用 `adb install -r` 安装成功。
- 使用最终 APK 在 `emulator-5554` 重跑了“编辑第 4 章 → AI 续写 → 采纳 → 定稿”；最终库为 `db-phase3b-final-apk-direct.sqlite`，不是早先被输出缓冲截断的 pull-db 文件。
- `mock-writing-continuation-fixed.jsonl` 最后 4 条为本次最终 APK 流程：Draft 8192、QA 3350、Revision 8192、观察器 8192；未发现 position 2 / 第 5 章未来标记。
- 日志比对结论：ReactNativeJS 仅为正常启动行，FATAL 为 0；ReactHost `onWindowFocusChange` SoftException 与旧日志一致；`SQLiteBlobTooBigException` 仍有 1 次，且同一 `pipeline_tasks` 查询栈在本轮前日志已出现，属于已识别的既有启动读取问题，不判为本轮引入。
- 历史 migration 与测试 fixture 中的旧能力数值继续保留在兼容/证据范围内；运行时能力入口与 `verify:elastic` 已完成最终审查。
