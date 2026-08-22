# TAVO-MINI 第二期 Pipeline-Behavior 未完成项下一步执行计划 V1.0

> **SUPERSEDED / HISTORICAL**
>
> 本文档是 2026-08-22 收口复审期间的历史 NO-GO 执行计划，**不再代表当前项目结论**。
>
> - 被哪一份 Final Seal 报告取代：`docs/optimization/TAVO-MINI_第二期_Pipeline-Behavior_Final-Seal_验收报告_20260821.md`
> - 对应最终 Production SHA：`6d389f8da48cf7a61d810246ef9e4a71d7e3fc18`（`fix(writing): close pipeline behavior persistence loop`）
> - 当前结论以 Final Seal 报告为准：`PHASE 2 FINAL SEALED / GO`
> - 脱敏最终证据：`docs/optimization/evidence/PHASE2_PIPELINE_BEHAVIOR_EVIDENCE_FINAL.md`
>
> 下文整篇保留为历史记录，避免丢失当时的未完成项与 Gate 串行约束。阅读时不得把它当成与 Final Seal 并存的「当前 NO-GO」。

## 0. 执行状态

- 项目：TAVO-MINI / ShineWriter
- 唯一施工基线：F:\ClaudeWorkSpace\projects\TAVO-MINI
- 需求基线：docs\optimization\TAVO-MINI_第二期_Pipeline-Behavior_测试与修复收口方案_V1.0.md
- 当前结论：NO-GO
- 执行原则：C0 → C1 → C2 → C3 → C4 → C5 严格串行，任一 Gate 未全绿不得进入下一 Gate
- 本计划目的：收口复审已发现的未完成项，重新生成可审计、可复现、与最终 Production SHA 绑定的证据
- 编制日期：2026-08-22

此前验收报告中的 PHASE 2 PIPELINE BEHAVIOR FINAL SEALED / GO 结论不再作为当前结论。原因是复审发现部分证据只证明了阶段队列或历史测试结果，尚未证明当前 Production SHA 下的完整 Android、Resume、PostWriting、ONE Memory 和远端 CI 闭环。

### 0.1 本轮推进记录（2026-08-22）

- C0：已重新 fetch 并锁定当前边界；本地 HEAD 为 `5284c1a3e75eef5c368c6e0d35083ccd55ffd792`，`origin/main` 为 `0148c4a25145e1876d9387bd936d5f3d8e5910b0`，工作区仍 dirty，因此尚无唯一 Production commit。
- C1：当前 dirty 源码通过 `npm run lint`（0 errors / 211 warnings）、`npm run typecheck`、`npm run verify:version` 和 `npm run test:ci`（497/500 suites、3802/3810 tests；3 suites / 8 tests skipped）。
- C2：Outline PostWriting → ONE Memory 已选择真实 outbox 路径；已补充稳定 event/dedupe key、WritingPersistedEvent 校验、revision drift fail-closed、trace/freeze 绑定、结果页真实 outbox 状态读取和幂等测试。R1–R5 当前 SHA 的完整崩溃矩阵证据仍未封板。
- C3：已用当前源码重新构建并 `adb install -r` 到 `emulator-5554`，最终 APK SHA-256 为 `69C20D1C48AD06B85F6250EFF03335DA1295BFE8488CB778C32A8449C915B1D9`；安装前后 DB SHA-256 均为 `3a71873ab2c4676219af6fb1d080347d55d0ef8a987fbef04a60cd475d586ec4`。已完成启动、UI XML、截图、作品库/构建/大纲/章节编辑视图烟测；设备已有失败任务提示“draft 未返回正文（empty）”，未执行真实 LLM 重试，也未完成完整档位/结果页操作矩阵。
- C4/C5：尚未执行当前 SHA 的真实 LLM 2+2+1+1，也未固化 commit、推送或绑定远端 CI；当前结论继续为 NO-GO。
- 本轮证据目录：`test-logs\pipeline-behavior-c3-20260822-2325`。

## 1. 当前基线与证据边界

### 1.1 已确认基线

