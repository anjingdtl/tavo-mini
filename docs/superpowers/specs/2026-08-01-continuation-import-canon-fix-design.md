# 续写模块：TXT 导入错误处理加固 & Canon 分析上下文自适应修复

- 日期：2026-08-01
- 作者：塔拉
- 状态：已通过设计评审，待实施
- 关联：
  - 真机回归发现的两类问题
  - `2026-07-31-continuation-multi-txt-import-design.md`（多 TXT 导入实现）
  - `2026-07-28-canon-analysis-fix-spec.md`（Canon 分析历史修复）

## 一、问题陈述

### 问题 1：多 TXT 导入失败无错误信息

真机导入多个 TXT 时，因编码不一致或个别 TXT 过大，出现个别文件失败，但应用未告知用户原因，整批中止且无具体失败文件清单。

### 问题 2：Canon 分析「模型上下文不足」

对 TXT 进行完整分析时，提示「模型上下文不足以执行 Canon 分析」。自多 TXT 支持上线后该问题暴露，根因是分析模块的 token 预算计算写死了上下文阈值，未与用户在 LLM 配置里设置的 `context_window` / `max_output_tokens` 联动。

## 二、根因

### 问题 1 根因

| # | 根因 | 位置 |
|---|---|---|
| 1.1 | 批量循环无单文件跳过机制——任一文件失败就 `throw`，整批中止 | `src/screens/continuation/ContinuationSourceChaptersScreen.tsx` `handleImport` 第 216–240 行 |
| 1.2 | `confirmEncodingIfNeeded` 探测失败被 `.catch(() => finish(undefined))` 静默吞 | 同文件第 80 行 |
| 1.3 | 原生 Kotlin 解码 malformed 字节降级 REPLACE 不报错 | `android/.../ContinuationTextImportModule.kt` 第 184–194 行 |
| 1.4 | catch 块只 `Toast.show({text2: e?.message || '请重试'})`，无 errorCode 区分 | 同文件第 296–298 行 |
| 1.5 | `finally` 清理 cachesDirectory 副本只覆盖已 push 的，push 之前失败会泄漏 | 同文件第 304–308 行 |
| 1.6 | 排序页 sampling 失败完全静默 | `ContinuationSourceOrderingScreen.tsx` 第 90、103 行 |

### 问题 2 根因

| # | 根因 | 详情 |
|---|---|---|
| 2.1 | `outputBaseline` 写死 32768，不随用户 `max_output_tokens` 自适应 | `canonAnalysisService.ts` 第 363–367 行 `CANON_OUTPUT_BASELINE_TOKENS`。当 LLM 配置 `context_window` < 32768 + 单章 token + overhead 时，`effectiveWindow` 直接是负数，无论怎么降级 perBatch/sliceCharBudget 都不可能成功 |
| 2.2 | 降级策略到地板仍 fail 时直接抛错，无更激进降级 | `canonAnalysisService.ts` 第 513–567 行：perBatch=1 + sliceCharBudget=512 仍超 → 抛错。没有「按 chunk 切超大章节继续分析」策略 |
| 2.3 | 错误信息只说「请改用更大上下文窗口的模型」，没给具体阈值 | 无 `当前 context_window=X，建议至少 Y` 这类信息 |
| 2.4 | UI 层无预检对话框 | 默认 `context_window=4096` 显然不够做 Canon 分析，但应用不主动校验，让用户跑到分析中途才报错 |
| 2.5 | `extractMaterialWithLlm` 实际请求 max_tokens 与 `planAnalysisTokenBudget` 校验 baseline 不一致 | 实际 `baselineMaxTokens = min(max(profileBaseline, max_output_tokens), 65536)`，但校验用 `profileBaseline`(32768)，用户配 max_output_tokens=100K 时实际请求 65536，校验只预留 32768 |

### 用户原诉求澄清

