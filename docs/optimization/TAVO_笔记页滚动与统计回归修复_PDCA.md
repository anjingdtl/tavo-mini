# TAVO-MINI 笔记页滚动与统计回归修复 PDCA

## P — Plan

### 用户症状

升级后进入“资料库 → 笔记”，顶部导入、笔记模式和仿写风格权重区域占满屏幕，下面的笔记列表无法继续向下滚动；合集/笔记的启用 Switch 以及最后一条笔记因此不可达。同时页面没有在禁用模式下清楚展示已导入笔记总数，用户容易把仿写/检索的 `x/y` 误认为总数。

### 现状审计与历史回归

当前 `ResourceLibrary` 使用固定上部 View 承载 actions/mode panel，再使用另一个纵向 `FlatList` 承载资源。仿写设置高度不确定，列表只能依赖剩余高度。

历史提交 `c25435dcb3b6ad63aa8bfce241089aae14fb554b` 曾用“外层 `ScrollView` + 内部 `FlatList` 禁止独立滚动”让高配置区可以整体滚动，直接缓解了同类问题；但该方案会形成纵向容器嵌套，并削弱大量笔记的 FlatList 虚拟化。后续 `57942700` 为避免嵌套和保护笔记选择/后台更新，将外层恢复为普通 View、内部列表重新启用滚动，消除了嵌套警告的风险，却把 Notes 顶部配置再次置于列表滚动上下文之外，导致本次 P0 回归。

### 方案

仅对 Notes 使用一个主 `FlatList` 作为纵向 scroll owner：导入操作、统计摘要、模式选择、仿写/资料库设置、手动新建及合集返回按钮全部放入 `ListHeaderComponent`；笔记和合集仍作为 FlatList 的 `data`/`renderItem`，不使用普通 `.map()` 渲染大量笔记，也不恢复外层纵向 `ScrollView` 包裹 FlatList。其他资料页保留原有布局模型。

## D — Do

- 将 Notes 根页与合集内部页统一为 `resource-notes-list` 主 FlatList，并把 Notes header 接入 `ListHeaderComponent`。
- 保留合集根页“合集 + 未归入合集的笔记”和合集内部“全部分片笔记”两级数据语义。
- 统计摘要使用当前已加载数据：`items.notes.length` 表示数据库笔记行总数（包含合集分片），`projectEnabledNotes.length` 同时考虑笔记项目开关和合集项目开关；只有仿写/资料库模式显示当前参与数 `effectiveEnabledNoteIds.length / projectEnabledNotes.length`。
- 新增稳定 testID：Notes 列表、Header、统计、总数、项目可用数、模式面板、笔记条目/开关、合集条目/开关及模式参与数。
- 新增 UI 回归覆盖：禁用总数、仿写/资料库计数、单一 FlatList/Header、200 条数据仍走虚拟列表、合集 Switch 与合集内部笔记 Switch。

## C — Check

以下结果在本次验收后补录：

- [x] `resourceLibraryUi` 定向测试：19/19 PASS
- [x] `tsc --noEmit`：PASS
- [x] 定向 ESLint：0 errors，4 个既有 warning
- [x] 全量 `npm test -- --runInBand --ci`：553 suites passed，3950 tests passed，9 skipped
- [x] 全量 `npm run lint`：exit 0，0 errors（268 个既有 warning）
- [x] 全量 `npm run typecheck`：PASS
- [x] Android Debug build：`ShineWriter-V3.0.5-debug.apk`，Gradle BUILD SUCCESSFUL
- [x] Android Release build：`ShineWriter-V3.0.5-release.apk`，Gradle BUILD SUCCESSFUL；签名/zipalign/version hard assertions 全部通过，证书 SHA-256 为 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`
- [x] Android 模拟器 `emulator-5556`：Release `adb install -r` 后，以页面入口创建 200 条独立笔记并导入 2 个合集（共 204 条笔记、每合集 2 个分片）；仿写、资料库、禁用、合集根页及合集内部滚动/统计/Switch 均通过，最后一条笔记 Switch 点击并重新进入后保持关闭
- [x] Logcat：P0 关键字 `FATAL EXCEPTION`、`E/AndroidRuntime`、`ANR in com.shinewriter`、`OutOfMemoryError`、`VirtualizedLists should never be nested`、`Maximum update depth`、`Cannot update a component` 均为 0

## A — Act

- 保持 `resource-notes-list` 的 `ListHeaderComponent` 结构，并用回归测试锁定 Notes 只有一个纵向 FlatList owner。
- 保持 200 条数据通过 FlatList `data` 进入 `renderItem`，不得将笔记重新移入 Header 或改成全量 `.map()`。
- 继续保留 `effectiveNoteIds`、`toggleNoteSelection`、合集项目启用和项目资源启用语义；本次修复不修改 Schema、不修改版本号、不引入迁移。
- 后续若调整 ResourceLibrary，先运行 Notes UI 回归和 Android 滑动验收，再变更滚动容器。
