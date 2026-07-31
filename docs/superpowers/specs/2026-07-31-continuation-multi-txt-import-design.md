# 续写模式多 TXT 原著导入 + LLM 顺序排序 设计

- **日期**：2026-07-31
- **状态**：待评审
- **作者**：塔拉
- **关联**：续写域（schema 19→29）、原著续写工作流

## 背景与动机

当前续写模式下，一次只能导入一个 TXT 原著。当原著以多个 TXT 文件形式存在时（如分卷下载、分章节归档），用户无法导入。

本改造新增"一本原著支持导入多个 TXT"的能力，并在导入前可选地用 LLM 分析多个 TXT 的先后顺序，提升拼装质量。

## 范围

**包含**：
- 多 TXT 文件选择与复制到私有目录
- LLM 顺序排序（可选，未配 LLM 时按文件名回退）
- 排序结果预览页（用户可上移/下移调整、移除文件）
- 多文件流式串联导入（保留单遍流式、整本不驻留内存的优势）
- Schema v28 → v29 加列（来源标记 + 多文件元数据）
- 跨文件章节重号处理（position 接续 + detected_title 保留原文）

**不包含**：
- 多文件单独替换/删除某个子文件（激活后仍是整体替换语义）
- 重新排序已激活 source（需重新导入）
- iOS 相关代码（项目纯 Android）

## 架构决策

### 方案A：合并为单一虚拟 source

多 TXT 按 LLM 排序/用户调整后的顺序拼接成一本线性文本，写入单一 `continuation_sources` 行。对外仍是"一个激活 source"，Phase 2/3 reader/snapshot/Canon 几乎不用改，`boundary` 概念不变（仍是全局 UTF-16 偏移）。

新增 `file_index` 列仅作来源标记，不参与 offset 计算；reader 读 chunks 时按 `char_start_offset` 排序即可还原顺序。

### LLM 排序策略

- **可选**：未配 LLM 时按文件名排序；配了 LLM 时先 LLM 排序
- **用户可调整**：排序后弹预览页，用户可上移/下移/移除文件，确认后才拼接导入
- **采样**：每个文件头尾各 ~1500 字（规范化后），文件名一并送入 LLM
- **回退**：LLM 调用失败/超时/JSON 异常 → 文件名排序 + 黄条提示

## 组件清单

### 新增

| 路径 | 职责 |
|------|------|
| `src/screens/continuation/ContinuationSourceOrderingScreen.tsx` | 排序预览页：展示 LLM/回退排序结果 + 每个文件头尾采样摘要 + 上移/下移/移除按钮 + "确认顺序"按钮 |
| `src/services/continuation/continuationOrderingService.ts` | LLM 排序服务：输入采样数组，输出顺序 + 置信度 + 理由；失败回退文件名排序 |

### 修改

| 路径 | 改动 |
|------|------|
| `src/screens/continuation/ContinuationSourceChaptersScreen.tsx` | `handleImport` 改多选（`allowMultiSelection: true`）；多文件时跳转排序预览页，单文件时走原路径 |
| `src/services/continuation/continuationImportService.ts` | `StartImportInput` 改成文件数组；`runPipelineToReview` 多文件流式串联（normalizer/parser/hasher 跨文件共享实例） |
| `src/services/continuation/continuationSourceRepository.ts` | `insertChunks`/`insertChapters` 加 `fileIndex` 参数；新增 `updateSourceMultiFileMeta` 写 `source_files_json` |
| `src/native/ContinuationTextImportModule.ts` | 无改动（仍按单文件路径解码，JS 侧循环调用） |

### 无需改

- `continuationSourceReader` / `canonAnalysisService` / `confirmContinuationSource` — 仍是单 source 视角
- `continuation_settings` 的 1:1 约束、`idx_continuation_sources_one_ready` 唯一索引 — 方案A 仍是"一个激活 source"

## 数据流

