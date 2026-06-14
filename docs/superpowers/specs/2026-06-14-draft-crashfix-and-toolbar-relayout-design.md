# 草稿预览闪退修复与章节编辑工具栏重排

> 日期：2026-06-14
> 状态：已确认，待实施
> 目标版本：V1.6.1
> 关联设计：`docs/superpowers/specs/2026-06-13-personal-novel-workbench-optimization-design.md`

## 1. 背景

Tavo Mini V1.6.0 实际使用过程中，写作模块暴露两个影响日常使用的问题：

1. **草稿预览页面按钮点击后软件闪退**（稳定性 P0）。
2. **章节编辑页面工具栏按钮挤在一行**（视觉可用性 P1）。

本轮只解决这两个问题，剩余 3 项（生成进度条、流水线结果自动弹窗、备份中心列表展示）记入下一轮 backlog，**不在本设计范围**。

约束与既有 V1.6 一致：Android-only、单用户、本地优先，不引入新依赖。

## 2. 成功标准

### 2.1 稳定性

- 草稿预览页面快速连续点击"采纳"按钮（≥3 次/秒）不闪退。
- 草稿预览页面在"全部采纳"Alert 显示期间按系统返回键，不闪退。
- 草稿预览页面采纳异步流程进行中跳转到其他页面再返回，不闪退、不残留错误 Alert。
- 草稿预览页面对同一草稿的"采纳"和"删除"按钮在采纳中点击，不闪退。
- 草稿预览页面在空列表状态下点击"全部采纳"和"清空草稿"入口被禁用，不进入错误路径。

### 2.2 UI 可用性

- 章节编辑工具栏稳定显示为两行：第一行主操作（4 个），第二行辅助/导航（4 个）。
- 任意按钮 label 不超过 2 个汉字，不出现"AI 续写""保存定稿"这种多字文案。
- 单个按钮触控区不小于 72dp × 34dp。
- 工具栏在 `compact` 模式下的视觉密度与原 V1.6 一致，竖屏不出现横向滚动。

### 2.3 工程质量

- `npm test -- --runInBand` 全部通过。
- `npm run lint` 无 error。
- `npm run apk:debug` 构建产物仅写入 `dist/apk/debug/`。
- 草稿预览相关代码保留中文错误文案，遵循 V1.6 错误处理约定。

## 3. 不在本设计范围

显式延后到 V1.6.2+ 处理的 3 项，仅作记录：

- 写作章节生成按钮点击后的动态进度条（LLM 写作管线进度可视化）。
- 流水线写作结束自动弹出结果给用户采纳。
- 备份中心备份做列表展示，避免遮挡"创建备份"按钮。

任何针对这三项的实现不被本设计覆盖。

## 4. 总体架构

本轮不新增服务、不动数据库、不动 navigation。所有改动集中在两个文件：

| 文件 | 改动性质 |
|---|---|
| `src/screens/DraftPreviewScreen.tsx` | 重构采纳/删除/清空异步流程，引入挂载守卫和操作锁；错误反馈从 Alert 改为 inline |
| `src/screens/ChapterEditor.tsx` | 工具栏拆两行；按钮文案缩短；移除 `flex: 1` 强制均分 |
| `__tests__/draftPreview.test.tsx` | 新增组件测试覆盖：双击采纳不并发、组件卸载后 setState 不抛错、空状态入口禁用 |

组件 `src/components/ui.tsx` 中的 `Button` 暂不改 API；`minWidth` 通过调用方在父容器样式中实现。

## 5. 设计：草稿预览闪退修复（方案 A1）

### 5.1 根因分析

`DraftPreviewScreen.tsx` 现有 `handleAdopt / handleDelete / handleClearAll` 存在 4 类典型 React Native 闪退诱因：

1. **Alert 嵌套 + 已卸载组件 setState**
   - `Alert.alert` 的 `onPress` 回调内 `setAdopting(draft.id)` 之后，await 链跨越异步边界。
   - 用户在 Alert 显示期间返回上一页，组件卸载，await 链中后续的 `setDrafts / setAdopting` 在已卸载组件上调用 → 闪退。
