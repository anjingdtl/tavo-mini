# ShineWriter 第二期工程收尾 PDCA 方案
## —— Resource Source Snapshot 同源冻结、Notes 降级可观测、Detail 强度与 Preview 语义收口

> 文档类型：第二期收尾建设 / 缺陷闭环 / Final Seal 前置方案  
> 执行模式：**PDCA 自审循环修复，持续迭代直到第二期剩余 NO-GO = 0**  
> 适用工程：ShineWriter / `anjingdtl/tavo-mini`  
> 编制日期：2026-08-13  
> 当前基线：第二期主体实现已接入 `main`，Context Budget V7 / Resource Context V2 / Pipeline Snapshot V4 已建立  
> 数据库基线：**SCHEMA_VERSION = 51，收尾阶段原则上不得升 52**  
> 兼容基线：V6 / Snapshot V3 旧任务继续按旧契约 Resume，不自动升级

---

# 0. 一句话目标

本收尾阶段**不再扩展第二期能力边界**，只修复远端验收中暴露出的冻结一致性、Notes 异常可观测性、Detail 强度有效性与 Preview 状态语义问题，并通过自动化测试、故障注入、Android 实机/模拟器复验和独立第二视角审查，将第二期从“主体能力已完成”推进到：

> **同一次 V7 Context Build 中，Character / Worldbook / Notes / Preset 必须来自同一冻结源视图；任何允许软降级的读取失败都必须可观测；节省/均衡/丰富必须真实影响 Detail 分配；Preview 必须准确描述最终实际注入状态；最终第二期剩余 NO-GO = 0。**

---

# 1. 当前状态与收尾原因

第二期主体方向已成立，当前已经具备：

- Global Awareness；
- Elastic Detail；
- Character Awareness；
- Worldbook Awareness；
- Preset Pipeline Stage Binding；
- Context Budget V7；
- Resource Context V2；
- Pipeline Snapshot V4；
- Draft / Review / FactCheck / Brief / Proof 冻结视图消费；
- V6 / Snapshot V3 Legacy Resume 兼容；
- Schema 51 保持不变；
- GitHub CI、Migration、JavaScript Validation、Jest、Android Debug Build 已可通过。

但最终远端代码级验收发现，当前实现仍存在以下必须在封板前闭环的问题。

---

# 2. 收尾问题清单

## NG-01：Notes 没有完全消费同一份 Resource Source Snapshot

### 当前风险

V7 构建已经先执行 `captureResourceSourceSnapshot()`，并冻结：

- Characters；
- Worldbook Entries；
- Notes；
- Preset。

但后续 Detail 构建路径又存在：

```ts
buildResourceContextV2({
  source: { ...source, notes: [] },
})
```

随后再调用旧的：

```ts
collectNoteCandidates(...)
```

重新读取数据库。

这会产生第二期方案明确禁止的版本撕裂：

```text
T0：第一次读取 Notes，Resource Source Snapshot 冻结为 Note A
T1：用户修改并保存 Note
T2：后续 Detail 再读数据库，得到 Note B
T3：同一次 build 中 Snapshot / fingerprint 描述 A，但实际 Detail 注入 B
```

### 定性

**P0 / NO-GO。**

### 收尾目标

在 V7 下：

> **Resource Source Snapshot 一旦捕获完成，本次 Context Build 的所有资源派生步骤不得再读取 Character / Worldbook / Notes / Preset 的实时数据库状态。**

Notes Detail 必须直接从：

```ts
source.notes
```

派生。

---

## NG-02：Notes 读取失败存在静默吞错

### 当前风险

Notes 列表读取、Notes 正文批量读取、后续旧 Notes Candidate 读取存在软降级路径，但失败后可能直接变为空数组 / 空正文，而没有稳定 Trace Warning。

这会混淆两种完全不同的状态：

```text
项目本来没有 Notes
```

与：

```text
项目存在 Notes，但这次读取失败
```

### 定性

**P0 / NO-GO。**

### 收尾目标

Notes 仍属于 Elastic Detail，可保持软降级策略，但必须满足：

```text
读取失败
→ 允许继续生成
→ 不破坏 Character / Worldbook Global Awareness
→ 必须产生结构化 Warning
→ Warning 必须进入 Context Trace / Preview
→ Final Pipeline Snapshot 不得伪造不存在的 Note 内容
```

禁止：

```ts
catch {
  // ignore
}
```

这种完全不可观测的吞错方式。

---

## NG-03：`rich` Detail 强度被最终预算计算抹平

### 当前风险

目前强度映射类似：

