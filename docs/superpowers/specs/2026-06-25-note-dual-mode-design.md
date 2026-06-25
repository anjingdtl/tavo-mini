# 笔记双模式智能应用设计

- **日期**：2026-06-25
- **状态**：待实现
- **关联**：资料-笔记板块升级

## 目标

对现有"资料-笔记"板块进行改造，增加基于 LLM 的智能处理能力。用户导入 TXT 笔记后，每个项目可选择两种模式使用笔记内容：

1. **仿写模式**：LLM 分析笔记提取写作风格特征，生成时注入风格画像，所有正常生成自动遵循该风格
2. **资料库模式**：笔记存入数据库作为项目知识库，LLM 生成正文时智能检索相关片段并结合上下文引用

## 已确认决策

| 决策项 | 选择 |
|--------|------|
| 模式粒度 | 每个项目选一个主模式 |
| 仿写输出 | 风格描述注入 system prompt，所有正常生成自动遵循 |
| 资料库检索 | LLM 智能检索（生成前额外一次 LLM 调用） |
| 项目隔离 | 保持全局笔记 + `project_resources` 关联表 |
| 风格分析缓存 | 按笔记全局缓存，微调配置存项目级 |
| 微调交互 | 风格要素滑块/档位 |
| 架构方案 | 方案 A：模式感知的 ContextBuilder，单一集成点 `buildContext` |

## 架构概览

### 集成点

单一集成点：`src/services/contextBuilder.ts` 的 `buildContext`。在组装资源消息时，原本统一调用 `buildNoteContext`，现改为先读取项目笔记模式，再分发到两个模式专属构建器：

```
buildContext
  └─ buildResourceContext
       └─ buildNoteContext (原: 全量注入)
            ├─ 读取 project_note_config.mode
            ├─ mode === 'none'      → 原 buildNoteContext 全量注入（向后兼容）
            ├─ mode === 'style'     → buildStyleContext   (注入缓存的风格画像 + 项目级要素权重)
            └─ mode === 'retrieval' → buildRetrievedNoteContext (LLM 检索 → 注入命中片段)
```

### 自动覆盖的生成入口

因为 pipelineRunner（草稿/审查/事实核查/校对四阶段）、FreeformEditor 的 AI 续写、batchChapterPipeline 都走 `buildContext`，改造后所有入口自动获得新模式能力，无需逐个修改。

### 新增模块

- `src/services/styleAnalyzer.ts` — LLM 风格分析，结果缓存到数据库
- `src/services/noteRetriever.ts` — LLM 智能检索，返回相关笔记片段
- 两者都通过 `callLLMResult` 复用现有 LLM 服务，scenario 分别为 `'style_analyze'` / `'note_retrieve'`，便于 llm_usage_logs 统计

### 项目模式存储

项目笔记模式不放进 `projects` 表（避免表结构改动牵连面广），放新建的 `project_note_config` 表，与项目解耦。

## 数据模型与迁移

### 新增表

#### 1. `project_note_config`（项目笔记模式 + 微调配置）

```sql
CREATE TABLE IF NOT EXISTS project_note_config (
  project_id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'none',          -- 'none' | 'style' | 'retrieval'
  style_weights TEXT NOT NULL DEFAULT '{}',   -- JSON: 要素权重
  retrieval_top_k INTEGER NOT NULL DEFAULT 5, -- 资料库模式每次检索的片段数上限
  enabled_note_ids TEXT NOT NULL DEFAULT '[]',-- JSON: 该模式下参与生成的笔记 id 白名单
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
)
```

- `mode = 'none'`：不启用笔记双模式，回退到现有 `buildNoteContext` 全量注入行为（向后兼容）
- `style_weights` JSON 结构：
  ```json
  {
    "sentence_structure": 2,   // 句式：0关/1弱/2中/3强
    "tone_emotion": 2,         // 语气与情感
    "vocabulary": 1,           // 常用词汇与搭配
    "character_voice": 3,      // 角色设定（叙述视角/口吻/身份）
    "narrative_rhythm": 2      // 叙事节奏
  }
  ```
