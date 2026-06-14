# 草稿预览闪退修复与章节编辑工具栏重排 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 TavoMini V1.6.0 草稿预览页面按钮点击后闪退的稳定性 bug，并把章节编辑工具栏从拥挤的单行重排为清晰的两行 4×4 布局。

**Architecture:** 改动仅涉及 UI 层。草稿预览侧引入 `isMountedRef` + `adoptingRef` 守卫所有 setState 与采纳入口；采纳/删除/清空流程从"Alert 内嵌 async"重构为"Alert 单次确认 → 稳定 async 函数"模式；错误反馈从 Alert 改为组件顶部 inline 文字 + 4s 自动消失。章节编辑侧拆 `toolbar` 为两个 `toolbarRow`，移除 Button 的 `flex: 1` 强制均分，并在 `ui.tsx` 的 `Button` 组件上新增可选 `minWidth` prop。所有变更不引入新依赖（RTL 已在 devDependencies）。

**Tech Stack:** React Native 0.85.3, TypeScript 5.8, React 19.2, Jest 29, @testing-library/react-native 13.3。

---

## 文件结构

### 修改

- `src/components/ui.tsx` — `Button` 新增可选 `minWidth?: number` prop。
- `src/screens/DraftPreviewScreen.tsx` — 引入挂载守卫与采纳 ref；将 `handleAdopt / handleDelete / handleClearAll` 拆为 Alert 确认回调 + 稳定 async `runAdopt / runDelete / runClear`；引入 `errorMessage` state + 4s 自动清除 effect；将错误反馈从 Alert 改为 inline 文字。
- `src/screens/ChapterEditor.tsx` — 工具栏拆为两个 `toolbarRow`；8 个 Button label 缩短到 ≤2 汉字；移除 `flex` 属性；统一传 `minWidth={72}`。

### 新增

- `src/utils/draftAdoptGuard.ts` — 纯函数 `canStartAdopt(currentAdopting, targetDraftId)`。
- `__tests__/draftAdoptGuard.test.ts` — 覆盖 `canStartAdopt` 4 个分支。
- `__tests__/draftPreview.test.tsx` — 组件级测试。
- `__tests__/chapterEditorToolbar.test.tsx` — 工具栏 label 与 focusMode 测试。

---

## Task 1: 抽离 canStartAdopt 纯函数并补单测

**Files:**
- Create: `src/utils/draftAdoptGuard.ts`
- Create: `__tests__/draftAdoptGuard.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `__tests__/draftAdoptGuard.test.ts`：

```ts
import { canStartAdopt } from '../src/utils/draftAdoptGuard';

describe('canStartAdopt', () => {
  it('returns true when no adopt in flight', () => {
    expect(canStartAdopt(null, 1)).toBe(true);
  });

  it('returns false when same draft is being adopted', () => {
    expect(canStartAdopt(1, 1)).toBe(false);
  });

  it('returns false when another draft is being adopted', () => {
    expect(canStartAdopt(1, 2)).toBe(false);
  });

  it('treats 0 as no adopt in flight', () => {
    expect(canStartAdopt(0, 1)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest __tests__/draftAdoptGuard.test.ts --runInBand`
Expected: FAIL with "Cannot find module '../src/utils/draftAdoptGuard'"

- [ ] **Step 3: 实现 canStartAdopt**

创建 `src/utils/draftAdoptGuard.ts`：

```ts
export function canStartAdopt(
  currentAdopting: number | null,
  targetDraftId: number,
): boolean {
  if (currentAdopting == null) return true;
  return currentAdopting !== targetDraftId;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest __tests__/draftAdoptGuard.test.ts --runInBand`
Expected: PASS（4 个用例全部通过）

- [ ] **Step 5: 提交**

```bash
git add src/utils/draftAdoptGuard.ts __tests__/draftAdoptGuard.test.ts
git commit -m "feat(draft-preview): add canStartAdopt guard helper with unit tests"
```

---

## Task 2: 在 Button 组件上加 minWidth 可选 prop

**Files:**
- Modify: `src/components/ui.tsx:92-137`（Button 函数签名与样式合并）

- [ ] **Step 1: 修改 Button 函数签名**

打开 `src/components/ui.tsx`，将 `Button` 函数签名从：

```ts
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  icon: Icon,
  compact = false,
  flex = false,
}: {
  label: string;
  onPress?: (event: GestureResponderEvent) => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  icon?: LucideIcon;
  compact?: boolean;
  flex?: boolean;
}) {
```

改为：

```ts
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  icon: Icon,
  compact = false,
  flex = false,
  minWidth = 0,
}: {
  label: string;
  onPress?: (event: GestureResponderEvent) => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  icon?: LucideIcon;
  compact?: boolean;
  flex?: boolean;
  minWidth?: number;
}) {
```

- [ ] **Step 2: 修改 TouchableOpacity style 合并**

将现有的 `style={[...]}` 块在末尾追加 `minWidth > 0 && { minWidth }`。改前：

```tsx
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.button,
        { backgroundColor: background, borderColor: theme.colors.border },
        disabled && styles.buttonDisabled,
        variant === 'ghost' && styles.ghostButton,
        compact && styles.buttonCompact,
        flex && styles.buttonFlex,
      ]}
    >
```

改后：

```tsx
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.button,
        { backgroundColor: background, borderColor: theme.colors.border },
        disabled && styles.buttonDisabled,
        variant === 'ghost' && styles.ghostButton,
        compact && styles.buttonCompact,
        flex && styles.buttonFlex,
        minWidth > 0 && { minWidth },
      ]}
    >