```text
save      = 0.55
balanced  = 1.00
rich      = 1.15
```

但最终 V7 demand 若继续使用：

```ts
detailDemandTokens * Math.min(intensity, 1)
```

则：

```text
balanced = 1.00
rich     = 1.00
```

用户选择“丰富”不会在最终 allocator 上获得比“均衡”更多的 Detail 争取能力。

### 定性

**P1，封板前必须修复。**

### 收尾目标

保证：

```text
save < balanced < rich
```

不仅在映射函数层成立，而且在**最终 V7 allocator 结果层**成立。

---

## NG-04：Note 未注入时 Preview 状态不应显示 AWARENESS_ONLY

### 当前风险

Character / Worldbook 有 Global Awareness，因此：

```text
没有 Detail，但 Awareness 已注入
→ AWARENESS_ONLY
```

语义成立。

Notes 没有 Global Awareness 层。

因此：

```text
Note Detail 未获得预算 / 未激活 / 未注入
```

不能显示：

```text
AWARENESS_ONLY
```

否则 UI 会暗示该 Note 仍以某种全局摘要方式进入上下文，但实际上没有。

### 定性

**P1，封板前必须修复。**

---

# 3. 第二期收尾边界

本轮只做“工程收尾”，不是第三期。

## 3.1 必须做

1. Notes 同源冻结；
2. Notes 软降级 Warning；
3. V7 Detail 强度真实生效；
4. Preview / Trace 状态语义修正；
5. 对上述行为补齐故障注入测试；
6. 补齐 Context Build → Snapshot → Resume 一致性测试；
7. Android Preview / 配置 / Resume 关键路径复验；
8. 重新执行完整 CI / Migration / Android Build；
9. 独立第二视角复审；
10. 更新第二期 Final Seal。

## 3.2 明确不做

本收尾阶段禁止顺手扩展：

- 新数据库表；
- Schema 52；
- 新 Resource 类型；
- 新 Pipeline Stage；
- 新 Story Memory 协议；
- Canon 新语义；
- Outline 新运行时协议；
- 第三期检索架构；
- Embedding / Vector DB；
- RAG 重构；
- Notes Global Awareness；
- 多级 Note 摘要体系；
- Preset 新持久化格式；
- Context Budget V8；
- Resource Context V3；
- Pipeline Snapshot V5；
- V6/V3 旧任务自动升级；
- 重新设计整个资源候选系统；
- 与本轮 NO-GO 无关的大规模 UI 改版。

---

# 4. 封板不变量

整个收尾过程中必须持续保持：

```text
SCHEMA_VERSION = 51
Context Budget 新任务版本 = 7
Resource Context Version = 2
Pipeline Snapshot Version = 4
V6 Legacy Resume 保持旧路径
Snapshot V3 不自动升级为 V4
Preset 不受 includeResources=false 控制
Character / Worldbook Global Awareness 仍属于保护区
Awareness 超预算继续 fail-closed
Notes 继续属于 Elastic Detail，而不是 Global Awareness
```

不得因为修 Notes 而破坏第二期已经成立的主体契约。

---

# 5. 目标运行时模型

修复后，V7 Context Build 应形成如下唯一数据流：

```text
Live DB / Repository
        │
        ▼
captureResourceSourceSnapshot()
        │
        ├── Characters FrozenSourceRecord[]
        ├── Worldbook FrozenSourceRecord[]
        ├── Notes FrozenSourceRecord[]
        └── Preset FrozenSourceRecord
        │
        ▼
ResourceSourceSnapshot
        │
        ├── Character Awareness Compiler
        ├── Character Detail Renderer
        ├── Worldbook Awareness Compiler
        ├── Worldbook Detail Activator
        ├── Note Detail Candidate Compiler
        └── Preset Context Compiler
        │
        ▼
Context Budget V7 Allocator
        │
        ├── Mandatory: protocol / outline / awareness / preset 等既有强约束
        └── Elastic: character detail / worldbook detail / note detail
        │
        ▼
Frozen Resource Items
        │
        ▼
Pipeline Snapshot V4
        │
        ├── Draft
        ├── Review
        ├── FactCheck
        ├── Brief
        └── Proof
```

关键规则：

> **从 `ResourceSourceSnapshot` 往下禁止再读资料数据库。**

---

# 6. Notes 同源冻结建设方案

## 6.1 删除 V7 Notes 二次实时读取

V7 分支不得继续使用：

```ts
collectNoteCandidates(projectId, ...)
```

去重新读取 Notes。

可以保留该函数供：