- `enabled_note_ids`：允许用户在项目内进一步缩窄参与仿写/检索的笔记子集；为空时 fallback 到 `project_resources` 中 `resource_type='note' AND enabled=1` 的全部笔记

#### 2. `note_style_profiles`（笔记风格画像缓存，全局共享）

```sql
CREATE TABLE IF NOT EXISTS note_style_profiles (
  note_id INTEGER PRIMARY KEY,
  profile_text TEXT NOT NULL DEFAULT '',      -- LLM 提取的风格画像全文
  profile_json TEXT NOT NULL DEFAULT '{}',    -- 结构化要素
  analyzed_at TEXT NOT NULL,
  source_hash TEXT NOT NULL DEFAULT '',       -- 笔记内容的 hash，判断是否需重新分析
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
)
```

- **全局共享**：一条笔记的画像只分析一次，所有项目复用
- **失效判定**：导入/编辑笔记时计算 `source_hash`（内容 sha256 前 16 位），与缓存不一致则标记需重新分析
- `profile_text`：LLM 输出的自然语言风格描述（注入 system prompt 用）
- `profile_json`：结构化字段，供未来"查看分析结果"UI 使用（本期暂不渲染，仅存储）

### 迁移：v8 → v9

新建 `src/services/migrations/v8-to-v9.ts`：
- 执行上述两条 `CREATE TABLE IF NOT EXISTS`
- 不修改现有 `notes` / `projects` / `project_resources` 表
- 在 `src/services/migrations/index.ts` 中 `SCHEMA_VERSION` 从 8 升到 9，注册新迁移

### 向后兼容

- 旧项目无 `project_note_config` 记录 → 代码层默认 `mode='none'` → 走原 `buildNoteContext` 全量注入
- 旧笔记无 `note_style_profiles` 记录 → 仿写模式首次触发时自动分析并缓存

## 仿写模式 — 风格分析与注入

### 服务：`src/services/styleAnalyzer.ts`

#### 核心函数

```ts
export interface StyleProfile {
  profileText: string;        // 自然语言风格描述，注入 system prompt
  profileJson: StyleElements; // 结构化字段
  sourceHash: string;
}

export interface StyleElements {
  sentence_structure: string;  // 句式特征描述
  tone_emotion: string;        // 语气与情感倾向
  vocabulary: string;          // 常用词汇与搭配
  character_voice: string;     // 角色设定（叙述视角/口吻/身份）
  narrative_rhythm: string;    // 叙事节奏
}

// 分析单条笔记，结果缓存到 note_style_profiles
export async function analyzeNoteStyle(noteId: number): Promise<StyleProfile>

// 批量分析多条笔记，并发受 limitLLMRequest 控制
export async function analyzeNotesStyle(noteIds: number[]): Promise<StyleProfile[]>

// 读取缓存（含 hash 校验），若失效则自动重新分析
export async function getOrAnalyzeNoteStyle(noteId: number): Promise<StyleProfile>

// 聚合多条笔记的画像为一个"联合风格画像"（跨文档联合参考仿写）
export async function mergeStyleProfiles(profiles: StyleProfile[], weights: StyleWeights): Promise<string>
```

#### 分析 prompt 要点（system）

> 你是文学风格分析专家。分析以下文本的写作风格，从五个维度提取特征：句式结构、语气与情感倾向、常用词汇与搭配、角色设定（叙述视角/口吻/身份）、叙事节奏。每个维度给出具体、可操作的描述，便于另一作者据此仿写。

#### 分析时机

1. 笔记导入时（`createNotesFromTextChunks` 调用后）异步触发分析，不阻塞导入
2. 笔记内容编辑保存后（`updateNote`）异步触发重新分析（source_hash 变化时）
3. 仿写模式首次生成时若缓存缺失，同步触发分析（首次会有延迟）