- ✅「LLM 自行先分配分析需要切块发起的分析次数」——核心目标
- ✅「通过次数来弥补上下文限制」——增加调用次数而非跳过内容
- ✅「按比例来分配每个切块可进行的分析次数」——按 LLM 配置的 context_window 按比例计算
- ✅「和 LLM 自动上下文配置里面进行联动」——零硬编码，全派生
- ❌ 不得跳过超大章节（会丢失 Canon 数据）
- ❌ 不得写死任何上下文窗口限制（6K chunk、24K 字符上限、32768 outputBaseline 等全部删除）

## 三、设计原则

1. **零硬编码，全派生**：所有 token 阈值从用户在 LLM 配置里设置的 `context_window` 与 `max_output_tokens` 动态计算，不在代码里写死任何上下文窗口数值
2. **完整分析原著**：通过增加 LLM 调用次数弥补单次上下文不足，绝不跳过章节、绝不丢失 Canon 数据
3. **按比例分配**：根据 LLM 配置按比例计算每 batch 可容纳的章节内容、需要的 batch 数量、chunk 切分粒度
4. **保留现有协议**：v3.1 协议的 `request_groups_v3_1_split`（character_state 5 类 + world_plot 3 类）继续使用
5. **profile 仅控制质量**：`AnalysisProfile`（quick/standard/deep）保留，但只决定 `materialType` 拆分策略与 prompt 内容深度，不参与 token 计算

## 四、问题 2 详细设计：Canon 分析上下文自适应

### 4.1 删除的硬编码常量

```ts
// 全部删除，替换为派生计算
const CANON_PROMPT_OVERHEAD_TOKENS = 600;                    // 改为动态估算
const CANON_ONLINE_OUTPUT_RESERVE_CAP_TOKENS = 65_536;       // 改为 max_output_tokens
const CANON_OUTPUT_BASELINE_TOKENS = {                      // 全删
  quick: 4096, standard: 32768, deep: 32768,
};
const CANON_ONLINE_CHAPTER_TEXT_LIMIT = 24_000;              // 改为动态派生
const fallbackOnlineWindow = 32_768;                        // 删
const CANON_LOCAL_MODEL_MIN_CONTEXT_WINDOW;                 // 删
```

### 4.2 保留的常量（与上下文无关）

- `FULL_CANON_QUALITY_CHAPTERS_PER_BATCH = 20`：质量上限，控制单 batch 最多 20 章，避免单 batch 太大影响 LLM 注意力分布
- `MIN_INPUT_BUDGET_TOKENS = 1024`：防御性下限，避免 `effectiveInputBudget ≤ 0` 导致无限循环（极小模型时拒绝分析）
- `CANON_ANALYSIS_RETRY_POLICY.maxAttempts = 3`：重试策略不变
- `AnalysisProfile` 枚举：保留，仅用于 prompt 内容深度

### 4.3 新增模块：`adaptiveBatchPlanner.ts`

路径：`src/services/continuation/canon/adaptiveBatchPlanner.ts`

#### 4.3.1 输入

```ts
interface AdaptiveBatchPlanInput {
  chapters: BoundedSourceChapter[];
  profile: AnalysisProfile;
  providerType?: string | null;
  contextWindow: number | null | undefined;       // 从 LLM 配置读取
  maxOutputTokens: number | null | undefined;     // 从 LLM 配置读取
  materialType: AnalysisWorkItemType;             // 当前工作项类型（影响 prompt 骨架）
}
```

#### 4.3.2 输出

```ts
type AdaptiveBatch =
  | { type: 'normal'; chapters: BoundedSourceChapter[] }
  | {
      type: 'chunk';
      chapter: BoundedSourceChapter;
      chunkIndex: number;
      chunkCount: number;
      chunkStartChar: number;
      chunkEndChar: number;
    };

interface AdaptiveBatchPlan {
  ok: boolean;
  batches: AdaptiveBatch[];
  effectiveInputBudget: number;    // 派生：单 batch 可塞多少 token 的章节内容
  outputReserve: number;           // = max_output_tokens
  promptOverhead: number;          // 动态估算
  estimatedBatchCount: number;     // 总 batch 数（chunks + normals）
  reason?: string;                 // ok=false 时的失败原因
  skippedChapters?: never;         // 永远不跳过章节，明确禁止
}
```

