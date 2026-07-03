# 批量导入实施计划 — 角色卡/世界书/笔记

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `src/services/fileImport.ts` 增加文件多选批量导入能力，覆盖角色卡、世界书、笔记三类。

**Architecture:** 薄包装层 — 新增 4 个函数（1 个 picker + 3 个 batch 串行循环），复用单文件版本的解析/写库逻辑。UI 增 3 个按钮 + 1 个 ResultModal。

**Tech Stack:** React Native + TypeScript + `@react-native-documents/picker` + Jest + lucide-react-native

---

## 文件结构

| 文件 | 状态 | 职责 |
|---|---|---|
| `src/services/fileImport.ts` | 修改 | 新增 `pickLocalFiles` / `importCharacters` / `importWorldBooks` / `importNotes`；保留旧单文件函数 |
| `src/components/BatchImportResultModal.tsx` | 新增 | 展示批量导入成功/失败明细的 Modal |
| `src/screens/ResourceLibrary.tsx` | 修改 | 新增 3 个按钮 + 3 个处理函数 + Modal 状态 |
| `__tests__/fileImportBatch.test.ts` | 新增 | 4 个 batch 函数的单元测试 |
| `__tests__/batchImportModal.test.tsx` | 新增 | Modal 组件测试 |

---

## Task 1: `pickLocalFiles` 支持多选 + 单文件拷贝容错

**Files:**
- Modify: `src/services/fileImport.ts:323-340`

- [ ] **Step 1: 写失败测试**

在 `__tests__/fileImportBatch.test.ts` 添加：

```ts
import { pickLocalFiles } from '../src/services/fileImport';
import * as picker from '@react-native-documents/picker';

jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(),
  keepLocalCopy: jest.fn(),
  types: { json: 'application/json', images: 'image/*', plainText: 'text/plain', allFiles: '*/*' },
}));

describe('pickLocalFiles', () => {
  beforeEach(() => jest.clearAllMocks());

  test('user cancel returns null', async () => {
    (picker.pick as jest.Mock).mockResolvedValueOnce([]);
    const result = await pickLocalFiles(['application/json']);
    expect(result).toBeNull();
  });

  test('multi-select happy path returns array of local files', async () => {
    (picker.pick as jest.Mock).mockResolvedValueOnce([
      { uri: 'content://a', name: 'a.json', type: 'application/json' },
      { uri: 'content://b', name: 'b.json', type: 'application/json' },
    ]);
    (picker.keepLocalCopy as jest.Mock).mockResolvedValueOnce([
      { status: 'success', localUri: 'file:///cache/a.json' },
      { status: 'success', localUri: 'file:///cache/b.json' },
    ]);
    const result = await pickLocalFiles(['application/json'], 50);
    expect(result).toEqual([
      { localPath: '/cache/a.json', name: 'a.json', mimeType: 'application/json' },
      { localPath: '/cache/b.json', name: 'b.json', mimeType: 'application/json' },
    ]);
  });

  test('individual copy failure is filtered out, others kept', async () => {
    (picker.pick as jest.Mock).mockResolvedValueOnce([
      { uri: 'content://a', name: 'a.json', type: 'application/json' },
      { uri: 'content://b', name: 'b.json', type: 'application/json' },
    ]);
    (picker.keepLocalCopy as jest.Mock).mockResolvedValueOnce([
      { status: 'error', copyError: 'disk full' },
      { status: 'success', localUri: 'file:///cache/b.json' },
    ]);
    const result = await pickLocalFiles(['application/json'], 50);
    expect(result).toEqual([
      { localPath: '/cache/b.json', name: 'b.json', mimeType: 'application/json' },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; npx jest __tests__/fileImportBatch.test.ts --verbose
```

Expected: 失败 — `pickLocalFiles` 不存在

- [ ] **Step 3: 实现 `pickLocalFiles`**

在 `src/services/fileImport.ts` 的 `pickLocalFile` 函数下方添加：

