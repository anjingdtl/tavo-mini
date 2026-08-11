# Tavo-Mini DeepSeek V4 Prompt Cache P0+P1 验收报告

> **方案**：`docs/optimization/Tavo-Mini_DeepSeek_V4_Prompt_Cache_P0_P1保守型优化与穿测方案_V2.11.49.md`
> **验收日期**：2026-08-11
> **验收 Agent**：ZCode 自主施工与验收

---

## 【基线】

| 项目 | 值 |
|------|-----|
| Remote SHA | `9a032637388353295e6ec14b555bcf6c718fba11` |
| 本地 HEAD | `9a032637 release: V2.11.49 story memory temporal boundary`（与远端一致，无未提交改动起底） |
| App Version | V2.11.49（未变更；本期为缓存专项，不发版版本号） |
| Schema before | 50 |
| Schema after | **51** |
| DeepSeek Model | `deepseek-v4-flash` @ `https://api.deepseek.com`（设备已配置且为激活） |

---

## 一、实际修改文件

### 生产代码（9 个文件，+196 / −4 行）

| 文件 | 改动 |
|------|------|
| `src/services/llm/types.ts` | `LLMResult` 新增 `promptCacheHitTokens?` / `promptCacheMissTokens?`；`rawUsage` 类型新增 cache 字段声明 |
| `src/services/llm/openAICompatibleProvider.ts` | 新增纯函数 `parsePromptCacheUsage()`；成功路径返回 cache 字段；`safeLogUsage` 接线 |
| `src/services/migrations/v50-to-v51.ts` | **新文件**：幂等 nullable ALTER，4 列 |
| `src/services/migrations/index.ts` | `SCHEMA_VERSION = 51`；注册 50→51 migration |
| `src/data/schema/createCurrentSchema.ts` | fresh install 引入 `buildSchema51CreateSqls()` |
| `src/services/database/schemaManifest.ts` | 两表 manifest 各加 2 列（validator 约束） |
| `src/data/repositories/usageRepository.ts` | `logLLMUsage` 写 cache 列；新增 3 个只读聚合查询 |
| `src/data/repositories/pipelineStageAttemptRepository.ts` | Row/Input/mapRow/update 新增 cache 字段 |
| `src/services/pipeline/reconcile.ts` | `runStageAttempt` 泛型约束 + 成功路径持久化 cache telemetry |

### 新增测试与工具（5 个新文件）

| 文件 | 用途 |
|------|------|
| `__tests__/llmPromptCacheUsage.test.ts` | Provider cache parser 单测（12 例，覆盖方案 §8.1 全部场景） |
| `__tests__/migrations-v50-v51.test.ts` | Schema 50→51 迁移：fresh / upgrade / 幂等 / 数据保留 / 禁止表未动 / 无新索引 |
| `__tests__/promptCacheByteStability.test.ts` | P0-8 Frozen Request 字节稳定 + P1 诊断工具 |
| `src/services/llm/promptByteStability.ts` | P1 诊断纯函数（`serializeChatMessagesForFingerprint` / `fingerprintChatMessages`） |
| `__tests__/migrations-schema40-to-43-chain.test.ts` | 版本哨兵 `'50'→'51'`（1 行维护性更新） |

---

## 二、Schema 变化

### Schema 50 → 51（纯向前兼容增量）

```sql
-- llm_usage_logs
ALTER TABLE llm_usage_logs ADD COLUMN prompt_cache_hit_tokens INTEGER;   -- nullable
ALTER TABLE llm_usage_logs ADD COLUMN prompt_cache_miss_tokens INTEGER;  -- nullable

-- pipeline_stage_attempts
ALTER TABLE pipeline_stage_attempts ADD COLUMN prompt_cache_hit_tokens INTEGER;   -- nullable
ALTER TABLE pipeline_stage_attempts ADD COLUMN prompt_cache_miss_tokens INTEGER;  -- nullable
```

### 边界遵守