```
用户点"导入 TXT 原著"
  ↓
多选 TXT（allowMultiSelection: true）
  ↓
逐个 keepLocalCopy → 私有目录副本（cachesDirectory）
  ↓
批量探测编码（detectEncoding，< 0.7 单独弹窗确认）
  ↓
逐个采样头尾各 ~1500 字（用 decodeChunk 读首段 + seek 读尾段）
  ↓
【若已配 LLM】LLM 顺序排序
  【若未配 LLM】按文件名排序
  ↓
排序预览页 ContinuationSourceOrderingScreen
  - 展示排序结果 + 每个文件头尾采样摘要
  - 上移/下移/移除按钮
  - "确认顺序"按钮
  ↓
runPipelineToReview 多文件流式串联
  - 按 order 依次：decode → normalize → parse → 入库
  - file_index 递增标记来源
  - position 全局递增（0-based）
  - char_offset 全局累加（跨文件无间隔）
  - normalized_sha256 = 拼接后整体哈希
  - source_files_json 记录每个文件元数据
  ↓
章节解析预览页（现有，复用 previewParsedSource）
  - 高亮重号章节（detected_title 保留原文）
  ↓
confirmContinuationSource（现有，无改动）
```

## Schema 变更（v28 → v29）

两处都改：`src/services/migrations/v28-to-v29.ts` + 镜像 `src/data/schema/createCurrentSchema.ts`。

### 1. `continuation_sources` 加 3 列

```sql
ALTER TABLE continuation_sources ADD COLUMN source_files_json TEXT;
ALTER TABLE continuation_sources ADD COLUMN is_multi_file INTEGER NOT NULL DEFAULT 0 CHECK(is_multi_file IN (0, 1));
ALTER TABLE continuation_sources ADD COLUMN file_count INTEGER NOT NULL DEFAULT 1 CHECK(file_count >= 1);
```

- `source_files_json`：`null` 表示单文件（旧数据兼容）；多文件时存数组：
  ```json
  [
    {
      "originalFileName": "first-volume.txt",
      "fileSizeBytes": 1234567,
      "detectedEncoding": "utf-8",
      "fileIndex": 0,
      "headSampleSha256": "abc...",
      "tailSampleSha256": "def...",
      "orderingReasoning": "文件名含『第一卷』，且首段出现书名"
    }
  ]
  ```
- `is_multi_file`：快速过滤标记
- `file_count`：冗余字段，UI 免解析 JSON

### 2. `continuation_source_text_chunks` 加 1 列

```sql
ALTER TABLE continuation_source_text_chunks ADD COLUMN file_index INTEGER NOT NULL DEFAULT 0 CHECK(file_index >= 0);
```

- 旧数据 `file_index = 0`（单文件场景，向后兼容）
- 仅作来源标记，不参与 `char_start_offset` 排序逻辑

### 3. `continuation_source_chapters` 加 1 列

```sql
ALTER TABLE continuation_source_chapters ADD COLUMN file_index INTEGER NOT NULL DEFAULT 0 CHECK(file_index >= 0);
```

- 同上，旧数据默认 0
- UI 可展示"该章来自第 N 个文件"

### 约束不变

- 不碰 `continuation_settings` 的 1:1 约束
- 不碰 `idx_continuation_sources_one_ready` 唯一索引
- 不碰 `idx_continuation_import_one_active` 唯一索引

## LLM 排序服务设计

### 接口

```ts
// src/services/continuation/continuationOrderingService.ts

export interface OrderingInputFile {
  index: number;              // 选择时的原始序号
  fileName: string;
  fileSizeBytes: number;
  headSample: string;         // 头部 ~1500 字（规范化后）
  tailSample: string;         // 尾部 ~1500 字（规范化后）
}

export interface OrderingResult {
  orderedFileIndexes: number[];   // 重排后的原始 index 数组
  confidence: number;             // 0-1
  reasoning: string;              // LLM 给的整体排序理由
  method: 'llm' | 'fallback_filename';  // 实际采用的方法
}

export async function orderSourceFiles(
  files: OrderingInputFile[],
  modelConfigId: number,
): Promise<OrderingResult>;
```

### Prompt 策略

- 让 LLM 输出严格 JSON：`{"order": [索引数组], "confidence": 0-1, "reasoning": "..."}`
- 用 JSON Schema 校验，校验失败则回退文件名排序
- **卷/部标记优先引导**：prompt 中明确"如果存在明确的卷/部标记（如『第一卷』『第二部』『卷一』『卷二』），优先按卷标记排序"
- **承接关系判断**：提示 LLM 关注"文件 N 的尾部"与"文件 M 的开头"是否能拼上（剧情连续性、人物对话中断、场景衔接）

### 调度

