# 上下文自动化配置 — 设计文档

| 字段 | 值 |
|---|---|
| 文档日期 | 2026-07-18 |
| 状态 | 待实现（spec 已审） |
| 影响范围 | 设置板块新增模块、5 处现有配置覆写、UI、单测 |
| Schema 版本 | 不变（保持 14） |

## 1. 背景与动机

### 1.1 问题

shinewriter 当前的"上下文 token 配置"分散在 **5 个独立位置**，对小白用户极度不友好：

1. **ContextConfig**（`ContextConfig` interface）— 滑动窗口、资料预算、摘要预算等 8 个字段
2. **PipelineConfig**（`PipelineConfig` interface）— 4 阶段（草稿/审阅/事实核查/校对）各自的 `max_tokens`
3. **LLMConfig**（`llm_config` 表）— 已有 `context_window` / `max_output_tokens` 字段，但默认值仅 4096，且在线 API 用户在 UI 上看不到这两个字段
4. **Preset**（`presets` 表）— 每预设 `max_tokens`
5. **单资源级**（`characters` / `notes` / `worldbook_entries` / `worldbook_collections` 等表）— 各自 `max_tokens` 列

用户必须在 5 个不同屏幕里分别填写各种 token 数字，且**完全不知道当前 LLM 实际能吃多少上下文**——尤其是旗舰云端模型（200K / 512K / 1M）的能力被严重低估。

### 1.2 目标

在设置板块新增"上下文自动化配置"模块。用户只需填**一个数字**（模型支持的最大上下文，如 200000），点"一键应用"，系统按内置比例自动分配到上述 5 个位置。

### 1.3 非目标

- 不引入 i18n（项目全部硬编码中文，沿用风格）
- 不引入新的 UI 依赖（不引入 Slider 库）
- 不修改数据库 schema 版本（settings 键值表足以承载）
- 不做"撤销历史"（仅"恢复默认"，YAGNI）
- 不让用户调整分配比例（写死，避免复杂度）

## 2. 用户决策记录

| # | 决策点 | 选择 |
|---|---|---|
| 1 | 输入源 | 全局设置项（设置板块新增独立模块） |
| 2 | 分配范围 | 按"输入/输出"两板块，覆盖所有 5 处 |
| 3 | 资源级 max_tokens | 覆盖 |
| 4 | UI 形态 | 一键分配 + 预览表格 |
| 5 | 应用时机 | 手动点击才应用 |
| 6 | 输入方式 | 快捷按钮 + 自由输入 |
| 7 | 应用范围 | 全局（所有项目） |
| 8 | 比例可调性 | 写死，不可调 |
| 9 | 输入字段数 | 只填一个值，自动按 80/20 拆分输入/输出 |
| 10 | 架构方案 | 方案 B（薄层 + settings 元数据） |
| 11 | 资源级算法 | R1（查询实际数量动态分配） |

## 3. 分配算法

### 3.1 顶层拆分（写死）

```
LLM 总上下文 maxContextTokens
  ├── 80% → inputBudget
  └── 20% → outputBudget
```

### 3.2 输入预算拆分（占 inputBudget 的比例）

| 配置项 | 字段路径 | 占 inputBudget 比例 | 例子（maxContextTokens=200000） |
|---|---|---|---|
| 滑动窗口 | `ContextConfig.slidingWindowSize` | **65%** | 104000 |
| 资料预算（角色+笔记+世界书） | `ContextConfig.resourceBudget` | **20%** | 32000 |
| 摘要预算 | `ContextConfig.summaryBudgetTokens` | **15%** | 24000 |

`ContextConfig` 其他字段（`strategy` / `recentChapterCount` / `memoryTopK` / `worldbookScanDepth` / `customRangeStart` / `customRangeEnd` / `includeResources` / `worldbookRecursive`）**不覆写**，保留用户原值。

资料预算的内部分配（角色 35% / 笔记 20% / 世界书 45%）由 `contextBuilder.ts` 现有逻辑处理，本设计不重复实现。

### 3.3 输出预算拆分（占 outputBudget 的比例）

| 配置项 | 字段路径 | 占 outputBudget 比例 | 例子（maxContextTokens=200000） |
|---|---|---|---|
| 草稿 | `PipelineConfig.draftMaxTokens` | **50%** | 20000 |
| 审阅 | `PipelineConfig.reviewMaxTokens` | **15%** | 6000 |
| 事实核查 | `PipelineConfig.factCheckMaxTokens` | **15%** | 6000 |
| 校对 | `PipelineConfig.proofMaxTokens` | **20%** | 8000 |