- ✅ 仅 4 个 nullable INTEGER 列，historical 行保持 NULL（"当时无采集能力"，未 backfill 为 0）
- ✅ `story_memory_request_attempts` / `multi_chapter_batches` / `pipeline_tasks` / `chapters` / `project_story_memory` **未新增任何缓存列**（迁移测试 + 设备实测双重确认）
- ✅ 未新增任何缓存索引（聚合专用列，非定位条件）
- ✅ 未持久化 Prompt / 正文 / API Key / reasoning 内容
- ✅ 迁移幂等（重复执行 3 次不报错）；缺失表跳过而非崩溃
- ✅ fresh install 与 50→51 upgrade 物理结果一致

---

## 三、P0 完成情况

| P0 项 | 状态 | 证据 |
|-------|------|------|
| P0-1 LLMResult 扩展 | ✅ PASS | `types.ts` 新增字段，typecheck clean |
| P0-2 `parsePromptCacheUsage` | ✅ PASS | 12 例单测全过；null 不伪造 0；不影响 inputTokens/reasoningTokens fallback |
| P0-3 Schema 50→51 | ✅ PASS | fresh + upgrade + 幂等 + 数据保留迁移测试全过；设备实测列存在 |
| P0-4 usage 日志接线 | ✅ PASS | `logLLMUsage` 写真实值/NULL；`safeLogUsage` 语义保持（失败不影响生成） |
| P0-5 Pipeline 阶段级统计 | ✅ PASS | `runStageAttempt` 成功路径写 cache；error 路径不写（NULL）；710 pipeline 测试全过 |
| P0-6 Story Memory 统计 | ✅ PASS（验证项，无代码改动） | scenario `story_memory_*` 已自动流入 `llm_usage_logs.scenario`；未改 `storyMemoryRequestAttemptRepository` / `storyMemoryAttemptBudget` |
| P0-7 只读缓存查询 | ✅ PASS | 新增 `getLLMCacheUsageSummary` / `ByScenario` / `ByConfig`；ratio = hit/NULLIF(hit+miss,0)；未改普通用户 UI |
| P0-8 Frozen Request 稳定性门禁 | ✅ PASS | 新增字节级回归测试：no-retry 字节一致；retry 前缀字节一致 + 仅末尾 1 条 user；fingerprint 跨独立构造稳定；20 次重复调用 fingerprint 唯一 |

**P0 请求次数验证**：本期仅新增 nullable 列与只读解析；正常生成路径**零新增 API 请求**。无 warm-up、无 miss 重试、cache hit/miss 不进任何 Pipeline 分支条件。

---

## 四、P1 字节不稳定点审计与修复证据

### 审计方法

对方案 §6.3 列出的全部 Prompt Builder 逐项审计非确定性来源（`Date.now` / `Math.random` / `new Date` / `Map` 迭代 / `Set` / `Object.keys/values/entries` / `JSON.stringify` 无序 key）：

| Builder | 审计结论 | 是否修改 |
|---------|---------|---------|
| `contextBuilder.ts` | Map/Set 均由确定性数组驱动（chapters/tokenize），JS 插入序迭代确定性；无 JSON.stringify | **未改（已稳定）** |
| `outlineContextBuilder.ts` | 无 Date/random/Map/Set；sha256Hex 输入为字符串 + contractVersion | **未改（已稳定）** |
| `pipelineMessages.ts` | Set 仅用于 `[...new Set(arr.filter(...))]` 去重（插入序确定）；JSON.stringify 均作用于固定 key 对象字面量/数组 | **未改（已稳定）** |
| `compileStageRequest.ts` | 无 Date/random；唯一 Set 为常量 `.has()` 查找无迭代；fingerprint 由 caller 计算 | **未改（已稳定）** |
| `compileBriefStageRequest.ts` | 无 Date/random/Map/Set；JSON.stringify 均作用于数组/固定 key 字面量 | **未改（已稳定）** |
| `pipelineTaskContext.ts` | fingerprint payload 为固定 key 字面量（确定）；`Date.now()` 仅用于 `createdAt`/`draftCompletedAt` 信封时间戳，**不进 fingerprint payload** | **未改（已稳定）** |
| `storyMemoryObservationMaterials.ts` | `Object.values(state.characters)` 后有显式 `.sort((a,b)=>a.id.localeCompare(b.id))` 保护 | **未改（已稳定）** |
| `storyMemoryObservationPrompts.ts` | 无任何非确定性来源 | **未改（已稳定）** |