- V6 legacy；
- 非 V7 旧路径；
- 其他明确仍采用实时旧候选模型的兼容代码。

但 V7 必须改为：

```text
source.notes
→ parse frozen note payload
→ score / classify / render
→ ResourceDetailCandidate[]
```

---

## 6.2 新建或抽取纯函数 Note Detail Compiler

推荐形成纯函数：

```ts
compileNoteDetailCandidatesFromSnapshot(...)
```

或等价命名。

输入只允许：

```ts
ResourceSourceSnapshot.notes
+
Frozen haystack
+
ContextConfig 中与 Notes Detail 有关的配置
```

不得接收：

```ts
projectId
database
repository
live note loader
```

建议接口：

```ts
interface NoteDetailCompileInput {
  notes: FrozenSourceRecord[];
  haystack: {
    title: string;
    synopsis: string;
    currentBody: string;
    userPrompt: string;
    previousChapters: string;
    storyMemory: string;
    outline: string;
    episodic: string;
  };
}
```

输出：

```ts
interface NoteDetailCompileResult {
  candidates: ResourceDetailCandidate[];
  totalActualTokens: number;
  styleNotePresent: boolean;
  warnings: ResourceContextWarning[];
}
```

---

## 6.3 保留既有 Notes 语义

收尾不是重写 Notes 产品逻辑。

应尽量保持当前行为：

- 普通 Note 作为可选 Detail；
- 风格画像 / 仿写 Note 保持低优先级补充；
- 风格 Note 不得覆盖选中的 Preset；
- Notes 不加入 Global Awareness；
- Notes 继续参与 Detail allocator；
- 原有显式选中、标题、正文、检索分数等语义若可从冻结 payload 恢复，应继续保留。

---

## 6.4 Frozen Note 必须携带真实正文

`freezeNote()` 必须确保最终 `payload` 中保存的是本次快照真实可用的正文。

如果 Notes 元信息与正文分开读取，则必须在 Snapshot Capture 阶段完成合并：

```text
note row
+
note content
→ FrozenSourceRecord.payload
```

从 Snapshot 返回后不得再补正文。

---

# 7. Notes 读取异常与 Warning 设计

## 7.1 原则

Character / Worldbook Global Awareness 是强一致性骨架。

因此相关核心读取失败仍按现有策略：

```text
fail-closed
```

Notes 属于可选 Elastic Detail。

因此：

```text
Notes 读取失败
→ soft degrade
→ Warning
```

---

## 7.2 建议 Warning 契约

推荐使用结构化类型，而不是散落字符串：

```ts
type ResourceContextWarningCode =
  | 'NOTE_LIST_READ_FAILED'
  | 'NOTE_CONTENT_READ_FAILED'
  | 'NOTE_DETAIL_COMPILE_FAILED';
```

例如：

```ts
interface ResourceContextWarning {
  code: ResourceContextWarningCode;
  sourceKind: 'note';
  sourceId?: number | null;
  title?: string;
  message: string;
  action?: 'open_resources' | 'retry' | 'none';
}
```

若希望最小改动，也至少保证有稳定 code + message，不得只有日志。

---

## 7.3 Warning 传递链

Warning 必须完整传播：

```text
captureResourceSourceSnapshot
        ↓
Phase2BudgetResources
        ↓
buildResourceSelectionTrace / Context Trace
        ↓
Context Preview
```

至少在 Preview 中让用户能区分：

```text
没有 Note
```

和：

```text
Note 本轮读取失败，已跳过
```

---

## 7.4 列表读取失败

当：

```ts
getNotesByProject(projectId)
```

失败：

允许：

```text
notes = []
```

但必须同时生成：

```text
NOTE_LIST_READ_FAILED
```

不得静默。

---

## 7.5 正文批量读取失败

当：

```ts
getNotesContentByIds(ids)
```

整体失败：

可以将相应 Note Detail 跳过，或仅使用明确存在于 row 中且可信的正文。

但必须生成：

```text
NOTE_CONTENT_READ_FAILED
```

禁止把正文读取失败的 Note 当成“正文为空的合法 Note”继续无提示处理。

---

## 7.6 单条异常

若某一条 Frozen Note payload 无法解析或 Detail 编译失败：

```text
跳过该 Note Detail
+
NOTE_DETAIL_COMPILE_FAILED
+
其他资料继续
```

不得因为单条可选 Note 损坏而破坏 Character / Worldbook Awareness。

---

# 8. Resource Source Snapshot 一致性加强

## 8.1 同源判定仍使用 fingerprint

保留现有：