`PipelineConfig` 其他字段（`pipelineMode` / `*PresetId`）**不覆写**。

### 3.4 资源级 max_tokens（R1 动态查询实际数量）

应用时先查每类资源的全局总数（跨所有项目），再除总预算：

| 资源表 | 公式 | 单项上限 floor |
|---|---|---|
| `characters` | `resourceBudget × 35% ÷ MAX(characters_count, 1)` | 1000 |
| `notes` | `resourceBudget × 20% ÷ MAX(notes_count, 1)` | 500 |
| `worldbook_entries` | `resourceBudget × 45% ÷ MAX(entries_count, 1)` | 500 |
| `worldbook_collections` | `resourceBudget × 45% ÷ MAX(collections_count, 1)` | 2000 |

某类资源 `count = 0` 时跳过该表的 UPDATE。

### 3.5 同步写入（保持口径一致）

| 表 | 字段 | 新值 |
|---|---|---|
| `llm_config`（仅 `provider_type !== 'llama_cpp'`） | `context_window` | `maxContextTokens` |
| `llm_config`（仅 `provider_type !== 'llama_cpp'`） | `max_output_tokens` | `outputBudget` |
| `presets`（全部） | `max_tokens` | `PipelineConfig.draftMaxTokens` |

**本地 GGUF 模型（`provider_type === 'llama_cpp'`）的 `context_window` / `max_output_tokens` 不覆写**——本地模型的上下文长度由 GGUF 文件元数据决定，强行覆写会破坏运行时。

### 3.6 安全兜底

- 所有数值经 `Math.max(MIN_FLOOR, Math.round(value))` 兜底
- `slidingWindowSize` 下限 1000
- `summaryBudgetTokens` 下限 2000
- `maxContextTokens < 8000` 时 UI 弹警告（不禁用）
- `maxContextTokens <= 0` 抛错（UI 已限制 min=1，纯函数仍校验）

### 3.7 算法签名

```ts
// src/services/contextAutoAllocator.ts

export interface ResourceCounts {
  characters: number;
  notes: number;
  worldbookEntries: number;
  worldbookCollections: number;
}

export interface AllocationResult {
  // 输入侧（ContextConfig 字段）
  slidingWindowSize: number;
  resourceBudget: number;
  summaryBudgetTokens: number;
  // 输出侧（PipelineConfig 字段）
  draftMaxTokens: number;
  reviewMaxTokens: number;
  factCheckMaxTokens: number;
  proofMaxTokens: number;
  // 同步写入
  llmContextWindow: number;
  llmMaxOutputTokens: number;
  presetMaxTokens: number;
  // 资源级（每类一项）
  characterMaxTokens: number;
  noteMaxTokens: number;
  worldbookEntryMaxTokens: number;
  worldbookCollectionMaxTokens: number;
  // 元信息
  inputBudget: number;
  outputBudget: number;
  resourceCounts: ResourceCounts;
}

/**
 * 纯函数：根据用户输入的 maxContextTokens 和当前资源数量，
 * 计算出所有要覆写的字段值。无副作用，可独立单测。
 */
export function allocateContextBudget(
  maxContextTokens: number,
  resourceCounts: ResourceCounts
): AllocationResult;
```

## 4. 数据层设计

### 4.1 新增 settings key（无需迁移）

| Key | 类型 | 含义 |
|---|---|---|
| `context_auto_input` | TEXT (JSON: `{ value: number }`) | 用户最后输入的 `maxContextTokens` |
| `context_auto_last_applied` | TEXT (JSON) | 应用记录（见 4.3） |

settings 表是键值表（`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`），新增 key 不需要 ALTER TABLE，与现有 `ContextConfig` / `PipelineConfig` 存储方式一致。

### 4.2 repository

新增 `src/data/repositories/contextAutoRepository.ts`，沿用项目现有风格（**单独 export 异步函数**，不导出 object）：

```ts
export async function getContextAutoInput(): Promise<number | null>;
export async function setContextAutoInput(value: number): Promise<void>;
export async function getContextAutoLastApplied(): Promise<ContextAutoAppliedRecord | null>;
export async function setContextAutoLastApplied(record: ContextAutoAppliedRecord): Promise<void>;
```