```

- [ ] **Step 3: 跑全量测试 + lint**

Run: `npx jest --runInBand`
Expected: 全部通过（无行为变化，新增 prop 默认 0）

Run: `npx eslint src/components/ui.tsx`
Expected: 无 error

- [ ] **Step 4: 提交**

```bash
git add src/components/ui.tsx
git commit -m "feat(ui): add optional minWidth prop to Button"
```

---

## Task 3: 重构 DraftPreviewScreen — 引入守卫与稳定 async 函数

**Files:**
- Modify: `src/screens/DraftPreviewScreen.tsx`（全文重写核心 async 流程）

- [ ] **Step 1: 新增 import**

在 `src/screens/DraftPreviewScreen.tsx` 顶部 import 区域中，添加 `useRef` 到 React import：

改前：

```ts
import React, { useCallback, useEffect, useState } from 'react';
```

改后：

```ts
import React, { useCallback, useEffect, useRef, useState } from 'react';
```

并新增 `canStartAdopt` import：

```ts
import { canStartAdopt } from '../utils/draftAdoptGuard';
```

- [ ] **Step 2: 替换 state 与 ref 块**

在 `DraftPreviewScreen` 函数体内，找到当前的 `useState` 声明块：

```tsx
  const [drafts, setDrafts] = useState<GenerationDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [adopting, setAdopting] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
```

在它**之后**新增 ref 和 errorMessage state：

```tsx
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const adoptingRef = useRef<number | null>(null);
```

- [ ] **Step 3: 在 useEffect 链中加入挂载守卫 effect**

找到现有 `useEffect(() => { load(); }, [load]);`（加载草稿的 effect），**在其后**追加一个 useEffect：

```tsx
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!errorMessage) return;
    const t = setTimeout(() => {
      if (isMountedRef.current) setErrorMessage(null);
    }, 4000);
    return () => clearTimeout(t);
  }, [errorMessage]);
```

- [ ] **Step 4: 把 load() 内的 setLoading 也加守卫**

改前：

```tsx
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getDrafts(targetType, targetId);
      setDrafts(list);
    } finally {
      setLoading(false);
    }
  }, [targetType, targetId]);