- `requestScheduler` 的 `queueClass: 'normal'`，`queuePriority: 'normal'`（不抢管线）
- 超时 60s

### 回退逻辑

- LLM 调用失败 / 超时 / JSON 解析失败 / 索引不完整 / 含重复索引 → 回退文件名排序
- 回退时 `confidence = 0`，`method = 'fallback_filename'`，`reasoning = 'LLM 排序失败，已按文件名排序'`
- 调用方（UI）在回退时展示黄条提示

## 多文件流式串联设计

### runPipelineToReview 改造

外层加 `for (fileIndex = 0; fileIndex < files.length; fileIndex++)`，内层复用现有的 decode→normalize→parse→入库循环。

**关键不变量**：
- `normalizer` / `parser` / `rawHasher` / `fallbackHasher` **跨文件共享实例**（不重置），保证拼接文本的 SHA-256 和章节 position 连续性
- `chunkIndex` 跨文件累加
- `char_start_offset` 跨文件累加（无间隔）
- `position` 跨文件累加（0-based 全局递增）
- `file_index` 每文件内固定值

### checkpoint_json 扩展

```json
{
  "fileIndex": 1,
  "byteCursor": 524288,
  "chunkIndex": 12,
  "lineStartOffset": 65536,
  "normalizedCharCount": 131072,
  "rawSha256State": "hex...",
  "normalizedSha256State": "hex...",
  "parserState": "hex..."
}
```

恢复时从 `fileIndex` 的 `byteCursor` 续读，跨文件的 hasher/parser 状态从序列化状态恢复。

### 跨文件章节重号处理

- `position` 全局递增（0-based）：文件1 的 0-9 章 + 文件2 的 10-14 章
- `detected_title` 保留原文：第二个"第一章"仍显示"第一章"
- 章节解析预览页（`previewParsedSource`）高亮提示"该标题在全文中重复"
- 用户可手动编辑 `title` 字段

### 总大小预检

导入前校验所有文件总大小，超过 `MAX_IMPORT_FILE_BYTES`（200 MB）直接拒绝，提示"原著总大小超过 200MB 限制"。

## 错误处理矩阵

| 场景 | 处理 |
|------|------|
| LLM 排序调用失败/超时/JSON 解析失败 | 回退文件名排序，预览页顶部黄条提示"LLM 排序失败，已按文件名排序，可手动调整" |
| LLM 排序返回的索引不完整/含重复 | 回退文件名排序 |
| 多文件中某个文件编码探测低置信 | 该文件单独弹窗确认编码，其他文件继续 |
| 多文件中某个文件解码失败 | 预览页标红该文件 + "移除"按钮，其他文件正常进入排序 |
| 多文件流式串联中某文件读取中断 | 整个 job 转 `interrupted`，`resumeContinuationImport` 从 `checkpoint_json` 的 `fileIndex` + `byteCursor` 恢复 |
| 多文件拼接后总字符数超 200MB 限制 | 导入前校验总大小，预检阶段直接拒绝 |
| 排序预览页用户移除某文件后只剩 1 个 | 退化为单文件导入路径（不调用 LLM 排序） |
| 拼接后章节重号 | detected_title 保留原文，position 全局递增，预览页高亮提示"该标题在全文中重复" |

## UI 交互

### ContinuationSourceChaptersScreen.handleImport 改造

```ts
const handleImport = async () => {
  // 1. 项目模式校验
  // 2. 多选文件（allowMultiSelection: true）
  const selected = await pick({
    mode: 'import',
    type: [types.plainText, types.allFiles],
    allowMultiSelection: true,
  });
  
  // 3. 全部必须是 .txt
  // 4. 逐个 keepLocalCopy → cachesDirectory
  // 5. 逐个 detectEncoding，低置信单独弹窗
  // 6. 总大小预检（>200MB 拒绝）
  
  if (selected.length === 1) {
    // 单文件：走原路径（startContinuationImport → previewParsedSource → confirm）
  } else {
    // 多文件：跳转排序预览页
    navigation.navigate('ContinuationSourceOrdering', {
      projectId,
      files: [{ localPath, originalFileName, detectedEncoding, fileSizeBytes }, ...],
    });
  }
};
```

### ContinuationSourceOrderingScreen

