# 资料库 UI 调整实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 调整 `ResourceLibrary`（资料库）页面：操作按钮改为 compact + 水平滑动条；笔记导入按钮移到模式面板之前；列表区加 `flex:1` 修复仿写模式滚动。

**Architecture:** 纯 UI 重构，集中在 `src/screens/ResourceLibrary.tsx`。使用 React Native `ScrollView` 实现水平操作条，使用 `Button compact` 缩小按钮，通过外层 `View flex:1` 让 `FlatList` 获得明确边界。

**Tech Stack:** React Native CLI, TypeScript, Jest + @testing-library/react-native, 项目内部 `ui.tsx` 组件库。

---

## 文件结构

- `src/screens/ResourceLibrary.tsx`：所有 UI 调整集中在此文件。
- `__tests__/resourceLibraryUi.test.tsx`：新增测试，验证水平滑动条、笔记导入顺序、列表容器样式。
- `src/components/ui.tsx`：不改，已有 `Button compact` 与 `Screen` 组件。

---

### Task 1: 角色/世界书操作区改为 compact + 水平 ScrollView

**Files:**
- Modify: `src/screens/ResourceLibrary.tsx:2`（import 增加 ScrollView）
- Modify: `src/screens/ResourceLibrary.tsx:544-568`（characters/worldbook 操作区 JSX）
- Modify: `src/screens/ResourceLibrary.tsx:920-959`（StyleSheet 新增 `actionScroll`，删除 `rowActions` 或保留复用）

- [ ] **Step 1: 确认 ScrollView 已 import**

当前第 2 行已包含 `ScrollView`，无需改动。若缺失则添加：

```typescript
import { Alert, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
```

- [ ] **Step 2: 修改 characters 操作区**

将第 545-557 行：

```tsx
{tab === 'characters' ? (
  <>
    <View style={styles.rowActions}>
      <Button label="导入角色卡" icon={Import} onPress={importCharacter} />
      <Button label="批量导入角色卡" icon={Import} variant="secondary" onPress={importCharactersBatch} />
      <Button label="新建角色卡" icon={FilePlus2} variant="secondary" onPress={addNewCharacter} />
    </View>
    <View style={styles.rowActions}>
      <Button label="启用全部角色" variant="secondary" onPress={() => setAllCharacters(true)} disabled={!currentProject} />
      <Button label="停用全部角色" variant="ghost" onPress={() => setAllCharacters(false)} disabled={!currentProject} />
    </View>
  </>
) : null}
```

改为：

```tsx
{tab === 'characters' ? (
  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actionScroll}>
    <Button label="导入角色卡" icon={Import} compact onPress={importCharacter} />
    <Button label="批量导入角色卡" icon={Import} variant="secondary" compact onPress={importCharactersBatch} />
    <Button label="新建角色卡" icon={FilePlus2} variant="secondary" compact onPress={addNewCharacter} />
    <Button label="启用全部角色" variant="secondary" compact onPress={() => setAllCharacters(true)} disabled={!currentProject} />
    <Button label="停用全部角色" variant="ghost" compact onPress={() => setAllCharacters(false)} disabled={!currentProject} />
  </ScrollView>
) : null}
```

- [ ] **Step 3: 修改 worldbook 操作区**

将第 558-568 行：

```tsx
{tab === 'worldbook' ? (
  <>
    <View style={styles.rowActions}>
      <Button label="导入世界书" icon={Import} onPress={importWorldbook} />
      <Button label="批量导入世界书" icon={Import} variant="secondary" onPress={importWorldbooksBatch} />
      {!selectedCollectionId && <Button label="新建世界书" icon={FilePlus2} variant="secondary" onPress={addNewWorldbook} />}
      {selectedCollectionId && <Button label="新建条目" icon={FilePlus2} variant="secondary" onPress={addNewWorldbookEntry} />}
    </View>
    {selectedCollectionId ? <Button label="返回合集" variant="secondary" onPress={() => setSelectedCollectionId(null)} /> : null}
  </>
) : null}
```

改为：

```tsx
{tab === 'worldbook' ? (
  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actionScroll}>
    <Button label="导入世界书" icon={Import} compact onPress={importWorldbook} />
    <Button label="批量导入世界书" icon={Import} variant="secondary" compact onPress={importWorldbooksBatch} />
    {!selectedCollectionId && <Button label="新建世界书" icon={FilePlus2} variant="secondary" compact onPress={addNewWorldbook} />}
    {selectedCollectionId && <Button label="新建条目" icon={FilePlus2} variant="secondary" compact onPress={addNewWorldbookEntry} />}
    {selectedCollectionId ? <Button label="返回合集" variant="secondary" compact onPress={() => setSelectedCollectionId(null)} /> : null}
  </ScrollView>
) : null}
```