```text
第一次完整读取
第二次完整读取
fingerprint 相同 → 使用第一份
不同 → 第三次读取
第二、第三相同 → 使用第二份
持续变化 → RESOURCE_SOURCE_CHANGED_DURING_BUILD
```

但必须保证参与 fingerprint 的数据与真正派生 Detail 的数据完全相同。

尤其 Notes：

```text
fingerprint 的正文
==
Detail compiler 实际使用的正文
```

---

## 8.2 禁止“冻结指纹 + 实时正文”

以下状态必须通过测试明确禁止：

```text
Frozen fingerprint = Note A
Injected content   = Note B
```

---

## 8.3 数据库读取次数验收

针对一次 V7 `buildContext()`：

在 Snapshot Capture 完成后，对以下读取函数建立调用次数断言：

```text
getCharactersByProject
getWorldbookEntriesByProject
getNotesByProject
getNotesContentByIds
```

允许 Snapshot 自身为了稳定视图执行规定次数的读取。

但进入：

```text
buildResourceContextV2
allocator
freeze details
compile stage request
```

后不得再次读取上述资料源。

---

# 9. Detail 强度修复方案

## 9.1 产品语义

用户只需要理解：

```text
节省
均衡
丰富
```

其含义：

### 节省

- Global Awareness 完整；
- Detail 更克制；
- 更优先保留核心角色 / 高相关世界书 / 高价值 Note；
- 为 Story Memory、Recent、Episodic 等保留更多空间。

### 均衡

- Global Awareness 完整；
- Detail 与其他上下文板块平衡。

### 丰富

- Global Awareness 完整；
- 在模型窗口允许时，给相关 Character / Worldbook / Notes Detail 更积极的预算；
- 不能突破 Hard Input Limit；
- 不能挤掉强制区；
- 不能改变 Awareness 的保护语义。

---

## 9.2 实现要求

禁止再用会抹平 rich 的计算：

```ts
Math.min(intensity, 1)
```

建议改为让 intensity 真正作用于：

```text
resource board target demand
```

或：

```text
detail item target / relevance / burst preference
```

但必须满足：

```text
hard cap 仍由 allocator / hard input limit 控制
```

不是直接允许无限超预算。

---

## 9.3 强度验收标准

对同一组候选、同一个 contextWindow、同一 reserved output：

```text
allocatedDetail(save)
<
allocatedDetail(balanced)
<=
allocatedDetail(rich)
```

当候选足够多、窗口存在竞争时，必须至少存在稳定测试场景满足：

```text
allocatedDetail(save)
<
allocatedDetail(balanced)
<
allocatedDetail(rich)
```

不能只测试：

```ts
intensityToDetailSoftRatio('rich') >
intensityToDetailSoftRatio('balanced')
```

必须测试最终 allocator。

---

# 10. Preview / Trace 状态语义修复

## 10.1 Character / Worldbook

继续使用：

```text
AWARENESS_ONLY
DETAIL_FULL
DETAIL_CLIPPED
DISABLED
ERROR
```

其中：

```text
AWARENESS_ONLY
```

仅适用于：

> Global Awareness 已经进入上下文，但该资源本轮没有 Detail。

---

## 10.2 Notes

Notes 没有 Global Awareness，因此必须增加或复用准确状态。

推荐新增：

```ts
NOT_SELECTED
```

或：

```ts
DETAIL_OMITTED
```

二选一即可，避免扩大状态数量。

建议最终：

```ts
type ResourcePreviewStatus =
  | 'AWARENESS_ONLY'
  | 'DETAIL_FULL'
  | 'DETAIL_CLIPPED'
  | 'NOT_SELECTED'
  | 'DISABLED'
  | 'ERROR';
```

Notes：

```text
有 Detail 且完整 → DETAIL_FULL
有 Detail 但裁剪 → DETAIL_CLIPPED
候选存在但没注入 → NOT_SELECTED
读取/编译异常 → ERROR
includeResources=false → DISABLED
```

---

## 10.3 Warning UI

若 Notes 读取失败：

Preview 至少展示：

```text
笔记资料本轮读取失败，已跳过，不影响角色/世界书全局设定。
```

不要弹成阻断式错误，除非异常影响到 Global Awareness 强制区。

---

# 11. Pipeline Snapshot V4 收尾要求

修复必须保证：

```text
第一次 build
→ Source Snapshot
→ Awareness / Detail
→ Frozen Pipeline Snapshot V4
```

之后：

```text
Review
FactCheck
Brief
Proof
Resume
```

只消费冻结结果。

不得因为 Notes 修复而让下游阶段重新查询 Note DB。

---