- **顶部**：标题"排序原著文件" + 副标题说明（共 N 个文件）
- **回退提示**：若 `method === 'fallback_filename'`，显示黄条"LLM 排序失败，已按文件名排序，可手动调整"
- **文件列表**：每项含
  - 序号（1-based）
  - 文件名
  - 文件大小
  - 头部采样摘要（前 200 字 + "..."）
  - 尾部采样摘要（"..." + 后 200 字）
  - LLM 排序理由（若有）
  - 上移/下移/移除按钮
- **底部**：
  - "重新 LLM 排序"按钮（仅 `method === 'fallback_filename'` 且已配 LLM 时显示）
  - "确认顺序"按钮 → 调 `startContinuationImport` 传入排序后的文件数组 → 跳转章节解析预览页

## 测试策略

### 单元测试（`__tests__/`）

- `continuationOrderingService.test.ts`
  - LLM 排序成功（返回合法 order）
  - LLM 调用失败 → 回退文件名排序
  - LLM 返回索引不完整 → 回退
  - LLM 返回索引含重复 → 回退
  - LLM JSON 解析失败 → 回退
  - 未配 LLM → 直接文件名排序

- `continuationImportService.multi-file.test.ts`
  - 2 文件流式串联、position 连续性
  - sha256 跨文件累加正确
  - file_index 标记正确（chunks 和 chapters）
  - source_files_json 写入正确
  - 中断恢复从正确 fileIndex + byteCursor 续读

- `v28-to-v29.migration.test.ts`
  - 迁移后新列默认值正确
  - 旧数据 `file_index = 0`、`source_files_json = null`、`is_multi_file = 0`、`file_count = 1`
  - 迁移后 `createCurrentSchema` 镜像一致

- 现有单文件测试全部保持绿色（回归）

### 集成测试

- 2 文件 + LLM 排序 → 预览页调整顺序 → 拼接导入 → boundary 设置 → Canon 分析全流程
- 多文件中断恢复

### 手动验收（真机）

- 3 个 TXT（顺序打乱）+ 已配 LLM → 验证 LLM 排序正确性
- 未配 LLM → 验证文件名排序回退
- 2 个都含"第一章"的 TXT → 验证 position 接续 + detected_title 保留
- 多文件中 1 个编码异常 → 验证单独弹窗确认
- 多文件总大小超 200MB → 验证预检拒绝

## 工作量与风险

### 主要工作量

1. Schema 迁移 + 镜像（小，机械）
2. `continuationOrderingService`（中，LLM prompt 调优 + 回退逻辑）
3. `runPipelineToReview` 多文件串联改造（中，需保证 hasher/parser 状态连续性）
4. `ContinuationSourceOrderingScreen`（中，新屏幕）
5. `handleImport` 多选改造（小）
6. 测试（中，多场景）

### 风险点

1. **跨文件 hasher/parser 状态序列化**：中断恢复时需把 `Sha256Stream` 和 `StreamingChapterParser` 的内部状态序列化到 `checkpoint_json`。若现有实现不支持状态导出，需新增序列化接口。**需在实现阶段先检查现有实现**。
2. **LLM 排序质量**：头尾各 1500 字可能不足以判断某些边缘情况（如倒叙叙事的小说）。回退 + 用户手动调整是兜底。
3. **多文件大文件内存**：单文件已是流式，多文件串联不引入额外内存压力，但需确认 `keepLocalCopy` 阶段不会一次性把所有文件读入内存（picker 的 `keepLocalCopy` 是流式复制，应无问题）。

## 验收标准

- [ ] 单文件导入路径完全不变（回归通过）
- [ ] 多文件导入后，`continuation_sources` 有且仅有 1 行 `status='ready'`
- [ ] 多文件导入后，`file_count` 与实际文件数一致，`source_files_json` 完整
- [ ] 多文件导入后，`continuation_source_text_chunks` 和 `continuation_source_chapters` 的 `file_index` 正确标记来源
- [ ] 多文件导入后，章节 `position` 全局连续递增
- [ ] 多文件导入后，`normalized_sha256` 与拼接后整体文本的 SHA-256 一致
- [ ] LLM 排序失败时正确回退文件名排序
- [ ] 排序预览页可上移/下移/移除文件
- [ ] 中断恢复可从正确 fileIndex + byteCursor 续读
- [ ] Schema v28 → v29 迁移后旧数据默认值正确
- [ ] Canon 分析可正常在多文件 source 上运行