```ts
export interface PickedFile {
  localPath: string;
  name: string;
  mimeType?: string | null;
}

export async function pickLocalFiles(
  allowedTypes: string[],
  max: number = 50,
): Promise<PickedFile[] | null> {
  const selected = await pick({ type: allowedTypes, allowMultiSelection: true, mode: 'import', limit: max });
  if (!selected || selected.length === 0) return null;

  const copies = await keepLocalCopy({
    files: selected.map((s) => ({ uri: s.uri, fileName: s.name || 'shinewriter-import' })),
    destination: 'cachesDirectory',
  });

  const result: PickedFile[] = [];
  for (let i = 0; i < copies.length; i += 1) {
    const copy = copies[i];
    if (copy.status !== 'success') continue;
    const original = selected[i];
    result.push({
      localPath: copy.localUri.replace(/^file:\/\//, ''),
      name: original.name || 'shinewriter-import',
      mimeType: original.type,
    });
  }
  return result;
}
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; npx jest __tests__/fileImportBatch.test.ts --verbose
```

Expected: 3 个测试通过

- [ ] **Step 5: 提交**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; git add src/services/fileImport.ts __tests__/fileImportBatch.test.ts; git commit -m "feat(import): pickLocalFiles 支持多选 + 单文件拷贝容错"
```

---

## Task 2: `importCharacters` 批量导入

**Files:**
- Modify: `src/services/fileImport.ts`（在 `importSelectedCharacter` 下方）

- [ ] **Step 1: 写失败测试**

在 `__tests__/fileImportBatch.test.ts` 追加：

```ts
import * as db from '../src/services/database';
jest.mock('../src/services/database', () => ({
  createCharacter: jest.fn(async (pid, name, stype, data) => 42),
}));
jest.mock('react-native-fs', () => ({
  readFile: jest.fn(async () => '{"spec":"chara_card_v2","data":{"name":"x"}}'),
  DocumentDirectoryPath: '/app/docs',
  mkdir: jest.fn(async () => undefined),
  copyFile: jest.fn(async () => undefined),
}));

import { importCharacters } from '../src/services/fileImport';