```

改后：

```tsx
  const load = useCallback(async () => {
    if (!isMountedRef.current) return;
    setLoading(true);
    try {
      const list = await getDrafts(targetType, targetId);
      if (!isMountedRef.current) return;
      setDrafts(list);
    } catch (e: any) {
      if (isMountedRef.current) setErrorMessage(e?.message || '加载草稿失败');
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [targetType, targetId]);
```

- [ ] **Step 5: 重写 handleAdopt — 拆为 Alert 确认 + runAdopt**

**完整替换**当前 `handleAdopt` 函数块（从 `const handleAdopt = (draft: GenerationDraft) => {` 到它结束的 `};`），改前代码（[DraftPreviewScreen.tsx:59-99](file:///workspace/src/screens/DraftPreviewScreen.tsx#L59-L99)）：

```tsx
  const handleAdopt = (draft: GenerationDraft) => {
    Alert.alert('采纳确认', '采纳后将覆盖当前内容（采纳前会自动保存版本快照），确定采纳？', [
      { text: '取消', style: 'cancel' },
      {
        text: '采纳',
        style: 'destructive',
        onPress: async () => {
          setAdopting(draft.id);
          try {
            const currentContent =
              targetType === 'chapter'
                ? (await db.getChapterById(targetId))?.content ?? ''
                : await db.getFreeformDocument(projectId);

            await createRevision({
              projectId,
              targetType,
              targetId,
              title: `采纳前快照 - ${SOURCE_LABELS[draft.source]}`,
              content: currentContent,
              source: 'before_pipeline_accept',
              sourceRef: `draft-${draft.id}`,
            });

            if (targetType === 'chapter') {
              await db.updateChapter(targetId, { content: draft.content } as any);
            } else {
              await db.setFreeformDocument(projectId, draft.content);
            }

            await removeDraft(draft.id);
            await load();
          } catch (e: any) {
            Alert.alert('采纳失败', e?.message || '未知错误');
          } finally {
            setAdopting(null);
          }
        },
      },
    ]);
  };
```

改后：

```tsx
  const runAdopt = useCallback(async (draft: GenerationDraft) => {
    if (!canStartAdopt(adoptingRef.current, draft.id)) return;
    if (!isMountedRef.current) return;
    adoptingRef.current = draft.id;
    setAdopting(draft.id);
    try {
      const currentContent =
        targetType === 'chapter'
          ? (await db.getChapterById(targetId))?.content ?? ''
          : await db.getFreeformDocument(projectId);

      await createRevision({
        projectId,
        targetType,
        targetId,
        title: `采纳前快照 - ${SOURCE_LABELS[draft.source]}`,
        content: currentContent,
        source: 'before_pipeline_accept',
        sourceRef: `draft-${draft.id}`,
      });

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
```

- [ ] **Step 6: 重写 handleDelete — 拆为 Alert + runDelete**

完整替换 `handleDelete` 函数（[DraftPreviewScreen.tsx:101-117](file:///workspace/src/screens/DraftPreviewScreen.tsx#L101-L117)）：

改前：

```tsx
  const handleDelete = (draft: GenerationDraft) => {
    Alert.alert('删除确认', '确定删除此草稿？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await removeDraft(draft.id);
            await load();
          } catch (e: any) {
            Alert.alert('删除失败', e?.message || '未知错误');
          }
        },
      },
    ]);
  };
```

改后：

```tsx
  const runDelete = useCallback(async (draft: GenerationDraft) => {
    if (!isMountedRef.current) return;
    try {
      await removeDraft(draft.id);
      await load();
    } catch (e: any) {
      if (isMountedRef.current) setErrorMessage(e?.message || '删除失败');
    }
  }, [load]);

  const handleDelete = useCallback((draft: GenerationDraft) => {
    Alert.alert('删除确认', '确定删除此草稿？', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => { runDelete(draft); } },
    ]);
  }, [runDelete]);
```

- [ ] **Step 7: 重写 handleAdoptLatest — 单次 Alert**

完整替换 `handleAdoptLatest`（[DraftPreviewScreen.tsx:119-123](file:///workspace/src/screens/DraftPreviewScreen.tsx#L119-L123)）：

改前：

```tsx
  const handleAdoptLatest = () => {
    if (drafts.length === 0) return;
    const latest = drafts[drafts.length - 1];
    handleAdopt(latest);
  };
