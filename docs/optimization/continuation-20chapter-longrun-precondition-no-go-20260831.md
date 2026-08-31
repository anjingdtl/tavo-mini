# TAVO-MINI 原著续写 20 章长测 — 前提缺失 NO-GO 报告

> 日期：2026-08-31（Asia/Shanghai）
> 任务：原著续写 20 章长测专项验收（Balanced × 10 + Strict × 10）
> 状态：**PRECONDITION NO-GO / STOP**
> 施工仓：`E:\AiWorkSpace\tavo-mini`
> 当前 HEAD：`c3a86997fed2bd1ceedacf5ddfe1ba059ded6947`（origin/main = main）

---

## 0. 一句话结论

设备当前状态完全不具备执行「原著续写 20 章长测」的最小前提条件：

- **数据库中没有任何续写域数据**（`continuation_sources / continuation_style_profiles / continuation_canon_snapshots / canon_*` 全部 0 行）
- **没有任何 `mode='continuation'` 的项目**（12 个项目全部为 `outline`）
- **`files/continuation-imports/` 目录为空**（没有任何已导入原著文本）

任务指令明确要求「选择一个材料充分、已完成原著分析、Canon/Style Profile 可用的真实测试项目」。当前不存在这样的项目。继续执行等于伪造 PASS，被任务规则禁止（十三、禁止事项），故立即停止并报告缺什么。

---

## 1. 用户路径与实际路径不一致

用户给出的施工仓为：

```text
F:\ClaudeWorkSpace\projects\TAVO-MINI
```

实际仓库为：

```text
E:\AiWorkSpace\tavo-mini
```

F 盘目录不存在，已切到 E 盘执行，但这是必须先报告的事实。

---

## 2. 已核验的环境前提

| 项 | 值 | 来源 |
| --- | --- | --- |
| 仓库实际路径 | `E:\AiWorkSpace\tavo-mini` | `pwd` |
| HEAD SHA | `c3a86997fed2bd1ceedacf5ddfe1ba059ded6947` | `git rev-parse HEAD` |
| 与 origin/main 一致 | yes | `git status -sb` |
| 工作区未提交变更 | 仅 2 个未跟踪 Phase3 文档 + `scripts/qa/__pycache__/` | `git status` |
| 当前版本 | V2.21.1 / versionCode 2210100 | `package.json` + `src/constants/version.json` |
| Android 设备 | `emulator-5554` (sdk_gphone16k_x86_64) | `adb devices` |
| 已安装 APK | `com.shinewriter` V2.21.1, lastUpdate 2026-08-31 04:27 | `adb dumpsys` |
| 设备 DB 当前 SHA-256 | `374b05cf5ae2b16c390cd35c5b18e3a88e456879565f6e77dfd4a47ca79de3e9` | `sha256sum` |
| Phase 4 封板时间 | 2026-08-31 13:30（IV-12A~IV-12E 已 GO） | `docs/optimization/` |
| 封板覆盖范围 | outline-mode 写作管线（Fast/Standard/Quality A/B） | IV-12A 报告 |
| **封板未覆盖** | **原著续写域 20 章长跑** | 本任务 |

注：设备 DB SHA 与 IV-12A preflight 快照一致，说明 IV-12A 把 DB 恢复到了「封板前 clean 状态」，而不是「续写域有数据的状态」。

---

## 3. LLM Provider 配置

| id | name | model | base_url | is_active | context | max_output | api_key 长度 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| 1 | 默认配置 | GLM-5.3-Flash | https://open.bigmodel.cn/... | 0 | 1,000,000 | 0 | 0 |
| 2 | Phase3C-Virtual-LLM | virtual-test-model | https://virtual.invalid/v1 | 0 | 128,000 | 0 | 0 |
| **3** | **Deepseek** | **deepseek-v4-flash** | **https://api.deepseek.com** | **1** | **1,000,000** | **0** | **0** |

观察：

