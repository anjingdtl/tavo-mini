# ShineWriter 原著续写改造工程 Spec：Phase 1（修订版）

> 文档状态：Ready for implementation  
> 修订日期：2026-07-27  
> 已核验基线：ShineWriter V2.6.6、SQLite Schema 18、React Native 0.85.3、Android-only  
> 本阶段目标 Schema：19；若施工前 `main` 已高于 18，必须顺延版本并同步更新本文、fresh schema、manifest、README、CHANGELOG 和迁移矩阵  
> 工程主题：项目模式、续写资料入口、TXT 原著持久化与严格边界  
> 后续依赖：Phase 2 只能使用本阶段公开的 bounded SourceReader；Phase 3 不得绕过 Phase 1/2 直接施工

## 1. 背景

Tavo Mini 当前是 Android-only、离线优先的小说工作台，已经具备项目、章节、角色卡、世界书、笔记、构建模块、AI 流水线、Story Memory、备份恢复和本地/在线模型能力。

本工程将原“自由写作”产品方向升级为“原著续写”。用户在项目内导入一部 TXT 原著，指定续写起点，并在后续阶段由系统分析原著、构建 Canon、生成续写正文。

Phase 1 只建设可靠的数据和产品底座，不建设复杂原著理解，也不改变现有 AI 流水线的生成逻辑。

## 2. 本阶段目标

本阶段必须交付以下能力：

1. 项目创建入口提供“原著续写”模式。
2. 兼容所有历史项目，不破坏数据库中现有 `freeform` 项目。
3. 在“资料”中新增独立的“续写”模块。
4. 支持导入 TXT 原著、编码识别、文本规范化和章节解析。
5. 支持章节解析结果预览、合并、拆分、改名与排除。
6. 支持续写起点设置，防止后续阶段召回续写点之后的原文。
7. 原著章节与用户续写章节物理隔离：原著只读，续写正文继续使用现有章节编辑体系。
8. 建立可恢复、可暂停、可诊断且不把整本正文塞进 JSON checkpoint 的导入任务基础。
9. 将新增业务表纳入迁移、备份、恢复、清理和测试体系。
10. 为 Phase 2 提供稳定、明确、可版本化的数据契约。

## 3. 非目标

本阶段明确不实现：

- AI 自动提取世界观、人物画像、关系、主线或人物经历。
- Embedding、向量数据库、知识图谱或 GraphRAG。
- 原著一致性检查。
- Planner、Writer、Checker、Repairer 新流水线。
- 原著文风分析。
- 自动生成角色卡或世界书。
- 将原著章节写入现有可编辑 `chapters` 表。
- 修改现有 Story Memory 语义。
- 删除历史“自由写作”数据或强制迁移其行为。

## 4. 术语

| 术语 | 定义 |
| --- | --- |
| 续写项目 | 项目模式为 `continuation` 的项目 |
| 历史自由写作项目 | 数据库 `projects.mode='freeform'` 的旧项目；继续兼容，但新建 UI 不再展示 |
| 原著源 | 用户导入的一份 TXT 文件及其规范化元数据 |
| 原著章节 | 从原著 TXT 解析出的只读章节 |
| 续写章节 | 用户或 AI 在现有章节系统中创建的可编辑章节 |
| 续写起点 | 原著中允许用于 Canon 和生成上下文的最后位置 |
| 原著边界 | 续写起点在规范化全文中的 UTF-16 全局偏移及对应原著章节 |
| 未来原文 | 位于原著边界之后的原文，默认不得进入分析和生成 |
| 规范化文本 | 完成编码转换、换行统一和安全清理后的全文；由文本分块表持久化，是证据与 offset 的文本权威 |
| 导入任务 | 原著读取、解析、保存和校验的可恢复任务 |

## 5. 核心不变量

施工 Agent 必须保证：

1. 原著章节始终只读，不能被章节编辑器修改。
2. 续写章节继续使用现有章节表、自动保存、版本和 Story Memory 机制。
3. 原著边界之后的文本必须有明确标识，Phase 2 和 Phase 3 默认禁止读取。
4. 导入失败不能留下半套“可用”原著数据。
5. 替换原著必须使用新 source 版本，不能原地覆盖并静默复用旧分析。
6. 删除项目必须清理该项目的续写源、章节、设置和任务。
7. 备份恢复后，原著源和章节必须完整可用。
8. API Key、凭据和原著正文不得进入诊断日志。
9. Phase 1 不得发起任何远程 LLM 请求。
10. 数据库迁移必须原子执行，失败时 Schema 版本不能前进。
11. `continuation_settings.active_source_id` 是“当前原著”的唯一事实来源；不得根据 status、version 或时间自行猜测。
12. 原著位置和续写章节位置属于两个命名空间，API 和类型不得混用裸 `number`。
13. 任何 Phase 2 可调用的正文接口都必须在服务层裁剪自定义边界所在末章。