- 本地 HEAD：5284c1a3e75eef5c368c6e0d35083ccd55ffd792
- origin/main：0148c4a25145e1876d9387bd936d5f3d8e5910b0
- C0 fetch 结果：HEAD 在 origin/main 之上 1 个文档提交，且工作区存在大量既有 dirty changes；不能把当前状态视为唯一 Production SHA
- 当前验证 APK：dist\apk\debug\ShineWriter-V2.11.54-debug.apk
- 当前 APK SHA-256：69C20D1C48AD06B85F6250EFF03335DA1295BFE8488CB778C32A8449C915B1D9
- 当前 Android 证据目录：test-logs\pipeline-behavior-c3-20260822-2325
- 当前安装规则：仅 adb install -r；禁止 adb uninstall、pm clear、清 App 数据

### 1.2 证据使用规则

1. 任何源码、测试、构建产物、配置、文档或依赖发生变化后，旧 APK SHA 的 live evidence 自动失效。
2. 历史 test-logs\pipeline-behavior-20260821-160403 下的 C2 结果只能作为定位参考，不得代替当前 SHA 的重新执行。
3. 当前 dirty worktree 没有可供远端 CI 验证的唯一 Production commit；最终 C5 必须把最终源码固化到 Git commit，并让 APK、CI、Android、真实 LLM 证据分别绑定到明确的 SHA。
4. 不允许通过修改数据库、手工补写 ledger、伪造 trace、伪造 Memory 状态或跳过真实运行来补证据。
5. 所有样本均须保留 Expected DAG vs Actual DAG；不能只以章节生成成功作为通过条件。

## 2. 未完成项总表

| 编号 | 未完成项 | 通过条件 | 影响 Gate |
|---|---|---|---|
| U1 | 当前 SHA 的 C2 Resume Crash R1–R5 尚未形成完整可审计证据 | 五类崩溃点全部重跑，重复付费、状态漂移、尾部幂等和 Memory 闭环均为 0 divergence | C2 |
| U2 | Outline 的 PostWriting → ONE Memory 目前只有 queued/no-op 迹象，没有明确完成契约 | 明确 formal_noop 或真实 Memory 更新；trace、UI、DB/outbox、测试语义一致 | C2、C4 |
| U3 | C3 没有当前 SHA 下 Outline 极速/低/中/高和 Continuation 实际档位的完整 Android 矩阵 | 所有要求档位真实运行并保留 XML、截图、配置、DB、DAG、ledger 证据 | C3 |
| U4 | 结果页采纳、放弃、失败或过期后的重试/继续缺少真实点击闭环证据 | 每个动作都能在 Android 真实页面点击，且前后状态、DAG、ledger、Persist/PostWriting/Memory 可核验 | C3 |
| U5 | 真实 LLM 2+2+1+1 虽已执行，但后续若修复代码必须重新绑定 | 最终 Production SHA 下重新完成 2 个 Outline Standard、2 个 Continuation Standard、1 个 Outline One-Shot、1 个 Continuation One-Shot | C4 |
| U6 | 远端 CI 只验证了 origin/main，不验证当前 dirty worktree 和当前 APK | 最终源码 commit、Production APK、远端 Verify、Generation Stability、Android evidence 同源可追溯 | C5 |
| U7 | 旧 Final-Seal 报告仍写着 GO | 旧报告标记为 superseded，新报告只在所有 Gate 全绿后生成 | C5 |

## 3. 串行执行总流程

不得跨 Gate 并行推进。每个 Gate 结束时生成 Gate 记录并确认出口条件。

### C0：基线、版本与证据锁定

1. 再次执行 fetch origin main。
2. 记录 local HEAD、origin/main、worktree status、最终 APK 路径和 APK SHA。
3. 固定当前证据目录，写入 baseline manifest。
4. 列出所有改动文件、未跟踪文件、构建版本、数据库基线和 emulator serial。
5. 若最终源码尚未形成唯一 commit，则 C0 只能保持准备状态，不能宣称已完成。

出口条件：

- local HEAD 与 origin/main 的关系明确；
- Production SHA、source commit、evidence directory 一一对应；
- 无未说明的脏文件或旧产物混入；
- 未通过时禁止进入 C1。

### C1：确定性契约与防回归