#### 4.3.3 核心算法

```ts
function planAdaptiveBatching(input: AdaptiveBatchPlanInput): AdaptiveBatchPlan {
  // 1. 动态估算 prompt 骨架 token（用真实 prompt 模板构造一次空 user message）
  const promptOverhead = estimatePromptOverhead({
    profile: input.profile,
    materialType: input.materialType,
  });

  // 2. 从 LLM 配置派生 effectiveInputBudget
  //    未配置 context_window 时用保守默认（与历史 deep profile 对齐），
  //    但不再硬编码 32768，而是按 max_output_tokens 的 8 倍作为默认窗口
  const declaredWindow =
    input.contextWindow && input.contextWindow > 0
      ? input.contextWindow
      : Math.max((input.maxOutputTokens ?? 4096) * 8, 32_768);
  const outputReserve =
    input.maxOutputTokens && input.maxOutputTokens > 0
      ? input.maxOutputTokens
      : 4096;
  const effectiveInputBudget = Math.max(
    MIN_INPUT_BUDGET_TOKENS,
    declaredWindow - outputReserve - promptOverhead,
  );

  // 3. 防御性下限：effectiveInputBudget < MIN 时拒绝
  if (effectiveInputBudget <= MIN_INPUT_BUDGET_TOKENS) {
    return {
      ok: false,
      batches: [],
      effectiveInputBudget,
      outputReserve,
      promptOverhead,
      estimatedBatchCount: 0,
      reason: `当前 LLM 配置的 max_output_tokens=${outputReserve} 过大，剩余输入预算仅 ${effectiveInputBudget} tokens（少于最低 ${MIN_INPUT_BUDGET_TOKENS}）。请在「设置 → LLM 配置」降低 max_output_tokens 或增大 context_window。`,
    };
  }

  // 4. 计算每章实际 token（基于实际内容，不截断到 24000）
  const chapterTokens = input.chapters.map(c => ({
    chapter: c,
    tokens: estimateChapterTokens(c),  // title + content，全量
  }));

  // 5. 贪心打包：按章节顺序累加，达到 effectiveInputBudget * 0.8 切 batch
  //    单章超过 budget 时切成多个 chunk batch
  const batches: AdaptiveBatch[] = [];
  let currentBatch: BoundedSourceChapter[] = [];
  let currentTokens = 0;
  const fillRatio = 0.8;  // 80% 阈值，预留 20% 给章节标题与分隔符

  for (const { chapter, tokens } of chapterTokens) {
    if (tokens > effectiveInputBudget) {
      // 5.1 单章超过 budget：先 flush 当前 batch，再切 chunk
      if (currentBatch.length > 0) {
        // 受质量上限约束
        for (let i = 0; i < currentBatch.length; i += FULL_CANON_QUALITY_CHAPTERS_PER_BATCH) {
          batches.push({ type: 'normal', chapters: currentBatch.slice(i, i + FULL_CANON_QUALITY_CHAPTERS_PER_BATCH) });
        }
        currentBatch = [];
        currentTokens = 0;
      }
      // 5.2 按 effectiveInputBudget 切 chunk
      //     chunk 字符数 = floor(effectiveInputBudget / estimateTokensPerChar(chapter))
      //     其中 estimateTokensPerChar 动态计算（CJK 约 1.0 token/字符，英文约 0.25 token/字符）
      const tokensPerChar = estimateTokensPerCharForChapter(chapter);
      const chunkCharSize = Math.max(
        512,  // 防御性下限，避免 chunk 过碎
        Math.floor(effectiveInputBudget / tokensPerChar),
      );
      const chunkCount = Math.ceil(chapter.content.length / chunkCharSize);
      for (let i = 0; i < chunkCount; i++) {
        batches.push({
          type: 'chunk',
          chapter,
          chunkIndex: i,
          chunkCount,
          chunkStartChar: i * chunkCharSize,
          chunkEndChar: Math.min((i + 1) * chunkCharSize, chapter.content.length),
        });
      }
    } else if (currentTokens + tokens > effectiveInputBudget * fillRatio) {
      // 5.3 达到 80% 阈值，切 batch
      batches.push({ type: 'normal', chapters: currentBatch });
      currentBatch = [chapter];
      currentTokens = tokens;
    } else {
      currentBatch.push(chapter);
      currentTokens += tokens;
    }
    // 5.4 质量上限：单 batch 最多 20 章
    if (currentBatch.length >= FULL_CANON_QUALITY_CHAPTERS_PER_BATCH) {
      batches.push({ type: 'normal', chapters: currentBatch });
      currentBatch = [];
      currentTokens = 0;
    }
  }
  if (currentBatch.length > 0) {
    batches.push({ type: 'normal', chapters: currentBatch });
  }

  return {
    ok: true,
    batches,
    effectiveInputBudget,
    outputReserve,
    promptOverhead,
    estimatedBatchCount: batches.length,
  };
}
```