## 6. 跨阶段公共数据契约

以下契约从 Phase 1 起固定，Phase 2/3 不得重新定义：

```ts
declare const sourcePositionBrand: unique symbol;
declare const continuationPositionBrand: unique symbol;
declare const utf16OffsetBrand: unique symbol;

export type SourceChapterPosition =
  number & { readonly [sourcePositionBrand]: true };
export type ContinuationChapterPosition =
  number & { readonly [continuationPositionBrand]: true };
export type Utf16Offset =
  number & { readonly [utf16OffsetBrand]: true };
```

- 两类 position 均为从 0 开始的有限非负整数。
- `SourceChapterPosition` 只用于原著 source；`ContinuationChapterPosition` 对应现有 `chapters.position`。
- 所有原著文本范围统一为规范化全文的 UTF-16 code unit offset。
- 范围统一采用 `[start, end)`：start 包含、end 不包含。
- JS 使用 `slice(start, end)`；SQL 不自行用 `length()` 推导 offset。
- 文本 hash 统一为规范化字符串 UTF-8 编码后的 SHA-256 小写十六进制。
- 边界 offset 表示“允许读取的末尾 exclusive offset”。边界为 100 时只能读取 `[0, 100)`。
- 原始文件 hash 基于原始字节；规范化 hash 基于完整规范化文本。
- 数据库存储使用 INTEGER/TEXT，Repository 边界负责验证并转换为 branded type。

Source 激活契约：

```text
staging/needs_review source
  --确认事务-->
旧 ready source -> superseded
新 source -> ready
continuation_settings.active_source_id -> 新 source
```

- `ready` 不等于“按最新时间自动选择”；查询只能跟随 `active_source_id`。
- 新 source 未确认前，旧 ready source 和旧 boundary 继续服务。
- source、parser、normalizer 或 boundary 变化必须通过统一 invalidation hook 标记 Phase 2/3 数据过期。
- 删除当前 source 必须在同一事务先清空 settings 指针，再删除正文、章节和 source；不得留下带正文的“软删除”记录。

## 7. 已核验基线与施工前复核

截至本文修订时已核验：

- `ProjectMode` 当前为 `'outline' | 'freeform'`。
- `projects` 已有 `mode TEXT NOT NULL DEFAULT 'outline'`，无需新增 mode 列。
- 写作路由当前只显式判断 `freeform`，其他模式进入 `OutlineEditor`。
- 底部为五个 Tab：项目、写作、构建、资料、设置。
- 资料库是 `ResourceLibrary` 单屏四段切换，不是嵌套 Stack。
- 构建模块已有一次性 TXT 解析，但只支持 UTF-8/UTF-16，且整文件 base64 进入 JS；不得直接作为本阶段大文件实现。
- 当前备份为 Manifest 驱动 format v3；新增普通数据库表不要求升级 format。
- 当前项目包导出为 `shinewriter-project-v2`，导入仅接受 v1/v2；continuation 完整迁移需要本阶段新增 v3。
- 当前 Schema 为 18，最低兼容 Schema 为 3。
- 项目删除依赖 `projects` 外键级联；新增表必须继续遵守。

Agent 开始改代码前必须输出一份审计记录，确认：

- 上述已核验事实在施工分支是否仍成立。
- 当前 Schema 版本和迁移注册方式。
- `Project` 类型、项目创建方法和项目模式当前真实字段。
- `projects` 表的当前列定义。
- “项目”“写作”“构建”“资料”“设置”的导航实现。
- 资料库当前屏幕、子模块和路由组织方式。
- TXT 文件选择和文本读取是否已有可复用实现。
- 当前备份 Manifest 和表白名单。
- 项目删除时的级联或事务清理逻辑。
- 当前测试基线：lint、typecheck、Jest、migration tests、Android Debug。
- 当前 `main` 是否存在用户未提交文件；不得删除或覆盖无关改动。

本文给出的表名和服务名是目标契约。若当前仓库存在等价命名，应优先复用现有模式，并在施工报告中记录映射关系。

## 8. 产品与导航设计

### 8.1 项目创建

项目创建界面应展示：

- 大纲创作
- 原著续写

不再向新用户展示“自由写作”作为新建选项。

历史自由写作项目必须继续可打开。固定内部模式：

```ts
export type ProjectMode =
  | 'outline'
  | 'continuation'
  | 'freeform';
```

禁止将现有 `freeform` 批量改写为 `free_legacy`。新增统一入口：

```ts
normalizeProjectMode(value: unknown): ProjectMode;
```

规则：

