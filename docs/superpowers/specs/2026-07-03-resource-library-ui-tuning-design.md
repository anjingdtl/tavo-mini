# 资料库 UI 调整设计文档

## 背景

当前 `ResourceLibrary`（资料库）页面在 Android 手机上存在三处可用性问题：

1. **操作按钮占用垂直空间过大**：角色、世界书等 Tab 的“导入/批量导入/新建”等按钮使用默认尺寸（minHeight 40）并采用换行排列，导致顶部操作区占掉大量可视区域。
2. **笔记导入入口位置不合理**：笔记 Tab 的导入按钮被放在“笔记模式（禁用/仿写/资料库）”配置面板之后，用户容易误以为导入属于某个模式子功能；在“仿写”模式下，用户需要切换回其他模式才能找到导入入口。
3. **仿写模式下笔记列表无法滚动**：资料库→笔记→仿写模式下，上方配置面板较高，下方笔记列表拿不到明确高度边界，导致无法下滑查看底部条目。

## 目标

- 缩小资料库顶部操作按钮，并改为水平滑动条，减少垂直占用。
- 将笔记导入/批量导入按钮固定在笔记 Tab 的全局顶部，不受模式切换影响。
- 修复仿写模式下笔记列表无法滚动的问题。

## 非目标

- 不改动按钮主题、颜色、交互语义。
- 不新增独立页面或 Modal。
- 不改写业务逻辑（导入、导出、启用/停用等）。

## 方案

### 1. 操作按钮改为 compact + 水平 ScrollView

文件：`src/screens/ResourceLibrary.tsx`

- 将 `characters` 与 `worldbook` Tab 的操作区从 `flexWrap` 换行改为 `ScrollView horizontal`。
- 所有操作按钮统一添加 `compact` 属性，尺寸由 40px 降至 34px。
- 水平滑动条内保留文字 + 图标，保证可识别性。
- 同一 Tab 下相关操作放在同一行滑动容器内，例如：
  - 角色：导入角色卡 / 批量导入角色卡 / 新建角色卡 / 启用全部角色 / 停用全部角色
  - 世界书：导入世界书 / 批量导入世界书 / 新建世界书（或新建条目） / 返回合集

样式新增：

```typescript
actionScroll: { flexDirection: 'row', gap: spacing.sm, paddingRight: spacing.lg },
```

### 2. 笔记导入按钮移到模式面板之前

文件：`src/screens/ResourceLibrary.tsx`

在 `tab === 'notes'` 区域，调整 JSX 顺序：

1. 导入 TXT 笔记（compact）
2. 批量导入 TXT（compact）
3. 笔记模式 SegmentedControl（禁用 / 仿写 / 资料库）
4. 模式相关的配置面板（权重、TopK、笔记选择器等）

这样导入入口始终位于笔记全局顶部，切换模式时不会丢失。

### 3. 列表区外层加 flex: 1

文件：`src/screens/ResourceLibrary.tsx`

- 在 `actions` 区域之后，用 `<View style={styles.listContainer}>` 包裹世界书合集列表、空状态以及条目 `FlatList`。
- 新增样式：

```typescript
listContainer: { flex: 1 },
```

使 `FlatList` 获得明确剩余高度，从而正常滚动。

## 数据流与状态

本次改动为纯 UI 调整，不引入新的状态、存储或 API 调用。所有事件处理函数保持原函数名和签名不变。

## 错误处理

- 保持现有 `try/catch` 和 Toast 提示不变。
- 水平滑动条本身不引入新的错误场景。

## 测试策略

1. 运行现有全部测试，确保无回归。
2. 针对 `ResourceLibrary.tsx` 的渲染测试：
   - 角色/世界书 Tab 下存在水平滑动的操作容器。
   - 笔记 Tab 下“导入 TXT 笔记”按钮出现在“笔记模式” SegmentedControl 之前。
   - 笔记列表外层容器具有 `flex: 1` 样式。

## 影响范围

- `src/screens/ResourceLibrary.tsx`：主要改动文件。
- `src/components/ui.tsx`：无需改动，`Button` 已支持 `compact`。
- 测试文件：`__tests__` 下涉及 `ResourceLibrary` 的现有测试需要同步更新选择器或快照。