读写底层走 `getSetting(key)` / `setSetting(key, value)`（`settingsRepository.ts` 已有），JSON 序列化/反序列化在 repository 内部处理。

### 4.3 应用记录

```ts
export interface ContextAutoAppliedRecord {
  maxContextTokens: number;
  appliedAt: number;   // Unix 毫秒
  allocation: AllocationResult;
  affectedCounts: {
    llmConfigs: number;     // 实际被覆写的 LLM 配置数
    presets: number;
    characters: number;
    notes: number;
    worldbookEntries: number;
    worldbookCollections: number;
  };
}
```

### 4.4 应用函数（事务化）

```ts
// src/services/contextAutoAllocator.ts

export async function applyContextAutoAllocation(
  maxContextTokens: number
): Promise<ContextAutoAppliedRecord>;
```

**事务约束**：项目现有 `executeTransaction(database, statements)`（`src/data/connection/transaction.ts`）要求"先完成所有读，再同步构建语句列表，最后一次执行"。它**不能边读边写**。因此应用函数分两阶段：

**阶段 1：读 + 算（无写操作）**

1. `database = await openDatabase()`
2. 读 ContextConfig / PipelineConfig 现值（用于合并未覆写字段）
3. 查询所有资源全局数量（`SELECT COUNT(*) FROM characters` / `notes` / `worldbook_entries` / `worldbook_collections`，无 WHERE 限制 = 跨项目）
4. 查询非本地 LLM 配置数（`SELECT COUNT(*) FROM llm_config WHERE provider_type IS NOT 'llama_cpp' OR provider_type IS NULL`）
5. 查询 preset 总数
6. 调 `allocateContextBudget(maxContextTokens, resourceCounts)` 算出 `AllocationResult`
7. 构建所有 `SqlStatement[]`：

```ts
const statements: SqlStatement[] = [
  // ContextConfig（3 个 settings key）
  { sql: "INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)",
    params: ['sliding_window_size', String(allocation.slidingWindowSize)] },
  { sql: "...", params: ['resource_budget', ...] },
  { sql: "...", params: ['summary_budget_tokens', ...] },
  // PipelineConfig（4 个 settings key）
  { sql: "...", params: ['pipeline_draft_max_tokens', ...] },
  { sql: "...", params: ['pipeline_review_max_tokens', ...] },
  { sql: "...", params: ['pipeline_factcheck_max_tokens', ...] },
  { sql: "...", params: ['pipeline_proof_max_tokens', ...] },
  // llm_config（仅非本地）
  { sql: "UPDATE llm_config SET context_window = ?, max_output_tokens = ? WHERE provider_type IS NOT 'llama_cpp' OR provider_type IS NULL",
    params: [allocation.llmContextWindow, allocation.llmMaxOutputTokens] },
  // presets（全部）
  { sql: "UPDATE presets SET max_tokens = ?", params: [allocation.presetMaxTokens] },
  // 资源表（仅在 count > 0 时加入）
  { sql: "UPDATE characters SET max_tokens = ?", params: [allocation.characterMaxTokens] },
  { sql: "UPDATE notes SET max_tokens = ?", params: [allocation.noteMaxTokens] },
  { sql: "UPDATE worldbook_entries SET max_tokens = ?", params: [allocation.worldbookEntryMaxTokens] },
  { sql: "UPDATE worldbook_collections SET max_tokens = ?", params: [allocation.worldbookCollectionMaxTokens] },
  // last_applied 记录
  { sql: "INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)",
    params: ['context_auto_last_applied', JSON.stringify(record)] },
];
```

**阶段 2：执行**

8. `await executeTransaction(database, statements)` — 单一原子事务
9. 任一语句失败 → 整体回滚 → 错误冒泡到 UI
10. 返回 `ContextAutoAppliedRecord`

**注意**：`affectedCounts` 通过查询前后差值或 `COUNT(*) WHERE max_tokens = newValue` 推算（react-native-sqlite-storage 不直接返回受影响行数）；为简化，应用前已查的总数即可填入 `affectedCounts`。

### 4.5 repository 不新增方法（应用函数直接构建 SQL）