- `outline`、`freeform`、`continuation` 原样返回。
- 旧项目包缺失 mode 时回退 `outline`。
- 未知字符串不得直接写库；项目导入时阻断并显示中文错误。
- 所有 UI 标签使用穷举映射，禁止继续使用 `mode === 'outline' ? ... : ...`。
- continuation 项目沿用现有创建事务并创建 position=0 的空续写章节；未导入原著时允许手写，但 AI 续写入口阻断。

### 8.2 历史项目兼容

迁移策略：

- 历史大纲项目保持原模式。
- 历史自由写作项目继续持久化为 `freeform`，行为保持不变。
- 新建原著续写项目写入 `continuation`。
- 本阶段不提供历史项目自动转换。
- 可预留“转换为续写项目”的服务接口，但 UI 不作为验收项。

### 8.3 资料模块

不要在现有四段 `SegmentedControl` 中硬塞第五项。将底部“资料”组件改为 `ResourceStack`，最低路由：

```ts
type ResourceStackParamList = {
  ResourceHome: undefined;
  ContinuationHome: undefined;
  ContinuationSourceChapters: undefined;
  ContinuationBoundary: undefined;
  ResourceLibrary: {
    initialTab?: 'characters' | 'worldbook' | 'notes' | 'presets';
  };
};
```

目标信息架构：

```text
资料
├── 续写
├── 角色
├── 世界书
├── 笔记
└── 预设
```

`ResourceHome` 提供“续写、角色、世界书、笔记、预设”入口；原 `ResourceLibrary` 可继续承担后四类内容。不要新增底部主 Tab。

### 8.4 续写资料首页

未导入状态：

- 显示功能说明。
- 显示“导入 TXT 原著”按钮。
- 显示本地处理和隐私提示。
- Phase 1 不显示 AI 分析入口。

已导入状态：

- 原著名称。
- 原文件名和大小。
- 规范化字符数。
- 识别章节数。
- 导入时间。
- 续写起点。
- 数据状态。
- 操作：查看章节、调整分章、设置续写起点、替换原著、删除原著。

非续写项目进入该模块时：

- 显示“当前项目不是原著续写项目”。
- 不允许直接导入。
- 可提供返回项目页的操作。
- 不得静默修改项目模式。

## 9. 数据模型

### 9.1 项目模式

复用现有 `projects.mode`，Schema 19 不新增该列。

目标语义：

```ts
type PersistedProjectMode = 'outline' | 'continuation' | 'freeform';
```

Schema 19 迁移不得重写合法历史 mode。fresh schema 继续使用 `outline` 默认值；Repository、Store、项目导入/导出和所有标签统一使用 `normalizeProjectMode()`。

### 9.2 `continuation_sources`

一项目允许存在一个 active source，但保留不含临时文件的历史 source 记录用于替换、诊断和回滚。

```sql
CREATE TABLE continuation_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(
    status IN ('staging', 'needs_review', 'ready', 'failed', 'superseded')
  ),
  display_name TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'text/plain',
  detected_encoding TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  raw_sha256 TEXT NOT NULL,
  normalized_sha256 TEXT NOT NULL,
  normalized_char_count INTEGER NOT NULL,
  normalized_byte_count INTEGER NOT NULL,
  chapter_count INTEGER NOT NULL DEFAULT 0,
  parser_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  activated_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, version),
  UNIQUE(project_id, id)
);

CREATE UNIQUE INDEX idx_continuation_sources_one_ready
  ON continuation_sources(project_id)
  WHERE status = 'ready';
```

规则：

- active source 只能从 `continuation_settings.active_source_id` 读取。
- 同一项目数据库层最多一个 `ready` source；允许同时存在一个旧 ready 和多个未激活 staging/needs_review source。
- 替换原著创建新 version。
- 新 source 完整校验并经用户确认前，旧 source 继续有效。
- 激活新 source 与旧 source 标记 `superseded` 必须在同一事务中完成。
- `error_message` 必须脱敏和限长。
- 用户删除原著时物理删除对应 source、chunks 和章节；不保留含正文的 deleted 软记录。

### 9.3 `continuation_source_text_chunks`

规范化全文的唯一文本权威。不得依赖原文件或 cache 恢复：

```sql
CREATE TABLE continuation_source_text_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
  char_start_offset INTEGER NOT NULL CHECK(char_start_offset >= 0),
  char_end_offset INTEGER NOT NULL CHECK(char_end_offset > char_start_offset),
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
  UNIQUE(source_id, chunk_index),
  UNIQUE(source_id, char_start_offset)
);

CREATE INDEX idx_continuation_text_chunks_range
  ON continuation_source_text_chunks(source_id, char_start_offset, char_end_offset);
```

规则：

- chunk 建议控制在 64–256 KiB UTF-8 数据范围，具体值由设备测试确定。
- chunk offset 必须连续、无重叠、无空洞，首块 start=0，末块 end=`normalized_char_count`。
- 拆章、合章、改名和排除只修改章节元数据，不重写规范化全文 chunks。
- import job 的临时文件不是权威数据，成功激活或取消后应删除。