1. 执行 lint、typecheck、version verify、CI test。
2. 覆盖统一 Pipeline、Writer、QA、Context、Memory 单实例约束。
3. 覆盖 Compact Formatter、FinalValidate、Final Candidate、Retry/Fallback、SQLite fault injection、Production Call Graph。
4. 扫描生产入口，确认没有旧 Stage 逃逸、隐藏 Formatter、隐藏 Retry、隐藏 Fallback、V5 runner 运行时调用或第二套 Pipeline/Writer/QA/Context/Memory。
5. 确认不新增 Proof、Judge、Audit、FactCheck 等角色。

出口条件：

- 确定性测试全绿；
- 生产调用图无 legacy V5 运行时路径；
- 统一 Pipeline 的阶段顺序和单实例约束有测试保护；
- 未通过时停在 C1。

### C2：Resume Crash 与数据闭环

按 R1 → R2 → R3 → R4 → R5 严格顺序执行。任何一项发现 Pipeline Divergence，立即停止封板并走第 4 节的修复闭环。

### C3：Android 真实矩阵与用户操作

只使用 C2 已全绿的 APK。只能执行 adb install -r，不清 App 数据。完成完整档位、结果页按钮和断链检查后，才可进入 C4。

### C4：真实 LLM 2+2+1+1

只使用 C3 已全绿且未发生源码变化的 APK。若 C2 或 C3 后有任何代码、配置或构建变化，C4 必须从头重跑并生成新 SHA 证据。

### C5：最终验证、远端 CI 与封板

最终源码必须先固化为唯一 Git commit，再建立 APK、Android、LLM、CI 的同源关系。所有 Gate 全绿且 Pipeline Divergence = 0，才允许宣布 FINAL SEALED / GO；否则持续 NO-GO。

## 4. Divergence 处理协议

任何以下情况均判 Pipeline Divergence：

- 漏跑、误跑、重复跑或旧 Stage 逃逸；
- 隐藏 Formatter、Retry、Fallback；
- Final Candidate 选错；
- Resume 重复付费或重复写入；
- Freeze 状态漂移；
- PostWriting 事件丢失、重复或断链；
- ONE Memory 未完成、无明确 formal_noop 契约或 outbox 未收敛；
- Android 页面缺少采纳、放弃、重试、继续等应有操作；
- 证据与 Production SHA、source commit 或 CI head 不一致。

发现 Divergence 后，必须按以下顺序处理，不得直接继续跑矩阵：

1. Red Test：先用最小失败样本固定红灯。
2. Root Cause：定位到唯一生产代码、状态机、数据库、调用图或 UI 入口。
3. Minimal Fix：只做最小修复，不新增第二套 Pipeline/Writer/QA/Context/Memory，不新增 Proof/Judge。
4. Focused Green：只重跑受影响测试和最小样本，确认修复方向。
5. Full Verify：重新执行 C1 全量确定性验证。
6. Android：重新构建并只执行 adb install -r，保留新 APK SHA。
7. 重跑受影响矩阵：至少重跑受影响的 C2、C3、C4 样本；若 Production SHA 变化，则所有旧 live evidence 失效并重新绑定。

## 5. C2 详细执行计划：R1–R5

### 5.1 统一样本断言

每个 R 样本都必须输出以下结构：

~~~text
Sample ID / mode / profile / APK SHA / source commit
Expected DAG
Freeze → Draft → ONE QA → Conditional Revision（按条件执行，最多一次）→ FinalValidate → Persist → PostWriting → ONE Memory
Actual DAG
逐阶段列出 RUN、SKIP、RETRY、RESUME、FAIL，并附 reason
DAG comparison
每个节点的执行次数、跳过原因、顺序、Paid Call 是否重复
Final Candidate
Draft 或 Revision 的选择依据、内容 hash、FinalValidate 输入 hash
Ledger
Logical / Formatter / Physical / Fallback / Retry / Token / Ledger 记录
Persistence
chapter、WritingPersistedEvent、outbox、PostWriting 和 ONE Memory 的前后状态
Verdict
PASS 或 Pipeline Divergence
~~~

### 5.2 R1：Draft 成功后崩溃

- 在 Draft 成功、状态已持久化后注入崩溃。
- Resume 后必须从 ONE QA 继续。
- Draft 不得重复执行，不得重复产生付费 LLM call，不得重新 Freeze。
- Actual DAG 必须明确 Draft=RESUME-SKIP，QA=RUN。