### 服务：`buildStyleContext`（在 contextBuilder.ts 内）

#### 构建流程

```
1. 读 project_note_config → mode='style', style_weights, enabled_note_ids
2. 确定参与笔记列表（enabled_note_ids 或 fallback 到 project_resources）
3. 对每条笔记调 getOrAnalyzeNoteStyle（命中缓存则秒回）
4. 调 mergeStyleProfiles(profiles, weights) 聚合为联合风格画像文本
5. 按笔记预算（budget * 0.2）裁剪画像文本
6. 返回 system 消息片段：
   "以下是本次写作必须遵循的风格画像，请严格按照对应权重的维度进行仿写：
    {联合风格画像}"
```

#### 权重作用机制

`mergeStyleProfiles` 中，权重 0 的维度直接剔除；权重 1/2/3 对应在聚合 prompt 中强调程度递增（如权重 3 的维度前加"必须严格遵循"，权重 1 加"适当参考"）。权重不影响画像内容提取，只影响注入时的强调措辞。

#### 多轮调整

用户在项目设置页调整滑块 → 更新 `project_note_config.style_weights` → 下次生成自动用新权重。无需重新分析笔记（画像缓存复用），调整即时生效。

### 预算与性能

- 风格画像文本通常 500-1500 token，远小于原笔记内容（可达 120000 字符），仿写模式反而节省 token 预算
- 首次分析受 LLM 调用延迟影响（约 5-15s），后续命中缓存几乎零延迟
- 批量分析并发受现有 `limitLLMRequest`（上限 250）控制

## 资料库模式 — LLM 智能检索与注入

### 服务：`src/services/noteRetriever.ts`

#### 核心函数

```ts
export interface RetrievedNoteFragment {
  noteId: number;
  noteTitle: string;
  fragment: string;      // 命中的笔记片段原文
  relevance: string;     // LLM 给出的相关性说明（便于调试，不注入正文）
}

// 根据生成上下文检索相关笔记片段
export async function retrieveNoteFragments(
  projectId: number,
  query: RetrievalQuery,
  topK: number,
): Promise<RetrievedNoteFragment[]>

export interface RetrievalQuery {
  chapterTitle: string;
  chapterSynopsis: string;
  previousEnding: string;   // 前文结尾（用于上下文衔接）
  userPrompt: string;       // 用户本次生成指令
}
```

#### 检索流程

**1. 确定检索范围**
- 读 `project_note_config` → `enabled_note_ids`，为空则 fallback 到 `project_resources` 中启用的笔记
- 对每条笔记用 `getNoteContentById` 读取完整内容

**2. 预筛（避免把全部笔记内容塞给 LLM）**
- 对每条笔记做关键词粗匹配：用 `RetrievalQuery` 中的标题、概要、用户指令分词后与笔记内容做文本匹配
- 每条笔记截取命中关键词周围 ±500 字符的片段作为候选
- 无任何命中的笔记跳过

**3. LLM 智能检索调用**

```
system: 你是写作素材检索助手。根据当前章节的生成需求，从提供的笔记片段中
        选择最相关、最值得引用的片段。只返回 JSON，不要解释。
user:
  当前章节标题：{chapterTitle}
  章节概要：{chapterSynopsis}
  前文结尾：{previousEnding}
  本次生成指令：{userPrompt}

  可选笔记片段：
  [笔记A「标题」] {fragment_1}
  [笔记B「标题」] {fragment_2}
  ...

  返回格式：{"selected":[{"noteId":1,"fragment":"原文片段","relevance":"相关性说明"}]}
  最多返回 {topK} 条。
```

**4. 返回结果**
- LLM 返回 JSON → `parseLLMJson` 解析（复用 `utils/jsonExtractor.ts`）
- 返回 `RetrievedNoteFragment[]`，按 LLM 给出的顺序排列

