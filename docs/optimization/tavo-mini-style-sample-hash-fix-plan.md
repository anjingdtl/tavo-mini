# TAVO-MINI 原著风格样本 Hash 校验失败定位与修复方案

> 本地项目目录：`D:\AiWorkSpace\tavo-mini`  
> 目标模块：原著分析 → 原著写作风格分析  
> 典型错误：`风格样本 hash 校验失败：chapter 444 [65648, 65692)`  
> 适用现象：Canon 五维分析可能已经完成，但在 `style_analysis` 阶段失败；点击“单独重试”后仍重复失败。  
> 远端参考基线：审查时默认分支 HEAD 为 `0c90b2119cb7d161e48e8b612a926f9e4d2cd69b`。施工时必须以本地实际 HEAD 和最新 `origin/main` 为准。

---

## 1. 问题定义

当前风格分析流程会：

1. 通过 `continuationSourceReader.listBoundedSourceChapters()` 读取边界内章节；
2. 从返回的 `chapter.content` 中确定性抽取风格样本；
3. 对样本文本计算 `contentHash`；
4. 再通过 `continuationSourceReader.readBoundedEvidenceRange()` 按全书 UTF-16 绝对偏移回读同一区间；
5. 对回读文本重新计算 SHA-256；
6. 如果两次哈希不一致，终止风格分析。

错误：

```text
风格样本 hash 校验失败：chapter 444 [65648, 65692)
```

说明：

- 失败发生在 LLM 调用之前；
- 不是模型、网络、JSON 或输出 Token 导致；
- `chapter 444` 是数据库章节 ID，不一定是第 444 章；
- `[65648, 65692)` 是全书 UTF-16 绝对字符区间；
- 采样阶段看到的文本与 SourceReader 二次回读看到的文本不一致；
- 当前完整性保护正确阻止了错误风格画像激活，修复时绝对不能绕过 Hash 校验。

---

## 2. 本轮修复目标

必须达成：

1. 能在本地真实数据库中稳定复现并输出可比较的两段文本；
2. 准确判断差异属于：
   - chunk 内容损坏；
   - chunk 偏移错误；
   - UTF-16 代理对边界问题；
   - chapter range 元数据错误；
   - 章节编辑后范围不一致；
   - SourceReader 跨 chunk 拼接错误；
   - 导入恢复或多文件边界错误；
   - 其他可证明原因；
3. 修复导入、存储、回读或章节元数据的根因；
4. 对已有损坏数据给出明确检测和恢复方案；
5. 保持样本 Hash 强校验，不允许降级为 warning；
6. 新增真实 SQLite 和 Android 回归测试；
7. 单独重试在源数据健康时可以成功；
8. 源数据损坏时，应在分析开始前给出明确可操作错误，而不是到风格阶段才失败。

---

## 3. 禁止事项

禁止通过以下方式“修复”：

- 删除或跳过 `sha256Hex(text) !== ref.contentHash` 校验；
- 捕获 Hash 错误后继续调用 LLM；
- 把错误改成 warning 后激活 Canon 或风格画像；
- 直接使用采样时缓存的正文，绕过 SourceReader 二次回读；
- 修改 Hash 算法让两个错误字符串碰巧一致；
- 只扩大重试次数；
- 点击失败后随机更换样本；
- 重新导入作为唯一处理方式而不修复根因；
- 只增加 Mock 测试；
- 依赖 SQLite `length(content)` 判断 UTF-16 长度；
- 破坏已有 Canon、续写 V5、pending review、备份恢复或导入恢复逻辑。

---

## 4. 开工前预检

在项目根目录执行：

```powershell
cd D:\AiWorkSpace\tavo-mini

git status --short
git branch --show-current
git rev-parse HEAD
git log --oneline -15
git remote -v
git fetch origin
git rev-parse origin/main
git rev-list --left-right --count origin/main...HEAD
git diff --stat origin/main...HEAD

node --version
npm --version
```

要求：

