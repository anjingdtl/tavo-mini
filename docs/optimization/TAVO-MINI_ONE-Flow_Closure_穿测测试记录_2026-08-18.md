# TAVO-MINI ONE-Flow Closure —— 真实 LLM 穿测测试记录

- 日期：2026-08-18
- APK：`dist/apk/debug/ShineWriter-V2.11.53-debug.apk`（50.22 MB；分别基于 `091e60a8`、`fdf17c62` 两次构建，均为 `adb install -r` 保留数据安装，未 uninstall / 未 pm clear / 未清库）
- 设备：emulator-5554（Medium_Phone / 2GB RAM / x86_64）
- 模型：deepseek-v4-flash（openai_compatible，context 1,000,000 / max_output 200,000）
- 历史数据保留确认（安装后核对）：25 个项目、项目 16（E2E_CB1）51 章 + source/canon 绑定、SM 行、**124 条 legacy pending proposals**、506 条 completed outbox、keychain API key 均在位。

## 一、穿测 C-1：Outline One-Shot（项目 24 KFC_FINAL_O_20260817_FINAL5）✅ 2/2

- 批次：`batch_msymytj1_4c11za`（completed），档位"极速（批次冻结）"= one_shot profile
- 章节结果：

| 章 | 章节ID | 字数 | generationTraceId | 状态 |
|---|---|---|---|---|
| 符文的指引（第1章） | 234 | 4,846 | `gt-msyn4ni3-dyjqjo9h` | full_pipeline succeeded |
| The Price of Immortality（第2章） | 235 | 3,721 | `gt-msyn5m68-by89v6p0` | full_pipeline succeeded |

- LLM 调用（llm_usage_logs，当日全部）：`batch_planner ×1` + `pipeline_draft ×2`
  - **每章正文 paid call = 1** ✓；formatter/review/audit/factCheck/revision/proof = 0 ✓
  - tokens：规划 734/738；第1章 7,353/3,260；第2章 5,967/2,958（in/out）
- 说明：第 2 章标题在 UI 操作中被误输入残留（标题含 "ofs" 拼接瑕疵），不影响验收口径。

## 二、穿测 A：Outline Standard（项目 24，档位"中"= standard profile）✅ 2/2

- 批次：`batch_msynjdr7_cju1km`（completed）
- 章节结果：

| 章 | 章节ID | 字数 | generationTraceId |
|---|---|---|---|
| 旧书馆的陷阱（第1章） | 236 | 8,687 | `gt-msynmrno-myeg32se` |
| 怀表起源（第2章） | 237 | 7,085 | `gt-msyo18po-68hupdm9` |

- LLM 调用分布：`batch_planner ×1`、`pipeline_draft ×2`（每章正文 paid=1）、`pipeline_review ×2` + `pipeline_factcheck ×2`（QA 并行 wave ✓）、`pipeline_brief ×2`、`pipeline_proof ×3`（第1章 2 次，见下）
- tokens（12:40 后合计）：draft 15,017/21,859；review 16,032/9,638；factcheck 13,687/3,609；brief 19,770/4,960；proof 20,951/21,280
- **Crash/恢复实证**：第 1 章 proof 阶段出现"结果未知"（服务端可能已执行）→ 批次暂停 → UI 二次确认对话框展示 checkpoint 精确恢复语义（"已成功的阶段直接复用…"）→ 确认继续 → **draft 未重复调用**（draft 总数仍为每章 1 次），proof 重试 1 次后通过 → 2/2。

## 三、穿测 B：Continuation Standard Batch（项目 16 E2E_CB1）✅ 2/2（2026-08-19 凌晨完成）

- 批次：`batch_msyoe0tl_5manuw`（completed），档位"中（批次冻结）"= standard，2 章
- 最终结果：