### 9.4 `continuation_source_chapters`

```sql
CREATE TABLE continuation_source_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  volume_title TEXT,
  detected_title TEXT NOT NULL,
  title TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  paragraph_count INTEGER NOT NULL,
  source_start_offset INTEGER NOT NULL,
  content_start_offset INTEGER NOT NULL,
  source_end_offset INTEGER NOT NULL,
  is_excluded INTEGER NOT NULL DEFAULT 0 CHECK(is_excluded IN (0, 1)),
  exclusion_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
  UNIQUE(source_id, position),
  UNIQUE(source_id, id),
  CHECK(char_count >= 0),
  CHECK(paragraph_count >= 0),
  CHECK(source_start_offset >= 0),
  CHECK(content_start_offset >= source_start_offset),
  CHECK(source_end_offset >= content_start_offset)
);
```

规则：

- `position` 固定为从 0 开始、连续整数。
- 三个 offset 均为规范化全文 UTF-16 全局 offset。
- `source_start_offset` 包含标题；`content_start_offset` 指向正文；`source_end_offset` 为 exclusive。
- 正文通过 chunk range reader 按需读取，不在章节表重复保存整章内容。
- 章节内容不可通过普通编辑 API 修改。
- 合并、拆分通过专用事务调整范围并重新计算 position/hash；改名只修改 `title`，原检测标题保存在 `detected_title`。
- 排除章节保留数据和证据位置，但后续默认不分析。

### 9.5 `continuation_settings`

```sql
CREATE TABLE continuation_settings (
  project_id INTEGER PRIMARY KEY,
  active_source_id INTEGER,
  boundary_source_id INTEGER,
  boundary_chapter_id INTEGER,
  boundary_char_offset_global INTEGER,
  boundary_mode TEXT NOT NULL DEFAULT 'end_of_source',
  import_completed INTEGER NOT NULL DEFAULT 0,
  analysis_status TEXT NOT NULL DEFAULT 'not_started',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id, active_source_id)
    REFERENCES continuation_sources(project_id, id),
  FOREIGN KEY(boundary_source_id, boundary_chapter_id)
    REFERENCES continuation_source_chapters(source_id, id),
  CHECK(boundary_mode IN ('end_of_source', 'end_of_chapter', 'custom_offset')),
  CHECK(import_completed IN (0, 1)),
  CHECK(analysis_status IN ('not_started', 'running', 'ready', 'outdated', 'failed')),
  CHECK(
    (active_source_id IS NULL AND boundary_source_id IS NULL
      AND boundary_chapter_id IS NULL AND boundary_char_offset_global IS NULL)
    OR
    (active_source_id IS NOT NULL AND boundary_source_id = active_source_id
      AND boundary_chapter_id IS NOT NULL AND boundary_char_offset_global IS NOT NULL)
  ),
  CHECK(active_source_id IS NULL OR boundary_source_id = active_source_id),
  CHECK(boundary_char_offset_global IS NULL OR boundary_char_offset_global >= 0)
);
```

`active_canon_snapshot_id` 由 Phase 2 的 Schema 20 正式增加；Phase 1 Schema 19 不创建该列。

`boundary_mode`：

```ts
type ContinuationBoundaryMode =
  | 'end_of_source'
  | 'end_of_chapter'
  | 'custom_offset';
```

边界规则：

- `end_of_source`：最后一个未排除章节末尾。
- `end_of_chapter`：指定章节末尾。
- `custom_offset`：UI 可接收章节内位置，但 Service 必须换算并持久化为规范化全文的全局 exclusive offset。
- 边界必须指向 active source。
- 边界不能位于排除章节。
- 边界 offset 必须落在 `[content_start_offset, source_end_offset]`。
- 更改边界必须将 Phase 2 分析状态标记为过期；Phase 1 先实现状态字段和失效接口。

### 9.6 `continuation_import_jobs`

```sql
CREATE TABLE continuation_import_jobs (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  source_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(
    state IN (
      'queued', 'running', 'paused', 'awaiting_review',
      'completed', 'failed', 'cancelled', 'interrupted'
    )
  ),
  stage TEXT NOT NULL,
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  parser_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  input_copy_relative_path TEXT,
  checkpoint_json TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK(stage IN (
    'reading', 'decoding', 'normalizing', 'detecting_chapters',
    'persisting', 'validating', 'awaiting_review', 'activating'
  )),
  CHECK(progress_current >= 0),
  CHECK(progress_total >= 0),
  CHECK(progress_total = 0 OR progress_current <= progress_total),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_continuation_import_one_active
  ON continuation_import_jobs(project_id)
  WHERE state IN ('queued', 'running', 'paused', 'awaiting_review', 'interrupted');
```