- 不得执行 `git reset --hard`；
- 不得清理用户未提交文件；
- 不得覆盖本地已有改造；
- 记录本地 HEAD、远端 HEAD、ahead/behind；
- 若本地已经比远端更新，优先审查本地实际实现；
- 当前远端文档、Schema 或版本号可能已变化，不得机械依赖旧数字；
- 先新建修复分支，例如：

```powershell
git switch -c fix/style-sample-hash-integrity
```

---

## 5. 相关代码链路

优先检查：

```text
src/services/continuation/styleProfile/styleAnalysisService.ts
src/services/continuation/styleProfile/styleSampler.ts
src/services/continuation/continuationSourceReader.ts
src/services/continuation/continuationSourceRepository.ts
src/services/continuation/continuationImportService.ts
src/services/continuation/continuationNormalizer.ts
src/services/continuation/continuationParser.ts
src/services/continuation/continuationEditLog.ts
src/services/continuation/hashUtils.ts
android/app/src/main/java/com/shinewriter/ContinuationTextImportModule.kt
```

测试重点：

```text
__tests__/styleAnalysis.test.ts
__tests__/styleSampler.test.ts
__tests__/continuationSourceReader.test.ts
__tests__/continuationHashStream.test.ts
__tests__/continuationNormalizer.test.ts
__tests__/continuationParser.test.ts
__tests__/continuationImport*.test.ts
```

搜索命令：

```powershell
rg -n "风格样本 hash 校验失败|readBoundedEvidenceRange|contentHash|char_start_offset|char_end_offset|content_start_offset|source_end_offset|CHUNK_CHAR_TARGET|applyParsingEdits" src android __tests__
```

---

## 6. 第一阶段：建立真实诊断证据

### 6.1 不要先改生产逻辑

先复现当前错误，并获得设备数据库或备份数据库。

优先方式：

1. 使用应用现有备份功能导出数据库；
2. 或使用 Android 调试工具从应用私有目录提取数据库；
3. 或在开发构建中增加受控诊断导出；
4. 不要把用户原著正文提交到 Git；
5. 诊断日志只输出 ID、offset、长度、Hash、UTF-16 边界码元；
6. 如必须展示文本，只输出差异附近极短片段并脱敏。

### 6.2 定位活动源与失败章节

```sql
SELECT
  st.project_id,
  st.active_source_id,
  st.boundary_chapter_id,
  st.boundary_char_offset_global,
  s.version,
  s.normalized_sha256,
  s.normalized_char_count,
  s.parser_version,
  s.normalization_version
FROM continuation_settings st
JOIN continuation_sources s ON s.id = st.active_source_id
WHERE st.project_id = :project_id;
```

查询失败章节：

```sql
SELECT
  id,
  source_id,
  position,
  title,
  source_start_offset,
  content_start_offset,
  source_end_offset,
  char_count,
  content_sha256,
  is_excluded
FROM continuation_source_chapters
WHERE id = 444;
```

确认：

```text
content_start_offset <= 65648
65692 <= source_end_offset
```

如果不满足，优先判定为 sample ref 或 chapter range 错误。

### 6.3 查询覆盖失败区间的 chunk

```sql
SELECT
  source_id,
  chunk_index,
  char_start_offset,
  char_end_offset,
  content,
  content_sha256,
  file_index
FROM continuation_source_text_chunks
WHERE source_id = :active_source_id
  AND char_start_offset < 65692
  AND char_end_offset > 65648
ORDER BY char_start_offset ASC;
```

同时查询目标 chunk 前后各两块。

### 6.4 增加临时 TypeScript 诊断函数

建议输出：

```ts
interface ChunkIntegrityDiagnostic {
  chunkIndex: number;
  declaredStart: number;
  declaredEnd: number;
  declaredUtf16Length: number;
  actualUtf16Length: number;
  storedHash: string;
  actualHash: string;
  lengthMatches: boolean;
  hashMatches: boolean;
  firstCodeUnit: string | null;
  lastCodeUnit: string | null;
  startsWithLowSurrogate: boolean;
  endsWithHighSurrogate: boolean;
}
```

核心检查：

