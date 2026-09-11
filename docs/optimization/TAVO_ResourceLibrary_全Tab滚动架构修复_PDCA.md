# TAVO ResourceLibrary 全 Tab 滚动架构修复 PDCA

- 日期：2026-09-11
- 分支：main（修复前 HEAD `84f6cca3`，版本 V3.0.6 / versionCode 3000600，无版本 bump、无 tag、无 Release）
- 关联历史：
  - `c25435dc` fix(ResourceLibrary): 资料库仿写页面支持整体滚动（2026-07）
  - `2e8a704e` fix(notes): restore scrollable library and note counts（2026-09）

---

## Plan

### 用户问题

资料库 → 作家风格 页面无法纵向滑动：作家风格说明、内置作家风格目录、展开的内置预览被固定在屏幕上部，用户无法向下查看与操作用户作家风格列表。此前刚修复过“笔记页顶部模式配置过高后下方笔记不可达”，两者表现为同一类问题。

### 为什么 Notes 修好了，Writer Style 仍然冻结

`2e8a704e` 只把 **Notes** 改成了单一滚动 owner（`resource-notes-list` FlatList + `ListHeaderComponent`），并没有动作家风格 Tab 的结构。作家风格 Tab 仍是同源结构缺陷：

```
View(scrollContent, flex:1)          ← 不是滚动容器，只是布局容器
├─ View(actions)                     ← 标题说明 + 导入按钮 + 新建输入（随文案增长）
├─ View(catalogList)                 ← PRESET_CATALOG.map() 4 张内置卡 + 可展开预览（随展开增长）
└─ View(listContainer, flex:1, minHeight:240)
   └─ FlatList(data=用户作家风格)     ← 唯一的滚动 owner
```

`actions` 与 `catalogList` 不属于任何纵向滚动 owner。内置目录 4 张卡 + 任一预览展开（`高级设置 · 运行时编译结果` 三段长文案）后，顶部高度轻易超过小屏可视高度；上部内容被裁切在屏幕外且不可滚动，下部 FlatList 被压到 minHeight 甚至更小。这不是样式参数问题，而是“动态增长的内容不在滚动 owner 内”的结构问题——和 Notes 修复前的缺陷同源。

### 历史方案为何不再适用

`c25435dc`（2026-07）用 `ScrollView 包裹 tabs/actions/listContainer + FlatList scrollEnabled=false` 换取可达性。代价：

1. `scrollEnabled=false` 的 FlatList 一次性渲染全部行，用户数据量大（笔记 200 条、作家风格可达数百条）时失去虚拟化；
2. 纵向 ScrollView 内嵌 FlatList 触发 `VirtualizedLists should never be nested` 警告；
3. 后续迭代在 Notes Tab 引入独立滚动的 FlatList（去掉外层包裹）后，该方案在 ResourceLibrary 内已经不统一——Notes 走新架构，presets 仍留在旧结构里，这就是“按下葫芦浮起瓢”的来源。

### 本轮方案（架构原则）

**一个 Tab = 一个明确的纵向 Scroll Owner；动态增长的 Header 必须活在 owner 内部（`ListHeaderComponent`）。**

```
WriterStyle FlatList (resource-writer-style-list)
├─ ListHeaderComponent (resource-writer-style-header)
│  ├─ 标题 + 说明
│  ├─ 导入作家风格
│  ├─ 新建作家风格（输入 + 添加）
│  ├─ 内置作家风格目录（PRESET_CATALOG.map，4 张，规模有限、可静态 map）
│  │  └─ 展开的内置预览（在 Header 内，随列表一起滚动）
│  └─ 用户作家风格分区标题（N>0 时显示）
└─ data = 用户作家风格（FlatList 虚拟化，不塞进 Header）
```

禁止回归的模式：外层纵向 ScrollView 包 FlatList；`maxHeight` 截断顶部；目录固定高度内嵌独立 ScrollView；删除预览内容；改 flex 数值而不改所有权。

### Scroll Ownership Matrix（本 Tab 的纵向滚动 owner 是谁）

| Tab | 纵向 Scroll Owner | 动态 Header 位置 |
|---|---|---|
| 续写 | `ContinuationHomeBody` 自有滚动 | — |
| 大纲（仅大纲模式项目） | `OutlineListBody` 自有滚动 | — |
| 角色 | `resource-characters-list` FlatList（合集层与条目层互斥复用） | 固定高度操作栏在列表外（无增长风险） |
| 世界书 | `resource-worldbook-list` FlatList（同上） | 同上 |
| 笔记 | `resource-notes-list` FlatList | Header = 导入/统计/模式面板/权重（`resource-notes-header`） |
| 作家风格 | `resource-writer-style-list` FlatList | Header = 目录 + 导入 + 新建（`resource-writer-style-header`） |