`state`：

```ts
type ImportJobState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
```

`stage`：

```ts
type ImportJobStage =
  | 'reading'
  | 'decoding'
  | 'normalizing'
  | 'detecting_chapters'
  | 'persisting'
  | 'validating'
  | 'awaiting_review'
  | 'activating';
```

规则：

- `checkpoint_json` 只保存游标、阶段、小型解析设置和编辑操作，不得保存全文或全部章节正文。
- `input_copy_relative_path` 只能是应用私有 import 目录中的相对路径，不得保存用户原始绝对路径。
- 每完成一个 chunk/章节批次即提交 checkpoint；进程被杀后将 running 转为 interrupted，由用户显式继续。
- `continuation_import_jobs` 加入 `SCHEMA_MANIFEST` 但 `backup:false`；source/chunks/chapters/settings 必须 `backup:true`。
- Phase 1 可以同步执行小文件，但必须通过统一 job 状态报告进度，不能另写一套不可恢复流程。

## 10. 文件读取与规范化

### 10.1 支持范围

必须支持：

- `.txt`
- UTF-8
- UTF-8 BOM
- GBK
- GB18030

- UTF-16 LE/BE

无法确定编码时必须要求用户选择，不得静默用错误编码继续。

固定实现路线：

- 新增 Android 原生 `ContinuationTextImportModule`，使用 `CharsetDecoder` 支持 UTF-8、GBK、GB18030、UTF-16LE/BE。
- 原生侧分块读取应用私有 import 副本，处理多字节字符跨块边界并输出规范化 UTF-8/UTF-16 offset 进度。
- JS 侧只接收元数据、进度和受控大小的 chunk，不得把 5 MB 文件整体转为 base64。
- 现有 `construction/textSourceParser.ts` 只可复用标题规则和测试语料，不可复用其整文件解码路径。
- 编码探测置信度不足时暂停 job，保存候选编码并要求用户选择后继续。

### 10.2 大文件处理

要求：

- 不得在 React 组件 state 中长期保存整本原著。
- 必须采用原生流式/分块读取，不接受整文件 base64 作为 5 MB 验收实现。
- 规范化和章节持久化必须分批，避免单一超大 SQL。
- 导入进度可见。
- App 进入后台时可复用现有前台服务的通知/保活桥接，但不得复用固定的 AI `pipeline_tasks` stage 类型。
- 进程死亡不承诺自动执行；必须依靠持久化 job/chunks/checkpoint 在重启后显式继续。

### 10.3 规范化规则

允许：

- 换行统一为 `\n`。
- 去除 BOM。
- 连续空行默认不压缩；若未来增加压缩必须提升 `normalization_version`，并在预览中说明。
- 去除 NUL 和不可显示控制字符。
- 保留中文标点、空格、缩进和正文段落。
- 记录规范化版本。

禁止：

- 自动改写原著内容。
- 自动纠错错别字。
- 自动替换敏感词。
- 自动删除疑似广告而不给用户预览。
- 改变字符偏移后不重新计算证据位置。

## 11. 章节解析

### 11.1 默认识别

至少识别：

```text
第一章
第1章
第001章
第一回
第十二回
卷一
第一卷
Chapter 1
CHAPTER 1
正文 第一章
```

解析器必须：

- 支持中文数字和阿拉伯数字。
- 避免把正文中的“第一章内容如下”误识别为标题。
- 支持无章节标题的纯文本回退。
- 保存卷标题但不强制把卷当作空章节。
- 解析规则集中配置和版本化，禁止散落在 UI。

### 11.2 解析预览

用户确认前显示：

- 章节序号。
- 标题。
- 字数。
- 开头预览。
- 解析警告。
- 排除状态。

编辑操作：

- 重命名。
- 与上一章合并。
- 与下一章合并。
- 在选定段落处拆分。
- 标记排除。
- 撤销本轮解析编辑。
- 恢复自动解析结果。

自动解析结果先持久化为 `needs_review` source 章节元数据；编辑以小型 edit log 持久化并事务应用。最终确认事务只负责校验和激活，不在 UI state 中持有整本正文。用户取消预览不能产生 active source，并应删除 staging source/chunks。

### 11.3 无标题文本

未识别到可靠章节时：

- 显示明确提示。
- 提供“按固定字数切分”的可选辅助方式，但默认关闭。
- 提供“整本作为一个章节”。
- 不得自动制造大量错误章节并直接完成导入。

## 12. 原著与续写章节边界

### 12.1 数据隔离

原著章节不得插入现有 `chapters` 表。

原因：

- 原著只读，续写可编辑。
- 原著不应触发现有自动保存、revision 和 Story Memory 更新。
- 原著替换不应破坏用户续写章节。
- 原著 position 与续写章节 position 属于不同命名空间。