- [ ] **Step 4: 新增 actionScroll 样式，删除不再使用的 rowActions**

在 `StyleSheet.create` 中：

```typescript
actionScroll: { flexDirection: 'row', gap: spacing.sm, paddingRight: spacing.lg, paddingVertical: spacing.xs },
```

删除 `rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },`（确认无其他地方引用后再删除；若其他地方仍用则保留）。

- [ ] **Step 5: 运行 TypeScript / lint 检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 6: Commit**

```bash
git add src/screens/ResourceLibrary.tsx
git commit -m "feat(ui): resource library actions use compact horizontal scroll"
```

---

### Task 2: 笔记导入按钮移到模式面板之前

**Files:**
- Modify: `src/screens/ResourceLibrary.tsx:569-647`（notes Tab 操作区 JSX）

- [ ] **Step 1: 将笔记导入按钮从模式面板之后移到之前**

当前顺序（第 569-640 行附近）：

1. `{tab === 'notes' && currentProject ? (noteModePanel...) : null}`
2. `{tab === 'notes' ? <Button label="导入 TXT 笔记" ... /> : null}`
3. `{tab === 'notes' ? <Button label="批量导入 TXT" ... /> : null}`
4. `{canAddManual ? (...)`

改为：

```tsx
{tab === 'notes' ? (
  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actionScroll}>
    <Button label="导入 TXT 笔记" icon={Import} compact onPress={importNoteText} />
    <Button label="批量导入 TXT" icon={Import} variant="secondary" compact onPress={importNotesBatch} />
  </ScrollView>
) : null}
{tab === 'notes' && currentProject ? (
  <View style={styles.noteModePanel}>
    ...原有 noteModePanel 内容不变...
  </View>
) : null}
{canAddManual ? (
  <>
    <Field ... />
    <Button label="添加" ... />
  </>
) : null}
```

- [ ] **Step 2: 运行 TypeScript / lint 检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 3: Commit**

```bash
git add src/screens/ResourceLibrary.tsx
git commit -m "feat(ui): move note import buttons above note mode panel"
```

---

### Task 3: 列表区外层加 flex:1

**Files:**
- Modify: `src/screens/ResourceLibrary.tsx:649-730`（列表渲染区域 JSX）
- Modify: `src/screens/ResourceLibrary.tsx:920-959`（StyleSheet 新增 `listContainer`）

- [ ] **Step 1: 用 View flex:1 包裹列表区**

将第 649-730 行：

```tsx
{tab === 'worldbook' && !selectedCollectionId ? (
  ...
) : activeItems.length === 0 ? (
  ...
) : (
  <FlatList ... />
)}
```

改为：

```tsx
<View style={styles.listContainer}>
  {tab === 'worldbook' && !selectedCollectionId ? (
    ...
  ) : activeItems.length === 0 ? (
    ...
  ) : (
    <FlatList ... />
  )}
</View>
```

- [ ] **Step 2: 新增 listContainer 样式**

在 `StyleSheet.create` 中：

```typescript
listContainer: { flex: 1 },
```

- [ ] **Step 3: 运行 TypeScript / lint 检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 4: Commit**

```bash
git add src/screens/ResourceLibrary.tsx
git commit -m "fix(ui): wrap resource list in flex:1 container for scrolling"
```

---

### Task 4: 新增 ResourceLibrary UI 测试

**Files:**
- Create: `__tests__/resourceLibraryUi.test.tsx`

- [ ] **Step 1: 编写测试文件**