#### 4.3.4 辅助函数

- `estimatePromptOverhead({ profile, materialType })`：构造空 prompt 骨架（不含章节正文），调 `estimateMessagesTokens` 返回实际 token 数。每次分析调用一次，结果可缓存到 `analysisRuns.checkpoint_json` 用于 resume
- `estimateChapterTokens(chapter)`：`title + content` 全量估算，用现有 `estimateTokens`，避免每章 24000 字符截断
- `estimateTokensPerCharForChapter(chapter)`：采样章节前 1KB，分别用 CJK 与英文公式估算，取加权平均

### 4.4 `canonAnalysisService.ts` 改造

#### 4.4.1 `startAnalysis` 修改

替换原 `resolveContextDrivenChaptersPerBatch` + `resolveQualityFirstChaptersPerBatch` + `planAnalysisTokenBudget` 三步：

```ts
// 新流程
const batchPlan = planAdaptiveBatching({
  chapters: plan.nearChapters,
  profile,
  providerType: requestConfig.provider_type,
  contextWindow: requestConfig.context_window,
  maxOutputTokens: requestConfig.max_output_tokens,
  materialType: MATERIAL_TYPE_CHARACTER_STATE,  // 用 character_state 作为代表估算
});
if (!batchPlan.ok) {
  throw new Error(batchPlan.reason);
}
// batchPlan.batches 直接作为 batches 写入 continuation_analysis_batches
// 每个 batch 又拆 2 个 materialType work_item（character_state + world_plot）
```

#### 4.4.2 `processAnalysisRunInner` 修改

处理 `AdaptiveBatch` 两种类型：

```ts
for (const batch of batches) {
  if (batch.type === 'normal') {
    // 现有流程：batch 内所有章节合并 prompt，调 2 个 materialType
    const chapters = await continuationSourceReader.listBoundedSourceChaptersForRange(
      snapshot, batch.startPosition, batch.endPosition,
    );
    await extractMaterialWithLlm(chapters, profile, modelConfigId, 'character_state', runId, signal);
    await extractMaterialWithLlm(chapters, profile, modelConfigId, 'world_plot', runId, signal);
  } else {
    // chunk 类型：单章切 chunk，每 chunk 独立调 2 个 materialType
    const chunkContent = batch.chapter.content.slice(
      batch.chunkStartChar, batch.chunkEndChar,
    );
    const chunkedChapter: BoundedSourceChapter = {
      ...batch.chapter,
      content: chunkContent,
      // 保留原 range，让 LLM 知道这是该章的第 N/M 片段
    };
    await extractMaterialWithLlm(
      [chunkedChapter], profile, modelConfigId, 'character_state', runId, signal,
      {
        chunkMetadata: {
          chunkIndex: batch.chunkIndex,
          chunkCount: batch.chunkCount,
        },
      },
    );
    // world_plot 同理
  }
}
```

#### 4.4.3 `extractMaterialWithLlm` 修改

