# Phase III-B 施工进度

更新时间：2026-08-28（B 轮最终验收）
当前状态：**PHASE III-B FINAL SEALED / GO**

## B 轮复核结果（2026-08-28）

- 当前实现 tip 为 `be835da`；本次仅封存 III-B B 轮，C 轮未启动。
- State Proposal / Evidence QA / PostWriting、最终发送 messages/receipt/physical ledger 与 `pipeline_tasks` 大载荷热路径均已完成真实复核；最终 30 章的 Evidence QA、状态来源、Final fingerprint、PostWriting `extract_state` 次数均已登记在 [phase3-b-final-report.md](F:/ClaudeWorkSpace/projects/TAVO-MINI/docs/optimization/phase3-b-final-report.md)。
- `npm run verify:elastic`、`npm run typecheck`、`npm run verify` 均通过；lint 0 errors / 216 existing warnings，505 suites passed（3 skipped），3637 tests passed（8 skipped）。
- 最新 Debug APK 构建成功，SHA-256 为 `1383E792F5B251F5025AD090BBD70B06547D89D3C87E09BEF5A6B123995FEB51`；在 `emulator-5554` 上仅执行 `adb install -r`，结果 `Success`，UI 启动正常。
- Outline 与 Continuation 真实矩阵均满足极速 3/3、标准 5/5、质量 5/5；所有最终 adopted run 完成，旧 retry 的失败/截断 receipt 未被隐藏。
- 当前结论为 **PHASE III-B FINAL SEALED / GO**。保留历史段落中的旧 NO-GO/GO 文字作为审计记录，以本节与最终报告为当前结论。

---

## 历史接手与施工记录（不构成当前验收结论）

以下内容保留接手时的 NO-GO 快照、阶段性修复记录和历史验证材料，仅供审计追溯；当前结论以本文顶部 B 轮最终验收结果和 [phase3-b-final-report.md](F:/ClaudeWorkSpace/projects/TAVO-MINI/docs/optimization/phase3-b-final-report.md) 为准。

## 范围约束

- 唯一施工基线：`F:\ClaudeWorkSpace\projects\TAVO-MINI`。
- 开工核对：`git fetch` 已完成；当前 `origin/main=86784869839cdee669ca6a16bd1c87fe0851e67d`，本地 `main` 起点相同。
- 当前实现提交 tip：`90f10e3fed08a2665717840097d4e736cc9e567f`；其后仅有本进度文档提交。接手时必须用 `git rev-parse HEAD` 实测当前文档提交，不得回退已有提交；`origin/main` 仍为上方 hash。
- B0-B5 保持既有行为；本轮只处理 B6、B7、B8，不启动 C 轮。
- 工作区没有已跟踪文件改动；以下 4 项是开工前已存在的未跟踪文件，必须保留、不得清理或擅自提交：`-`、`docs/optimization/TAVO-MINI_第二期_最终生产源码穿透测试与自修复封板方案_V1.0.md`、`emulator-5554`、`qa_import_preset.json`。

## 当前接手快照（2026-08-27）

### 已完成并独立提交的 PDCA 修复

每项均已执行 Red → Do → targeted verify → Check，并独立提交；接手后不要重复制造同一提交：

1. `b4b6db5 fix(llm): enforce elastic output budgets at call sites`
   - 给 `callLLM` / `callLLMResult` 增加 TypeScript AST 固定数字参数回归扫描。
   - 修复 Plotline、summaryGenerator、continuationOrdering、resourceSourceSnapshot、noteRetriever、styleAnalyzer 的业务上限参数。
   - 定向 8 suites / 66 tests 通过；`npm run verify:elastic`、`npm run typecheck` 通过。
2. `6f7e7c6 fix(writing): fail closed on invalid revision contracts`
   - Revision `finishReason=length` 失败关闭。
   - Compact Revision 严格校验 structured contract、字段缺失、JSON 截断、状态提案指纹、Segment/Full fallback。
   - 新增稳定 Red Test：`__tests__/writingRevisionFormatContract.test.ts`。
   - 定向 9 suites / 50 tests 通过；`npm run typecheck` 通过。