### P1 结论

> **发现实际字节不稳定点：0 个。**

当前所有 Prompt Builder 在相同业务输入下已具备字节确定性。P1-2 审计未复现任何"相同业务输入产生不同字节"的非语义抖动。按方案 §6.3 铁律"没有复现，记录'已稳定'，不改代码"，**P1 未对任何 Builder 做生产代码修改**，只新增字节稳定性锁定测试（`promptByteStability.test.ts`）。

这同时验证了方案 §2.5 的判断：现有架构已具备大量确定性设计（outline position 序、`ORDER BY c.id ASC`、`ORDER BY w.position ASC, w.id ASC`、Frozen Request、Pipeline Context Snapshot）。

### 已保护的语义顺序（严禁重排，本期未动）

- enabled outlines → position 顺序
- characters → `ORDER BY c.id ASC`
- worldbook → `ORDER BY w.position ASC, w.id ASC`
- Story Memory Character/Relationship/Foreshadowing/Timeline/Evidence（承载 firstSeen/lastChanged/opened/resolved/时间边界/relevance）
- Draft/Review/FactCheck/Brief/Final 五阶段拓扑

---

## 五、明确未修改的保护边界

以下全部为 **NO**（未触碰）：

- system/user/assistant 角色：未改
- Prompt 信息块顺序：未改
- 完整大纲：未删减/压缩/截断
- Final 上下文：未减少
- 最近最多 10 章 / Recent Bridge / Episodic：未改
- Story Memory Protocol V2 全链路（Evidence Anchor / Entity Handle / Observer Contract / Normalizer / Resolver / Compiler / Validator / Merger / CAS / Partial Success / 3→2→1 split / Elastic Allocator / Temporal Boundary / Foreground / Outcome Unknown）：未改
- Draft Frozen Request 冻结与 retry append-only：未改实现，仅加测试
- Validator / Formatter / Retry / Fail-Closed：未改
- reasoning tier / FactCheck 固定低推理：未改
- 缓存预热 API：未增加
- 正常生成路径 API 请求次数：未增加
- cache hit/miss 进 Pipeline 分支条件：未引入

---

## 六、测试结果

### 离线全量回归

| 测试 | 结果 |
|------|------|
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 0 errors（181 warnings 全部为既有文件，无新增） |
| `npm run test:ci`（全量） | ✅ **3070 passed, 7 skipped（既有跳过）, 0 failed** |

### 专项回归

| 范围 | 结果 |
|------|------|
| LLM provider（llm/llmFailureClassification/llmRequestPolicy/llmPromptCacheUsage） | ✅ 65 passed |
| Migration（coverage/matrix/engine/databaseMigration/v48-v49/v50-v51） | ✅ 60 passed |
| Pipeline / reconcile / batch（73 suites） | ✅ 710 passed |
| Story Memory（54 suites） | ✅ 500 passed, 4 skipped |
| Frozen Request（pipelineSealFreeze/promptCacheByteStability/f301BatchResume/inputFingerprint/pipelineMessages） | ✅ 48 passed |

### 新增测试明细

- `llmPromptCacheUsage.test.ts`：12 例（hit/miss 正常、hit=0、miss=0、双缺、第三方 gateway、负数、字符串数字、NaN/Infinity、非对象、reasoning 独立、纯 metadata、hit+miss≠prompt_tokens 不拒）
- `migrations-v50-v51.test.ts`：5 例（upgrade+幂等、fresh install 列存在、禁止表未动、无新缓存索引）
- `promptCacheByteStability.test.ts`：12 例（工具确定性、检测 content/order 抖动、frozen no-retry 字节一致、重复编译字节一致、retry 前缀字节一致 + 仅 1 条末尾 user、不同 retry 指令前缀仍一致、fingerprint 跨独立构造稳定、frozen base 不受 retry 影响、20 次纯函数调用 fingerprint 唯一）