出口断言：Duplicate Draft = 0，Duplicate Paid Call = 0，Freeze Drift = 0。

### 5.3 R2：QA 成功后崩溃

- 在 ONE QA 成功后注入崩溃。
- Resume 后不得重复 QA。
- QA 结果为 clean 时，Conditional Revision 必须显式 SKIP，不能误跑 Revision。
- 若 QA 结果需要修订，则只能进入一次 Conditional Revision。

出口断言：Duplicate QA = 0，Clean Revision Misfire = 0，DAG 顺序正确。

### 5.4 R3：Revision 成功后崩溃

- 在 Conditional Revision 成功并落盘后注入崩溃。
- Resume 后不得重复 Revision。
- Final Candidate 必须稳定选择已持久化 Revision，而不是旧 Draft。
- 必须继续执行 FinalValidate 和 Persist。

出口断言：Duplicate Revision = 0，Final Candidate Drift = 0，FinalValidate 输入 hash 与 Revision hash 一致。

### 5.5 R4：Persist 前崩溃

- 在所有付费 LLM 阶段完成但 Persist 尚未完成时注入崩溃。
- Resume 后不得重新调用已完成的付费阶段。
- FinalValidate、Persist、PostWriting、ONE Memory 的本地尾部必须幂等。
- 检查 chapter、event、outbox、ledger 是否只产生一份有效结果。

出口断言：Duplicate Paid Call = 0，Duplicate Persist = 0，Local Tail Idempotent = YES。

### 5.6 R5：Persist 后、PostWriting 前崩溃

- 在 Persist 成功、PostWriting 尚未完成时注入崩溃。
- Resume 或 outbox worker 必须继续消费 WritingPersistedEvent。
- 不得重复生成正文，不得重复调用 LLM，不得重复写入正文。
- PostWriting 必须继续到 ONE Memory；若采用 formal_noop，必须记录明确 skip reason 和完成状态。

出口断言：Duplicate Body = 0，Duplicate LLM = 0，WritingPersistedEvent 可追溯，PostWriting 不断链，Memory 最终状态符合第 6 节契约。

## 6. Outline PostWriting → ONE Memory 未完成项

当前 Outline 样本 trace 只显示 WritingPersistedEvent → Story Memory queued，project_story_memory 仍停留在旧 through_chapter_id，outbox 为空。因此必须在 C2 结束前完成以下契约决策，不能继续保留含义不清的 queued。

### 6.1 路径 A：正式定义 Outline 的 formal_noop

只有在产品契约确认 Outline 的 planned chapter 不进入长期 Story Memory 时才允许采用：

- 将 ONE Memory 定义为本场景的正式 no-op；
- trace 必须写明 formal_noop、skip reason、作用域和完成状态；
- UI 和 evidence 必须显示未执行真实 Memory 更新，不得写成 queued 或 completed；
- C1 contract test 必须锁定该语义；
- C2、C4 的 Expected/Actual DAG 必须把 ONE Memory 标为 FORMAL-NOOP，而不是假装已更新。

### 6.2 路径 B：完成真实 ONE Memory

若方案要求所有完成链路都更新 Story Memory，则：

- 复用现有 ONE Memory 和 continuation_state_sync_outbox；
- 使用 WritingPersistedEvent 驱动幂等消费；
- 增加稳定 event key、去重、重启恢复和 ready gate；
- 成功后必须能从只读 DB、trace 和 UI 证明 through_chapter、dirty/error、outbox 收敛；
- 禁止新增第二套 Memory 或直接手工改 DB；
- 修复后必须重跑受影响的 R5、Outline Android 样本和 Outline 真实 LLM 样本。

### 6.3 该项的最终判定

- A 或 B 必须在代码契约、测试、trace、UI 和证据报告中保持同一语义；
- 未决、queued 无消费、无 skip reason 或 DB 状态无法解释，均为 NO-GO；
- 不能用章节已生成、Persist 已成功或 WritingPersistedEvent 已存在替代 ONE Memory 结论。

## 7. C3 Android 详细矩阵

### 7.1 安装和数据保护