经过对项目现有架构的考察（`src/data/connection/transaction.ts` 的 `executeTransaction` 要求"先读完再一次性写"），决定**不**在各 repository 新增 `updateAllMaxTokens` 之类的批量方法——这会与"单一事务一次性写入"的约束冲突（每个 repository 方法各自开事务，无法合并）。

应用函数 `applyContextAutoAllocation` 直接在内部构建 SQL 语句列表，通过 `executeTransaction` 一次性原子写入。这与 `backupService.ts` 恢复流程的写法一致（参考其事务化恢复实现）。

**仅需新增的 repository 方法**：无。所有 UPDATE 都在 `contextAutoAllocator.ts` 内直接构建 `SqlStatement[]`。

## 5. UI 设计

### 5.1 入口

`src/screens/SettingsScreen.tsx` 的 `<Section title="AI">` 最顶部插入入口 Card（与"OpenAI 兼容接口"平级）：

```
[Card] 上下文自动化配置
       根据模型支持的最大上下文，自动分配各项 token 预算
       [Button label="配置" icon="Settings2" onPress=navigation.navigate('ContextAutoConfig')]
```

### 5.2 路由

`src/navigation/TabNavigator.tsx`：

- `SettingsStackParamList` 加 `'ContextAutoConfig'`
- 栈注册（L108-120 附近）加 `<Stack.Screen name="ContextAutoConfig" component={ContextAutoConfigScreen} />`

### 5.3 屏幕布局

`src/screens/ContextAutoConfigScreen.tsx`，沿用项目惯用 `<Screen><Header/><ScrollView>...</ScrollView></Screen>` 模式：

```
┌─ Header ────────────────────────────────────┐
│  上下文自动化配置                              │
│  填一个数字，自动分配所有上下文相关设置           │
└──────────────────────────────────────────────┘

┌─ Card: 上次应用记录（有记录时才显示）─────────┐
│  上次应用：200,000 tokens                     │
│  时间：2026-07-18 14:30                       │
│  已覆盖：3 个 LLM 配置 · 5 个预设 · 12 个资源   │
│  [恢复默认]（回滚到 DEFAULT_*）                │
└──────────────────────────────────────────────┘

┌─ Card: 输入最大上下文 ───────────────────────┐
│  你的模型支持的最大上下文（tokens）             │
│                                              │
│  [128K] [200K] [512K] [1M]  ← 快捷按钮        │
│                                              │
│  [数字输入框]  ← 用户可自由输入                │
│  例：200000、512000、1000000                  │
└──────────────────────────────────────────────┘

┌─ Card: 分配预览（实时根据输入值计算）──────────┐
│  📥 输入侧（80% = 160,000）                   │
│    • 滑动窗口  104,000                        │
│    • 资料预算   32,000                         │
│    • 摘要预算   24,000                         │
│                                              │
│  📤 输出侧（20% = 40,000）                    │
│    • 草稿     20,000                          │
│    • 审阅      6,000                           │
│    • 事实核查   6,000                          │
│    • 校对      8,000                           │
│                                              │
│  📊 资源级（按实际数量分摊）                   │
│    • 角色（12个）     单项 933                  │
│    • 笔记（8个）       单项 800                  │
│    • 世界书条目（24个）单项 600                  │
└──────────────────────────────────────────────┘

[Button: 一键应用]   ← 主按钮，accent 色
```

### 5.4 关键 UX 细节

1. **数字格式化**：所有展示用千分位（`160,000`），输入框接受纯数字字符串
2. **实时预览**：用户改输入框/点快捷按钮时，预览区立即重算（`useMemo` 依赖输入值）
3. **资源数量查询**：进屏幕时 `useEffect` 调一次 `countAllResources()`，显示在预览区"📊 资源级"行
4. **应用确认弹窗**：点"一键应用"后弹 `Alert`：`将覆写所有 LLM 配置的 context_window、所有预设的 max_tokens、所有项目的资源上限。确定继续？`
5. **应用成功反馈**：Toast 中文提示"已应用 {value} tokens 的分配方案"，写入 `last_applied` 记录
6. **恢复默认**：把所有字段重置到 `DEFAULT_CONTEXT_CONFIG` / `DEFAULT_MAX_TOKENS` 等常量（不做完整 undo 历史）
7. **极小值警告**：输入 < 8000 时在输入框下方红色提示"上下文过小，可能影响生成质量"，不禁用按钮
8. **空状态**：第一次进屏幕（无 `context_auto_input`），输入框默认填 `200000`（最常见的旗舰模型值）
9. **应用中状态**：按钮禁用 + loading 指示器（防双击）