```ts
const declaredUtf16Length =
  row.charEndOffset - row.charStartOffset;

const actualUtf16Length = row.content.length;
const actualHash = sha256Hex(row.content);
```

必须检查：

```text
declaredUtf16Length === actualUtf16Length
storedHash === actualHash
```

代理对辅助函数：

```ts
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
```

### 6.5 直接比较两条读取路径

```ts
const chapter = chapters.find(item => item.id === 444);
if (!chapter) throw new Error('未找到失败章节');

const localStart = 65648 - chapter.range.start;
const localEnd = 65692 - chapter.range.start;

const samplePathText = chapter.content.slice(localStart, localEnd);

const sourceReaderText =
  await continuationSourceReader.readBoundedEvidenceRange({
    snapshot,
    start: asUtf16Offset(65648),
    end: asUtf16Offset(65692),
  });

const diagnostic = {
  chapterId: chapter.id,
  chapterPosition: chapter.position,
  chapterRange: chapter.range,
  localStart,
  localEnd,
  sampleLength: samplePathText.length,
  readerLength: sourceReaderText.length,
  sampleHash: sha256Hex(samplePathText),
  readerHash: sha256Hex(sourceReaderText),
  same: samplePathText === sourceReaderText,
  firstDifferentIndex: findFirstDifference(
    samplePathText,
    sourceReaderText,
  ),
};
```

```ts
function findFirstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  }
  return a.length === b.length ? -1 : n;
}
```

输出差异位置附近最多 16 个 UTF-16 码元的十六进制值，不输出长原文。

### 6.6 检查整章一致性

```ts
const rereadChapter =
  await continuationSourceReader.readBoundedEvidenceRange({
    snapshot,
    start: chapter.range.start,
    end: chapter.range.end,
  });

assert(rereadChapter.length === chapter.content.length);
assert(sha256Hex(rereadChapter) === sha256Hex(chapter.content));
```

再核实 `continuation_source_chapters.content_sha256` 的字段语义，确认它是否是正文 Hash。不得在语义未确认前直接用它修复数据。

### 6.7 检查章节编辑路径

重点检查：

- 重命名；
- 合并章节；
- 拆分章节；
- 排除章节；
- 重置识别结果。

核对 `applyParsingEditsToJob()` 是否：

- 对拆分后新增章节执行 INSERT；
- 对合并后减少章节执行 DELETE；
- 正确重排 position；
- 正确重算 source/content offset；
- 正确重算真实正文 Hash；
- 不会只对原有 position 做 UPDATE。

如果用户执行过合并或拆分，该路径必须列为首要嫌疑。

---

## 7. 根因分类与处理决策

### A. Chunk 声明长度与实际 UTF-16 长度不一致

判定：

```text
char_end_offset - char_start_offset != content.length
```

检查导入写入、Android 到 JS 传输、SQLite TEXT、代理对边界、恢复路径。

### B. Chunk 存储 Hash 不一致

判定：

```text
content_sha256 != sha256Hex(content)
```

检查 Hash 输入是否与写入正文完全相同、参数是否错位、恢复是否复用旧元数据。

### C. 相邻 Chunk 元数据连续但正文不连续

检查 native `bytesConsumed`、多字节字符尾段、UTF-16 对齐、多文件边界、CR/LF 归一化、pending surrogate 和 pending CR。

### D. Chapter range 不正确

检查 streaming parser offset、文件末尾无换行、CRLF 跨块、volume heading、超长行和编辑写回。

### E. SourceReader 跨 Chunk 切片错误

在 chunk 本身健康时检查：

```ts
localStart = start - chunk.charStartOffset;
localEnd = end - chunk.charStartOffset;
```

同时检查查询排序、gap、overlap 和最终长度。

### F. 章节编辑持久化错误

如果拆分或合并后才出现，应重构编辑持久化，不能只按已有 position UPDATE。

### G. 旧版本数据已经损坏

新增完整性扫描。能证明正文权威数据健康时可重建 chapter metadata；不能证明时必须要求重新导入。

---