### 服务：`buildRetrievedNoteContext`（在 contextBuilder.ts 内）

#### 构建流程

```
1. 读 project_note_config → mode='retrieval', retrieval_top_k
2. 构造 RetrievalQuery（从 currentChapter 和 contextConfig 提取）
3. 调 retrieveNoteFragments(projectId, query, topK)
4. 按 token 预算（budget * 0.2）裁剪命中片段
5. 返回 system 消息片段：
   "以下是本次写作可参考的资料片段，请结合上下文合理引用：
    [笔记「{title}」] {fragment}
    ..."
```

### 延迟与缓存策略

**问题**：资料库模式每次生成都多一次 LLM 调用，延迟 5-15s。

**缓解措施**
- **查询指纹缓存**：在 `noteRetriever.ts` 内部维护内存级 LRU 缓存，同一章节的多次生成（如 pipeline 草稿/审查/事实核查/校对四阶段）命中缓存秒回
- **缓存 key 设计**：key = `projectId + chapterTitle + chapterSynopsis + previousEnding`（**不含 userPrompt**），因为笔记检索的相关性取决于章节上下文而非各阶段不同的生成指令。这样 pipeline 四阶段对同一章节的调用自动复用同一次检索结果，无需修改 pipelineRunner
- **缓存容量与失效**：LRU 上限 32 条（约 8 个项目 × 4 章节），项目切换或章节切换自动淘汰旧条目；笔记内容编辑后清空对应 projectId 的缓存条目

### 失败回退

- LLM 检索调用失败或 JSON 解析失败 → 回退到关键词匹配的预筛结果（步骤 2 的输出），不阻塞生成
- 所有笔记都无关键词命中 → 返回空消息，`buildResourceContext` 跳过笔记部分

## UI 交互设计

### 改造位置

`src/screens/ResourceLibrary.tsx` 的"笔记"Tab。现有笔记 Tab 已有：导入 TXT、列表（卡片含标题/预览/token/项目启用开关）、编辑 Modal。改造在现有结构上增量扩展，不重构整体布局。

### 1. 项目笔记模式入口

位置：笔记 Tab 顶部，紧贴现有"导入 TXT 笔记"按钮上方，新增一个**模式选择条**。

```
┌─────────────────────────────────────────┐
│  当前项目：{项目名}                       │
│  笔记模式： [  禁用  | 仿写  | 资料库 ]    │  ← SegmentedControl 3 段
└─────────────────────────────────────────┘
```

- **禁用**（`mode='none'`）：笔记不参与任何智能处理，回退到现有全量注入行为
- **仿写**：选中后展开风格权重面板
- **资料库**：选中后展开检索配置面板
- 切换模式时写 `project_note_config` 表，立即生效

### 2. 仿写模式面板

模式选"仿写"时，模式条下方展开：

```
┌─ 仿写配置 ──────────────────────────────┐
│                                          │
│  参与仿写的笔记：3/5 篇  [选择笔记 ▼]     │  ← 弹出多选列表
│                                          │
│  风格要素权重：                           │
│    句式结构      [弱]──● 中 ──[强]        │  ← 4 档滑块
│    语气与情感    [弱]── 中 ──●[强]        │
│    常用词汇搭配  ●[关]── 中 ──[强]        │
│    角色设定      [弱]── 中 ──●[强]        │
│    叙事节奏      [弱]──● 中 ──[强]        │
│                                          │
│  [重新分析风格]              [查看画像]   │  ← 按钮
└──────────────────────────────────────────┘
```

- **"选择笔记"**：弹出多选 Modal，列出项目启用的笔记，勾选的 id 存入 `enabled_note_ids`；默认全选
- **滑块**：4 档（关/弱/中/强），实时更新 `style_weights`，无保存按钮（即时写入）
- **"重新分析风格"**：对所有参与笔记强制重新跑 LLM 分析（更新 `note_style_profiles`），带 loading 态和确认弹窗
- **"查看画像"**：弹出 Modal 展示 `profile_text`，只读（本期不支持编辑画像文本）