```

改后：

```tsx
  const handleAdoptLatest = useCallback(() => {
    if (drafts.length === 0) return;
    const latest = drafts[drafts.length - 1];
    Alert.alert('采纳最近草稿', '将采纳最近一份草稿并覆盖当前内容，确定继续？', [
      { text: '取消', style: 'cancel' },
      { text: '采纳', style: 'destructive', onPress: () => { runAdopt(latest); } },
    ]);
  }, [drafts, runAdopt]);
```

- [ ] **Step 8: 重写 handleClearAll — 拆为 Alert + runClear**

完整替换 `handleClearAll`（[DraftPreviewScreen.tsx:125-141](file:///workspace/src/screens/DraftPreviewScreen.tsx#L125-L141)）：

改前：

```tsx
  const handleClearAll = () => {
    Alert.alert('清空确认', '确定清空所有草稿？此操作不可恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: async () => {
          try {
            await clearDrafts(targetType, targetId);
            await load();
          } catch (e: any) {
            Alert.alert('清空失败', e?.message || '未知错误');
          }
        },
      },
    ]);
  };
```

改后：

```tsx
  const runClear = useCallback(async () => {
    if (!isMountedRef.current) return;
    try {
      await clearDrafts(targetType, targetId);
      await load();
    } catch (e: any) {
      if (isMountedRef.current) setErrorMessage(e?.message || '清空失败');
    }
  }, [targetType, targetId, load]);

  const handleClearAll = useCallback(() => {
    Alert.alert('清空确认', '确定清空所有草稿？此操作不可恢复。', [
      { text: '取消', style: 'cancel' },
      { text: '清空', style: 'destructive', onPress: () => { runClear(); } },
    ]);
  }, [runClear]);
```

- [ ] **Step 9: 渲染错误文字与 inline 反馈**

找到 `return (` 处的 JSX，在 `<Header ... />` **之后**、`{loading ? ...}` **之前**，插入错误文字块：

```tsx
      {errorMessage ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="关闭错误"
          onPress={() => setErrorMessage(null)}
          style={[styles.errorBar, { backgroundColor: theme.colors.danger + '22', borderColor: theme.colors.danger }]}
        >
          <Text style={[styles.errorText, { color: theme.colors.danger }]} numberOfLines={2}>
            {errorMessage}
          </Text>
        </TouchableOpacity>
      ) : null}
```

- [ ] **Step 10: 补充 styles 块**

在现有 `styles` 对象末尾追加（**不要替换任何已有键**）：

```ts
  errorBar: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
  },
```

- [ ] **Step 11: 跑测试 + lint**

Run: `npx jest --runInBand`
Expected: 全部通过（行为变化不破坏现有 17 套件）

Run: `npx eslint src/screens/DraftPreviewScreen.tsx`
Expected: 无 error

- [ ] **Step 12: 提交**

```bash
git add src/screens/DraftPreviewScreen.tsx
git commit -m "fix(draft-preview): add mount guard and adopt ref to prevent crash"
```

---

## Task 4: 重排 ChapterEditor 工具栏为两行

**Files:**
- Modify: `src/screens/ChapterEditor.tsx:277-297`（工具栏 JSX）
- Modify: `src/screens/ChapterEditor.tsx:321-333`（styles 块）
- Modify: `src/screens/ChapterEditor.tsx:3`（lucide import 保持不变）

- [ ] **Step 1: 替换工具栏 JSX**

找到现有工具栏块（[ChapterEditor.tsx:277-297](file:///workspace/src/screens/ChapterEditor.tsx#L277-L297)）：

改前：

```tsx
        {!focusMode && (
        <View style={styles.toolbar}>
          <Button label={generating ? '生成中...' : 'AI 续写'} icon={Bot} onPress={runPipeline} disabled={generating || finalizing} compact flex />
          <Button label={finalizing ? '定稿中...' : '保存定稿'} icon={FileText} variant="secondary" onPress={finalizeChapter} disabled={finalizing || generating} compact flex />
          <Button label="摘要" icon={FileText} variant="secondary" onPress={() => Alert.alert('章节摘要', chapter.memory_summary || '暂无记忆摘要。')} compact flex />
          <Button label="版本" icon={History} variant="secondary" onPress={manualCheckpoint} compact flex />
          <Button label="历史" icon={History} variant="ghost" onPress={() => {
            // @ts-ignore
            navigation.navigate('RevisionHistory', { targetType: 'chapter', targetId: chapter.id, projectId: chapter.project_id });
          }} compact flex />
          <Button label="上下文" icon={Eye} variant="ghost" onPress={() => {
            // @ts-ignore
            navigation.navigate('ContextPreview', { chapterId: chapter.id });
          }} compact flex />
          <Button label="草稿" icon={Inbox} variant="ghost" onPress={() => {
            // @ts-ignore
            navigation.navigate('DraftPreview', { targetType: 'chapter', targetId: chapter.id, projectId: chapter.project_id });
          }} compact flex />
          <Button label="清空" icon={Trash2} variant="ghost" onPress={clearContent} disabled={generating || finalizing} compact flex />
        </View>
        )}
