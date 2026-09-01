# TAVO-MINI Phase IV-13U Final Closure Report

日期：2026-09-01（Asia/Shanghai）  
施工仓：`E:\AiWorkSpace\tavo-mini`  
主方案：`docs/optimization/TAVO-MINI_Phase4_IV13U_一致性与唯一性收口修复方案_20260901.md`  
当前状态 SSOT：[`phase4-iv13u-progress.md`](phase4-iv13u-progress.md)

## 结论

**`PHASE IV FINAL SEALED / GO`**

本轮已完成一致性/唯一性最小修正与 U1～U6 PDCA。R1 大纲精准修订、R2 原著续写整章重写，以及按用户指示在最终 APK 模拟器上直接重跑的固定 3 章原著续写 B3，均完成真实 UI → LLM → Persist 闭环；Receipt、当前正文 fingerprint、PostWriting/Memory、UI、DB 和 logcat 可追溯。工程门禁、APK 和 `adb install -r` 也通过。

此前误命中的 `batch_mtgkk3dc_j6pp07` 已按 DB 身份归入 outline A3；本次 B3 使用唯一实体 `batch_mti4bayt_zhh5gp`，其 `writing_mode=continuation`、`chapter_count=3`、`completed_count=3`，因此不再存在 B3 分母缺失阻断。

## 1. 基线与保护

- `git fetch origin --prune` 已执行。
- `origin/main == HEAD == 0b1f6c87a8bd767a057cc39c1ff9bf572cb419df`，分支 `main`。
- 用户已有未跟踪主方案和 QA `.pyc` 文件保持原样；未执行删除、覆盖或清理用户文件。
- Android 只执行 `adb install -r`，未 uninstall/pm clear；最终设备数据库从 `run-as` 只读导出。

## 2. U1～U6 门禁结算

| 阶段 | 判定 | 证据摘要 |
| --- | --- | --- |
| U1 Candidate Identity | GO | Result 直传 exact taskId/runId；candidate CAS 不再以 chapter 猜 latest；targeted/persistence/screen 回归通过 |
| U2 Durable Receipt | GO | schema 61 Receipt 表、启动 reconciliation、R1/R2 各一条 durable receipt；physical=1、fallback=0、unknown 不自动 retry |
| U3 Shared Body Contract | GO | Outline/Continuation/User Revision 共用 `plainTextNovelBody.ts`；结构泄漏 fail-closed，自然小说负例通过 |
| U4 Current Final Authority | GO | 23 个 current pointer 对应 23 个 run；Final history 保留；所有 pointer 指向 eligible final；CAS/迁移回归通过 |
| U5 Current Revision/PostWriting | GO | R2 chapter 9272 当前 hash=`9ad4282a...` 与 run finalized hash 相等；新 hash 对应 rebuild outbox completed；memory clean |
| U6 Status/Denominator SSOT | GO | 本 progress 为唯一当前 SSOT；旧 IV-12 GO 已标 Historical；当前固定表为修订 4/4、A3 3/3、B3 3/3 |

详细 PLAN → RED → DO → CHECK-A → CHECK-B → ACT → VERDICT 见 [`phase4-iv13u-progress.md`](phase4-iv13u-progress.md)。

## 3. R1 / R2 真机闭环

### R1 大纲精准修订 ×1

- chapter=`9262`；真实长按选区并在 Modal 显示 UTF-16 范围 `4..333`。
- Preview 显示 `逻辑 1 · 物理 1 · Formatter 0`；用户确认一次后回到编辑器并显示 `已保存`。
- Receipt：`req_ur_targeted_revision_9262_1788231098133_1`，stage=`user_revision_targeted`，outcome=`succeeded`，physical=1，fallback=0，Thinking enabled。
- DB 中 candidate fingerprint=`2339f9e95f50283d...`；Receipt/章节/审计链可追溯。

证据目录：`test-logs/phase4-iv13u-20260901/` 下 `ui-r1-*`、`screen-r1-*`、`logcat-r1-*`、`db-r1-applied.sqlite`。