- 新增可选参数 `chunkMetadata?: { chunkIndex: number; chunkCount: number }`
- 当 `chunkMetadata` 存在时，prompt 里附加说明：
  ```
  注意：本章由于篇幅过大，已按字符区间切分为 M 个片段。当前为第 N 个片段（字符区间 [start, end)）。
  请仅基于本片段内容提取 evidence，跨片段的关联（如人物关系、伏笔）由后续合并阶段处理。
  bodyStart/bodyEnd 仍按全书 UTF-16 绝对偏移填写。
  ```
- `max_tokens` 参数从 `batchPlan.outputReserve`（= `max_output_tokens`）取，不再用 `baselineMaxTokens` 公式
- `chapterTextLimit` 从 `batchPlan.effectiveInputBudget` 派生（动态），不再用 `CANON_ONLINE_CHAPTER_TEXT_LIMIT`

#### 4.4.4 chunk 结果合并

新增 `mergeChunkResults(chunkResults: ExtractMaterialOutcome[], chapterId: number): ExtractMaterialOutcome`：
- 按 chapterId 分组
- 同一 evidence quotePreview 去重（保留首次出现）
- character_aliases 合并去重
- relationships 合并（同 sourceCharacterId + targetCharacterId 取并集）
- plot_threads 合并（同 threadId 取并集，evidence 合并）

### 4.5 UI 预检对话框

`ContinuationHomeScreen.tsx` 或 `CanonAnalysisConfigScreen.tsx`：

用户点「开始完整分析」时，先调 `precheckCanonAnalysis({ projectId, mode })` 返回：

```ts
interface CanonAnalysisPrecheck {
  ok: boolean;
  reason?: string;
  // 当前 LLM 配置
  contextWindow: number;
  maxOutputTokens: number;
  // 派生计算
  effectiveInputBudget: number;
  estimatedBatchCount: number;       // 总 batch 数（含 chunk）
  estimatedWorkItemCount: number;    // = batchCount * 2（character_state + world_plot）
  estimatedDurationMinutes: number;  // 按 30s/work_item 估算
  // 建议值（仅在 ok=false 时）
  suggestedContextWindow?: number;
  suggestedMaxOutputTokens?: number;
}
```

不 ok 时弹 Alert：

```
当前模型配置无法完成 Canon 分析

当前 LLM 配置：
  context_window: 4096
  max_output_tokens: 4000

派生计算：
  单 batch 输入预算: -1636 tokens（不足）

错误原因：max_output_tokens=4000 过大，剩余输入预算仅 -1636 tokens

建议：
  • 降低 max_output_tokens 至 1024，或
  • 增大 context_window 至至少 8192

[前往 LLM 配置] [仍然尝试] [取消]
```

ok 时弹确认对话框：

```
即将开始完整 Canon 分析

当前 LLM 配置：
  context_window: 128000
  max_output_tokens: 8000

派生计算：
  单 batch 输入预算: 119400 tokens
  预计 batch 数: 47（含 3 个 chunk 切分）
  预计 LLM 调用次数: 94
  预计耗时: 约 47 分钟

[开始分析] [取消]
```

### 4.6 错误信息改进

`canonAnalysisService.ts` 抛错时携带结构化信息：

```ts
class CanonAnalysisContextError extends Error {
  constructor(public readonly details: {
    contextWindow: number;
    maxOutputTokens: number;
    effectiveInputBudget: number;
    suggestedContextWindow?: number;
    suggestedMaxOutputTokens?: number;
  }) {
    super(formatCanonContextError(details));
  }
}
```

UI 层捕获该错误类型时显示完整 Alert（含建议值与跳转按钮）。

## 五、问题 1 详细设计：TXT 导入错误处理加固

### 5.1 `handleImport` 批量循环改造

`ContinuationSourceChaptersScreen.tsx`：