| 章 | 章节ID/position | 字数 | generationTraceId | freezeFingerprint | 状态 |
|---|---|---|---|---|---|
| 余烬未冷（第56章全局） | 238/51 | 2,673 | gt_6929563234463a93cd37bfe296be79d6 | 3b12bd7f1e52da5313ebd7c351d24b7de545de5361713fb0c2106b6ee6c13f0c | finalized, run adopted |
| 重铸天机（第57章全局） | 239/52 | 2,863 | gt_ae9abea84bce65b135acc91ba234d86f | 9be08ba988fefe6102812e9b915ccac4e531efd2e0225b7e75dfa9bb78d06268 | finalized, run adopted |

- LLM 调用分布（13:40 后）：`pipeline_draft ×2`（**每章正文 paid=1，多次 crash/恢复重试零重复 draft**）、review/audit/brief/proof 各 ×2（QA wave）、`continuation_state_extraction ×2`、`story_memory_v2_primary ×111`（见下）
- tokens：draft 合计 60,680/4,372；state extraction 4,797/1,485；SM checkpoint 风暴 1,684,025/253,453（111 次）
- **P0-2 真实验证（核心）**：Ready Gate 首次执行 `replayPendingContinuityProposals` —— **124 条 legacy pending → 0**（auto_commit 累计 138 条 = 124 legacy + 14 新提取），零人工清理、零额外 LLM 分类调用；replay 产生的 per-event rebuild 入队后由 worker 消化，最终 outbox **786 条全部 completed**（含 1 条乐观锁冲突 failed 与 38 条网络 failed，经"全部重试"+worker 重跑后全部转绿——历史失败最终不阻断的完整实证）。
- Ready Gate 精确链路闭环：`extract_state:239:<hash>` completed + `rebuild_story_memory:auto:16:52:<hash>` completed + SM `clean / dirty=null / through=52`。
- **过程中发现并修复的真实问题**（三个，全部最小修复 + 测试锁定）：
  1. `SQLiteBlobTooBigException`（run 行 1MB+ vs 低内存设备 1MB CursorWindow）→ commit `fdf17c62`（列裁剪 + json_extract + substr 分段流式读）。
  2. 冷启动 outbox 僵尸 `running` 行永不 re-claim → commit `b53c4bd1`（冷启动复位 interrupted；真机实证 48 条 running 复位后恢复消化）。
  3. `retryFailedContinuationOutbox` 使用 `UPDATE ... ORDER BY ... LIMIT` —— Android 内置 SQLite 未启用 `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`，真机"全部重试"静默语法报错（sql.js 测试环境支持故未测出）→ commit `01cbaf6`（LIMIT 移入 `id IN (SELECT ... LIMIT)` 子查询；真机实证 failed 38 → 全部重置消化）。
  - 另：GROK 中途接手时发现 FIFO 风暴饿死当前章 extract_state（139 条 replay 残留排在其前致 gate 超时）→ commit `3244bef8`（`listPendingOutbox` 按 extract_state → apply_event → rebuild 排序，真机实证 15:40 冷启动 extract_state:239 立即出队完成）。
- 环境事故（非代码问题，记录备考）：模拟器运行数日后 **DNS 解析失效**（IP 直连通、域名 unknown host）导致 rebuild 风暴期 38 条 `network_error` failed —— 重启模拟器恢复。低内存设备上 `uiautomator dump` 会被 OOM kill（静默失败读到旧文件），UI 取证需用截图 + 图像分析交叉验证。

## 三B、穿测 C-2：Continuation One-Shot（项目 16，单章批次）✅ 1/1

- 批次：新批次（completed），档位"极速（批次冻结）"= one_shot，1 章（第 58 章全局 = position 53「月影阁惊局」，3,508 字，finalized）
- generationTraceId `gt_3855bd56c889c48f3fcca74e0adae6d2` / freezeFingerprint `3c0f64c1c5ec1898a8dcbde8fc081d2eba37852f9aae2de2dd7f6d284611cc99`
- LLM 调用：`batch_planner ×1`（1,798/3,019）+ **`pipeline_draft ×1`（34,090/2,633，chapterWritingPaidCallCount = 1）** + PostWriting 辅助：`continuation_state_extraction ×1`（2,888/313）、`story_memory_v2_primary ×1`（10,193/1,107）
- **formatter/review/audit/factCheck/revision/proof = 0** ✓；Persist = PASS（finalized）✓；PostWriting = PASS（SM clean through=53）✓