### 12.2 写作页面

Phase 1 最低要求：

- 续写项目的写作页显示原著已导入/未导入状态。
- 未导入时，AI 续写入口应提示先导入原著。
- 续写章节仍正常创建和编辑。
- 可提供只读“原著章节”查看入口；若工期受限，可先从资料模块查看。
- 不改变历史项目写作页面行为。

### 12.3 未来原文防护

Phase 2 只允许使用以下 bounded API：

```ts
interface BoundedSourceChapter {
  id: number;
  sourceId: number;
  position: SourceChapterPosition;
  title: string;
  content: string;
  range: { start: Utf16Offset; end: Utf16Offset };
  clippedByBoundary: boolean;
}

listBoundedSourceChapters(
  snapshot: ContinuationSourceSnapshot,
): Promise<BoundedSourceChapter[]>;
readBoundedEvidenceRange(input: {
  snapshot: ContinuationSourceSnapshot;
  start: Utf16Offset;
  end: Utf16Offset;
}): Promise<string>;
```

每次读取必须在同一数据库读事务中校验传入 snapshot 的 source id/version/hash、parser/normalizer 和 boundary 全部仍等于 active source/settings；不一致抛 `continuation_source_snapshot_outdated`。读取始终按 snapshot 的 `sourceId + boundary.charOffsetExclusive` 裁剪，禁止先按 project 查“最新 source”后继续旧 run。

自定义边界位于章节中间时，最后一个 `BoundedSourceChapter.content` 必须在边界处截断。禁止 Phase 2 使用返回完整末章的 API。

未来原文浏览仅允许 UI 通过独立的 `ContinuationSourceBrowserService`，每次调用必须传 `purpose:'user_browse_future_source'`。该服务不得从 `src/services/continuation/canon` 或 generation 模块导入。

## 13. 服务接口

必须新增以下领域服务（可按现有命名规范调整文件大小，但公开职责和接口不得省略）：

```text
src/services/continuation/
├── continuationProjectService.ts
├── continuationImportService.ts
├── continuationParser.ts
├── continuationSourceRepository.ts
├── continuationSettingsService.ts
└── continuationSourceReader.ts
```

必须提供：

```ts
createContinuationProject(input): Promise<Project>;

startContinuationImport(input): Promise<ImportJob>;

resumeContinuationImport(jobId): Promise<ImportJob>;

cancelContinuationImport(jobId): Promise<void>;

previewParsedSource(jobId): Promise<ParsedSourcePreview>;

applyParsingEdits(jobId, edits): Promise<ParsedSourcePreview>;

confirmContinuationSource(jobId, boundary): Promise<ContinuationSource>;

replaceContinuationSource(projectId, file): Promise<ImportJob>;

deleteContinuationSource(projectId): Promise<void>;

getActiveContinuationSource(projectId): Promise<ContinuationSource | null>;

listBoundedSourceChapters(
  snapshot: ContinuationSourceSnapshot,
): Promise<BoundedSourceChapter[]>;

readBoundedEvidenceRange(input: {
  snapshot: ContinuationSourceSnapshot;
  start: Utf16Offset;
  end: Utf16Offset;
}): Promise<string>;

updateContinuationBoundary(projectId, boundary): Promise<void>;
```

服务层必须承担权限和不变量检查，UI 不得直接拼 SQL。

## 14. 原子性与失败恢复

### 14.1 导入原子性

推荐流程：

1. 复制用户文件到应用私有 import 目录，并创建 job + `staging` source。
2. 原生分块读取、解码、规范化，逐批写 `continuation_source_text_chunks`。
3. 解析章节并逐批写 staging source 的章节元数据。
4. 校验 chunk 连续性、全文/hash、章节范围、position 和候选边界。
5. source 进入 `needs_review`，job 进入 `awaiting_review`。
6. 用户应用编辑并确认 boundary。
7. 单事务将旧 ready 标记 superseded、新 source 标记 ready、切换 active/boundary、触发统一 invalidation hook、完成 job。
8. 事务成功后删除私有 import 临时副本。

任何步骤失败：

- active source 不变。
- staging 数据可清理或可恢复。
- job 标记 failed。
- 错误可重试。
- 不留下“ready 但章节不完整”的 source。

### 14.2 App 被杀

重新启动后：

- 冷启动将所有遗留 `running` job 转为已定义的 `interrupted`。
- UI 提供继续、重来、取消。
- 不自动激活不完整 source。
- 清理孤儿临时文件。

### 14.3 替换原著

替换时：

- 用户续写章节不得删除。
- Phase 2 Canon 和 Phase 3 状态必须标记过期，不能继续静默使用。
- 新 source 未激活前旧 source 仍是当前 source。
- 用户需确认替换会使原著分析失效。

## 15. 备份、恢复与项目包