代码内在 tab 分支渲染处固化了同样的注释（Scroll ownership invariant）。

---

## Do

改动文件：

1. `src/screens/ResourceLibrary.tsx`
   - presets（作家风格）从“固定 View + 独立 FlatList”分支中拆出，改为独立 `FlatList testID=resource-writer-style-list`，`ListHeaderComponent=writerStyleHeader`（标题说明 / 导入 / 新建 / 内置目录 + 展开预览 / 用户分区标题），`data=items.presets` 继续虚拟化。
   - 共享条目渲染提取为 `renderResourceItem`（角色条目 / 世界书条目 / 用户作家风格三处复用，业务语义零改动）。
   - 角色 / 世界书合集 FlatList 与条目 FlatList 补 `resource-characters-list` / `resource-worldbook-list` testID（互斥渲染，不新增滚动容器）。
   - `noteListLoadBlocked` 泛化为 `resourceListLoadBlocked` 供 Notes / presets 共用；作家风格获得与 Notes 一致的加载失败 / 修复中 / 空态 EmptyState。
   - 新增 testID：`resource-writer-style-header`、`writer-style-catalog-item-<id>`、`writer-style-catalog-preview-view-<id>`、`writer-style-catalog-title`（内置作家风格目录）、`resource-writer-style-user-section`（用户作家风格（N））、`writer-style-delete-<id>`；复用既有 `writer-style-import` / `writer-style-add-name` / `writer-style-add` / `writer-style-item-<id>` / `writer-style-edit-<id>` / `writer-style-set-active-<id>` / `writer-style-export-<id>` / `writer-style-catalog-list` / `writer-style-catalog-preview-<id>` / `writer-style-catalog-add-<id>`。
   - 渲染分支处固化 Scroll ownership invariant 注释。
2. `__tests__/resourceLibraryScrollOwnership.test.tsx`（新增）
   - WS-1 单 scroll owner + Header 含目录/导入/添加；WS-2 展开预览属于 Header；WS-3 100 条用户风格在 data 不在 Header；WS-4 data[99] 为第 100 条；WS-5 `writer-style-edit-21` 打开 WriterStyleEditor；WS-6 设为当前/导出/删除业务调用不变；WS-7 catalog copy 入库。
   - R-1 角色、R-2 世界书、R-3 笔记、R-4 作家风格 各 Tab 单 owner 断言；R-5 跨 Tab 切换时动态区域永不脱离 owner，且列表无“纵向 ScrollView 祖先”（含对 `ScrollView>FlatList` 嵌套检测器的有效性反证测试）。
3. `docs/optimization/TAVO_ResourceLibrary_全Tab滚动架构修复_PDCA.md`（本文档）

不改动：WriterStyleEditor、semantic_json、writer-style runtime compiler、preset source_format、activeWriterStyleId、Notes 既有结构、Construction/LLM/DB migration/Updater 等无关模块。无 Schema 改动、无版本 bump。

---

## Check

### 自动化

| 项 | 结果 |
|---|---|
| `npm run verify:version` | PASS（V3.0.6 versionCode=3000600） |
| `npm run lint` | PASS（0 errors；268 warnings 全部为存量，改动文件 0 新增，与 HEAD 版本逐行对比一致） |
| `npm run typecheck` | PASS |
| `npm run test:ci` | PASS：555 suites / 3963 tests 全过，0 失败（含新增 12 条滚动所有权回归） |

### Android 构建

| 项 | 结果 |
|---|---|
| `npm run apk:debug`（= `gradlew.bat assembleDebug`） | BUILD SUCCESSFUL（1m20s），`dist/apk/debug/ShineWriter-V3.0.6-debug.apk` |
| `npm run apk:release`（= `gradlew.bat assembleRelease`） | BUILD SUCCESSFUL（1m13s），`dist/apk/release/ShineWriter-V3.0.6-release.apk`，签名 SHA-256 = `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`（与发版要求一致） |

### Android 模拟器实测（Medium_Phone / emulator-5554，`wm size 1080x1920` 模拟小屏，测后已还原）

前置：安装 debug APK，经 run-as 拉取 DB 后本地注入测试数据（30 条用户作家风格 `QA滚动测试风格 01-30`、12 个角色合集、12 个世界书合集，quick_check ok，md5 校验一致后推回），项目 `elasticcontqa`（原著续写模式，另有 201 篇存量笔记）。取证截图在 `qa/scroll-ownership/`（未入库）。