2. **缺少操作锁**
   - `adopting` 状态在异步操作进行中是 `draft.id`，但 `disabled` 只阻止新点击的视觉反馈，不阻止 onPress 实际触发。快速连点同一按钮会让两个采纳流程并发执行同一个草稿，第二次 `removeDraft(draft.id)` 在草稿已删除后失败 → 抛错冒到 React → 闪退。
3. **Alert 套 Alert**
   - `handleAdoptLatest` 调 `handleAdopt(latest)`，后者再 `Alert.alert`，两层弹窗在某些 Android ROM 上会触发 window manager 异常闪退。
4. **错误反馈用 Alert**
   - 即便非卸载场景，错误 Alert 与成功 Alert 在快速操作下可能同时出现，被 `Alert.alert` 内部队列处理时若时序错乱也有概率触发 native 异常。

### 5.2 修复策略

#### 5.2.1 挂载守卫

组件内新增 `const isMountedRef = useRef(true);`，`useEffect` 清理函数中 `isMountedRef.current = false`。

所有 `setXxx` 调用前增加 `safeSetXxx` 包装：

```ts
const safeSet = <T>(setter: (v: T) => void) => (v: T) => {
  if (!isMountedRef.current) return;
  setter(v);
};
```

或更直接：把 `setDrafts / setLoading / setAdopting / setExpandedIds` 改为先 `if (!isMountedRef.current) return;` 再调用。

`load()` 在 `useEffect` 中调用时不需要守卫（卸载时 setState 仍然安全，但本设计统一加守卫以保持一致）。

#### 5.2.2 操作锁 ref

新增 `const adoptingRef = useRef<number | null>(null);`，与 `adopting` state 并行。

`runAdopt(draft)` 函数首行：

```ts
if (adoptingRef.current !== null) return;
adoptingRef.current = draft.id;
safeSetAdopting(draft.id);
try { ... } finally {
  adoptingRef.current = null;
  safeSetAdopting(null);
}
```

UI 上的 `disabled` 判断改为 `adopting !== null || adoptingRef.current !== null`，双重保险；视觉上保持只有一项处于"采纳中"。

#### 5.2.3 Alert 链路扁平化

- `handleAdopt` 不再使用 `Alert.alert` 包裹 `onPress` 内的异步逻辑。
- 改为：用户点"采纳" → `Alert.alert` 仅做"确认 / 取消" → 确认回调里只调用 `runAdopt(draft)`，**不再 await**。
- `runAdopt` 是组件作用域的稳定 async 函数（用 `useCallback` 包裹，依赖项只有 refs 和 setter），负责全部副作用。
- `handleAdoptLatest` 同样：弹单次 Alert → 确认后调 `runAdopt(latest)`。不再嵌套 Alert 链。

#### 5.2.4 错误反馈从 Alert 改为 inline

新增组件级 `errorMessage: string | null` state（用 `useState`）。

采纳/删除/清空失败时：

```ts
} catch (e: any) {
  safeSetError(e?.message || '未知错误');
}
```

`useEffect` 监听 `errorMessage`，设置 4 秒后自动清空：

```ts
useEffect(() => {
  if (!errorMessage) return;
  const t = setTimeout(() => safeSetError(null), 4000);
  return () => clearTimeout(t);
}, [errorMessage]);
```

在 `Header` 下方（FlatList 上方）渲染一行错误文字，红色 `theme.colors.danger`，仅在 `errorMessage` 非空时显示。点击可手动清空。

#### 5.2.5 空状态入口禁用

`drafts.length === 0` 时，header 中的"全部采纳"和"清空草稿"按钮**不渲染**（当前已经做 `drafts.length > 0 && ...`，保留此行为）。`runAdopt` 顶部加 `if (drafts.length === 0) return;` 二次防护。

### 5.3 关键代码结构（伪代码）