```ts
const failedFiles: Array<{
  fileName: string;
  errorCode?: string;
  message: string;
}> = [];
const successFiles: ImportFileInfo[] = [];

for (const f of selected) {
  try {
    const [copy] = await keepLocalCopy({ ... });
    if (copy.status === 'error') {
      throw new ImportFileError(copy.copyError || '复制失败', 'copy_failed');
    }
    const localPath = localFileUriToPath(copy.localUri);
    // 立即记入 fileInfos 用于 finally 清理（含失败副本）
    fileInfos.push({ localPath, originalFileName: f.name || 'original.txt', ... });
    const encodingOverride = await confirmEncodingIfNeeded(localPath);
    if (encodingOverride === null) {
      // 用户取消整个导入，break 而非 continue
      break;
    }
    // ...detectEncoding / readFileMeta
    successFiles.push({ ... });
  } catch (e: any) {
    failedFiles.push({
      fileName: f.name || 'original.txt',
      errorCode: e.errorCode,
      message: sanitizeErrorMessage(e?.message || '未知错误'),
    });
  }
}

// 汇总提示
if (failedFiles.length > 0 && successFiles.length > 0) {
  Alert.alert(
    '部分文件导入失败',
    `成功 ${successFiles.length} 个，失败 ${failedFiles.length} 个：\n` +
      failedFiles.map(f => `• ${f.fileName}: ${f.message}`).join('\n'),
    [
      { text: '全部取消', style: 'cancel', onPress: () => {} },
      {
        text: '继续导入成功的文件',
        onPress: () => proceedWithFiles(successFiles),
      },
    ],
  );
} else if (failedFiles.length === selected.length) {
  Alert.alert(
    '导入失败',
    `所有文件均失败：\n` +
      failedFiles.map(f => `• ${f.fileName}: ${f.message}`).join('\n'),
  );
} else {
  proceedWithFiles(successFiles);
}
```

### 5.2 `confirmEncodingIfNeeded` 探测失败处理

`catch` 不再静默吞：

```ts
.catch((e: any) => {
  Toast.show({
    type: 'error',
    text1: '编码探测失败',
    text2: '将按 UTF-8 兜底解析，若出现乱码请改用单文件导入并手动指定编码',
  });
  finish(undefined);
});
```

### 5.3 临时文件清理覆盖 push 之前

如 5.1 所示，`keepLocalCopy` 成功后立即 `fileInfos.push`，确保 `finally` 覆盖所有已复制文件（含后续步骤失败的副本）。

### 5.4 错误信息工具

新增 `src/services/continuation/errorMessaging.ts`：

```ts
export function mapImportErrorToUserMessage(
  errorCode: string | undefined,
  rawMessage: string,
): { title: string; suggestion?: string } {
  switch (errorCode) {
    case 'unsupported_encoding':
      return { title: 'TXT 编码不支持', suggestion: '请转为 UTF-8 后重试' };
    case 'file_too_large':
      return { title: '文件超过 200MB 限制', suggestion: '请拆分文件后重试' };
    case 'decode_failed':
      return { title: '解码失败', suggestion: '疑似编码不匹配，请尝试手动指定编码' };
    case 'parse_failed':
      return { title: '解析失败', suggestion: rawMessage };
    case 'chunk_integrity_failed':
      return { title: '分块校验失败', suggestion: '请重新导入' };
    case 'storage_full':
      return { title: '存储空间不足', suggestion: '请清理设备空间后重试' };
    default:
      return { title: rawMessage || '未知错误' };
  }
}
```

### 5.5 排序页 sampling 失败提示

`ContinuationSourceOrderingScreen.tsx` 第 90、103 行的空 catch：

```ts
.catch(() => {
  Toast.show({
    type: 'info',
    text1: '部分文件预览失败',
    text2: '将仅按文件名排序',
  });
  return '';
});
```

## 六、测试计划

### 6.1 新增测试文件

| 文件 | 覆盖场景 |
|---|---|
| `__tests__/adaptiveBatchPlanner.test.ts` | 单 TXT 10 章小书 → 5 个 batch；多 TXT 累计 500 章 → 250+ 个 batch；单章 100K 字符超大章节 → 切成 ~17 个 chunk batch；context_window=4096 极小模型 → 友好报错带阈值；context_window=200K 大模型 → batch 数量减少；chunk 字符数动态派生（不写死 6K） |
| `__tests__/canonAnalysisChunkMerge.test.ts` | chunk 结果合并去重；evidence quotePreview 去重；character_aliases 合并；relationships 合并；plot_threads 合并 |
| `__tests__/continuationImportErrorHandling.test.ts` | 批量循环单文件失败跳过；部分失败 + 部分成功；全部失败；临时文件清理覆盖 push 之前；errorCode 映射文案 |
| `__tests__/canonAnalysisPrecheck.test.ts` | UI 预检返回结构化数据；ok=false 时给出建议值；ok=true 时给出耗时估算 |