describe('importCharacters', () => {
  beforeEach(() => jest.clearAllMocks());

  test('all files succeed', async () => {
    let idCounter = 1;
    (db.createCharacter as jest.Mock).mockImplementation(async () => idCounter++);
    const files = [
      { localPath: '/c/a.json', name: 'a.json', mimeType: 'application/json' },
      { localPath: '/c/b.json', name: 'b.json', mimeType: 'application/json' },
    ];
    const result = await importCharacters(1, files);
    expect(result.total).toBe(2);
    expect(result.success).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.success[0]).toEqual({ fileName: 'a.json', id: 1 });
  });

  test('partial failure returns both success and failed', async () => {
    let idCounter = 1;
    (db.createCharacter as jest.Mock).mockImplementation(async () => {
      if (idCounter === 1) { idCounter += 1; return 1; }
      throw new Error('DB error');
    });
    const files = [
      { localPath: '/c/a.json', name: 'a.json', mimeType: 'application/json' },
      { localPath: '/c/b.json', name: 'b.json', mimeType: 'application/json' },
    ];
    const result = await importCharacters(1, files);
    expect(result.success).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toEqual({ fileName: 'b.json', error: 'DB error' });
  });

  test('empty file list returns empty result', async () => {
    const result = await importCharacters(1, []);
    expect(result).toEqual({ success: [], failed: [], total: 0 });
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; npx jest __tests__/fileImportBatch.test.ts --verbose
```

Expected: 失败 — `importCharacters` 不存在

- [ ] **Step 3: 实现 `importCharacters`**

在 `src/services/fileImport.ts` 的 `importSelectedCharacter` 下方添加：

```ts
export interface BatchImportResult<T> {
  success: Array<{ fileName: string; id: T }>;
  failed: Array<{ fileName: string; error: string }>;
  total: number;
}

async function importOneCharacterFromFile(projectId: number, file: PickedFile): Promise<number> {
  const isPng = isPngSelection(file);
  let payload = isPng
    ? await parseCharacterCardPNG(file.localPath)
    : parseCharacterCardJSON(await RNFS.readFile(file.localPath, 'utf8'), file.name);
  if (isPng) {
    const imagePath = await persistCharacterPngImage(file.localPath, file.name);
    payload = { ...payload, data: withCharacterImageAsset(payload.data, imagePath, file.name) };
  }
  return db.createCharacter(projectId, payload.name, payload.sourceType, JSON.stringify(payload.data));
}

export async function importCharacters(
  projectId: number,
  files: PickedFile[],
): Promise<BatchImportResult<number>> {
  const success: Array<{ fileName: string; id: number }> = [];
  const failed: Array<{ fileName: string; error: string }> = [];
  for (const file of files) {
    try {
      const id = await importOneCharacterFromFile(projectId, file);
      success.push({ fileName: file.name, id });
    } catch (e: any) {
      failed.push({ fileName: file.name, error: String(e?.message || e) });
    }
  }
  return { success, failed, total: files.length };
}
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; npx jest __tests__/fileImportBatch.test.ts --verbose
```

Expected: 全部 6 个测试通过

- [ ] **Step 5: 提交**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; git add src/services/fileImport.ts __tests__/fileImportBatch.test.ts; git commit -m "feat(import): importCharacters 批量导入角色卡"
```

---

## Task 3: `importWorldBooks` 批量导入

**Files:**
- Modify: `src/services/fileImport.ts`

- [ ] **Step 1: 写失败测试**

在 `__tests__/fileImportBatch.test.ts` 追加：

```ts
describe('importWorldBooks', () => {
  beforeEach(() => jest.clearAllMocks());

  test('all files create separate collections', async () => {
    let colId = 1;
    (db.createWorldbookCollection as jest.Mock).mockImplementation(async () => colId++);
    (db.createWorldbookEntry as jest.Mock).mockResolvedValue(undefined);
    (db.updateWorldbookCollectionTokenEstimate as jest.Mock).mockResolvedValue(undefined);

    const files = [
      { localPath: '/c/a.json', name: 'a.json', mimeType: 'application/json' },
      { localPath: '/c/b.json', name: 'b.json', mimeType: 'application/json' },
    ];
    (RNFS.readFile as jest.Mock).mockImplementation(async (path: string) => {
      if (path.endsWith('a.json')) {
        return JSON.stringify({ spec: 'lorebook_v3', data: { name: 'A', entries: [{ keys: ['k1'], content: 'c1' }] } });
      }
      return JSON.stringify({ spec: 'lorebook_v3', data: { name: 'B', entries: [{ keys: ['k2'], content: 'c2' }] } });
    });

    const result = await importWorldBooks(1, files);
    expect(result.success).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.success[0].id.collectionId).toBe(1);
    expect(result.success[1].id.collectionId).toBe(2);
  });

  test('file with no entries goes to failed', async () => {
    (RNFS.readFile as jest.Mock).mockResolvedValueOnce(JSON.stringify({ spec: 'lorebook_v3', data: { name: 'X', entries: [] } }));
    const result = await importWorldBooks(1, [{ localPath: '/c/x.json', name: 'x.json', mimeType: 'application/json' }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain('未找到');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; npx jest __tests__/fileImportBatch.test.ts --verbose
```

Expected: `importWorldBooks` 不存在

- [ ] **Step 3: 补全 mock + 实现**

修改 `__tests__/fileImportBatch.test.ts` 顶部 mock（追加 createWorldbookCollection / createWorldbookEntry / updateWorldbookCollectionTokenEstimate）：

```ts
jest.mock('../src/services/database', () => ({
  createCharacter: jest.fn(async () => 42),
  createWorldbookCollection: jest.fn(async () => 1),
  createWorldbookEntry: jest.fn(async () => 1),
  updateWorldbookCollectionTokenEstimate: jest.fn(async () => undefined),
}));
```

在 `src/services/fileImport.ts` `importSelectedWorldBook` 下方添加：

```ts
export async function importWorldBooks(
  projectId: number,
  files: PickedFile[],
): Promise<BatchImportResult<{ collectionId: number; entriesImported: number }>> {
  const success: Array<{ fileName: string; id: { collectionId: number; entriesImported: number } }> = [];
  const failed: Array<{ fileName: string; error: string }> = [];
  for (const file of files) {
    try {
      const parsed = parseWorldBookJSON(await RNFS.readFile(file.localPath, 'utf8'), file.name);
      const collectionId = await db.createWorldbookCollection(projectId, parsed.name, { enabled: 1 });
      let count = 0;
      for (const entry of parsed.entries) {
        await db.createWorldbookEntry(projectId, entry.keyword_primary, entry.content, entry.enabled, {
          collection_id: collectionId,
          keyword_secondary: entry.keyword_secondary,
          comment: entry.comment,
          constant: entry.constant,
          position: entry.position,
        });
        count += 1;
      }
      await db.updateWorldbookCollectionTokenEstimate(collectionId);
      success.push({ fileName: file.name, id: { collectionId, entriesImported: count } });
    } catch (e: any) {
      failed.push({ fileName: file.name, error: String(e?.message || e) });
    }
  }
  return { success, failed, total: files.length };
}
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; npx jest __tests__/fileImportBatch.test.ts --verbose
```

Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; git add src/services/fileImport.ts __tests__/fileImportBatch.test.ts; git commit -m "feat(import): importWorldBooks 批量导入世界书"
```

---

## Task 4: `importNotes` 批量导入

**Files:**
- Modify: `src/services/fileImport.ts`

- [ ] **Step 1: 写失败测试**

```ts
describe('importNotes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('all files create notes', async () => {
    let firstId = 100;
    (db.createNotesFromTextChunks as jest.Mock).mockImplementation(async () => {
      const ret = { firstId: firstId, createdCount: 3 };
      firstId += 3;
      return ret;
    });
    (RNFS.readFile as jest.Mock).mockResolvedValue('第一段\n\n第二段\n\n第三段');

    const files = [
      { localPath: '/c/a.txt', name: 'a.txt', mimeType: 'text/plain' },
      { localPath: '/c/b.txt', name: 'b.txt', mimeType: 'text/plain' },
    ];
    const result = await importNotes(1, files);
    expect(result.success).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.success[0].id).toEqual({ firstId: 100, createdCount: 3 });
  });

  test('empty txt goes to failed', async () => {
    (RNFS.readFile as jest.Mock).mockResolvedValueOnce('');
    // createNotesFromTextChunks mock returns success even on empty — but our batch relies on its result.
    // Configure to throw for empty case
    (db.createNotesFromTextChunks as jest.Mock).mockRejectedValueOnce(new Error('文件内容为空'));
    const result = await importNotes(1, [{ localPath: '/c/x.txt', name: 'x.txt', mimeType: 'text/plain' }]);
    expect(result.failed).toHaveLength(1);
  });
});
```

补 mock（顶部）：

```ts
jest.mock('../src/services/database', () => ({
  createCharacter: jest.fn(async () => 42),
  createWorldbookCollection: jest.fn(async () => 1),
  createWorldbookEntry: jest.fn(async () => 1),
  updateWorldbookCollectionTokenEstimate: jest.fn(async () => undefined),
  createNotesFromTextChunks: jest.fn(async () => ({ firstId: 1, createdCount: 1 })),
}));
```

- [ ] **Step 2: 跑测试，确认失败**

Expected: `importNotes` 不存在

- [ ] **Step 3: 实现 `importNotes`**

```ts
export async function importNotes(
  projectId: number,
  files: PickedFile[],
): Promise<BatchImportResult<{ firstId: number; createdCount: number }>> {
  const success: Array<{ fileName: string; id: { firstId: number; createdCount: number } }> = [];
  const failed: Array<{ fileName: string; error: string }> = [];
  for (const file of files) {
    try {
      const content = await RNFS.readFile(file.localPath, 'utf8');
      const title = file.name.replace(/\.[^.]+$/, '').trim() || '导入的 TXT 笔记';
      const ret = await db.createNotesFromTextChunks(projectId, title, content);
      success.push({ fileName: file.name, id: ret });
    } catch (e: any) {
      failed.push({ fileName: file.name, error: String(e?.message || e) });
    }
  }
  return { success, failed, total: files.length };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; git add src/services/fileImport.ts __tests__/fileImportBatch.test.ts; git commit -m "feat(import): importNotes 批量导入 TXT 笔记"
```

---

## Task 5: `BatchImportResultModal` 组件

**Files:**
- Create: `src/components/BatchImportResultModal.tsx`
- Create: `__tests__/batchImportModal.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { BatchImportResultModal } from '../src/components/BatchImportResultModal';

describe('BatchImportResultModal', () => {
  test('renders success and failed entries', () => {
    const onClose = jest.fn();
    const { getByText } = render(
      <BatchImportResultModal
        visible
        title="批量导入角色卡"
        success={[{ fileName: 'a.json', id: 1 }, { fileName: 'b.json', id: 2 }]}
        failed={[{ fileName: 'bad.png', error: 'no metadata' }]}
        onClose={onClose}
      />,
    );
    expect(getByText('批量导入角色卡')).toBeTruthy();
    expect(getByText('a.json')).toBeTruthy();
    expect(getByText('bad.png')).toBeTruthy();
    expect(getByText('no metadata')).toBeTruthy();
  });

  test('calls onClose when close button pressed', () => {
    const onClose = jest.fn();
    const { getByText } = render(
      <BatchImportResultModal visible title="t" success={[]} failed={[]} onClose={onClose} />,
    );
    fireEvent.press(getByText('关闭'));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; npx jest __tests__/batchImportModal.test.tsx --verbose
```

Expected: 模块不存在

- [ ] **Step 3: 实现组件**

```tsx
import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button } from './ui';

export interface BatchImportResultModalProps<T = any> {
  visible: boolean;
  title: string;
  success: Array<{ fileName: string; id: T }>;
  failed: Array<{ fileName: string; error: string }>;
  onClose: () => void;
}

export function BatchImportResultModal<T>({ visible, title, success, failed, onClose }: BatchImportResultModalProps<T>) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <View style={styles.summary}>
            <Text style={styles.success}>✅ 成功 {success.length}</Text>
            <Text style={styles.failed}>❌ 失败 {failed.length}</Text>
          </View>
          <ScrollView style={styles.list}>
            {success.map((s, i) => (
              <Text key={`s-${i}`} style={styles.row}>
                ✓ {s.fileName} → ID {String(s.id)}
              </Text>
            ))}
            {failed.map((f, i) => (
              <View key={`f-${i}`} style={styles.failedRow}>
                <Text style={styles.failedName}>✗ {f.fileName}</Text>
                <Text style={styles.failedReason}>{f.error}</Text>
              </View>
            ))}
          </ScrollView>
          <Button label="关闭" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 16 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, maxHeight: '80%' },
  title: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  summary: { flexDirection: 'row', gap: 16, marginBottom: 12 },
  success: { color: '#2e7d32', fontWeight: '500' },
  failed: { color: '#c62828', fontWeight: '500' },
  list: { maxHeight: 360, marginBottom: 12 },
  row: { paddingVertical: 4, color: '#222' },
  failedRow: { paddingVertical: 4 },
  failedName: { color: '#c62828', fontWeight: '500' },
  failedReason: { color: '#666', fontSize: 12, marginLeft: 12 },
});
```

- [ ] **Step 4: 跑测试，确认通过**

Expected: 2 个测试通过

- [ ] **Step 5: 提交**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; git add src/components/BatchImportResultModal.tsx __tests__/batchImportModal.test.tsx; git commit -m "feat(ui): BatchImportResultModal 展示批量导入明细"
```

---

## Task 6: `ResourceLibrary.tsx` UI 接入

**Files:**
- Modify: `src/screens/ResourceLibrary.tsx`

- [ ] **Step 1: 修改 import 列表 + 状态**

在文件顶部 import 后追加：

```tsx
import { pickLocalFiles, importCharacters, importWorldBooks, importNotes, type PickedFile, type BatchImportResult } from '../services/fileImport';
import { BatchImportResultModal } from '../components/BatchImportResultModal';
```

在已有 useState 区域追加：

```tsx
const [batchResult, setBatchResult] = useState<{ title: string; result: BatchImportResult<any> } | null>(null);
```

- [ ] **Step 2: 添加处理函数**

紧邻 `importCharacter` / `importWorldbook` / `importNoteText` 之后追加：

```tsx
const importCharactersBatch = async () => {
  const files = await pickLocalFiles([types.json, types.images], 50);
  if (!files) return;
  try {
    const result = await importCharacters(projectId, files);
    if (result.total === 0) return;
    Toast.show({ type: result.failed.length === 0 ? 'success' : 'info', text1: `角色卡：${result.success.length} 成功 / ${result.failed.length} 失败` });
    if (result.failed.length > 0) setBatchResult({ title: '批量导入角色卡', result });
    await loadData();
  } catch (e: any) {
    Toast.show({ type: 'error', text1: '批量导入失败', text2: e.message });
  }
};

const importWorldbooksBatch = async () => {
  const files = await pickLocalFiles([types.json], 50);
  if (!files) return;
  try {
    const result = await importWorldBooks(projectId, files);
    if (result.total === 0) return;
    Toast.show({ type: result.failed.length === 0 ? 'success' : 'info', text1: `世界书：${result.success.length} 成功 / ${result.failed.length} 失败` });
    if (result.failed.length > 0) setBatchResult({ title: '批量导入世界书', result });
    await loadData();
  } catch (e: any) {
    Toast.show({ type: 'error', text1: '批量导入失败', text2: e.message });
  }
};

const importNotesBatch = async () => {
  const files = await pickLocalFiles([types.plainText, types.allFiles], 50);
  if (!files) return;
  try {
    const result = await importNotes(projectId, files);
    if (result.total === 0) return;
    Toast.show({ type: result.failed.length === 0 ? 'success' : 'info', text1: `TXT 笔记：${result.success.length} 成功 / ${result.failed.length} 失败` });
    if (result.failed.length > 0) setBatchResult({ title: '批量导入 TXT 笔记', result });
    await loadData();
  } catch (e: any) {
    Toast.show({ type: 'error', text1: '批量导入失败', text2: e.message });
  }
};
```

- [ ] **Step 3: 按钮接入**

在角色卡 tab 按钮旁追加（在 `Button label="导入角色卡" ...` 同一 row）：

```tsx
<Button label="批量导入角色卡" icon={Import} variant="secondary" onPress={importCharactersBatch} />
```

在世界书 tab 按钮旁追加：

```tsx
<Button label="批量导入世界书" icon={Import} variant="secondary" onPress={importWorldbooksBatch} />
```

在笔记 tab 按钮旁追加：

```tsx
<Button label="批量导入 TXT" icon={Import} variant="secondary" onPress={importNotesBatch} />
```

- [ ] **Step 4: Modal 挂载**

在主 `View` 内、靠近末尾追加：

```tsx
{batchResult ? (
  <BatchImportResultModal
    visible
    title={batchResult.title}
    success={batchResult.result.success}
    failed={batchResult.result.failed}
    onClose={() => setBatchResult(null)}
  />
) : null}
```

- [ ] **Step 5: 跑现有 resourceLibraryNoteMode 测试，确认 UI 没坏**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; npx jest __tests__/resourceLibraryNoteMode.test.tsx --verbose
```

Expected: 全部通过

- [ ] **Step 6: 提交**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; git add src/screens/ResourceLibrary.tsx; git commit -m "feat(ui): ResourceLibrary 接入批量导入按钮 + ResultModal"
```

---

## Task 7: 全量回归

- [ ] **Step 1: 跑全部测试**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; npm test 2>&1 | Tee-Object -FilePath "$env:TEMP\jest-batch-final.log"
```

Expected: 全量通过，无回归

- [ ] **Step 2: 跑 lint**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; npm run lint 2>&1 | Tee-Object -FilePath "$env:TEMP\lint-batch.log"
```

Expected: 无 error（warning 可接受）

- [ ] **Step 3: 修复任何 lint error**

如有，逐条修复。

- [ ] **Step 4: 最终 commit**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; git add -A; git status; git commit -m "chore: batch import lint + regression fixups" 2>&1
```

---

## Task 8: 推送远端 main

- [ ] **Step 1: 验证本地 main 与 origin 一致**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; git fetch origin; echo "local: $(git rev-parse HEAD)"; echo "remote: $(git rev-parse origin/main)"
```

- [ ] **Step 2: 推送**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; git push origin main
```

- [ ] **Step 3: 验证远端**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; git fetch origin; echo "remote HEAD: $(git log --oneline origin/main -3)"
```

Expected: 看到本次提交的多个 commit 已在 origin/main

---