```ts
const isMountedRef = useRef(true);
const adoptingRef = useRef<number | null>(null);
const [errorMessage, setErrorMessage] = useState<string | null>(null);

useEffect(() => {
  return () => { isMountedRef.current = false; };
}, []);

useEffect(() => {
  if (!errorMessage) return;
  const t = setTimeout(() => {
    if (isMountedRef.current) setErrorMessage(null);
  }, 4000);
  return () => clearTimeout(t);
}, [errorMessage]);

const runAdopt = useCallback(async (draft: GenerationDraft) => {
  if (adoptingRef.current !== null) return;
  if (!isMountedRef.current) return;
  adoptingRef.current = draft.id;
  setAdopting(draft.id);
  try {
    const currentContent = targetType === 'chapter'
      ? (await db.getChapterById(targetId))?.content ?? ''
      : await db.getFreeformDocument(projectId);
    await createRevision({ ... });
    if (targetType === 'chapter') {
      await db.updateChapter(targetId, { content: draft.content } as any);
    } else {
      await db.setFreeformDocument(projectId, draft.content);
    }
    await removeDraft(draft.id);
    await load();
  } catch (e: any) {
    if (isMountedRef.current) setErrorMessage(e?.message || '采纳失败');
  } finally {
    adoptingRef.current = null;
    if (isMountedRef.current) setAdopting(null);
  }
}, [targetType, targetId, projectId, load]);

const handleAdopt = useCallback((draft: GenerationDraft) => {
  Alert.alert('采纳确认', '采纳后将覆盖当前内容（采纳前会自动保存版本快照），确定采纳？', [
    { text: '取消', style: 'cancel' },
    { text: '采纳', style: 'destructive', onPress: () => { runAdopt(draft); } },
  ]);
}, [runAdopt]);

const handleAdoptLatest = useCallback(() => {
  if (drafts.length === 0) return;
  const latest = drafts[drafts.length - 1];
  Alert.alert('采纳最近草稿', '将采纳最近一份草稿并覆盖当前内容，确定继续？', [
    { text: '取消', style: 'cancel' },
    { text: '采纳', style: 'destructive', onPress: () => { runAdopt(latest); } },
  ]);
}, [drafts, runAdopt]);
```

`handleDelete / handleClearAll` 同步改造：Alert 回调里只调 `runDelete / runClear`；错误走 `setErrorMessage`。

### 5.4 行为变化（用户可见）

- 错误不再弹 Alert，改为列表顶部一行红色文字，4 秒后自动消失，可点击关闭。
- "采纳中…"状态文字保留，仍然作为该卡片的状态指示。
- 采纳按钮在采纳中 disabled，避免双击并发。
- 空列表时 header 中"全部采纳""清空草稿"入口不可见（行为不变）。

## 6. 设计：章节编辑工具栏重排（方案 B1）

### 6.1 现状

`ChapterEditor.tsx` 工具栏当前是 8 个按钮一字排开，8 个按钮都 `compact` 且 `flex: 1`，导致：

- `flex: 1` 强制均分，**阻止 wrap 换行**（flex item 会撑满第一行）。
- 即使去掉 flex，8 个按钮总宽度在小屏机型（截图显示 720px 宽）也接近 800px，必然溢出。

按钮 label 现状：

| 当前 label | 缩短后 |
|---|---|
| AI 续写 | 续写 |
| 保存定稿 | 定稿 |
| 摘要 | 摘要 |
| 版本 | 版本 |
| 历史 | 历史 |
| 上下文 | 上下文 |
| 草稿 | 草稿 |
| 清空 | 清空 |

### 6.2 新结构