```

改后：

```tsx
        {!focusMode && (
        <View style={styles.toolbar}>
          <View style={styles.toolbarRow}>
            <Button
              label={generating ? '续写中…' : '续写'}
              icon={Bot}
              onPress={runPipeline}
              disabled={generating || finalizing}
              compact
              minWidth={72}
            />
            <Button
              label={finalizing ? '定稿中…' : '定稿'}
              icon={FileText}
              variant="secondary"
              onPress={finalizeChapter}
              disabled={finalizing || generating}
              compact
              minWidth={72}
            />
            <Button
              label="版本"
              icon={History}
              variant="secondary"
              onPress={manualCheckpoint}
              compact
              minWidth={72}
            />
            <Button
              label="清空"
              icon={Trash2}
              variant="ghost"
              onPress={clearContent}
              disabled={generating || finalizing}
              compact
              minWidth={72}
            />
          </View>
          <View style={styles.toolbarRow}>
            <Button
              label="摘要"
              icon={FileText}
              variant="ghost"
              onPress={() => Alert.alert('章节摘要', chapter.memory_summary || '暂无记忆摘要。')}
              compact
              minWidth={72}
            />
            <Button
              label="历史"
              icon={History}
              variant="ghost"
              onPress={() => {
                // @ts-ignore
                navigation.navigate('RevisionHistory', { targetType: 'chapter', targetId: chapter.id, projectId: chapter.project_id });
              }}
              compact
              minWidth={72}
            />
            <Button
              label="上下文"
              icon={Eye}
              variant="ghost"
              onPress={() => {
                // @ts-ignore
                navigation.navigate('ContextPreview', { chapterId: chapter.id });
              }}
              compact
              minWidth={72}
            />
            <Button
              label="草稿"
              icon={Inbox}
              variant="ghost"
              onPress={() => {
                // @ts-ignore
                navigation.navigate('DraftPreview', { targetType: 'chapter', targetId: chapter.id, projectId: chapter.project_id });
              }}
              compact
              minWidth={72}
            />
          </View>
        </View>
        )}
```

- [ ] **Step 2: 更新 styles 块**

找到现有 `styles` 末尾的 `toolbar` 样式行（[ChapterEditor.tsx:324](file:///workspace/src/screens/ChapterEditor.tsx#L324)）：

改前：

```ts
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginVertical: spacing.lg },
```

改后：

```ts
  toolbar: { marginVertical: spacing.lg, gap: spacing.sm },
  toolbarRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
```

- [ ] **Step 3: 跑测试 + lint**

Run: `npx jest --runInBand`
Expected: 全部通过

Run: `npx eslint src/screens/ChapterEditor.tsx`
Expected: 无 error

- [ ] **Step 4: 提交**

```bash
git add src/screens/ChapterEditor.tsx
git commit -m "feat(chapter-editor): split toolbar into 4x4 two-row layout with short labels"
```

---

## Task 5: 补充 DraftPreviewScreen 组件级测试

**Files:**
- Create: `__tests__/draftPreview.test.tsx`

- [ ] **Step 1: 创建测试文件**

创建 `__tests__/draftPreview.test.tsx`：

```tsx
import React from 'react';
import { Alert, Text } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