- 仅 Deepseek (`is_active=1`)，其它均 inactive。
- `api_key` 长度为 0（落 Android Keystore，未存到 DB，正确）。
- `max_output_tokens = 0` 看起来可疑——可能是「不显式约束」的隐式语义，但需要核对 provider registry 是否回退到默认；该核对不阻止本任务 NO-GO，仅记一笔。

凭据与连通性不是 NO-GO 原因，但需要后续用真实 provider 接通后才能确认 thinking / max_tokens 等。

---

## 4. 续写域数据全空（核心 NO-GO 原因）

数据库快照：`test-logs/continuation-20chapter-precheck-20260831/precondition-device-db-snapshot.db`
SHA-256：`374b05cf5ae2b16c390cd35c5b18e3a88e456879565f6e77dfd4a47ca79de3e9`

### 4.1 续写域表行数

| 表 | rows |
| --- | ---: |
| `continuation_sources` | **0** |
| `continuation_source_chapters` | **0** |
| `continuation_import_jobs` | **0** |
| `continuation_style_profiles` | **0** |
| `continuation_canon_snapshots` | **0** |
| `continuation_analysis_batches` | **0** |
| `continuation_analysis_runs` | **0** |
| `continuation_plans` | **0** |
| `continuation_generation_runs` | **0** |
| `continuation_state_events` | **0** |
| `continuation_settings` | **0** |
| `continuation_entities` | **0** |

### 4.2 Canon 核心表行数

| 表 | rows |
| --- | ---: |
| `canon_characters` | **0** |
| `canon_world_rules` | **0** |
| `canon_relationships` | **0** |
| `canon_plot_threads` | **0** |
| `canon_timeline_events` | **0** |
| `canon_evidence` | **0** |

### 4.3 项目与模式分布

| 项 | 数量 |
| --- | ---: |
| projects total | 12 |
| projects `mode='continuation'` | **0** |
| projects `mode='outline'` | 12 |

所有 12 个项目均为 outline-mode，最近 6 个为 `iv11-*` / `phase3c-c1-*`（2026-08-28~31），用于 Phase 3-C / IV-11 / IV-12A 测试，没有任何一个切换到 continuation mode。

### 4.4 章节与 multi_chapter_batches

| 项 | 数量 |
| --- | ---: |
| `chapters` | 36 |
| `multi_chapter_batches` | 11 |
| `multi_chapter_batch_items` | 66 |
| `pipeline_tasks` | 86 |
| `pipeline_stage_attempts` | 203 |

其中：

- `multi_chapter_batches` 全部 11 个都是 outline-mode 项目（project 63 / 64 / 65 / 66），`pipeline_mode='full'`，不是 continuation。
- `pipeline_tasks` 中没有任何 `pipeline_context_json` 包含 `continuation` / `Continuation` 字段的记录（基于 `LIKE '%continuation%'` 命中数为 0）。
- 最近一批 `batch_mtgmub04_rzoyix`（project 66）`completed` 10/10，但属于 outline-mode 写作任务，不是续写。

### 4.5 设备文件系统

```text
files/continuation-imports/    -> empty (只有 . / ..)
files/datastore/               -> (datastore 持久化，未必需要续写源)
files/schema-recovery/         -> (schema-recovery 备份目录)
```

`files/continuation-imports/` 是空目录，没有任何已落盘的原著文本。

---

## 5. 任务要求 vs 现实差距

| 任务要求 | 现实 |
| --- | --- |
| 选择一个材料充分、已完成原著分析、Canon/Style Profile 可用的真实测试项目 | 无 |
| 原著续写共 20 章 | 无续写源，无法生成 |
| 真实生产链路 | 续写生产链路 0 行状态 |
| Mock / fake provider 不可计入分母 | 唯一 active 是 Deepseek，无 mock |
| Thinking 必须保持 ON | 当前无任何续写任务，无法验证 thinking 行为 |

任务还要求：

> 没有满足测试条件的真实原著项目，不要伪造 PASS，直接 PRECONDITION NO-GO 并说明缺什么。

触发该条件。

---

## 6. 缺什么 / 启用本任务的最小条件

要让本任务可行，至少需要满足以下所有项（顺序建议）：