### 3. 资料库模式面板

模式选"资料库"时展开：

```
┌─ 资料库配置 ─────────────────────────────┐
│                                          │
│  参与检索的笔记：5/5 篇  [选择笔记 ▼]     │
│  检索片段数上限：  [3]  [5]  [8]  [10]    │  ← SegmentedControl
│                                          │
│  ℹ️ 生成正文时会自动从笔记中检索相关内容   │
└──────────────────────────────────────────┘
```

- **"选择笔记"**：同仿写模式的多选列表
- **检索片段数**：4 档对应 `retrieval_top_k = 3/5/8/10`，默认 5

### 4. 笔记卡片增强

现有笔记卡片保持不变，仅当当前项目模式非"禁用"时，卡片右上角追加一个小标签：

```
┌──────────────────────────────────────────┐
│ 笔记标题              [仿写] [资料库] ↵   │  ← 标签显示该笔记是否参与当前模式
│ 内容预览...                              │      （标签仅为状态指示，不可点）
│ Tokens: 1234                  项目启用 ●  │
└──────────────────────────────────────────┘
```

- 标签含义：笔记在 `enabled_note_ids` 中 → 显示对应模式标签；否则不显示
- 若笔记无风格画像缓存且模式为仿写 → 显示 `[待分析]` 灰色标签，点击触发单条分析

### 5. 笔记编辑 Modal

现有编辑 Modal（名称/Max Tokens/内容）保持不变，不增加字段。风格分析在保存后自动触发，用户无需在编辑器内操作。

### 6. 与项目切换的联动

- `ResourceLibrary` 的 `loadData` 已基于 `currentProject.id` 加载数据
- 新增：`loadData` 同时读取 `project_note_config`，模式条和面板状态跟随当前项目切换
- 切换项目 → 模式条重置为新项目的配置，面板收起或展开相应状态

### 7. UI 组件复用

- 模式选择条、滑块面板用现有 `components/ui` 中的 SegmentedControl、Card、Field 组件
- 4 档滑块用简单的 4 按钮 SegmentedControl 实现，避免新增依赖
- "选择笔记"多选 Modal 复用现有编辑 Modal 的 Modal 容器

## 错误处理

### 1. 风格分析失败

- LLM 调用超时/返回空 → `analyzeNoteStyle` 抛错，写入 `note_style_profiles` 时 `profile_text=''`，`source_hash=''`
- 仿写生成时若画像为空 → `buildStyleContext` 回退到原 `buildNoteContext` 全量注入，并 Toast 提示"风格分析失败，已使用原始笔记"
- 用户可点"重新分析风格"手动重试

### 2. LLM 检索失败

- `retrieveNoteFragments` 的 LLM 调用失败 → 回退到关键词预筛结果
- 关键词预筛也无命中 → 返回空数组，`buildRetrievedNoteContext` 返回空字符串，`buildResourceContext` 跳过笔记部分，不阻塞生成
- JSON 解析失败 → 复用 `utils/jsonExtractor.ts` 的容错解析；仍失败则同上回退关键词预筛

### 3. 数据库迁移失败

- v8→v9 迁移在 `backupService.ts` 自动备份后执行（现有机制）
- 仅 `CREATE TABLE IF NOT EXISTS`，不修改旧表，迁移失败风险极低
- 失败则回滚到备份，App 提示升级失败（现有 UpgradeScreen 流程处理）

### 4. 笔记内容超大

- 现有 `NOTE_TEXT_CHUNK_CHARS = 120000` 分块机制不变
- 风格分析：对每块独立分析，`mergeStyleProfiles` 聚合（一条超大笔记 = 多个画像合并）
- LLM 检索预筛：对每块分别关键词匹配，命中块作为候选

## 测试策略

### 1. 单元测试（Jest，`__tests__/`）