const mockGetDrafts = jest.fn();
const mockRemoveDraft = jest.fn();
const mockClearDrafts = jest.fn();
const mockUpdateChapter = jest.fn();
const mockSetFreeformDocument = jest.fn();
const mockGetChapterById = jest.fn();
const mockCreateRevision = jest.fn();

jest.mock('../src/services/draftService', () => ({
  getDrafts: (...args: any[]) => mockGetDrafts(...args),
  removeDraft: (...args: any[]) => mockRemoveDraft(...args),
  clearDrafts: (...args: any[]) => mockClearDrafts(...args),
}));

jest.mock('../src/services/database', () => ({
  getChapterById: (...args: any[]) => mockGetChapterById(...args),
  updateChapter: (...args: any[]) => mockUpdateChapter(...args),
  setFreeformDocument: (...args: any[]) => mockSetFreeformDocument(...args),
}));

jest.mock('../src/services/revisionService', () => ({
  createRevision: (...args: any[]) => mockCreateRevision(...args),
}));

import { DraftPreviewScreen } from '../src/screens/DraftPreviewScreen';

const sampleDrafts = [
  {
    id: 1,
    projectId: 10,
    targetType: 'chapter' as const,
    targetId: 100,
    source: 'pipeline' as const,
    content: '草稿内容一号',
    tokenCount: 1234,
    createdAt: '2026-06-14T08:00:00.000Z',
    status: 'pending' as const,
  },
  {
    id: 2,
    projectId: 10,
    targetType: 'chapter' as const,
    targetId: 100,
    source: 'continuation' as const,
    content: '草稿内容二号',
    tokenCount: 2345,
    createdAt: '2026-06-14T08:30:00.000Z',
    status: 'pending' as const,
  },
];

describe('DraftPreviewScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDrafts.mockResolvedValue(sampleDrafts);
    mockGetChapterById.mockResolvedValue({ id: 100, content: '原文内容' });
    mockCreateRevision.mockResolvedValue(undefined);
    mockUpdateChapter.mockResolvedValue(undefined);
    mockRemoveDraft.mockResolvedValue(undefined);
    mockClearDrafts.mockResolvedValue(undefined);
  });

  it('renders adopt and delete buttons for each draft', async () => {
    const onClose = jest.fn();
    const { findAllByText } = render(
      <DraftPreviewScreen
        targetType="chapter"
        targetId={100}
        projectId={10}
        onClose={onClose}
      />,
    );
    const adopts = await findAllByText('采纳');
    const deletes = await findAllByText('删除');
    expect(adopts.length).toBe(2);
    expect(deletes.length).toBe(2);
  });

  it('does not render adopt-all or clear-all buttons when list is empty', async () => {
    mockGetDrafts.mockResolvedValue([]);
    const onClose = jest.fn();
    const { queryByText, findByText } = render(
      <DraftPreviewScreen
        targetType="chapter"
        targetId={100}
        projectId={10}
        onClose={onClose}
      />,
    );
    await findByText('暂无草稿');
    expect(queryByText('全部采纳')).toBeNull();
    expect(queryByText('清空草稿')).toBeNull();
  });

  it('runs adopt only once when adopt button is triple-tapped quickly', async () => {
    let resolveAdopt: () => void = () => {};
    mockUpdateChapter.mockImplementation(
      () => new Promise<void>((resolve) => { resolveAdopt = resolve; }),
    );

    const onClose = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(((_title, _msg, buttons) => {
      const adoptBtn = (buttons as any[]).find((b) => b.text === '采纳');
      adoptBtn.onPress();
    }) as any);

    const { findAllByText } = render(
      <DraftPreviewScreen
        targetType="chapter"
        targetId={100}
        projectId={10}
        onClose={onClose}
      />,
    );

    const adopts = await findAllByText('采纳');
    // Three rapid taps on the first adopt button.
    fireEvent.press(adopts[0]);
    fireEvent.press(adopts[0]);
    fireEvent.press(adopts[0]);

    // Allow microtasks to flush.
    await act(async () => {
      await Promise.resolve();
    });

    // updateChapter must have been called exactly once because the adopt lock rejects the rest.
    expect(mockUpdateChapter).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
    resolveAdopt();
  });

  it('shows inline error message instead of Alert on failure', async () => {
    mockUpdateChapter.mockRejectedValue(new Error('写库炸了'));

    const onClose = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(((_title, _msg, buttons) => {
      const adoptBtn = (buttons as any[]).find((b) => b.text === '采纳');
      adoptBtn.onPress();
    }) as any);

    const { findAllByText, findByText } = render(
      <DraftPreviewScreen
        targetType="chapter"
        targetId={100}
        projectId={10}
        onClose={onClose}
      />,
    );

    const adopts = await findAllByText('采纳');
    fireEvent.press(adopts[0]);

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('采纳确认', expect.any(String), expect.any(Array));
    });
    // The error feedback must come from inline text, not from a second Alert.
    await findByText('写库炸了');
    const errorAlertCalls = alertSpy.mock.calls.filter(
      (call) => call[0] === '采纳失败' || call[0] === '删除失败' || call[0] === '清空失败',
    );
    expect(errorAlertCalls.length).toBe(0);

    alertSpy.mockRestore();
  });

  it('does not throw when component unmounts during adopt', async () => {
    let resolveAdopt: () => void = () => {};
    mockUpdateChapter.mockImplementation(
      () => new Promise<void>((resolve) => { resolveAdopt = resolve; }),
    );

    const onClose = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(((_title, _msg, buttons) => {
      const adoptBtn = (buttons as any[]).find((b) => b.text === '采纳');
      adoptBtn.onPress();
    }) as any);

    const { findAllByText, unmount } = render(
      <DraftPreviewScreen
        targetType="chapter"
        targetId={100}
        projectId={10}
        onClose={onClose}
      />,
    );

    const adopts = await findAllByText('采纳');
    fireEvent.press(adopts[0]);

    // Unmount before adopt resolves.
    unmount();
    resolveAdopt();

    // Wait a tick to let any rejected setState propagate.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    alertSpy.mockRestore();
    // The test passing without throwing is the assertion.
  });
});
```

- [ ] **Step 2: 跑测试确认通过**

Run: `npx jest __tests__/draftPreview.test.tsx --runInBand`
Expected: PASS（5 个用例全部通过）

- [ ] **Step 3: 跑全量测试**

Run: `npx jest --runInBand`
Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add __tests__/draftPreview.test.tsx
git commit -m "test(draft-preview): add component tests for mount guard and adopt lock"
```