## 8. 推荐正式修复设计

以下内容按实证根因选择，不得无证据全部乱改。

### 8.1 新增统一源完整性验证器

建议新增模块：

```text
src/services/continuation/sourceIntegrity/
```

核心类型：

```ts
export interface ContinuationSourceIntegrityIssue {
  code:
    | 'chunk_offset_gap'
    | 'chunk_offset_overlap'
    | 'chunk_length_mismatch'
    | 'chunk_hash_mismatch'
    | 'chunk_surrogate_boundary'
    | 'chapter_range_invalid'
    | 'chapter_content_mismatch'
    | 'boundary_invalid';
  sourceId: number;
  chunkIndex?: number;
  chapterId?: number;
  start?: number;
  end?: number;
  detail: string;
}

export interface ContinuationSourceIntegrityReport {
  ok: boolean;
  checkedChunkCount: number;
  checkedChapterCount: number;
  issues: ContinuationSourceIntegrityIssue[];
}
```

快速检查用于分析启动：

- chunk offset 连续；
- 声明长度等于 `content.length`；
- stored Hash 等于实际 Hash；
- chapter range 合法；
- boundary 合法。

深度检查用于导入确认和诊断：

- 每章重新从 chunk 回读；
- chapter content 与范围一致；
- 跨 chunk 探针一致；
- 必要时复算 source normalized hash。

### 8.2 Chunk 切分避免拆开代理对

如果证实代理对边界相关：

```ts
export function adjustUtf16ChunkEnd(
  text: string,
  proposedEnd: number,
): number {
  let end = Math.max(0, Math.min(proposedEnd, text.length));

  if (end > 0 && end < text.length) {
    const left = text.charCodeAt(end - 1);
    const right = text.charCodeAt(end);

    if (isHighSurrogate(left) && isLowSurrogate(right)) {
      end -= 1;
    }
  }

  return end;
}
```

要求：

- 不产生空 chunk；
- `char_end_offset = start + slice.length`；
- 下一块从真实 `slice.length` 继续；
- 不按固定目标值盲目推进 cursor；
- Normalizer、Hash 和 SQLite 使用同一字符串。

### 8.3 强化导入完成验证

进入 `needs_review` 前必须验证：

1. offset 连续；
2. 每块 `content.length` 与声明长度一致；
3. 每块 Hash 一致；
4. 最后一块 end 等于 normalizedCharCount；
5. 跨块探针回读一致；
6. chapter ranges 全部合法；
7. boundary 合法。

失败时 import job 标记 failed，新源不得激活。

### 8.4 SourceReader 自校验

`readTextRange()` 应校验：

```text
第一块覆盖 start
相邻块无 gap/overlap
最后一块覆盖 end
每块真实长度与元数据一致
最终 result.length == end - start
```

发现错误抛专用异常：

```ts
class ContinuationSourceIntegrityError extends Error {
  code = 'continuation_source_integrity_failed';
}
```

### 8.5 风格分析错误传播

保留底层错误码：

```text
style_sample_hash_mismatch
source_integrity_failed
source_outdated
llm_transport_failed
style_schema_invalid
```

确定性源损坏不应提示“稍后重试”，而应引导检查或重新导入。

### 8.6 修复章节编辑持久化

若确认 merge/split 有问题，建议事务内重建最终 chapter rows：

```text
读取 staging source 原始章节
应用编辑得到 final chapters
验证 final ranges
删除该 source 现有 chapter rows
按最终顺序重新 INSERT
重算 position/range/真实正文 Hash
验证无重叠和越界
提交
```

如果 ID 有外键依赖，先核实引用关系；staging 阶段优先允许重建。

---

## 9. 旧数据处理策略

### 不允许盲目自愈

以下情况不得自动改 offset 或 Hash：

- chunk Hash 错；
- chunk 实际长度小于声明长度；
- normalized source Hash 无法复现；
- 出现不可恢复替换字符；
- 无法判断丢失字符位置。

### 可以安全修复

仅当能够证明：