---

## 七、Android 验证结果

### 构建验证

| 项 | 结果 |
|----|------|
| `npm run apk:debug` | ✅ BUILD SUCCESSFUL（44s） |
| 产物 | `dist/apk/debug/ShineWriter-V2.11.49-debug.apk`（56.16 MB） |

### 覆盖升级（真实用户数据，emulator-5554，`adb install -r`，未 uninstall / 未 pm clear）

**升级前**（V2.11.49 / Schema 50）：

```
schema_version: 50
projects: 8 | chapters: 72 | outlines: 24 | characters: 3 | notes: 3
pipeline_tasks: 39 | pipeline_stage_attempts: 193 | llm_usage_logs: 308
story_memory_request_attempts: 35
cache 列: 不存在
```

**升级后**（同 APK / Schema 51）：

```
schema_version: 51 ✅
prompt_cache_hit_tokens / prompt_cache_miss_tokens: 两表均已存在 ✅
story_memory_request_attempts 缓存列: 空（未动）✅
```

**数据保留（6 项内容 fingerprint 全部字节一致）**：

| Fingerprint | before | after | 一致 |
|-------------|--------|-------|------|
| projects | `580ef1588a067046` | `580ef1588a067046` | ✅ |
| chapters | `598d37511ea62f40` | `598d37511ea62f40` | ✅ |
| outlines | `64678c2caf6358b0` | `64678c2caf6358b0` | ✅ |
| pipeline_stage_attempts | `d16eaf1f467683ef` | `d16eaf1f467683ef` | ✅ |
| llm_usage_logs | `75f6c3b14ff29cdf` | `75f6c3b14ff29cdf` | ✅ |
| story_memory_request_attempts | `2ccc92344d31389c` | `2ccc92344d31389c` | ✅ |

**历史行 NULL 保持**：308/308 llm_usage_logs 行、193/193 pipeline_stage_attempts 行 cache 列均为 NULL（未 backfill 为 0）✅

**App 运行**：启动正常（PID 31791），作品库显示 7 个项目，无崩溃 / 无 FATAL / 无空白屏 ✅

---

## 八、DeepSeek 缓存实测结果

### 环境状态

设备已配置激活的 DeepSeek V4 Flash（`https://api.deepseek.com` / `deepseek-v4-flash`），历史 308 条 usage 覆盖全部 Pipeline 阶段与 Story Memory scenario。API Key 存于 Android Keystore。

### 可离线验证部分（已完成）

- Provider cache parser：12 例单测证明能正确解析 DeepSeek `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（含 hit=0/miss=0/双缺/负数/字符串/NaN 全部边界）
- 端到端接线（typecheck + 全量测试证明）：provider → `LLMResult.promptCacheHitTokens/MissTokens` → `safeLogUsage` → `llm_usage_logs` 列；provider → `runStageAttempt` → `updateStageAttempt` → `pipeline_stage_attempts` 列
- Schema 51 列物理存在（设备实测）
- 统计查询 `getLLMCacheUsageSummary/ByScenario/ByConfig` 就绪

### 待测项（明确记录）

> **真实 DeepSeek V4 Flash 长篇穿测（方案 §9.3，20～50 章）未在本次自主会话中执行。**

原因：
1. 该穿测需连续生成 20～50 章（5 阶段 × reasoning 模型 × 多章），单次耗时 30 分钟以上并产生真实 API 费用，属人工成本/时间决策范畴；
2. 方案明确"缓存命中率不是发版硬 Gate"，验收优先级中文学质量/稳定性/恢复正确性高于缓存收益；
3. 方案 §9.3 允许"如无 Key…只完成可离线验证部分并明确记录待测项"——Key 存在，但长篇穿测本身是独立人工执行项。

**后续执行建议**：人工加载本构建，固定测试项目，连续生成 20～50 章后查询：
```sql
SELECT scenario,
  SUM(prompt_cache_hit_tokens) AS hit,
  SUM(prompt_cache_miss_tokens) AS miss,
  SUM(prompt_cache_hit_tokens)*1.0/NULLIF(SUM(prompt_cache_hit_tokens)+SUM(prompt_cache_miss_tokens),0) AS ratio
