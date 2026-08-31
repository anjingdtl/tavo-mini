# TAVO-MINI 原著续写 20 章长测 — 进度跟踪

> 日期：2026-08-31（Asia/Shanghai）
> 状态：阶段 0 — 准备（导入 + Canon + Style Profile + boundary）
> 施工仓：`E:\AiWorkSpace\tavo-mini`
> HEAD：`c3a86997fed2bd1ceedacf5ddfe1ba059ded6947`
> 源文本：`C:\Users\anjin\Desktop\Ai工作坊\《白篱梦》.txt`（3.0 MB / 34861 行 / UTF-8 / 299 章 / 作者 希行）

## 0. PDCA 进度

- [x] **PLAN** 任务定义
- [x] **PRECHECK** 设备 / 凭据 / 数据库核验（首轮 NO-GO）
- [x] **PRECHECK 第二轮** 用户提供真实源文本
- [x] **阶段 0a** 项目创建（project_id=67，name=`bailimeng-longrun-20260831`）
- [x] **阶段 0b** 源文本导入（source_id=4，299 章，1,033,681 字，UTF-8，sha256=6faa89e6...）
- [x] **阶段 0c** Canon 快速续写分析（4 批 × 2 类 = 8 LLM calls，约 4 分钟，6/6 批次 100%，snapshot `0d4656b9…` v1 已激活）
- [ ] **阶段 0d** Style Profile V2 分析与激活（UI 显示「就绪」，需进一步确认 active_style_profile_id）
- [ ] **阶段 0e** boundary 配置确认（已设 `end_of_source` / chapter 299）
- [ ] **阶段 0f** continuation_generation_settings 配置（balanced / strict 两套 strictness）
- [ ] **BUILD** Exact HEAD APK（如需要）
- [ ] **adb install -r**
- [ ] **Run A** Balanced 10 章连续
- [ ] **CHECK A** 数据汇总
- [ ] **Run B** Strict 10 章连续
- [ ] **CHECK B** 数据汇总
- [ ] **LITERARY AUDIT** 两轮 blinded scoring
- [ ] **DATA VALIDATION** 风格统计 + 累积衰减
- [ ] **ACT + GO/NO-GO**

## 1. 关键事实 / 决策

- 用户给的仓库路径 `F:\ClaudeWorkSpace\projects\TAVO-MINI` 不存在；实际在 `E:\AiWorkSpace\tavo-mini`。
- 设备 DB SHA = `374b05cf...` 与 IV-12A preflight 一致（封板后干净状态）。
- Phase 4 IV-12A~IV-12E 已 SEALED，但只覆盖 outline-mode 写作管线（Fast/Standard/Quality A/B），未覆盖原续写域。
- LLM 配置：Deepseek `is_active=1`，API key 落 Keystore（DB 长度=0）。
- 续写域数据全空（0 行），需要在阶段 0 完成导入 + Canon + Style Profile + boundary。

## 2. 禁止 / 边界

按任务指令禁：

- 不为通过率修改 Gate / Context / Governor / Prompt / Retry
- 不新增 Judge Stage / QA2 / 第二 Writer / 第二 Context / 第二 Memory
- 不删除失败记录、不 reset 统计、不允许 recovery 后改 firstPass=true
- 不 uninstall / pm clear / 清数据库
- Thinking 必须保持 ON
- 不允许 outcome_unknown 自动重发

## 3. 数据工件目录

- `test-logs/continuation-20chapter-precheck-20260831/` — precondition 证据
- `test-logs/continuation-20chapter-longrun-20260831/` — 长测主目录
  - `after-canon4.db` — Canon 完成后的设备 DB 快照（exec-out 二进制拉取，integrity_check=ok）

## 4. 阶段 0 详细记录

### 4.1 源文本导入

- 文件：`C:\Users\anjin\Desktop\Ai工作坊\《白篱梦》.txt`
- SHA-256：`6faa89e68bba97a96e1dacc0cc969de2b3217dc9c59167e9bfdb2b9e27971c81`
- 设备路径：`/sdcard/Download/白篱梦.txt` + `/sdcard/Documents/bailimeng.txt`
- 媒体扫描：通过 `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE`
- 导入结果：299 章解析成功，source_id=4

### 4.2 Canon 快速续写分析

- 触发：UI 自动化点击「快速续写分析」
- 配置：Deepseek single_batch_hard_safety_cap=300000，predicted_batches=4，predicted_llm_calls=8
- 进度：6/6（提取 2/2），100%，约 4 分钟
- 快照：`0d4656b9…` v1，已激活
- 任务界面：阶段 `风格校验`（自动收尾）；Canon + Style Profile 串联

### 4.3 Style Profile V2 状态

- UI 显示「原著写作风格：状态：就绪」
- Canon 完成后自动触发；但是否已经落库 / 处于 active 状态待 DB 二次确认

## 5. 已知遗留 / 待 DB 二次确认

- 由于 dump_continuation.py 的列名是旧 schema（schema 19/20），新 schema 50+ 的实际表结构需用 sqlite3 直接 `.schema <table>` 查询确认
- Canon snapshot / Style Profile V2 / continuation_settings 的 `active_style_profile_id` 字段需要从 DB 直接 SELECT 确认
- continuation_generation_settings 是否存在 / schema 是否支持 strictness_profile 字段需要查询
- multi_chapter_batches 是否支持 writing_mode='continuation'（CLAUDE.md 提到 schema 53+）需要在 DB 上 `PRAGMA table_info` 验证

## 6. 下一步（移交下一个 Agent）

1. 完成 Canon + Style Profile + boundary + generation_settings 的 DB 二次核验（不要相信 UI 文字）
2. 准备 Run A（balanced × 10 章）：通过 multi_chapter_batch 入口下发
3. 监控 batch progress；记录每章 firstPass / retry / fallback / adopt 状态
4. 完成后接 Run B（strict × 10 章）
5. 文学盲评 + 硬一致性 + 风格统计 + 累积衰减 + KPI 汇总 + GO/NO-GO 报告

## 7. 关键约束（必须遵守）

- 不为通过率改 Gate / Context / Governor / Prompt / Retry
- 不新增 Judge / QA2 / Writer / Context / Memory
- 不删失败记录 / 不 reset 统计 / recovery 后不允许 firstPass=true
- 不 uninstall / pm clear / 清数据库
- Thinking 必须保持 ON
- outcome_unknown 不自动重发
- 单 Pipeline / 单 Context / 单 Memory 架构
- 脱敏：API key / Authorization / 完整 Prompt / 完整原著 / 大量生成正文 / 大 SQLite 不入库