```tsx
{!focusMode && (
  <View style={styles.toolbar}>
    <View style={styles.toolbarRow}>
      <Button label={generating ? '续写中…' : '续写'} icon={Bot} onPress={runPipeline} disabled={generating || finalizing} compact />
      <Button label={finalizing ? '定稿中…' : '定稿'} icon={FileText} variant="secondary" onPress={finalizeChapter} disabled={finalizing || generating} compact />
      <Button label="版本" icon={History} variant="secondary" onPress={manualCheckpoint} compact />
      <Button label="清空" icon={Trash2} variant="ghost" onPress={clearContent} disabled={generating || finalizing} compact />
    </View>
    <View style={styles.toolbarRow}>
      <Button label="摘要" icon={FileText} variant="ghost" onPress={...} compact />
      <Button label="历史" icon={History} variant="ghost" onPress={...} compact />
      <Button label="上下文" icon={Eye} variant="ghost" onPress={...} compact />
      <Button label="草稿" icon={Inbox} variant="ghost" onPress={...} compact />
    </View>
  </View>
)}
```

样式补充：

```ts
toolbar: { marginVertical: spacing.lg, gap: spacing.sm },
toolbarRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
```

注意：去掉了外层 `toolbar` 上的 `flexWrap: 'wrap'`，把 wrap 移到 `toolbarRow` 内部。移除每个 Button 的 `flex` 属性（不再 `flex: 1`）。

### 6.3 触控区下限

在 `toolbarRow` 上对所有 Button 通过 `style` 传 `minWidth: 72` 不现实（Button 不接受外部 style 透传）。改为在 `Button` 组件上加一个可选 `minWidth` prop，默认 0：

```ts
// ui.tsx Button 新增 prop
minWidth?: number;

// 渲染时
style={[..., typeof minWidth === 'number' && { minWidth }]}
```

调用方：

```tsx
<Button label="续写" icon={Bot} onPress={runPipeline} compact minWidth={72} />
```

`minWidth` 8 个按钮统一传 72。

### 6.4 行为不变

- `focusMode` 下整个工具栏仍隐藏。
- 各按钮的 `disabled` 条件不变。
- 各按钮的 `onPress` 行为不变（除 label 缩短和分组）。
- 主操作优先级视觉上更靠前：第一行 4 个（续写/定稿/版本/清空），第二行 4 个（摘要/历史/上下文/草稿）。

### 6.5 自由写作编辑器（`FreeformEditor.tsx`）是否同步改？

`FreeformEditor` 也有工具栏，但截图未显示用户对此提出问题。本轮**不**修改 `FreeformEditor`，留作下一轮 backlog。如果 `FreeformEditor` 复用同一组按钮且体验一致，V1.6.2 可统一处理。

## 7. 数据 / 服务 / 数据库

无变更。沿用现有 `draftService / revisionService / database`。

## 8. 错误处理

- 草稿预览：所有 catch 内不再 `Alert.alert`，统一 `setErrorMessage(...)`。
- 草稿预览：4 秒自动清除 + 点击清除。
- 章节编辑：无新错误路径。
- 草稿预览 Alert 回调：仅 `onPress: () => runAdopt(...)`，不内联 async 逻辑。

## 9. 测试策略

### 9.1 单元测试

#### 9.1.1 纯函数测试（`__tests__/draftAdoptGuard.test.ts` 新增）

把 `runAdopt` 内的同步判断（`adoptingRef.current !== null` → return）抽成可单测的 helper `canStartAdopt(currentAdopting, targetDraftId)`。测试覆盖：

- `canStartAdopt(null, 1)` → true
- `canStartAdopt(1, 1)` → false（已有同 id 采纳中）
- `canStartAdopt(1, 2)` → false（已有其他 id 采纳中）
- `canStartAdopt(0, 1)` → true（0/falsy 视为空）

#### 9.1.2 组件级测试（`__tests__/draftPreview.test.tsx` 新增）

项目 devDependencies 已含 `@testing-library/react-native: ^13.3.3`（无需新装）。使用 `render / fireEvent / waitFor` 覆盖：

- 渲染草稿列表 → 出现"采纳""删除"按钮。
- 快速连续点击"采纳" 3 次 → `runAdopt` 实际只被调用 1 次（验证操作锁）。
- 组件卸载后，`runAdopt` 内部 `setErrorMessage` 不抛错（验证挂载守卫）。
- 错误反馈以 inline 文字显示（`getByText(/失败/)`），不弹 Alert。
- 空列表时不渲染"全部采纳""清空草稿"按钮。