- 目标设备：emulator-5554
- 安装方式：adb install -r
- 禁止：adb uninstall、pm clear、清 App 数据、修改 DB 伪造前置状态
- 每次安装记录 APK SHA、versionName、versionCode、安装时间、设备 serial
- 每个样本保留安装前后 DB hash，确认既有数据没有被清除

### 7.2 Outline 档位

当前 SHA 必须真实执行并分别留证：

1. One-Shot / 极速
2. One-Shot / 低
3. One-Shot / 中
4. One-Shot / 高

每个档位都要记录配置页选择、保存后的 DB 设置、运行计划、Freeze、每个阶段、结果页和最终 Persist/PostWriting/ONE Memory。

### 7.3 Continuation 档位

按当前 UI 实际提供的档位全部执行，不以默认 Standard 样本代替其他档位。每个档位记录：

- 续写资料在 Freeze 前是否生效；
- Draft、ONE QA、Conditional Revision、FinalValidate、Persist、PostWriting、ONE Memory；
- 是否错误进入旧 V5 runner；
- 是否产生额外 Formatter、Retry、Fallback 或重复付费 call。

### 7.4 真实用户操作

在结果页实际点击并保存证据：

- 采纳：点击前后 UI XML、截图、章节状态、Persist/PostWriting/Memory 状态；
- 放弃：点击前后 UI XML、任务状态、是否错误写入正文；
- 失败或过期后的重试：确认只从允许的 Resume 节点继续，不重复付费；
- 失败或过期后的继续：确认任务状态和 DAG 恢复正确；
- 重新进入结果页：确认采纳、重试按钮仍存在且语义正确，不被长页面或错误折叠遮挡。

结果页必须能让用户在当前页面完成必要操作；按钮可以压缩为细条，但不能隐藏、移除或只在源码中存在而无法点击。

### 7.5 Android 样本证据包

每个样本至少保存：

- 配置页 UI XML 和截图；
- 运行计划 UI XML 和截图；
- Freeze 后 UI XML 和截图；
- running/result/failure/expired UI XML 和截图；
- 点击前后 UI XML 和截图；
- logcat、任务 ID、run ID、DB 只读快照；
- Expected DAG vs Actual DAG；
- LLM、ledger、Final Candidate、Persist、PostWriting、ONE Memory 结果。

## 8. C4 真实 LLM 2+2+1+1

在最终 Production SHA 下执行以下固定矩阵：

| 类别 | 数量 | 样本要求 |
|---|---:|---|
| Outline Standard | 2 | 独立章节、独立 task、完整链路 |
| Continuation Standard | 2 | 独立 run、独立输入资料、完整链路 |
| Outline One-Shot | 1 | One-Shot 实际配置，非误触或取消 |
| Continuation One-Shot | 1 | One-Shot 实际配置，非 Standard、非取消 |

每个样本必须分别记录：

- Logical：逻辑阶段调用与 stage identity；
- Formatter：是否调用、调用位置、调用次数；
- Physical：真实 provider/model、HTTP/SDK 成功结果；
- Fallback：是否发生；未发生也要明确记录；
- Retry：是否发生；未发生也要明确记录；
- Token：prompt、completion、total；
- Ledger：每个 call 的 paid/physical/settled/idempotency key；
- Final Candidate：Draft/Revision、内容 hash、选择原因；
- PostWriting：WritingPersistedEvent、正文 hash、执行结果；
- ONE Memory：真实更新或 formal_noop 的明确结果。

任何源码、配置或 APK SHA 变化都使旧 2+2+1+1 证据失效，必须全量重跑。以下取消或误配置样本不得计入矩阵：

- 无真实 LLM 的取消任务；
- 误跑 Standard 的 One-Shot 任务；
- 只完成部分调用后取消的任务。

## 9. C5 最终验证与远端 CI

### 9.1 本地验证

按 package.json 的定义执行：

1. lint
2. typecheck
3. version verify
4. test:ci
5. apk:debug
6. Android C3 受影响矩阵
7. C2 R1–R5 当前 SHA 证据
8. C4 2+2+1+1 当前 SHA 证据

### 9.2 同源绑定字段

最终报告必须分别记录，禁止混用：