### 5.5 UI 组件

全部复用 `src/components/ui.tsx`，**不引入新依赖**：

- `Screen`、`Header`、`Section`、`Card`、`Button`、`Field`
- 快捷按钮和资源数量展示用少量内联 JSX
- 颜色全部走 `useThemeStore().colors`

## 6. 错误处理与边界

### 6.1 事务性

`applyContextAutoAllocation` 包在 `runInTransaction` 内。任何一步失败 → 整体回滚 → 抛错 → UI 弹 Toast `应用失败：{中文错误信息}`。

### 6.2 数值边界（在 `allocateContextBudget` 内兜底）

| 情况 | 处理 |
|---|---|
| `maxContextTokens <= 0` | 抛错（UI 限制 min=1，纯函数仍校验） |
| `maxContextTokens < 8000` | 仍计算，UI 弹警告（不禁用） |
| 资源数量 = 0 | 跳过该类资源表 UPDATE，预览显示"无数据，跳过" |
| 单项 max_tokens < MIN_FLOOR | `Math.max(MIN_FLOOR, ...)` 强制兜底 |
| `slidingWindowSize < 1000` | 兜底到 1000 |
| `summaryBudgetTokens < 2000` | 兜底到 2000 |

### 6.3 与现有数据的冲突

- **用户已手动调过资源 max_tokens**：会被覆写。应用前 `Alert` 明确告知。
- **`llm_config` 在线 API 配置之前 `context_window=4096`**：直接覆写（这正是修复点）。
- **本地 GGUF 模型的 `context_window`**：**不覆写**，按 `provider_type !== 'llama_cpp'` 过滤。
- **`presets` 表为空**：跳过 UPDATE，无错误。

### 6.4 数据库异常

- 写入失败（磁盘满等）：事务回滚，Toast 提示，不写 `last_applied`
- 查询资源数量失败：用 `count = 0` 兜底（跳过该类），不阻断应用

### 6.5 并发

应用过程是同步事务，不存在并发。UI 上"应用"按钮在请求期间禁用 + loading（防双击）。

### 6.6 备份系统

新增的 `context_auto_input` / `context_auto_last_applied` 两个 settings key 自动随备份走（manifest 驱动，无需特殊处理）。API Key 仍不进备份，本设计未涉及。

## 7. 测试

### 7.1 单元测试（必填）

**`__tests__/contextAutoAllocator.test.ts`** — 覆盖分配算法所有分支：

| 用例 | 期望 |
|---|---|
| 8000（最小） | 滑动窗口 4160、资料 1280、摘要 960、草稿 800、审阅/事实 240、校对 320 |
| 200000（典型） | 各字段按 80/20 → 65/20/15 / 50/15/15/20 比例 |
| 1000000（1M） | 各字段按比例放大，无溢出 |
| 500（过小） | 抛错 |
| 0 / 负数 | 抛错 |
| 999（非整千） | 正常计算，无 round 误差堆积 |
| 资源数 = 0（无角色） | 跳过，无除零 |
| 资源数 = 1（单项吃全预算） | 计算正确 |
| 资源数 = 1000（单项极小） | 兜底到 MIN_FLOOR |

**`__tests__/contextAutoRepository.test.ts`** — 读写 round-trip：

| 用例 | 期望 |
|---|---|
| 首次读 input | `null` |
| 写入 200000 再读 | 200000 |
| 首次读 last_applied | `null` |
| 写入记录再读 | 字段一致 |

### 7.2 集成测试

`applyContextAutoAllocation` 调用后用 in-memory DB 验证：

- `settings` 表对应字段被覆写
- `llm_config` 表中非 llama_cpp 行的 `context_window` / `max_output_tokens` 被覆写
- `llm_config` 表中 llama_cpp 行**未**被覆写
- `presets` / `characters` / `notes` / `worldbook_*` 表对应字段被覆写
- `context_auto_last_applied` 写入成功

### 7.3 手动验收

- 用户填 200000 + 点应用，所有字段被覆写，Toast 提示成功
- 屏幕显示"上次应用"卡片
- 重启 App 后配置仍生效
- "恢复默认"将所有字段重置到 `DEFAULT_*`
- 极小值（如 4000）输入时弹警告