---

## Task 6: 补充 ChapterEditor 工具栏测试

**Files:**
- Create: `__tests__/chapterEditorToolbar.test.tsx`

- [ ] **Step 1: 创建测试文件**

创建 `__tests__/chapterEditorToolbar.test.tsx`：

```tsx
import React from 'react';
import { render } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockUpdateChapter = jest.fn();
const mockGetChapterById = jest.fn();
const mockGetActiveTaskForTarget = jest.fn(() => null);
const mockCreateTask = jest.fn(() => 'task-1');
const mockRunChapterPipeline = jest.fn();

jest.mock('../src/services/database', () => ({
  updateChapter: (...args: any[]) => mockUpdateChapter(...args),
  getChapterById: (...args: any[]) => mockGetChapterById(...args),
}));

jest.mock('../src/services/pipelineRunner', () => ({
  runChapterPipeline: (...args: any[]) => mockRunChapterPipeline(...args),
}));

jest.mock('../src/services/revisionService', () => ({
  createRevision: jest.fn(async () => undefined),
}));

jest.mock('../src/services/summaryGenerator', () => ({
  generateMemorySummary: jest.fn(async () => ''),
}));

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({
      createTask: mockCreateTask,
      getActiveTaskForTarget: mockGetActiveTaskForTarget,
      tasks: [],
    }),
  },
}));

import { ChapterEditor } from '../src/screens/ChapterEditor';

const sampleChapter = {
  id: 1,
  project_id: 10,
  title: '第 1 章',
  synopsis: '',
  content: '',
  status: 'draft',
  position: 1,
  memory_summary: '',
  memory_summary_tokens: 0,
  created_at: '2026-06-14T00:00:00.000Z',
  updated_at: '2026-06-14T00:00:00.000Z',
};

describe('ChapterEditor toolbar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChapterById.mockResolvedValue(sampleChapter);
    mockUpdateChapter.mockResolvedValue(undefined);
  });

  it('renders all 8 short-label buttons', async () => {
    const onClose = jest.fn();
    const { findByText } = render(
      <ChapterEditor chapterId={1} onClose={onClose} />,
    );
    for (const label of ['续写', '定稿', '版本', '清空', '摘要', '历史', '上下文', '草稿']) {
      expect(await findByText(label)).toBeTruthy();
    }
  });

  it('does not render the old long labels', async () => {
    const onClose = jest.fn();
    const { findByText, queryByText } = render(
      <ChapterEditor chapterId={1} onClose={onClose} />,
    );
    await findByText('续写');
    expect(queryByText('AI 续写')).toBeNull();
    expect(queryByText('保存定稿')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认通过**

Run: `npx jest __tests__/chapterEditorToolbar.test.tsx --runInBand`
Expected: PASS（2 个用例全部通过）

- [ ] **Step 3: 跑全量测试 + lint**

Run: `npx jest --runInBand`
Expected: 全部通过

Run: `npx eslint src/screens/ChapterEditor.tsx src/screens/DraftPreviewScreen.tsx src/components/ui.tsx`
Expected: 无 error

- [ ] **Step 4: 提交**

```bash
git add __tests__/chapterEditorToolbar.test.tsx
git commit -m "test(chapter-editor): add toolbar label and layout tests"
```

---

## Task 7: 全量验证 + 构建

**Files:**
- 无（仅运行命令）

- [ ] **Step 1: 跑全量测试**

Run: `npx jest --runInBand`
Expected: 全部通过（19 个套件，包括 2 个新套件）

- [ ] **Step 2: 跑 lint**

Run: `npx eslint .`
Expected: 0 errors

- [ ] **Step 3: 更新版本号到 1.6.1**

修改 `package.json` 第 3 行：

改前：

```json
  "version": "1.6.0",