1. **导入一份真实原著文本**（UTF-8，中长篇，章节清晰，建议 ≥ 30 章 / 30 万字以上），通过「原著续写 → 资料 Tab → TXT 导入」完成 `continuation_sources` + `continuation_source_chapters` 落库（schema 19/20）。
2. **触发并完成 Canon 五维分析**（character / relationship / plot / timeline / world_rule / experience / knowledge），生成至少一个 `review_status != superseded` 的 `continuation_canon_snapshots` 行 + 填充 `canon_characters/world_rules/relationships/plot_threads/timeline_events/evidence`。
3. **触发并完成 Style Profile（V2）分析**，生成至少一个 `state='active'` 且 `review_status='accepted'` 的 `continuation_style_profiles` 行；`active_style_profile_id` 在 `continuation_settings` 中指向它。
4. **设置 boundary**：在 `continuation_settings` 写入 `boundary_source_id`、`boundary_chapter_id`、`boundary_char_offset_global`、`boundary_mode`，且 `import_completed=1`、`analysis_status='completed'`。
5. **创建或切换到 `mode='continuation'` 的项目**（目前没有任何一个）。
6. **配置 `continuation_generation_settings`**：`strictness_profile='balanced'` 与 `'strict'` 两套；目标章节长度（如 3000 字）；planner/writer/checker/repair/control 五个 LLM config id 全部指向 Deepseek（id=3）。
7. **校对 LLM 实际连通性**：用一次小规模（1 章 dry-run）确认 Deepseek 在续写生产链路上 Thinking ON / max_output_tokens 实际行为（不能只读 DB 中 0 这个可疑值）。
8. **脱敏备份当前 DB**（已完成：`test-logs/continuation-20chapter-precheck-20260831/precondition-device-db-snapshot.db`）。

完成 1–7 后，再开 `multi_chapter_batches`（feature flag `multi_chapter_batch_enabled`），按本任务规定的 Balanced 10 + Strict 10 跑分母。

---

## 7. 已停止的下游任务

下列任务在本报告状态下不再执行（已记录但被 NO-GO 阻断）：

- [x] 任务 #1：验证前提条件 → 结果：本节即报告，**NO-GO**
- [ ] 任务 #3：创建进度跟踪文档 → 不创建（无任务可跟踪）
- [ ] 任务 #4：构建并安装 Exact HEAD APK → 不构建（V2.21.1 已安装且与 HEAD 一致，重建无收益）
- [ ] 任务 #5：Run A Balanced 10 章 → 缺源、缺项目
- [ ] 任务 #6：Run B Strict 10 章 → 同上
- [ ] 任务 #7：文学质量盲评 → 无正文可评
- [ ] 任务 #8：硬一致性检查 → 无 Canon / 无边界
- [ ] 任务 #9：风格统计 + 累积衰减 → 无 Style Profile / 无正文
- [ ] 任务 #10：KPI 汇总 + 95% Wilson CI + GO/NO-GO 报告 → 不出（分母为 0）

---

## 8. 证据 / 工件

- 设备 DB 快照：`test-logs/continuation-20chapter-precheck-20260831/precondition-device-db-snapshot.db`
  SHA-256：`374b05cf5ae2b16c390cd35c5b18e3a88e456879565f6e77dfd4a47ca79de3e9`
- 本报告：`docs/optimization/continuation-20chapter-longrun-precondition-no-go-20260831.md`
- 设备状态：未做任何 `adb uninstall` / `pm clear` / DB 删除；APK 未重装；DB 仅拉取做只读查询，未在设备上写入。

---

## 9. 最终结论

```text
CONTINUATION 20-CHAPTER LONG-RUN
PRECONDITION NO-GO / STOP

缺少：真实原著文本导入 + 完整 Canon 分析 + 已激活 Style Profile + continuation-mode 项目 + boundary 设置。
当前设备仅有 outline-mode 历史，无法计入任何续写分母。
```

建议下一步是导入合适体量的真实原著并完成 Canon + Style Profile + boundary 配置，再重开本任务；不要在本状态下强行推进 20 章。
