# 批量导入设计 — 角色卡 / 世界书 / 笔记

**日期**：2026-07-03
**项目**：ShineWriter V2.3.0
**范围**：`src/services/fileImport.ts` + `src/screens/ResourceLibrary.tsx`

## 背景

当前 `fileImport.ts` 提供 3 个单文件导入函数：

| 函数 | 入参 | 支持格式 |
|---|---|---|
| `importSelectedCharacter(projectId)` | 系统 picker 选单个文件 | JSON / PNG |
| `importSelectedWorldBook(projectId)` | 同上 | JSON (lorebook_v3 / chara_card_v*) |
| `importSelectedNoteText(projectId)` | 同上 | TXT / 纯文本 |

UI 层每个 tab 各有一个"导入"按钮（`ResourceLibrary.tsx`），每次只能选 1 个文件。

**用户痛点**：作者常常积累了几十张角色卡、几本世界书、十几份笔记资料，逐个导入费时费力。

## 目标

让三类导入支持**文件多选**：一次选 N 个同类型文件（N ≤ 50），部分成功时给出明细报告。

## 非目标（YAGNI）

- **不做文件夹导入**：暂不支持扫一个目录
- **不做跨类型混合**：一次调用只处理一种类型
- **不做合并去重**：每个 JSON 世界书生成独立合集，不跨文件合并
- **不做进度条/取消**：N ≤ 50 串行处理 < 5 秒，无须进度
- **不做预解析再入库**：单文件函数已自带 partial cleanup，串行调用足够

## 架构

### 调用链

```
ResourceLibrary.tsx
    │
    │ 用户点「批量导入角色卡」→ fileImport.pickLocalFiles([json, images], 50)
    │
    ▼
fileImport.ts（新增）
    │
    └─ importCharacters(projectId, files[])
        │
        └─ for-loop 串行调 importSelectedCharacter()
           返回 { success: [{fileName, id}], failed: [{fileName, error}] }
    │
    ▼
ResourceLibrary.tsx 收到结果 →
    Toast.show("导入完成 X 个成功 Y 个失败")
    失败 > 0 时弹 ResultModal 显示明细
```

### 设计原则

- **薄包装**：batch 函数仅做"多选 + 串行循环 + 结果聚合"
- **不重写解析**：复用单文件函数的 `parseCharacterCardJSON` / `parseCharacterCardPNG` / `parseWorldBookJSON` / `db.createNotesFromTextChunks`
- **同位置**：batch 函数放在 `fileImport.ts` 紧邻单文件版本
- **同接口**：三个 batch 函数返回结构一致（见下）
- **旧函数保留**：单文件 `importSelected*` 不删（向后兼容）

## 接口设计

### `pickLocalFiles(allowedTypes, max)`

```ts
async function pickLocalFiles(
  allowedTypes: string[],
  max: number = 50,
): Promise<Array<{ localPath: string; name: string; mimeType?: string | null }> | null>
```

行为：
- `pick({ type: allowedTypes, allowMultiSelection: true, mode: 'import', limit: max })`
- 用户取消 → 返回 `null`
- 用户选了 N 个文件 → 走 `keepLocalCopy` 全部拷贝到 caches，返回数组
- 复制时单个失败 → 该文件不返回，其它仍正常（不抛错中断整体）

### `BatchImportResult<T>`

```ts
interface BatchImportResult<T> {
  success: Array<{ fileName: string; id: T }>;   // 成功条目
  failed: Array<{ fileName: string; error: string }>;  // 失败条目（含原因）
  total: number;
}
```

`id` 类型因导入类型而异：
- 角色卡：`number`（`db.createCharacter` 返回主键）
- 世界书：`{ collectionId: number; entriesImported: number }`（保留 `entriesImported` 给 UI 提示）
- 笔记：`{ firstId: number; createdCount: number }`（与现有 `importSelectedNoteText` 返回一致）

### 三个 batch 函数

```ts
export async function importCharacters(
  projectId: number,
  files: PickedFile[],
): Promise<BatchImportResult<number>>;

export async function importWorldBooks(
  projectId: number,
  files: PickedFile[],
): Promise<BatchImportResult<{ collectionId: number; entriesImported: number }>>;

export async function importNotes(
  projectId: number,
  files: PickedFile[],
): Promise<BatchImportResult<{ firstId: number; createdCount: number }>>;
```

**串行实现**（伪代码）：

```ts
export async function importCharacters(projectId, files) {
  const success = [];
  const failed = [];
  for (const file of files) {
    try {
      const id = await importOneCharacter(projectId, file);  // 内部调现有 parseCharacterCardJSON/PNG + createCharacter
      success.push({ fileName: file.name, id });
    } catch (e: any) {
      failed.push({ fileName: file.name, error: e.message });
    }
  }
  return { success, failed, total: files.length };
}
```

世界书特殊处理：现有 `importSelectedWorldBook` 已有"partial 失败 → 删 collection"的回退，但**批量场景不期望回退**（一个失败不应撤销其它成功），所以直接复用 `importWorldBookFromJSON` 路径（不走 user picker），由 batch 函数逐个调用。

## 错误处理