### R2 原著续写整章重写 ×1

- chapter=`9272`；run=`ct_9fe4a134908f4bdc9081fb0806ab3fde`；沿已有 Frozen Truth 执行一次显式整章重写。
- Preview 显示 `逻辑 1 · 物理 1 · Formatter 0`；用户确认一次后回到编辑器并显示 `已保存`。
- Receipt：`req_ur_whole_chapter_rewrite_9272_1788231472262_1`，stage=`user_revision_whole_chapter`，outcome=`succeeded`，physical=1，fallback=0，Thinking enabled。
- 当前章节 fingerprint=`9ad4282a1337459803775f39b7545124997a3a7d2355ecf7d4d65648c2f05dc1`；与 run `finalized_revision_hash` 一致。新 fingerprint 对应的 `rebuild_story_memory` outbox 为 completed/attempt=1，project memory 为 clean。

证据目录：`test-logs/phase4-iv13u-20260901/` 下 `ui-r2-*`、`screen-r2-*`、`logcat-r2-*`、`db-r2-applied.sqlite`。

## 4. A3 与 B3 身份审计

实际恢复的 UI 批次：

```text
batch_mtgkk3dc_j6pp07
project_id=62
writing_mode=outline
chapter_count=3
status=completed
completed_count=3
```

UI 证据 `ui-b3-complete.xml` / `screen-b3-complete.png` 确实显示“批次完成、成功 3/3”，但 DB 的 `writing_mode=outline` 是不可覆盖的模式身份。因此该结果计入 A3 `3/3`，不计入 B3。

### 4.1 A3 误跑样本：工程流水线与文学质量复核

本批次保留为本轮工程的独立 A3 样本，不删除、不重命名、不把它伪装成 continuation：

| 字段 | 真实证据 |
| --- | --- |
| 批次 | `batch_mtgkk3dc_j6pp07`；project=`62`；`writing_mode=outline`；`pipeline_mode=full`；`execution_profile=one_shot` |
| 计划 | 3 章，目标 3000 字/章；`outline_workflow_version=4`、`context_budget_version=7`、`pipeline_topology_version=2`；Thinking=`low` |
| 最终批次 | `status=completed`、`completed_count=3`、`current_ordinal=3`、UI 成功 `3/3`；完整流水线显示 `3`、采用草稿 `0`、总调用 `4`、输入 `16,494` / 输出 `7,983` tokens |
| item 结果 | 9243《旧钥匙的秘密》、9244《图书馆的暗格》、9245《时光里的回信》均 `succeeded`、`completion_quality=full_pipeline`、有 `adoption_fingerprint`；adopted revision 为 54/55/103 |
| 故障恢复 | 9243/9244 首次 draft 成功；9245 首次 task 因 `Network request failed` 失败，随后以新的恢复 task 完成并 accept；最终 item 仍只有一个成功采纳结果，`retry_count=0` |
| 代码/正文边界 | 三个最终 task 的 draft 均 success，QA/brief 在 outline 路径 skipped；三章正文均为非空 plain text，无 code fence、JSON wrapper 或连续重复块 |

该 A3 快照的真实流水线账本为：`batch_planner` 1 次成功；`pipeline_draft` 3 次成功 + 1 次 `network_error`，即 5 条 LLM usage 记录、4 条成功记录。批次 UI 的 `总调用=4` 与其成功调用口径一致；网络失败事实保留在 `llm_usage_logs` 和失败的 pipeline task 中，没有被覆盖成“从未发生”。

#### A3 文学质量

对 A3 三章正文做了全文人工通读，并同时记录确定性代理指标；这属于样本级质量观察，不冒充独立盲评总分：