## 11.1 Freeze / Resume 测试

必须补：

```text
Build 时 Note = A
Snapshot V4 冻结
用户把 Note 改成 B
Resume / Review
仍然看到 A
```

并校验：

```text
sourceFingerprint 仍对应 A
```

---

# 12. 必须新增的故障注入测试

以下测试属于收尾硬门槛。

## T-01 Notes Snapshot 后禁止二次读取

构造数据库 mock：

```text
第一次 Snapshot 读取 → Note A
后续若发生任何额外 Notes DB read → 返回 Note B 或直接 throw
```

期望：

```text
最终 Detail 只能是 Note A
后续数据库读取次数符合 Snapshot 设计
不会看到 Note B
```

---

## T-02 Snapshot 构建中 Note 发生变化

模拟：

```text
first snapshot  → A
second snapshot → B
third snapshot  → B
```

期望：

```text
选择稳定的 B
```

并且 Detail / fingerprint 均来自 B。

---

## T-03 Snapshot 持续变化

模拟：

```text
A → B → C
```

期望：

```text
RESOURCE_SOURCE_CHANGED_DURING_BUILD
LLM call count = 0
```

---

## T-04 Notes 列表读取失败

模拟：

```text
getNotesByProject throw
```

期望：

```text
Character Awareness 正常
Worldbook Awareness 正常
生成可继续
Trace 包含 NOTE_LIST_READ_FAILED
Preview 可见 Warning
```

---

## T-05 Notes 正文读取失败

模拟：

```text
getNotesByProject success
getNotesContentByIds throw
```

期望：

```text
不得伪装成“没有 Notes”
Trace 包含 NOTE_CONTENT_READ_FAILED
对应 Note 不注入错误/空 Detail
```

---

## T-06 单条 Note payload 异常

期望：

```text
单条 Note 跳过
其他 Detail 正常
Warning 可见
```

---

## T-07 Detail 强度最终分配

同一候选集：

```text
save / balanced / rich
```

比较最终：

```text
resource board grant
detail item allocations
frozen detail token total
```

必须证明 rich 与 balanced 在真实竞争场景下可产生差异。

---

## T-08 Preview Note 状态

构造 Note candidate 未获分配。

期望：

```text
NOT_SELECTED
```

不得：

```text
AWARENESS_ONLY
```

---

## T-09 Snapshot V4 Resume 不漂移

Build 后修改 live DB。

期望五阶段及 Resume 均继续消费原 Frozen Note。

---

## T-10 includeResources=false

期望：

```text
Character / Worldbook / Notes 均不进入上下文
Preset 仍然生效
不因为 Notes Warning 误报 ERROR
```

---

# 13. 回归测试矩阵

除新增测试外，以下旧能力必须继续通过。

## 13.1 Character

- 关系网络 Awareness；
- knowledge boundary；
- legacy character fallback；
- Detail activation；
- relation-neighbor boost；
- Awareness 不因 Detail 未命中消失；
- Character read failure fail-closed。

## 13.2 Worldbook

- constant；
- primary / secondary keyword；
- recursive detail；
- zero-hit fallback；
- Worldbook read failure fail-closed；
- 未命中 Detail 时仍有 Awareness。

## 13.3 Preset

- selected preset；
- default runtime baseline；
- `includeResources=false` 时 Preset 仍生效；
- preset fingerprint；
- Snapshot V4 stage binding。

## 13.4 Pipeline

- Draft；
- Review；
- FactCheck；
- Brief；
- Proof；
- Freeze；
- Resume；
- cold resume 兼容边界；
- Snapshot V3 legacy 不升级。

## 13.5 Budget

- 32K；
- 128K；
- 大窗口；
- Awareness mandatory；
- Detail elastic；
- hard input limit；
- reserved output；
- item allocation；
- clipped details。

---

# 14. Android E2E 收尾场景

必须在 Android 模拟器或真机至少复验以下场景。

## E2E-01 Notes 正常 Detail

准备：

```text
1 个角色
1 条世界书
2 条 Notes
1 个 Preset
```

Preview 检查：

```text
角色 Awareness
世界书 Awareness
Note Detail
Preset
```

并完成真实生成或至少共用正式 compile/send path 的 Preview 验证。

---

## E2E-02 节省 / 均衡 / 丰富

对同一章节切换三档。

期望 Preview 中：

```text
Global Awareness 不变
Detail 数量或 Detail token 使用趋势：
节省 < 均衡 <= 丰富
```

在构造的竞争场景中应看到“丰富”实际比“均衡”多展开 Detail。

---

## E2E-03 includeResources=false