### 7.4 覆盖率门禁

按 `jest.config.js`：全局 `branches 55 / functions 65 / lines 65 / statements 65`；`database.ts`、`database/**`、`schema/**`、`migrations/**`、`backupService.ts` 更高阈值。本设计新增的 repository 文件归属 `database/**`，需满足 `branches 70 / lines 80`。

## 8. 实现路径

### 8.1 新增文件（5 个）

| 路径 | 职责 |
|---|---|
| `src/services/contextAutoAllocator.ts` | `allocateContextBudget` + `applyContextAutoAllocation` + 类型 + 直接构建 SQL 语句列表 |
| `src/data/repositories/contextAutoRepository.ts` | 读写 settings 表的两个新 key（`context_auto_input` / `context_auto_last_applied`） |
| `src/screens/ContextAutoConfigScreen.tsx` | 新屏幕 |
| `__tests__/contextAutoAllocator.test.ts` | 纯函数单测 + 应用函数集成测试（in-memory DB） |
| `__tests__/contextAutoRepository.test.ts` | repository 读写 round-trip 测试 |

### 8.2 修改文件（2 个）

| 路径 | 修改点 |
|---|---|
| `src/navigation/TabNavigator.tsx` | `SettingsStackParamList` 加 `'ContextAutoConfig'`，`<Stack.Screen>` 注册 |
| `src/screens/SettingsScreen.tsx` | `<Section title="AI">` 最顶部插入入口 Card |

### 8.3 不修改

- `services/contextBuilder.ts`（35%/20%/45% 内部拆分继续工作）
- `services/migrations/*`（不需要迁移）
- `services/pipelineRunner.ts`（PipelineConfig 走现有存储）
- `data/schema/createCurrentSchema.ts`（不动 schema，不动 SCHEMA_VERSION）
- `data/repositories/llmConfigRepository.ts` / `presetRepository.ts` / `characterRepository.ts` / `noteRepository.ts` / `worldbookRepository.ts`（不新增方法，UPDATE 直接在应用函数里构建）

### 8.4 实现顺序（TDD 友好）

1. 类型与纯函数：`contextAutoAllocator.ts` 的 `AllocationResult` / `allocateContextBudget` 实现 + `__tests__/contextAutoAllocator.test.ts` 全绿
2. `contextAutoRepository.ts` + 读写测试
3. 应用函数 `applyContextAutoAllocation`，构建 SQL 语句列表 + `executeTransaction` 事务；集成测试用 in-memory DB 验证覆写正确性、本地模型未覆写
4. 屏幕 `ContextAutoConfigScreen.tsx`
5. 接线：`TabNavigator.tsx` + `SettingsScreen.tsx` 入口
6. 验收：`npm run verify`（lint + typecheck + test:ci 全绿）

## 9. 验收标准

- ✅ 用户可在新屏幕填一个数字（或点快捷按钮）+ 实时看到分配预览
- ✅ 点"一键应用"后所有相关字段被覆写，事务性保证
- ✅ 屏幕显示"上次应用记录"卡片（含时间、覆盖范围）
- ✅ 单元测试覆盖分配算法所有分支，覆盖率达标
- ✅ `npm run verify` 全绿
- ✅ 不引入新依赖，不修改 schema 版本
- ✅ 本地 GGUF 模型的 `context_window` 不被覆写
- ✅ 备份/恢复仍正常（新 settings key 自动纳入）

## 10. 风险与权衡

| 风险 | 缓解 |
|---|---|
| 用户精心调过的资源 max_tokens 被覆写 | 应用前 `Alert` 明确告知"将覆写所有项目的资源上限" |
| 全局应用粒度过粗（多项目用户） | 当前需求已确认全局；如未来需要按项目，可后续扩展 |
| 写死比例无法满足所有用户 | 与"对小白友好"目标一致；进阶用户仍可直接到各配置屏手改 |
| 80/20 输入输出比可能与某些模型不匹配（如 Claude 200K 输入 + 8K 输出） | 单值输入是用户决策；模型特异化属未来工作 |

## 11. 未来工作（非本 spec 范围）

- 每个 LLM 配置独立设置最大上下文（替代全局）
- 分配比例可调（高级设置展开）
- 真正的 undo 历史（多步撤销）
- 自动检测 GGUF 模型真实 context_length 并参与分配