```

改后：

```json
  "version": "1.6.1",
```

- [ ] **Step 4: 跑 prebuild 重新生成 version.json**

Run: `npm run prebuild`
Expected: 成功，version.json 内容更新为 1.6.1

- [ ] **Step 5: 构建 debug APK**

Run: `npm run apk:debug`
Expected: 成功，产物写入 `dist/apk/debug/`

- [ ] **Step 6: 提交版本号更新**

```bash
git add package.json src/constants/version.json
git commit -m "chore: bump version to 1.6.1"
```

- [ ] **Step 7: 更新 progress.md**

在 `/workspace/progress.md` 顶部"版本路径"一行追加 `→ V1.6.1`，并在文档开头追加"## V1.6.1 / 闪退修复与工具栏重排"小节，简述本轮改动（3-5 行），引用 spec 文件路径。

- [ ] **Step 8: 提交 progress.md 更新**

```bash
git add progress.md
git commit -m "docs: record v1.6.1 changes in progress.md"
```

---

## 自审

- [x] **Spec 覆盖**：spec 第 5 节（闪退修复）由 Task 1 + Task 3 实现；spec 第 6 节（工具栏重排）由 Task 2 + Task 4 实现；spec 第 9 节（测试）由 Task 1 + Task 5 + Task 6 实现。
- [x] **占位符扫描**：所有步骤都给完整代码或精确命令，无 "TBD / 类似 / 适当处理"。
- [x] **类型一致性**：`canStartAdopt(currentAdopting, targetDraftId)` 在 Task 1 定义为 `(number | null, number) => boolean`，在 Task 3 调用处 `canStartAdopt(adoptingRef.current, draft.id)` 匹配；`Button` 新增 `minWidth` prop 在 Task 2 引入，Task 4 调用均传 `minWidth={72}`；`errorMessage` state 在 Task 3 引入并渲染，渲染处 `setErrorMessage(null)` 类型一致。
- [x] **依赖一致**：未引入新依赖；RTL 已在 devDependencies。
- [x] **提交粒度**：每个 Task 单独 commit，便于 review 与回滚。