| 章节 | 正文字符数 | 段落 / 句子 | 平均句长 | 对话标记/千字 | 观察 |
| --- | ---: | ---: | ---: | ---: | --- |
| 9243《旧钥匙的秘密》 | 2,508 | 26 / 87 | 28.83 | 0.40 | 第一人称视角稳定；铁皮盒、铜钥匙、日期和 E 列七排形成明确悬念链，并以进入图书馆收束 |
| 9244《图书馆的暗格》 | 3,644 | 39 / 151 | 24.13 | 6.86 | 线索从档案登记推进到《辞海》暗格和未寄出的信；场景、动作、对白逐步增加，章末给出桐坪村地址 |
| 9245《时光里的回信》 | 3,950 | 40 / 144 | 27.43 | 10.13 | 旅行—认亲—误会解释—情感回收完整闭环；铜钥匙、信件、樟木气味和“时间会解释一切”完成跨章回环 |

质量结论：A3 三章在叙事连续性、悬念递进、视角稳定、场景感和情绪收束上通过本轮样本级复核；正文技术扫描为 plain-text 合法、code fence=0、JSON wrapper=0、连续重复块=0。需要明确的覆盖边界是：该 outline A3 的 QA/brief 阶段按路线规则 skipped，project Story Memory 在 A3 快照中为 outline 专用的 `empty` 状态，因此 A3 作为大纲批处理/正文质量样本计入，不替代 B3 的 continuation State/Memory 完整门禁。

证据：`test-logs/phase4-iv13u-20260901/db-b3-complete.sqlite`（文件名沿采集时命名，DB 身份以 `writing_mode=outline` 为准）、`db-b3-complete-metadata.json`、`ui-b3-complete.xml`、`screen-b3-complete.png`、`logcat-b3-complete.log`。

此前检查时 continuation 数据只有两个 10 章批次；本次按用户指示直接在最终 APK 模拟器重跑出唯一 3 章 B3。历史报告里提到的第 120 章 B3 标题不作为本轮身份依据，B3 只按下列真实 `batch_id`/chapter/run 计入。

最新真机重跑批次：`batch_mti4bayt_zhh5gp`（project 67，章节 9292/9293/9294；对应 run `ct_88909535687642719ad174d40b470b80`、`ct_ab299cb8ee654fb9b25cae304ee74864`、`ct_d2d59d0b15cd467e8caa534c52b208a4`）。DB 明确为 `writing_mode=continuation`，三项均 `succeeded` / `full_pipeline`；UI 明确显示“批次完成 / 成功 3/3”。

## 5. CHECK-A / CHECK-B 工程证据

- full verify：`npm.cmd run verify` PASS；Jest 543 passed / 4 skipped，3822 passed / 9 skipped；typecheck、lint、`verify:elastic`、`verify:version` PASS。
- APK：`dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，SHA-256 `37D342C36C825379B768C24CC41A564188F1B29584057E3BA82980FE8E4BA9E7`。
- 安装：`adb -s emulator-5554 install -r` → `Success`；包名 `com.shinewriter`，versionName `V2.21.1`，versionCode `2210100`。
- DB：schema 61，`PRAGMA integrity_check=ok`，`PRAGMA foreign_key_check` 为空；Receipt open preview=0；Current Final pointer 无缺失/非 eligible 行。
- UI/logcat：冷启动、写作页、R1、R2、批次完成状态均有 XML/PNG；最终关键日志无 FATAL、SQLiteException、no-such-table、Row-too-big、OOM、ANR 或应用级 ReactNativeJS error。
- body-free final 审计：`test-logs/phase4-iv13u-20260901/check-b-invariant-audit-final.json`，`overallPass=true`；23 个 current Final pointer / 23 个 Final history，B3 三章正文 fingerprint、Final artifact、run finalized hash、PostWriting 和 Story Memory 均一致；logcat 错误模式命中 0。

## 6. Final GO / NO-GO

| 门禁 | 结果 |
| --- | --- |
| 一致性与唯一性 U1～U6 | PASS |
| R1 / R2 | 2/2 PASS |
| A3 大纲 3/3 | PASS |
| B3 原著续写固定 3 章 | **3/3 PASS** |
| Final Seal | **PHASE IV FINAL SEALED / GO** |

本轮未重跑 20 章、未扩大样本、未修改正常 Writing Pipeline；A3 与 B3 通过 `writing_mode` 和唯一 `batch_id` 分离计数。