期望：

```text
角色 / 世界书 / Notes 不进入
Preset 保留
Preview 显示 DISABLED
```

---

## E2E-04 Freeze / Resume

1. 生成新 V7 任务；
2. 冻结 Snapshot V4；
3. 修改角色 / 世界书 / Notes / Preset；
4. Resume；
5. 确认 Resume 继续使用原任务冻结视图。

---

## E2E-05 覆盖安装

继续采用：

```bash
adb install -r
```

禁止为了通过测试执行：

```bash
pm clear
uninstall
```

确认：

- 项目；
- 章节；
- 角色；
- 世界书；
- Notes；
- Presets；
- 旧任务；
- 新 V7 任务；

均保留。

---

# 15. CI / 构建硬门槛

每个 PDCA Round 结束至少运行相关子集。

最终必须全部执行：

```bash
npm ci
npm run lint
npm run typecheck
npm run test:ci
npm run verify
```

若项目脚本不同，以仓库实际脚本为准，但 Final Seal 必须记录真实命令。

还必须执行：

```text
Migration matrix
Android Debug build
必要的 Release / APK 验证（若当前仓库 Final Seal 规范要求）
```

---

# 16. PDCA 总执行规则

执行 Agent 必须：

> **一次读取完整方案 → 建立 NO-GO 台账 → 按 Round 持续 Plan / Do / Check / Act → 每轮修完立即自审 → 未达到 GO 不停止 → 最终再以独立第二视角从零复查。**

禁止：

- 只修测试不修生产代码；
- 修改 expected 值掩盖问题；
- skip / todo / only；
- 删除失败测试；
- 放宽硬契约；
- 将读取失败伪装为空数据；
- 为了过 E2E 清库；
- 直接修改 Final Seal 为 PASS 而没有新证据；
- 用一次外部模型抽样替代确定性编译/冻结测试。

---

# 17. PDCA Round 0：基线冻结与 NO-GO 建账

## Plan

确认当前：

```text
main HEAD
SCHEMA_VERSION
Context Budget Version
Resource Context Version
Pipeline Snapshot Version
最新 GitHub Actions
现有 Final Seal
```

建立：

```text
NG-01 Notes 同源冻结
NG-02 Notes 异常 Warning
NG-03 rich 强度失效
NG-04 Preview Note 状态错误
```

## Do

运行当前基线：

```text
lint
typecheck
相关 Jest
test:ci
```

保存初始日志。

## Check

确认这些问题能够从当前源码明确复现，而不是误判。

## Act

冻结本轮修改范围。

---

# 18. PDCA Round 1：关闭 NG-01 —— Notes 同源冻结

## Plan

目标：

```text
V7 Notes 只能从 ResourceSourceSnapshot.notes 派生
```

## Do

1. 抽取 Frozen Note → Detail Candidate 纯函数；
2. V7 删除 Notes 二次数据库读取；
3. 保留 V6 legacy 旧路径；
4. 确保 fingerprint 与实际正文一致；
5. 补 T-01 / T-02 / T-03。

## Check

代码搜索：

```text
V7
collectNoteCandidates
getNotesByProject
getNotesContentByIds
```

确认 Snapshot 以后不存在实时 Notes read。

运行相关测试。

## Act

若仍存在任何二次读取：

```text
NG-01 保持 OPEN
```

不得进入“已完成”状态。

---

# 19. PDCA Round 2：关闭 NG-02 —— Notes 异常可观测

## Plan

建立结构化 Warning 链。

## Do

1. Notes list read fail → Warning；
2. Notes content read fail → Warning；
3. 单条 compile fail → Warning；
4. Warning 传至 Trace；
5. Preview 渲染 Warning；
6. 补 T-04 / T-05 / T-06。

## Check

故障注入时确认：

```text
LLM 是否允许继续
Awareness 是否保持
Warning 是否存在
Preview 是否可见
```

## Act

只要存在：

```text
catch {}
```

导致用户和 Trace 都不知道失败，

则：

```text
NG-02 保持 OPEN
```

---

# 20. PDCA Round 3：关闭 NG-03 / NG-04

## Plan

只修两个收尾语义问题，不扩展产品。

## Do

### NG-03

让：

```text
save < balanced < rich
```

在最终 allocation 层生效。

### NG-04

修 Note 未注入状态：

```text
NOT_SELECTED
```

或同义明确状态。

补：

```text
T-07
T-08
```

## Check

验证：

```text
rich 不突破 hard limit
Awareness 不变化
Note 未注入不再冒充 Awareness
```

## Act