### 6.2 修改现有测试

- `canonAnalysisService.test.ts`（如有）：适配 `planAnalysisTokenBudget` → `planAdaptiveBatching` 签名变更
- `extractMaterialWithLlm.test.ts`（如有）：适配 `max_tokens` 参数派生逻辑变更
- 任何 mock `CANON_OUTPUT_BASELINE_TOKENS` 的测试：删除该 mock

### 6.3 全量回归

- `npm run verify`（lint + typecheck + test:ci）
- 覆盖率门禁不能下降（参考 `jest.config.js`：全局 branches 55 / functions 65 / lines 65 / statements 65；database/schema/migrations/backup 更高阈值）

### 6.4 真机回归（发版前）

- 多 TXT 导入：1 个失败 + 2 个成功 → 弹失败清单 + 继续选项
- 多 TXT 导入：全部失败 → 弹失败清单，不进入排序页
- 完整 Canon 分析：context_window=8K 小模型 → 自动切多 batch，能跑完
- 完整 Canon 分析：context_window=128K 大模型 → batch 数量合理，能跑完
- 完整 Canon 分析：单章 100K 字符 → 自动切 chunk，能跑完
- 完整 Canon 分析：context_window=4096 极小 → 预检对话框拒绝并给建议

## 七、涉及文件清单

| 类别 | 文件 | 改动类型 |
|---|---|---|
| Canon 新模块 | `src/services/continuation/canon/adaptiveBatchPlanner.ts` | 新增 |
| Canon 核心 | `src/services/continuation/canon/canonAnalysisService.ts` | 修改（删除 `planAnalysisTokenBudget` / `resolveContextDrivenChaptersPerBatch` / `resolveCanonChapterTextLimit`，新增 `planAdaptiveBatching` 调用；`extractMaterialWithLlm` 接收派生参数；新增 chunk 结果合并） |
| Canon Prompt | `src/services/continuation/canon/extractionPromptSpec.ts` | 修改（新增 chunk metadata 说明） |
| Canon UI 预检 | `src/screens/continuation/ContinuationHomeScreen.tsx` | 修改（新增预检对话框） |
| 导入 UI | `src/screens/continuation/ContinuationSourceChaptersScreen.tsx` | 修改（批量循环改造 + 错误提示） |
| 导入 UI | `src/screens/continuation/ContinuationSourceOrderingScreen.tsx` | 修改（sampling 失败提示） |
| 错误工具 | `src/services/continuation/errorMessaging.ts` | 新增 |
| 测试 | `__tests__/adaptiveBatchPlanner.test.ts` | 新增 |
| 测试 | `__tests__/canonAnalysisChunkMerge.test.ts` | 新增 |
| 测试 | `__tests__/continuationImportErrorHandling.test.ts` | 新增 |
| 测试 | `__tests__/canonAnalysisPrecheck.test.ts` | 新增 |
| Schema | 无改动 | — |

## 八、兼容性与回滚

- 不改 Schema 版本（仍是 Schema 21）
- 不改 `continuation_analysis_batches` / `continuation_analysis_work_items` 表结构
- 已存在的 `continuation_analysis_runs.checkpoint_json` 字段新增 `adaptiveBatchPlan` 子对象，老 checkpoint resume 时回退到单 chunk 重算
- 回滚：还原 `canonAnalysisService.ts` 与新增文件即可，无 Schema 不可逆变更

## 九、发版计划

1. 实施所有改动
2. `npm run verify` 通过
3. `npm run apk:release` 构建正式 APK
4. 真机回归（按 6.4 场景）
5. commit & push 主分支

版本号：根据 `package.json` 当前版本递增 patch（预计 V2.11.8）