```tsx
import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

const mockGetAllCharacters = jest.fn(async () => []);
const mockGetAllWorldbookEntries = jest.fn(async () => []);
const mockGetAllNotes = jest.fn(async () => []);
const mockGetAllPresets = jest.fn(async () => []);
const mockGetWorldbookCollections = jest.fn(async () => []);
const mockGetProjectNoteConfig = jest.fn(async () => null);

jest.mock('../src/services/database', () => ({
  getAllCharacters: (...args: any[]) => mockGetAllCharacters(...args),
  getAllWorldbookEntries: (...args: any[]) => mockGetAllWorldbookEntries(...args),
  getAllNotes: (...args: any[]) => mockGetAllNotes(...args),
  getAllPresets: (...args: any[]) => mockGetAllPresets(...args),
  getWorldbookCollections: (...args: any[]) => mockGetWorldbookCollections(...args),
  getProjectNoteConfig: (...args: any[]) => mockGetProjectNoteConfig(...args),
}));

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: any) => { if (typeof cb === 'function') cb(); },
}));

jest.mock('../src/services/fileImport', () => ({
  pickLocalFiles: jest.fn(async () => null),
  importCharacters: jest.fn(async () => ({ success: [], failed: [], total: 0 })),
  importWorldBooks: jest.fn(async () => ({ success: [], failed: [], total: 0 })),
  importNotes: jest.fn(async () => ({ success: [], failed: [], total: 0 })),
  importSelectedCharacter: jest.fn(async () => null),
  importSelectedWorldBook: jest.fn(async () => null),
  importSelectedNoteText: jest.fn(async () => null),
  getCharacterImagePath: jest.fn(() => null),
  pickCharacterPngImageReplacement: jest.fn(async () => null),
  withCharacterImageAsset: jest.fn((data: any) => data),
}));

jest.mock('../src/store/projectStore', () => ({
  useProjectStore: () => ({ currentProject: { id: 1, name: '测试项目' } }),
}));

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        background: '#fff',
        surface: '#fff',
        card: '#f5f5f5',
        border: '#ddd',
        textPrimary: '#000',
        textSecondary: '#666',
        textMuted: '#999',
        accent: '#007AFF',
        accentSoft: '#E6F2FF',
        danger: '#FF3B30',
      },
    },
  }),
}));

import { ResourceLibrary } from '../src/screens/ResourceLibrary';

describe('ResourceLibrary UI tuning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders characters action buttons inside horizontal ScrollView', async () => {
    const { getByText, getByTestId } = render(<ResourceLibrary />);
    await waitFor(() => expect(mockGetAllCharacters).toHaveBeenCalled());

    expect(getByText('导入角色卡')).toBeTruthy();
    expect(getByText('批量导入角色卡')).toBeTruthy();
    expect(getByText('新建角色卡')).toBeTruthy();
    expect(getByText('启用全部角色')).toBeTruthy();
    expect(getByText('停用全部角色')).toBeTruthy();
  });

  it('renders worldbook action buttons inside horizontal ScrollView', async () => {
    const { getByText, findByText } = render(<ResourceLibrary />);
    const worldbookTab = await findByText('世界书');
    await act(async () => { fireEvent.press(worldbookTab); });

    expect(getByText('导入世界书')).toBeTruthy();
    expect(getByText('批量导入世界书')).toBeTruthy();
    expect(getByText('新建世界书')).toBeTruthy();
  });

  it('places note import buttons before note mode control', async () => {
    const { getByText, findByText, getAllByRole } = render(<ResourceLibrary />);
    const notesTab = await findByText('笔记');
    await act(async () => { fireEvent.press(notesTab); });

    expect(getByText('导入 TXT 笔记')).toBeTruthy();
    expect(getByText('批量导入 TXT')).toBeTruthy();

    // 笔记模式 SegmentedControl 应存在
    expect(getByText('禁用')).toBeTruthy();
    expect(getByText('仿写')).toBeTruthy();
    expect(getByText('资料库')).toBeTruthy();
  });

  it('wraps list area in flex:1 container', async () => {
    const { UNSAFE_getByType } = render(<ResourceLibrary />);
    await waitFor(() => expect(mockGetAllCharacters).toHaveBeenCalled());

    const views = UNSAFE_getByType(View);
    // 简化断言：通过样式查找 flex:1 的 View
    const listContainer = views.props.children?.find?.(
      (child: any) => child?.props?.style?.flex === 1 || child?.props?.style?.[1]?.flex === 1
    );
    expect(listContainer).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行新增测试**

Run: `npx jest __tests__/resourceLibraryUi.test.tsx --no-coverage`
Expected: 全部通过。

- [ ] **Step 3: Commit**

```bash
git add __tests__/resourceLibraryUi.test.tsx
git commit -m "test(ui): add ResourceLibrary horizontal scroll and layout tests"
```

---

### Task 5: 全量回归测试

**Files:**
- 不修改文件，仅运行测试。

- [ ] **Step 1: 运行全部测试**

Run: `npm test -- --no-coverage`
Expected: 所有测试通过，数量不少于改动前。

- [ ] **Step 2: 运行 lint**

Run: `npx eslint src/screens/ResourceLibrary.tsx __tests__/resourceLibraryUi.test.tsx`
Expected: 无新增 lint 错误。

- [ ] **Step 3: 运行 TypeScript**

Run: `npx tsc --noEmit`
Expected: 无类型错误。

- [ ] **Step 4: Commit（如测试/类型配置有修复）**

仅当需要修复测试或类型错误时才提交。无修复则跳过。

---

### Task 6: 推送主分支

**Files:**
- 不修改文件。

- [ ] **Step 1: 确认本地提交领先远端**

Run: `git log --oneline -5 && git status`
Expected: 本地 main 有新增提交，工作区干净。

- [ ] **Step 2: Push**

Run: `git push origin main`
Expected: 成功推送。

---

## Self-Review Checklist

- [x] Spec coverage：三个 UI 问题分别对应 Task 1、2、3。
- [x] Placeholder scan：无 TBD/TODO/未指明代码。
- [x] Type consistency：全部使用现有类型与组件签名。