- chunk 内容拼接的 normalized Hash 等于 source Hash；
- 错误只在 chapter metadata；
- parser 版本明确；

才可在备份后重建章节索引。

### 必须重新导入

任一条件成立：

- chunk 正文 Hash 错；
- chunk 实际长度错；
- chunk gap/overlap 无法恢复；
- normalized Hash 无法复现；
- 导入路径已丢字符。

---

## 10. 测试计划

### 10.1 单元测试

覆盖：

- 普通 CJK chunk；
- ASCII；
- emoji；
- 扩展汉字；
- chunk 切点位于代理对中间；
- 无空 chunk；
- 拼接结果等于原文；
- offset gap/overlap；
- 声明长度错误；
- Hash 错误；
- chapter 越界；
- boundary 越界。

### 10.2 真实 SQLite 测试

不能只 Mock。

创建临时真实 SQLite 数据库，写入：

```text
正文长度 > 65536 UTF-16 单元
65536 附近含 emoji
多个章节
章节跨两个以上 chunk
样本位于 65536 之后
样本跨 chunk
```

断言：

```text
chapter.content 对应 slice
readBoundedEvidenceRange
直接 chunk 拼接结果
三者文本和 Hash 完全一致
```

还需覆盖数据库关闭重开、backup/restore、导入恢复和多文件导入。

### 10.3 章节编辑测试

覆盖：

- rename 不改 range；
- merge 后行数减少；
- split 后行数增加；
- position 连续；
- 旧行删除；
- 新行插入；
- 回读文本正确；
- 真实正文 Hash 正确；
- 编辑后风格样本校验通过。

### 10.4 风格分析集成测试

新增真实链路：

```text
真实 SQLite
→ SourceReader
→ styleSampler
→ readSampleSpans
→ hash reverify
```

模型调用可以 Mock，但数据库和 SourceReader 不得 Mock。

健康源应进入 LLM；损坏源应在 LLM 前失败，且不创建 ready profile、不激活 Canon。

### 10.5 Android 模拟器测试

验证：

1. UTF-8 大文件；
2. 65536 附近 emoji；
3. UTF-16LE/BE；
4. GB18030；
5. LF 与 CRLF；
6. 多文件；
7. 完整分析；
8. 快速分析；
9. 单独重试；
10. 重启后重试；
11. 备份恢复后重试；
12. merge/split 后分析。

测试文本必须为自动生成的无版权内容。

---

## 11. 故障注入样本

```ts
const target = 65536;
const prefix = '甲'.repeat(target - 1);
const emoji = '😀';
const suffix = '乙'.repeat(5000);

const text = [
  '第一章 测试',
  prefix + emoji + suffix,
  '第二章 继续',
  '丙'.repeat(10000),
].join('\n');
```

调整前缀长度，使拟切点分别落在代理对前、代理对中间和代理对后，建立三组测试。

---

## 12. 性能要求

完整性检查不能让每次打开页面都全量扫描。

建议：

- 导入确认：深度检查一次；
- 分析启动：快速完整性检查；
- SourceReader：局部连续性和结果长度断言；
- 可按 source fingerprint 与 integrity checker version 缓存结果；
- 源、边界、parser、normalizer 或 chunk 变化后缓存必须失效。

---

## 13. Schema 要求

是否新增 Schema 由实现决定。

如果新增完整性状态或审计表，必须：

1. 使用本地当前 `SCHEMA_VERSION + 1`；
2. 更新 migration；
3. 更新 registry；
4. 更新 `createCurrentSchema`；
5. 更新 `schemaManifest`；
6. 更新备份恢复；
7. 更新 fixture；
8. 增加 fresh install 和旧库升级测试。

如可不持久化，优先不增加 Schema。

---

## 14. 实施顺序

### P0-1：复现与证据

- 获取失败数据库；
- 定位 source/chapter/chunk；
- 比较两条读取路径；
- 输出 first difference；
- 检查 65536 附近代理对；
- 检查 chunk length/hash。

### P0-2：先补失败测试