若仅映射函数不同、最终 allocator 没有实际差异：

```text
NG-03 仍 OPEN
```

---

# 21. PDCA Round 4：Freeze / Resume 与五阶段复验

## Plan

验证本轮修复没有破坏二期核心价值。

## Do

运行：

```text
T-09
Draft
Review
FactCheck
Brief
Proof
Resume
```

重点检查：

```text
Frozen Notes
Frozen fingerprint
Frozen Awareness
Frozen Preset
```

## Check

修改 live DB 后：

```text
下游阶段不得漂移
```

## Act

任一阶段重新读 live resources：

```text
新增 P0 NO-GO
回到前一轮修复
```

---

# 22. PDCA Round 5：Android / 覆盖安装 / 全量 CI

## Plan

执行最终设备级回归。

## Do

完成：

```text
E2E-01 ~ E2E-05
```

并运行完整：

```text
lint
typecheck
test:ci
verify
migration
Android Debug build
```

## Check

确认：

- 无清库；
- 覆盖安装成功；
- 数据不丢；
- 新旧任务兼容；
- Preview 语义正确；
- 三档 Detail 强度可观察；
- Notes Warning 可观察。

## Act

任何失败重新登记 NO-GO，不允许直接写 Final Seal。

---

# 23. PDCA Round 6：独立第二视角 Final Audit

本轮必须模拟一个“不知道实现者过程”的独立验收者。

## 23.1 从零阅读

重新阅读：

1. 第二期原建设方案；
2. 本收尾方案；
3. 当前最终 diff；
4. 新增测试；
5. Android 证据；
6. GitHub Actions；
7. Final Seal 草稿。

---

## 23.2 独立搜索重点

代码搜索：

```text
collectNoteCandidates
getNotesByProject
getNotesContentByIds
catch
AWARENESS_ONLY
resourceDetailIntensity
Math.min(intensity
contextBudgetVersion
snapshotVersion
SCHEMA_VERSION
```

---

## 23.3 独立问题清单

逐条回答：

```text
1. V7 Snapshot 后还有没有任何资料二次读取？
2. Notes 读取失败能否被 Preview / Trace 看见？
3. Character / Worldbook read failure 是否仍 fail-closed？
4. rich 是否真的比 balanced 更积极？
5. Notes 未注入是否还会显示 AWARENESS_ONLY？
6. Snapshot V4 Resume 是否完全冻结？
7. V6 / Snapshot V3 是否未被自动升级？
8. Schema 是否仍为 51？
9. includeResources=false 时 Preset 是否仍生效？
10. 是否为了过测试降低了任何硬门槛？
```

任何一项不能明确回答 PASS：

```text
第二期剩余 NO-GO ≠ 0
```

继续下一轮 PDCA。

---

# 24. Final Seal 必须包含的证据

最终 `第二期 Final Seal` 至少记录：

## 24.1 Git

```text
main HEAD SHA
本轮收尾 commit SHA
与收尾前基线的 compare 范围
```

## 24.2 协议版本

```text
SCHEMA_VERSION = 51
Context Budget = 7
Resource Context = 2
Pipeline Snapshot = 4
```

## 24.3 Notes 同源证明

记录测试名称和结论：

```text
Snapshot 后没有 Notes DB 二次读取
build 中修改 Notes 不产生版本撕裂
fingerprint == 实际 Detail 源版本
```

## 24.4 Warning 证明

记录：

```text
NOTE_LIST_READ_FAILED
NOTE_CONTENT_READ_FAILED
NOTE_DETAIL_COMPILE_FAILED
```

或最终实际采用的等价 code。

## 24.5 Detail 强度

记录真实 allocator 结果，至少一组：

```text
save      allocated = X
balanced  allocated = Y
rich      allocated = Z
```

满足：

```text
X < Y < Z
```

在设计的竞争测试场景中成立。

## 24.6 Preview

截图或 UI tree 证明：

```text
Character Awareness Only
Worldbook Awareness Only
Note Not Selected
Note Warning
Detail Full
Detail Clipped
Disabled
```

## 24.7 Freeze / Resume

记录修改 live DB 后 Resume 仍消费 Frozen Snapshot 的证据。

## 24.8 CI

记录完整：

```text
lint
typecheck
test:ci
migration
Android Debug build
GitHub Actions run id
```

---

# 25. 最终 GO / NO-GO 判定表