## 四、穿测结论（全部完成）

| 轮 | 结果 | 关键口径 |
|---|---|---|
| C-1 Outline One-Shot 2 章 | ✅ 2/2 | 每章 paid=1，formatter/proof 等 0 |
| A Outline Standard 2 章 | ✅ 2/2 | 每章 draft=1，QA wave 并行，checkpoint 恢复零重复 |
| B Continuation Standard 2 章 | ✅ 2/2 | 124 legacy pending 零人工清理，Ready Gate 闭环，多次恢复零重复 draft |
| C-2 Continuation One-Shot 1 章 | ✅ 1/1 | paid=1，PostWriting PASS，SM through=53 |

真实 LLM 总计 6 章（2+2+2）。按方案§十：不做 P50/P95、不声称提速、不做统计显著性与外推；逐章数据见上文各节。

## 五、证据副本（本地 Temp，不入库）

| 轮/章 | scenario | executionProfile | generationTraceId | paid正文 | 辅助调用 | in/out tokens |
|---|---|---|---|---|---|---|
| C-1 ch1 | outline | one_shot | gt-msyn4ni3-dyjqjo9h | 1 | 0 | 7,353/3,260 |
| C-1 ch2 | outline | one_shot | gt-msyn5m68-by89v6p0 | 1 | 0 | 5,967/2,958 |
| A ch1 | outline | standard | gt-msynmrno-myeg32se | 1 | review+factcheck+brief+proof×2 | 见§二 |
| A ch2 | outline | standard | gt-msyo18po-68hupdm9 | 1 | review+factcheck+brief+proof | 见§二 |
| B ch1 | continuation | standard | gt_6929563234463a93cd37bfe296be79d6 | 1 | extract+SM rebuild | draft 30,340/2,186（章均） |
| B ch2 | continuation | standard | gt_ae9abea84bce65b135acc91ba234d86f | 1（多次恢复零重复） | extract+SM rebuild | 见§三 |
| C-2 | continuation | one_shot | gt_3855bd56c889c48f3fcca74e0adae6d2 | 1 | extract×1+SM×1 | 34,090/2,633 |

- freezeFingerprint：outline 轮存 pipeline_context `generationFingerprint`（ch1 `a5106cf2…`）；continuation 轮 4 章齐备（B 两章 + C-2 见§三/§三B，经 `json_extract` 从 run snapshot SQL 层提取）。
- 历史 failed outbox 真实阻断验证：设备原 0 条 failed；B 轮自然产生 1 条乐观锁冲突 failed + 38 条网络 failed —— 经修复后的"全部重试"+worker 全部转 completed，批次最终 completed，**"历史失败不阻断未来 Batch"得到真机活案例实证**；fail-closed 语义由 closure 测试套件锁定。

## 六、证据副本（本地 Temp，不入库）

- DB 快照序列：`C:/Users/Administrator/AppData/Local/Temp/tavo-qa/device-db.db` … `device-db9.db` / `dbp.db`（穿测各时点）
- UI dump：同目录 `ui.xml`；截图 `screen.png`
- 查询速查：
  - 批次：`SELECT status FROM multi_chapter_batches WHERE id='batch_msyoe0tl_5manuw';`
  - outbox：`SELECT state,COUNT(*) FROM continuation_state_sync_outbox WHERE project_id=16 AND state!='completed' GROUP BY state;`
  - pending：`SELECT COUNT(*) FROM continuation_state_proposals WHERE project_id=16 AND status='pending';`
  - SM：`SELECT status,dirty_from_position,through_chapter_position FROM project_story_memory WHERE project_id=16;`
  - 拉库命令（注意 MSYS_NO_PATHCONV + exec-out 二进制安全）：`MSYS_NO_PATHCONV=1 adb -s emulator-5554 exec-out run-as com.shinewriter cat databases/shine_writer.db > 本地路径`