- 真实 SQLite 跨 chunk；
- 代理对边界；
- 损坏 chunk；
- 章节编辑。

### P0-3：修复根因

按证据修改 chunk 切分、native decoder、normalizer、parser、SourceReader 或 edit persistence。

### P0-4：增加完整性 Gate

- 导入确认；
- 分析启动；
- SourceReader 局部断言；
- 专用错误码。

### P1：旧数据与 UI

- 可安全重建 chapter metadata；
- 不可修复时提示重新导入；
- 单独重试保留详细错误；
- 确定性损坏不建议反复重试。

### P1：回归

- Canon；
- 风格画像；
- 激活；
- AI 续写；
- pending review；
- 备份恢复；
- 导入恢复。

---

## 15. 验收标准

### 数据正确性

- 每个 chunk 的声明长度等于 `content.length`；
- 每个 chunk 的 stored Hash 等于实际 Hash；
- 任意合法范围回读长度精确等于 `end - start`；
- 跨 chunk 回读与完整文本 slice 完全一致；
- chapter.content 与相同绝对范围回读一致；
- 风格样本 Hash 二次校验稳定通过；
- 源损坏时绝不调用 LLM；
- 源损坏时绝不激活风格画像或 Canon。

### 行为

- 单独重试不吞掉可操作错误；
- 可重试和不可重试错误明确区分；
- 重新导入健康源后正常完成；
- 完整分析和快速分析均正常衔接风格分析；
- 不改变两种 Canon 模式既定验收规则。

### 命令

```powershell
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
npm run apk:debug
```

还需单独报告：

```text
chunk安全切分测试
真实SQLite SourceReader测试
风格样本集成测试
导入恢复测试
多编码测试
章节编辑测试
备份恢复测试
Android模拟器测试
```

---

## 16. 最终交付报告

Agent 必须报告：

1. 本地开工 HEAD；
2. `origin/main` HEAD；
3. ahead/behind；
4. 未提交改动保护情况；
5. 复现步骤；
6. 失败数据库证据；
7. 两条读取路径的长度、Hash 和首个差异位置；
8. 根因结论；
9. 65536 边界是否相关；
10. 是否存在代理对拆分；
11. 是否存在章节编辑持久化错误；
12. 修改文件和关键函数；
13. 是否新增 Schema；
14. 旧数据处理策略；
15. 新增测试；
16. 全量验证结果；
17. Android 实机或模拟器结果；
18. 尚存风险；
19. 用户恢复步骤；
20. 不包含原著正文和敏感信息的诊断摘要。

---

# 附：可直接交给本地 Agent 的开工提示词

请在 `D:\AiWorkSpace\tavo-mini` 中定位并修复：

```text
风格样本 hash 校验失败：chapter 444 [65648, 65692)
```

完整方案：

```text
docs/optimization/tavo-mini-style-sample-hash-fix-plan.md
```

先完整阅读方案，再完成本地/远端预检。不要只输出审查建议，必须直接完成复现、诊断、代码修复、真实 SQLite 测试和 Android 验证。

关键要求：

- 不得绕过或放宽样本 Hash 校验；
- 必须获取真实设备数据库或备份数据库；
- 必须比较 `chapter.content.slice()` 与 `readBoundedEvidenceRange()`；
- 必须检查覆盖 `[65648,65692)` 的 chunk；
- 必须检查约 65536 UTF-16 chunk 边界；
- 必须检查 chunk 声明长度、实际 `content.length`、stored Hash 和实际 Hash；
- 必须检查代理对、SourceReader 跨块拼接、streaming import、parser offset 和 merge/split 持久化；
- 先补能稳定失败的真实 SQLite 测试，再改生产代码；
- 健康源必须成功；
- 损坏源必须在 LLM 调用前阻断；
- 单独重试不能吞掉详细错误；
- 不得破坏 Canon、续写 V5、pending review、导入恢复、备份恢复和激活原子性；
- 最终执行 lint、typecheck、版本校验、全量测试和 Android debug 构建；
- 完成后按第 16 节输出交付报告。

直接开工，不等待额外确认。