- `styleAnalyzer.test.ts`：
  - mock `callLLMResult` 返回固定画像文本 → 验证解析、缓存写入、source_hash 计算
  - mock 缓存命中 → 验证不调用 LLM
  - mock 内容变更（hash 不匹配）→ 验证重新分析
  - `mergeStyleProfiles` 不同权重组合 → 验证聚合文本中各维度强调措辞

- `noteRetriever.test.ts`：
  - mock LLM 返回合法 JSON → 验证解析为 `RetrievedNoteFragment[]`
  - mock LLM 返回非法 JSON → 验证回退关键词预筛
  - mock LLM 抛错 → 验证回退关键词预筛
  - LRU 缓存命中验证（同一章节不同 userPrompt 应命中同一缓存）

- `contextBuilder.test.ts`（扩展现有测试）：
  - `mode='none'` → 走原 `buildNoteContext`，行为不变
  - `mode='style'` → 调用 `buildStyleContext`，验证消息格式
  - `mode='retrieval'` → 调用 `buildRetrievedNoteContext`，验证消息格式
  - `project_note_config` 不存在 → 默认 `mode='none'`

- `migrations/v8-to-v9.test.ts`：
  - 在 v8 schema 上执行迁移 → 验证两张新表存在
  - 重复执行幂等性验证

### 2. 数据库层测试

- `database.test.ts`（扩展）：
  - `getProjectNoteConfig` / `setProjectNoteConfig` CRUD
  - `getNoteStyleProfile` / `setNoteStyleProfile` CRUD
  - 删除笔记 → `note_style_profiles` 联动删除（外键 CASCADE）
  - 删除项目 → `project_note_config` 联动删除（外键 CASCADE）

### 3. Mock 要求

- 新增服务未引入新原生依赖，现有 `jest.setup.js` 的 mock 足够
- `styleAnalyzer` / `noteRetriever` 依赖 `callLLMResult`，已在现有测试中 mock

### 4. 不测试的部分

- UI 交互（滑块/模式切换）：人工验证，不写组件测试（项目现有测试不含组件测试）
- LLM 实际调用质量：依赖真实 API，集成测试范畴

## 文件清单

### 新增文件

- `src/services/styleAnalyzer.ts`
- `src/services/noteRetriever.ts`
- `src/services/migrations/v8-to-v9.ts`
- `__tests__/styleAnalyzer.test.ts`
- `__tests__/noteRetriever.test.ts`
- `__tests__/migrations/v8-to-v9.test.ts`

### 修改文件

- `src/services/contextBuilder.ts` — `buildNoteContext` 分发逻辑，新增 `buildStyleContext` / `buildRetrievedNoteContext`
- `src/services/database.ts` — 新增 `project_note_config` 和 `note_style_profiles` 的 CRUD 函数
- `src/services/migrations/index.ts` — `SCHEMA_VERSION` 升至 9，注册 v8→v9 迁移
- `src/screens/ResourceLibrary.tsx` — 笔记 Tab 顶部模式选择条、仿写/资料库配置面板、笔记卡片标签
- `src/services/database.ts` 的 `createNotesFromTextChunks` — 导入后异步触发风格分析
- `src/services/database.ts` 的 `updateNote` — 编辑保存后异步触发重新分析
- `__tests__/contextBuilder.test.ts` — 扩展三种模式的测试用例
- `__tests__/database.test.ts` — 扩展新表 CRUD 测试

### 不修改的文件

- `src/services/llm.ts` — 复用现有 `callLLMResult`，无需改动
- `src/services/pipelineRunner.ts` — 通过 `buildContext` 自动获得新能力
- `src/screens/FreeformEditor.tsx` — 通过 `buildContext` 自动获得新能力
- `src/services/batchChapterPipeline.ts` — 通过 `buildContext` 自动获得新能力
- `src/navigation/TabNavigator.tsx` — 资料 Tab 结构不变