- finalRepositoryHead：最终源码 Git commit
- finalProductionCodeHead：构建 Production APK 的源码 Git commit
- productionApkSha256：最终 APK SHA-256
- ciValidatedHead：远端 CI 实际验证的 Git commit
- androidValidatedHead：Android 实际安装验证的 APK 对应源码 commit
- realLlmValidatedHead：真实 LLM 证据对应的 APK 或源码 commit

只有 finalRepositoryHead、finalProductionCodeHead、ciValidatedHead、androidValidatedHead、realLlmValidatedHead 能沿构建记录互相追溯，才允许进入封板判断。

### 9.3 远端 CI

必须在最终 commit 上确认：

- Verify workflow 成功；
- Generation Stability workflow 成功；
- 迁移、构建、Android 相关检查成功；
- workflow URL、run ID、head SHA 全部写入最终报告。

origin/main 上旧 run 的成功不能覆盖 dirty worktree，也不能覆盖另一份 APK。若没有提交、推送或触发远端 CI 的授权，C5 保持 NO-GO，不得使用历史 CI 代替。

## 10. 最终证据包与报告修订

### 10.1 旧报告处理

以下报告只能作为历史记录，必须在新报告中明确标记 superseded：

- test-logs\emulator-qa-final-20260822-9FFBE1\PIPELINE_BEHAVIOR_EVIDENCE.md
- docs\optimization\TAVO-MINI_第二期_Pipeline-Behavior_Final-Seal_验收报告_20260821.md

不能通过改写旧报告中的几个字段来掩盖证据已失效；新 SHA 必须有新证据目录和新最终报告。

### 10.2 新最终报告必须包含

- C0–C5 每个 Gate 的输入、执行、出口条件和 verdict；
- C2 R1–R5 的每个样本 Expected DAG vs Actual DAG；
- Outline Memory 采用 formal_noop 或真实更新的正式契约；
- C3 完整 Android 档位矩阵；
- 采纳、放弃、重试、继续的真实点击证据；
- C4 真实 LLM 2+2+1+1 全量明细；
- Logical、Formatter、Physical、Fallback、Retry、Token、Ledger、Final Candidate、PostWriting、ONE Memory；
- 最终 Git commit、APK SHA、CI run URL、CI head SHA；
- Pipeline Divergence 计数，必须为 0；
- 未解决风险，必须为空。

## 11. 封板判定

只有以下条件同时满足，才可宣布：

PHASE 2 PIPELINE BEHAVIOR FINAL SEALED / GO

- C0、C1、C2、C3、C4、C5 全部 Gate 全绿；
- 所有样本 Expected DAG 与 Actual DAG 一致；
- 漏跑、误跑、重复跑、旧 Stage 逃逸、隐藏 Formatter/Retry/Fallback 均为 0；
- Final Candidate、Resume、Persist、PostWriting、ONE Memory 均无 divergence；
- C2 R1–R5 当前 SHA 全绿；
- C3 当前 SHA 完整 Android 矩阵和结果页按钮点击全绿；
- C4 当前 SHA 真实 LLM 2+2+1+1 全绿；
- 最终源码、APK、Android、真实 LLM、远端 CI 同源可追溯；
- Pipeline Divergence = 0；
- 旧 live evidence 已失效或明确 superseded，新 evidence 已绑定最终 SHA。

任一条件不满足，最终结论必须保持：

PHASE 2 PIPELINE BEHAVIOR NO-GO

## 12. 禁止事项

- 不新增第二套 Pipeline、Writer、QA、Context 或 Memory。
- 不增加 Proof、Judge、Audit、FactCheck 或同类隐性评审链。
- 不恢复旧 V5 runner 作为生产入口。
- 不把兼容元数据 workflowVersion=5、pipeline_brief、brief storage key 误判为旧 V5 运行时调用；同时必须继续扫描确认其不逃逸到生产调用图。
- 不把 queued、pending、事件已写入或章节已生成当成 ONE Memory 已完成。
- 不复用旧 APK SHA、旧 dirty worktree 证据或 origin/main 历史 CI 覆盖最终实现。
- 不清 App 数据；Android 仅 adb install -r。
- 不直接编辑 DB、ledger 或 trace 伪造测试前置条件和结果。
- 不在所有 Gate 全绿、Pipeline Divergence=0 之前宣布 GO。