必须更新现有备份 Manifest，将下列表纳入：

- `continuation_sources`
- `continuation_source_text_chunks`
- `continuation_source_chapters`
- `continuation_settings`
- `continuation_import_jobs` 加入 manifest 但 `backup:false`。

要求：

- 恢复后 active source、章节、边界一致。
- 恢复时校验 foreign key。
- 仅增加数据库表时保持 `format_version=3`，依靠 Schema 19 和 manifest 恢复；不得无理由升级备份格式。
- 原著正文进入备份前应在 UI 说明备份体积可能增加。
- 外部原文件引用不能作为唯一恢复来源。
- API Key 不进入备份的现有契约保持不变。

项目包契约：

- continuation 项目导出使用 `shinewriter-project-v3`。
- 导出前明确提示包将包含原著正文、体积和合法使用提醒。
- v3 包包含 active source 元数据、text chunks、source chapters、boundary/settings 和续写 chapters；不包含 import job。
- v3 导入必须先校验 spec、版本、chunk 连续性、hash、章节范围与引用，再在项目级事务/补偿删除中创建新项目并重映射全部 ID；失败不得留下半个项目。
- `ProjectImportPreview.specVersion`、parser 和 exporter 的类型必须从 `1 | 2` 扩为 `1 | 2 | 3`，但 v1/v2 解析行为保持不变。
- 继续兼容 v1/v2 项目包。
- Markdown/纯文本导出默认只导出用户续写章节，不混入原著。
- 不选择“包含原著”时，不允许把包标为可完整恢复的 continuation 项目；应导出为“续写正文副本”并给出明确提示。

## 16. 隐私与安全

- 原著文件默认只保存在设备。
- Phase 1 不上传原著。
- 日志只能记录 source ID、文件大小、章节数、hash 前缀和错误码。
- 不记录章节标题之外的大段正文；标题也应有长度限制。
- 文件路径在用户可见诊断中只显示文件名，不显示完整私有路径。
- 删除原著必须清理数据库内容和私有目录中的复制文件。
- 导入时显示用户拥有合法使用权的确认文案；该确认只作为产品提示，不代替法律判断。

## 17. 性能要求

最低验收目标：

- 5 MB TXT 在主流 Android 设备上可完成导入，不发生 JS OOM。
- 解析期间 UI 可响应取消操作。
- 章节列表采用虚拟化，不一次渲染全部正文。
- 单次 SQLite 事务不持有整本原著的 JS 对象副本。
- 章节正文按需读取。
- 不在项目列表查询中联表加载原著正文。
- 导入完成后数据库一致性检查不超过合理时间；具体设备数据写入施工报告。

## 18. 测试要求

### 18.1 单元测试

至少覆盖：

- UTF-8、BOM、GBK/GB18030 检测。
- 换行和控制字符规范化。
- 中文数字章节标题。
- 英文章节标题。
- 卷标题。
- 无标题文本回退。
- 标题误识别边界。
- 合并、拆分、排除和重命名。
- hash 和 offset 重算。
- UTF-16 surrogate pair、emoji 和跨 chunk 多字节字符的 offset/hash。
- chunk 连续、无重叠、无空洞。
- 边界合法性。
- 自定义边界位于章节中间时 bounded reader 必须裁剪末章。
- future source 查询不可越界，Phase 2 模块不得导入 browser service。
- `freeform` 历史模式不迁移、未知项目包模式被阻断。

### 18.2 数据库和迁移测试

至少覆盖：

- Schema 3–18 到 19 的迁移矩阵，以及 18→19 定向测试。
- 迁移中途失败版本不前进。
- foreign key 完整性。
- 删除项目级联。
- 替换 source 原子切换。
- source 写入中途失败不激活。
- boundary 不得指向其他 source。
- partial unique index 阻止同项目两个 ready source。
- active pointer、source status、boundary 和 invalidation 同事务回滚。
- 备份恢复 round-trip。
- `shinewriter-project-v3` continuation 项目包 round-trip。
- 旧备份恢复兼容。

### 18.3 UI 测试

至少覆盖：

- 新建原著续写项目。
- 非续写项目进入续写资料模块。
- 导入文件。
- 章节预览。
- 分章编辑。
- 设置续写点。
- 替换确认。
- 删除确认。
- 导入失败重试。
- 页面离开后任务状态恢复。

### 18.4 E2E

增加 Maestro 流程：

```text
07-continuation-import.yaml
```

覆盖：

1. 创建续写项目。
2. 打开资料 > 续写。
3. 导入测试 TXT。
4. 确认解析章节数。
5. 设置非末尾续写点。
6. 重新进入页面验证持久化。
7. 备份、修改、恢复后验证原著和边界恢复。

测试 TXT 必须是仓库自有、无版权风险的中文夹具。

## 19. 可观测性

新增诊断字段：