FROM llm_usage_logs GROUP BY scenario;
```
（或调用 `getLLMCacheUsageByScenario(projectId)`）

---

## 九、API 调用数前后对比

| 维度 | before | after |
|------|--------|-------|
| 正常生成路径每章请求数 | 不变 | **不变**（零新增） |
| 缓存预热请求 | 0 | **0** |
| miss 触发重试 | 无 | **无** |
| Story Memory 请求节奏 | 不变 | **不变** |

本期纯观测性改造，**API 请求次数零增量**。

---

## 十、已知风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| 第三方 OpenAI-compatible gateway 不返回 cache 字段 | 极低 | parser 返回 null，列写 NULL，不影响生成；已在单测 case 5 覆盖 |
| 历史 308 条 usage 无 cache 数据 | 无 | 设计如此（NULL = 当时无采集能力），新调用自动采集 |
| `Number(true)===1` 布尔强制转换 | 极低 | 与既有 `parseNonNegativeUsageNumber`/`parseReasoningTokens` 一致行为；provider 不发布尔；单测显式锁定 |
| 真实 cache hit ratio 未实测 | 中 | 离线管线已全验证；长篇穿测列为待测项，非发版 Gate |

---

## 十一、Gate A/B/C/D 核对

### Gate A：上下文完整性 ✅
完整大纲完整、最近正文策略不变、Story Memory 注入不变、上一章连续性不变、Character/Worldbook/Note 命中不变、Final 上下文不减少。**未触碰任何 Prompt 构建生产代码。**

### Gate B：流水线稳定性 ✅
710 pipeline 测试 + 500 Story Memory 测试全过；成功率/Formatter/Retry/Validator/outcome_unknown/API 调用数均无变化（本期不改业务分支）。

### Gate C：文学质量 ✅
未改任何 Prompt 角色/顺序/上下文选择；Frozen Request retry 仍复用 frozen.messages；Story Memory V2 协议冻结。文学语义零变化。

### Gate D：缓存收益 ⏳（待长篇实测）
离线管线就绪；真实 ratio 待人工 20～50 章穿测。**非发版 Gate。**

---

## 【最终结论】

# ✅ GO

**理由**：

1. **第一优先级全部满足**：文学上下文零变化、Pipeline 行为零变化、Story Memory 行为零变化、API 请求次数零增量、Retry/Resume 行为零变化、原有测试无回退（3070 passed）。
2. P0 可观测性全链路就绪（parser + LLMResult + 双表 telemetry + 3 个只读聚合查询 + Frozen Request 字节稳定门禁）。
3. P1 审计证明当前 Builder 已字节确定，零非语义抖动需修复——符合"先证明问题再修复"铁律。
4. Schema 51 纯向前兼容增量，真实用户数据 8 项目 / 72 章 / 193 attempts / 308 usage 全部字节级保留。
5. 唯一待测项（真实长篇 cache ratio）非发版 Gate，离线管线已全验证，可安全交付。

---

## 附录：施工原则遵守确认

> 先观测，后修复；先证明字节抖动，后允许改动。 → ✅ P1 审计 0 抖动，0 改动
>
> 只优化非业务序列化差异，不优化文学语义。 → ✅ 未触碰任何 Prompt 业务语义
>
> 不为缓存删上下文、不为缓存调顺序、不为缓存降推理、不为缓存多发一次请求。 → ✅ 全部遵守
>
> 缓存收益是结果指标，用户体验、文学质量和恢复正确性才是发版门槛。 → ✅ Gate A/B/C 通过，Gate D 待实测但不阻断