| 场景 | 处理 |
|---|---|
| 用户取消 picker | 返回 `null`，UI 不弹 Toast |
| `files.length === 0` | 边界：picker 库不应返回空数组；防御性返回 `{ success: [], failed: [], total: 0 }` |
| 单文件解析失败（角色卡格式错 / PNG 无 tEXt / TXT 空 / 世界书无 entry） | catch → 进 `failed[]` |
| 单文件写库失败（DB 异常） | catch → 进 `failed[]` |
| 拷贝文件失败 | 不进 `failed[]`（文件根本没复制成功，从 `pickLocalFiles` 返回中已剔除） |
| 全部失败 | 仍然返回 `BatchImportResult`，由 UI Toast 报"0 成功 N 失败" |

**不做**：批量过程中断/取消（50 文件串行几秒完成，无必要）。

## UI 改动

### 按钮（`ResourceLibrary.tsx`）

现有按钮：
```
角色卡 tab:  [导入角色卡]  [新建角色卡]
世界书 tab:  [导入世界书]  [新建世界书]
笔记 tab:    [导入 TXT 笔记]
```

新增按钮（紧邻现有"导入"按钮）：
```
角色卡 tab:  [批量导入角色卡]
世界书 tab:  [批量导入世界书]
笔记 tab:    [批量导入 TXT]
```

按钮复用 `Button` 组件，icon 复用 `Import`，label 加"批量"前缀；事件处理函数 3 个。

### ResultModal 组件（新增）

新增 `src/components/BatchImportResultModal.tsx`：

```ts
interface Props {
  visible: boolean;
  title: string;             // e.g. "批量导入角色卡"
  success: Array<{ fileName: string; id: any }>;
  failed: Array<{ fileName: string; error: string }>;
  onClose: () => void;
}
```

展示：
- 顶部状态徽章：✅ N 个成功 / ❌ M 个失败
- 成功区：文件名 + ID（如"林夏.json → ID 42"）
- 失败区：文件名 + 错误原因（红色行）
- 底部"关闭"按钮

UI 库复用以 `Modal` 为基础的现有 `Modal` 组件或 RN 原生 `Modal`（已在 ResourceLibrary.tsx 用过）。

### 调用流程（UI）

```ts
const importCharactersBatch = async () => {
  const files = await pickLocalFiles([types.json, types.images], 50);
  if (!files) return;
  setBatchImporting(true);
  try {
    const result = await importCharacters(projectId, files);
    if (result.total === 0) return;  // 防御性
    const text = `导入完成：${result.success.length} 成功 / ${result.failed.length} 失败`;
    Toast.show({ type: result.failed.length === 0 ? 'success' : 'info', text1: text });
    if (result.failed.length > 0) {
      setBatchResult({ title: '批量导入角色卡', ...result });
    }
    await loadData();
  } catch (e: any) {
    Toast.show({ type: 'error', text1: '批量导入失败', text2: e.message });
  } finally {
    setBatchImporting(false);
  }
};
```

## 测试

### 单元测试（`__tests__/fileImportBatch.test.ts`，新增）

每个 batch 函数 2-3 个用例：

| 函数 | 用例 |
|---|---|
| `importCharacters` | 全成功、混合成功失败（PNG 无 tEXt 触发错）、空数组 |
| `importWorldBooks` | 全成功、单文件解析错（无 entry）、混合 |
| `importNotes` | 全成功、TXT 为空触发错、混合 |
| `pickLocalFiles` | 用户取消、limit 截断、单文件拷贝失败被剔除 |

**Mock 策略**：
- `pick` / `keepLocalCopy`：`jest.mock('@react-native-documents/picker', ...)` 返回受控数据
- `RNFS.readFile`：mock 返回受控文本
- `db.createCharacter` 等：mock 返回递增 ID
- 现有单文件函数的依赖全部沿用现有 mock

### 组件测试（`__tests__/batchImportModal.test.tsx`，新增）

- 全部成功：弹 Toast"info"型、不显示 Modal
- 部分失败：弹 Toast + 显示 Modal、列表内容正确
- 全部失败：Toast、Modal 全显示
- 关闭按钮：调用 `onClose`

### 回归

跑全量 `npm test`，确保原有 210 个用例不破。

## 风险与回退

| 风险 | 缓解 |
|---|---|
| SQLite 串行写 N 条慢 | 实测 50 文件 < 5s，无须并发；如有性能问题加并发 |
| 大 PNG 角色卡 base64 内存压力 | 已有 `PngMetadata` 原生模块走原生路径，规避 base64 |
| 用户选 50+ 文件 | picker `limit: 50` 强约束，超出 picker UI 限制选择 |
| 部分失败 → 用户疑惑 | ResultModal 明细 + Toast 计数 |

## 改动清单

| 文件 | 类型 | 估算行数 |
|---|---|---|
| `src/services/fileImport.ts` | 修改（新增 4 个函数） | +60 行 |
| `src/screens/ResourceLibrary.tsx` | 修改（新增按钮 + 处理函数） | +80 行 |
| `src/components/BatchImportResultModal.tsx` | 新增 | +90 行 |
| `__tests__/fileImportBatch.test.ts` | 新增 | +120 行 |
| `__tests__/batchImportModal.test.tsx` | 新增 | +80 行 |
| `__tests__/resourceLibraryNoteMode.test.tsx` | 可能需更新 mock | 待评估 |