```ts
interface ContinuationImportDiagnostic {
  jobId: string;
  projectId: number;
  sourceVersion: number;
  stage: ImportJobStage;
  parserVersion: string;
  fileSizeBytes: number;
  normalizedCharCount?: number;
  detectedChapterCount?: number;
  elapsedMs: number;
  errorCode?: string;
}
```

禁止包含正文。

UI 错误分类至少包括：

- `unsupported_file`
- `unsupported_encoding`
- `decode_failed`
- `file_too_large`
- `parse_failed`
- `storage_full`
- `database_error`
- `cancelled`
- `source_changed`
- `invalid_boundary`
- `job_interrupted`
- `chunk_integrity_failed`

## 20. Agent 施工顺序

Agent 必须按以下顺序施工：

1. 仓库审计和基线测试。
2. 类型与项目模式兼容层。
3. Schema 19、fresh schema、manifest、18→19 与完整迁移矩阵。
4. chunks/chapters/settings Repository 和 bounded SourceReader 失败测试。
5. Android 原生分块解码模块与 UTF-8/GB18030/UTF-16 测试。
6. 规范化、解析器、edit log 与完整性校验。
7. 导入任务、interrupted 恢复与原子激活。
8. ResourceStack 与资料 > 续写 UI。
9. 边界设置、bounded API 和显式 future browser。
10. format v3 备份恢复与项目包 v3。
11. 单元、集成、UI、E2E。
12. 文档、版本、`npm run verify`、`npm run test:coverage`、`npm run apk:debug` 和 Android 实机/模拟器验证。

每一步必须先补失败测试，再实施修复。

## 21. 验收标准

### 功能验收

- [ ] 新项目可选择“原著续写”。
- [ ] 历史项目行为不变。
- [ ] 资料中存在独立“续写”模块。
- [ ] 可导入 UTF-8 和 GB18030 TXT。
- [ ] 5 MB 导入不经过整文件 base64，不在 React state 保存全文。
- [ ] 可预览、合并、拆分、改名和排除章节。
- [ ] 可设置末尾、章节末尾和章节内偏移续写点。
- [ ] 原著章节只读且与续写章节分离。
- [ ] future source 默认不可被领域查询返回。
- [ ] 自定义边界所在末章在 Phase 2 reader 中被物理裁剪。
- [ ] 替换和删除操作有确认与原子保护。
- [ ] 导入失败可重试。
- [ ] 备份恢复后数据完整。
- [ ] continuation 项目包 v3 可完整导出导入，旧 v1/v2 仍兼容。

### 质量验收

- [ ] lint 通过。
- [ ] typecheck 通过。
- [ ] 全量 Jest 通过并自然退出。
- [ ] coverage 不低于施工前基线。
- [ ] migration matrix 通过。
- [ ] Android Debug 构建通过。
- [ ] 新增 Maestro 流程通过。
- [ ] 不引入真实凭据和大段原著日志。
- [ ] Schema、备份版本、README、CHANGELOG 一致。

## 22. Definition of Done

本阶段只有在以下条件全部满足时才算完成：

1. Phase 1 功能验收全部通过。
2. 新增数据契约已写入项目文档。
3. Phase 2 可以只通过公开 service 获取 boundary 内原著章节。
4. 无业务代码直接跨层读取 future source。
5. 所有新增表已纳入 manifest 和项目删除；业务表进入备份，import job 明确 `backup:false`。
6. 至少一份 30 章中文测试原著完成端到端导入。
7. 导入任务失败、取消和 App 重启均有可验证结果。
8. 施工报告列出实际文件、迁移版本、测试命令、APK 和剩余风险。

## 23. Phase 2 交接契约

Phase 1 必须向 Phase 2 提供：

```ts
interface ContinuationSourceSnapshot {
  projectId: number;
  sourceId: number;
  sourceVersion: number;
  normalizedSha256: string;
  parserVersion: string;
  normalizationVersion: string;
  boundary: {
    chapterId: number;
    chapterPosition: SourceChapterPosition;
    charOffsetExclusive: Utf16Offset;
  };
}

interface ContinuationSourceReader {
  getSnapshot(projectId: number): Promise<ContinuationSourceSnapshot>;
  listBoundedSourceChapters(
    snapshot: ContinuationSourceSnapshot,
  ): Promise<BoundedSourceChapter[]>;
  readBoundedEvidenceRange(input: {
    snapshot: ContinuationSourceSnapshot;
    start: Utf16Offset;
    end: Utf16Offset;
  }): Promise<string>;
}
```

Phase 2 不得依赖 UI 状态、临时文件路径、未激活 source 或 future browser service。`ContinuationSourceReader` 必须在一次调用内绑定同一个 snapshot；调用中 source/boundary 改变时抛出 `source_snapshot_changed`，不得混读两个版本。