3. `a8cfcf4 fix(writing): preserve frozen materials in revision prompts`
   - Draft / QA / Revision 的 model-visible messages 增加显式 Chapter Truth Projection、Requirement Checklist 和冻结资料块。
   - Revision allowlist 补齐 seam、anchor、chapter、preset、character、worldbook、note、episodic memory 等边界资料。
   - 测试覆盖 receipt fingerprint 与 Freeze 后 live source 不漂移；定向 prompt/evidence/chapter-truth/receipt 测试 7 suites / 50 tests 通过。
4. `8e2cd61 fix(storage): project and chunk large pipeline payloads`
   - `pipeline_tasks`、`pipeline_stage_attempts`、continuation artifact/stage result 热路径改为 metadata projection + 按需分块加载，避免大 JSON/BLOB 直接进入 CursorWindow。
   - 新增真实 sql.js 大 payload / CursorWindow guard 红测；定向 5 suites / 20 tests 通过。
5. `90f10e3 fix(writing): reconcile physical request accounting`
   - Request Receipt、usage、stage artifact、continuation ledger、DB outbox 对齐 physical dispatch / protocol fallback 计数。
   - 失败路径也保留实际物理计数；多 stage attempt/result 索引修正。
   - 定向 6 suites / 20 tests 通过。

### 已有证据与当前限制

- 已有历史真实证据：Outline Issue=3、Clean=2、Fast=1；Evidence QA 有真实命中样本；Continuation 有过一次真实采纳/定稿闭环。
- 这些数量不满足本轮最终矩阵要求（Outline 与 Continuation 均需 Fast≥3、Standard≥5、Quality≥5），不能作为 GO。
- 当前阶段没有重新执行完整 `npm run verify:elastic`、`npm run typecheck`、`npm run verify`、Debug APK build/install 和完整真实矩阵；必须在接手时实测的当前 HEAD 上重跑并留证。
- 当前进度仍需继续核查 State Proposal / Evidence QA / PostWriting closure 的真实 receipt、stage ledger、usage、outbox 一致性；现有单测不能替代真实请求证据。
- 最终报告 `docs/optimization/phase3-b-final-report.md` 仍含旧的 GO 文字；在全部硬门禁满足前不得沿用该结论，最终收口时必须按真实结果更新。

## 接手后的严格执行顺序

1. **State Proposal / Evidence QA PDCA**：先读 `qaStateProposals.ts`、finalization、outbox worker 及相关测试；如发现任何问题，先写稳定 Red Test，再 Do、targeted verify、Check、Act，并单独 commit。必须证明 Final==Draft 才读 QA proposals；Final!=Draft 只读 Revision proposals；fingerprint 等于 Final body；evidenceQuote 在 Final body 唯一命中；正常 PostWriting 的 `extract_state` outbox/LLM 为 0。
2. **资料注入与调用对账**：从最终发送的 `messages` / request receipt 核对 Draft、QA、Revision 的章节边界、Canon、Source Boundary、真实上一章 Seam/Anchor、Story Memory、Structured State、Writer Style、相关人物/世界书/资料、Chapter Truth Projection/Requirement Checklist；同时验证无 future leakage、无 Freeze 后 live read 漂移，且 physical calls 与 usage、stage ledger、outbox 一致。
3. **SQLite 全面热路径审查**：继续搜索所有大表读取，特别是 `pipeline_tasks`，禁止热路径 `SELECT *` 读取大 JSON/BLOB；补低内存/大 payload 回归证据。若有缺口按独立 PDCA commit 修复。
4. **最终门禁**：按顺序执行 `npm run verify:elastic`、`npm run typecheck`、`npm run verify`；构建最新 Debug APK，只能 `adb install -r`，不得 uninstall / `pm clear`，保留设备上的项目、LLM 配置、Writer Style、Canon、Story Memory。
5. **真实矩阵**：Outline 与 Continuation 各执行 Fast≥3、Standard≥5、Quality≥5；每章记录真实 physical calls、Draft/QA/Revision 输入/输出 tokens、finishReason、Evidence QA hit/fallback、Segment Repair/Full Revision、State Proposal source、Final fingerprint、PostWriting `extract_state` 次数，并核对模型可见 request messages。
6. **最终报告**：只有上述硬门禁全部真实满足后，更新 `docs/optimization/phase3-b-final-report.md` 与本进度文档为 `PHASE III-B FINAL SEALED / GO`；任何一项 NO-GO 都必须如实保留，停止在 B 轮，不启动 C 轮。

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