| Gate | 必须状态 |
|---|---|
| NG-01 Notes 同源冻结 | GO |
| NG-02 Notes Warning | GO |
| NG-03 rich 真实生效 | GO |
| NG-04 Preview Note 状态 | GO |
| Character Awareness | GO |
| Worldbook Awareness | GO |
| Awareness fail-closed | GO |
| Elastic Detail | GO |
| Preset stage binding | GO |
| Snapshot V4 | GO |
| 五阶段冻结消费 | GO |
| V6 legacy | GO |
| Snapshot V3 legacy | GO |
| Schema 51 | GO |
| includeResources=false + Preset | GO |
| Freeze / Resume | GO |
| Android E2E | GO |
| 覆盖安装 | GO |
| 数据保留 | GO |
| lint | GO |
| typecheck | GO |
| test:ci | GO |
| Migration matrix | GO |
| Android Debug build | GO |
| GitHub Actions | GO |
| 独立第二视角复审 | GO |

只有全部为 GO，才允许：

```text
第二期剩余 NO-GO = 0
```

---

# 26. 自动循环停止条件

Agent 不得以“主要问题已修”作为停止条件。

唯一停止条件：

```text
所有登记 NO-GO 已关闭
+
没有独立复审新发现的 P0/P1 封板缺陷
+
完整测试全绿
+
Android 关键场景通过
+
覆盖安装数据保留通过
+
GitHub Actions 对最终 HEAD 全绿
+
Final Seal 与真实实现一致
```

如果 Final Audit 新发现问题：

```text
Plan → Do → Check → Act
```

继续下一轮。

---

# 27. 推荐 Agent 总提示词

可将以下提示词与本方案一起交给本地 Agent：

```text
请完整阅读：

docs/optimization/ShineWriter_第二期工程收尾_PDCA方案_20260813.md

你现在执行的是“第二期工程收尾”，不是新功能开发。

必须严格按文档中的 PDCA Round 0 → Round 6 执行，并持续自审循环，直到：

第二期剩余 NO-GO = 0

核心任务：

1. 修复 V7 Notes 二次读取，所有 Notes Detail 必须从 ResourceSourceSnapshot.notes 派生；
2. 保证同一次 build 中 fingerprint 与实际注入正文来自同一冻结版本；
3. Notes list/content/compile 失败允许软降级，但必须进入结构化 Trace Warning 和 Preview；
4. 修复 resourceDetailIntensity，使 save < balanced < rich 在最终 V7 allocation 层真实成立；
5. 修复 Note 未注入时错误显示 AWARENESS_ONLY 的状态语义；
6. 补齐故障注入、Snapshot、Freeze/Resume、Preview、allocator 测试；
7. 回归 Character / Worldbook / Preset / 五阶段 / V6 legacy / Snapshot V3；
8. 保持 SCHEMA_VERSION=51、Context Budget=7、Resource Context=2、Snapshot=4；
9. 完成 Android E2E、覆盖安装、数据保留、完整 CI；
10. 最后必须以独立第二视角重新从零审查源码、测试与 Final Seal。

禁止：
- 扩展第三期范围；
- 升 Schema；
- 新建无关协议版本；
- skip/todo/only；
- 删除失败测试；
- 改 expected 掩盖问题；
- catch 后静默吞错；
- 为通过 E2E 清库；
- 未有证据就修改 Final Seal 为 PASS。

每关闭一个 NO-GO，都必须同时具备：
生产代码修复 + 正向测试 + 故障注入测试 + 回归证据。

如果独立复审发现新问题，自动进入下一轮 PDCA，继续修复，不需要等待人工确认。

最终只有全部 Gate 为 GO，才允许写：

第二期剩余 NO-GO = 0
```

---

# 28. 封板声明模板

最终通过后，Final Seal 使用如下口径：

```text
ShineWriter 第二期资料资产 → 写作流水线弹性上下文接驳已完成工程收尾。

确认：
- V7 Resource Source Snapshot 同源冻结成立；
- Character / Worldbook / Notes / Preset 在同一次 Context Build 内不存在版本撕裂；
- Notes 可选 Detail 异常具备结构化 Warning，不再静默伪装为空资料；
- Global Awareness 保护语义保持；
- save / balanced / rich 在最终 Detail allocation 层真实生效；
- Preview 状态与实际注入一致；
- Pipeline Snapshot V4 的 Draft / Review / FactCheck / Brief / Proof / Resume 使用冻结视图；
- V6 / Snapshot V3 Legacy 兼容保持；
- SCHEMA_VERSION 仍为 51；
- Android E2E、覆盖安装、数据保留、自动化测试与最终 GitHub Actions 全部通过；
- 独立第二视角复审未发现剩余封板问题。

第二期剩余 NO-GO = 0。
允许封板第二期。
```