| CASE | 内容 | 结果 |
|---|---|---|
| A | 作家风格页连续上滑：说明/目录/用户风格全部随同一滚动链移动 | PASS（A1→A2→A3：Header 与内置目录滚出，用户风格 02/03 进入视野） |
| B | 展开“长篇连贯叙事”预览（页面显著变高）后连续上滑 | PASS（B1 展开 → B2 18 连滑后到达最底第 30 条） |
| C | 最后一条用户作家风格（第 30 条）实际操作 | PASS（设为当前作家风格 → `writer-style-active-33` 徽章出现且持久；编辑 → WriterStyleEditor 打开；导出 → 系统保存对话框出现文件名 `QA滚动测试风格 30.json`；删除 → 确认弹窗出现后取消，未实际删除） |
| D | 角色→世界书→笔记→作家风格→角色→作家风格 循环切换 | PASS（每 Tab 的 owner testID 恰好出现一次，无冻结、无触摸失效） |
| E | 笔记仿写模式（5 组权重全展开）后滑到笔记；进入 200 篇合集内滚动 | PASS（E1：权重 Header 滚出后 `resource-note-item-1` 等笔记卡完整可操作；合集内滚到 note-item-36~38，虚拟化正常） |
| F | 角色 / 世界书 smoke：13 个合集两端可达 | PASS（角色：顶=合集12/11，底=合集01+未分组角色；世界书：顶=合集12/11，底=合集01+QA弹性世界书） |

> 实测备注：世界书/角色/作家风格的手势必须从各自 FlatList viewport 内起始（世界书页顶部操作区更高，viewport 约从 y≈1067 开始）；起始在固定操作区上的滑动不会传给列表，这是 Android 标准触摸分派行为，不是缺陷。测试早期两次“列表没动”均属此类操作误差，已用规范手势复核。

### Logcat（测试前 `logcat -c`，测试后 `logcat -d`，共 64721 行）

| 关键字 | 命中 |
|---|---|
| `FATAL EXCEPTION` | 0 |
| `E AndroidRuntime`（崩溃） | 0（286 条均为 shell 工具 RuntimeInit 常规启动日志） |
| `ANR` | 0 |
| `OutOfMemoryError` | 0 |
| `VirtualizedLists should never be nested` | **0**（硬门禁） |
| `Maximum update depth` / `Cannot update a component` | 0 / 0 |
| `ReactNativeJS` | 仅正常启动日志（Running "ShineWriter"、database startup path=light） |

### 结构验证（防“看不见的嵌套”）

`dumpsys activity top` 确认作家风格页唯一的 `com.facebook.react.views.scroll.ReactScrollView` 就是 `resource-writer-style-list`（[0,674]-[1080,1694]）。UI Automator 树中出现的无 testID 外层 `android.widget.ScrollView` 实为 react-native-screens 的 `ScreenContentWrapper`（导航库内部容器，a11y 类名报告为 ScrollView，`scrollable=false`），非 RN 滚动容器，不构成嵌套。

---

## Act

1. **规则**：今后 ResourceLibrary 任何布局改动，必须跑 `__tests__/resourceLibraryScrollOwnership.test.tsx` 全 Tab 滚动可达性门禁（WS-1~7 + R-1~5）；涉及真机/模拟器发版验收时至少复跑 CASE A/B/C（作家风格）+ CASE E smoke（笔记）。
2. **不变量**：每个 Tab 有且仅有一个纵向 scroll owner；动态增长 Header 一律放 `ListHeaderComponent`。禁止 reintroduce：外层纵向 ScrollView 包 FlatList、`scrollEnabled={false}`、顶部 `maxHeight` 截断、目录独立内滚。
3. **未来改造入口**：若角色/世界书顶部将来出现动态增长内容（如 continuation hint 变高、多行操作栏），应按本轮 presets 的模式并入对应 FlatList 的 Header，而不是恢复外层 ScrollView。
4. 遗留观察项（非本轮缺陷，不阻塞）：
   - 旧版 preset（`max_tokens=0`）在列表中显示“软上限 0 tokens”文案，语义上 0=AUTO，展示可读性可后续优化；
   - `src/screens/ResourceLibrary.tsx` 仍超 3000 行，如后续再增长，可按任务建议有限提取 `WriterStyleHeader` 纯展示组件（本轮为最小改造未提取）。

## GO / NO-GO

**GO**。DoD 全部满足：作家风格可纵向滑动、展开预览后仍可滑到底、最后一条用户风格可操作、用户数据保持 FlatList 虚拟化、Notes 未回归、角色/世界书 smoke PASS、无纵向嵌套警告、Jest/Lint/TS/Debug/Release/Logcat 全部 PASS、无 Schema 改动、无版本 bump、无 tag、无 Release。