`Alert.alert` 通过 `jest.spyOn(Alert, 'alert')` 验证被调用，但**不依赖**弹窗返回值——所有副作用走 `runAdopt` 等稳定 async 函数。

#### 9.1.3 章节编辑器工具栏（`__tests__/chapterEditorToolbar.test.tsx` 新增）

- 渲染 → 出现 8 个 Button label：续写、定稿、版本、清空、摘要、历史、上下文、草稿。
- `focusMode = true` → 整个工具栏不渲染。
- 验证不出现"AI 续写""保存定稿"等旧文案。

### 9.2 现有测试更新

- 不需要修改任何现有测试。
- 跑全量 `npm test -- --runInBand` 必须 100% 通过。

### 9.3 不引入的依赖

- **不**引入新的 npm 依赖（RTL 和 react-test-renderer 已在 devDependencies）。
- 不引入原生模块测试工具。

## 10. 验证方式

### 10.1 自动化

- `npm test -- --runInBand`
- `npm run lint`
- `npm run apk:debug`（构建产物必须存在）

### 10.2 手工冒烟（设备）

1. 创建测试项目，章节生成 1 份流水线草稿。
2. 进入草稿预览页。
3. 快速点击"采纳" ≥ 5 次 → 必须不闪退，最终只有 1 次采纳成功。
4. 点击"全部采纳"，Alert 显示时按系统返回 → 不闪退。
5. 采纳中跳转到项目列表页再返回 → 不闪退，无残留错误弹窗。
6. 故意制造一次采纳失败（mock 改坏 `db.updateChapter`）→ 错误以 inline 文字显示，4 秒后消失，可点击关闭。
7. 章节编辑：截屏验证工具栏确实显示为两行 4×4 布局。

## 11. 文件规划

### 修改

- `src/screens/DraftPreviewScreen.tsx` — 引入挂载守卫、adopting ref、runAdopt/runDelete/runClear 稳定 async；Alert 回调扁平化；errorMessage 替代错误 Alert。
- `src/screens/ChapterEditor.tsx` — 工具栏拆为两个 `toolbarRow`；label 缩短；移除 Button `flex` 属性；补充 `minWidth={72}`。
- `src/components/ui.tsx` — `Button` 新增可选 `minWidth?: number` prop（默认 0，向后兼容）。

### 新增

- `__tests__/draftAdoptGuard.test.ts` — 覆盖 `canStartAdopt(currentAdopting, targetDraftId)` 的并发拒绝逻辑。

## 12. 明确不包含

- 草稿预览页以外的闪退（其他屏幕如有类似问题，本轮不修）。
- 草稿预览页的 Toast 系统改造（本轮仅 inline 文字 + 4s 自动消失）。
- 草稿预览页的乐观 UI 改造。
- 草稿预览页的取消采纳功能。
- 章节编辑工具栏的下拉菜单收纳。
- 章节编辑工具栏的拖拽排序。
- 自由写作（`FreeformEditor`）的工具栏改造。
- LLM 生成进度条、流水线结果自动弹窗、备份中心列表展示。
- 任何新依赖安装。

## 13. 发布与回滚

- 本轮定为 V1.6.1 patch 升级，schema 不变（保持 v8）。
- 草稿预览的 inline 错误反馈属于 UI 行为变化，不影响数据层，回滚时只需恢复 `DraftPreviewScreen.tsx` 单文件。
- 章节编辑工具栏分组与 label 缩短不涉及数据，回滚时只需恢复 `ChapterEditor.tsx` 单文件。
- 必要时 `Button` 的 `minWidth` prop 设为 0 即保持 V1.6 行为，因此该改动是纯加法。

## 14. 待用户确认（实施前）

无。设计已与用户确认 A1 + B1 两个推荐方案。直接进入实施计划阶段。
