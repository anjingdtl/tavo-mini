# ShineWriter Personal Novel Workbench Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分三个可独立发布的阶段，把 ShineWriter 升级为防丢、可恢复、可解释并适合长篇个人创作的 Android 小说工作台。

**Architecture:** 保持 React Native + Zustand + SQLite 的现有结构，所有业务数据继续通过 `services/database.ts` 访问。新增版本历史、生成草稿、上下文追踪、管线恢复、搜索与统计等聚焦服务，每个阶段通过独立数据库迁移增量交付。

**Tech Stack:** React Native 0.85, TypeScript, Zustand 5, react-native-sqlite-storage, react-native-fs, React Navigation 7, Jest, Testing Library

**Spec:** `docs/superpowers/specs/2026-06-13-personal-novel-workbench-optimization-design.md`

---

## 交付顺序

| Release | Tasks | Schema | 交付主题 |
|---|---|---:|---|
| V1.4 | 1-6 | 6 | 防丢保存、版本历史、备份恢复、项目导入 |
| V1.5 | 7-11 | 7 | 上下文预览、生成草稿、管线续跑、批量采纳 |
| V1.6 | 12-16 | 8 | 搜索排序、故事统计、用量统计、专注模式、工程治理 |

每个 release 完成后必须运行全量 Jest、lint 和 debug APK 构建。不要跨阶段提前修改
后续 schema。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/utils/debounce.ts` | 异步防抖与 flush |
| `src/types/revision.ts` | 版本历史类型 |
| `src/services/revisionService.ts` | 快照创建、清理和恢复 |
| `src/screens/RevisionHistoryScreen.tsx` | 历史浏览和恢复 |
| `src/services/backupService.ts` | 备份 v2、校验、清单和事务恢复 |
| `src/screens/BackupCenterScreen.tsx` | 手动备份恢复 UI |
| `src/services/projectImport.ts` | 项目包校验和事务导入 |
| `src/types/contextTrace.ts` | 上下文追踪类型 |
| `src/services/contextInspector.ts` | 上下文汇总与展示转换 |
| `src/screens/ContextPreviewScreen.tsx` | 生成前上下文预览 |
| `src/types/generationDraft.ts` | 生成草稿类型 |
| `src/services/generationDraftService.ts` | 草稿持久化与采纳 |
| `src/screens/GenerationPreviewScreen.tsx` | 原文/生成文预览与采纳 |
| `src/services/pipelineResume.ts` | 恢复点计算和续跑 |
| `src/services/searchService.ts` | 项目内搜索 |
| `src/services/analyticsService.ts` | 故事和 LLM 用量聚合 |
| `src/screens/ProjectSearchScreen.tsx` | 搜索 UI |
| `src/screens/UsageStatsScreen.tsx` | 用量统计 UI |

---

## Phase 1 / V1.4：数据安全与可恢复

### Task 1: 建立基线并修复版本检测测试

**Files:**
- Modify: `__tests__/installTypeDetection.test.ts`
- Modify: `src/components/CharacterEditor.tsx`

- [ ] **Step 1: 将硬编码版本改为动态当前版本**

```ts
const currentVersion = require('../src/constants/version.json').versionName.replace(/^V/, '');

test('detects same version when stored version = current version', async () => {
  const { db, settings } = createMockDb({
    app_version: currentVersion,
    schema_version: '5',
    first_install_version: '1.0.0',
  });
  const { detectInstallType } = require('../src/services/database');
  const info = await detectInstallType(db as any);
  expect(info.installType).toBe('same');
  expect(settings.get('install_type')).toBe('same');
});
```

- [ ] **Step 2: 运行失败测试并确认恢复**

Run: `npx jest __tests__/installTypeDetection.test.ts --runInBand`

Expected: 3 tests PASS。

- [ ] **Step 3: 将 CharacterEditor 的两个 `borderBottomWidth: 2` inline style 移入 StyleSheet**

新增 `styles.activeTab` 并在两处引用，保持视觉不变。

- [ ] **Step 4: 验证基线**

Run: `npm test -- --runInBand`

Expected: 15 suites、54 tests 全部 PASS。

Run: `npm run lint`

Expected: 0 errors、0 warnings。

- [ ] **Step 5: Commit**

```powershell
git add __tests__/installTypeDetection.test.ts src/components/CharacterEditor.tsx
git commit -m "test: stabilize version detection baseline"
```

### Task 2: 实现可 flush 的异步防抖

**Files:**
- Modify: `src/utils/debounce.ts`
- Create: `__tests__/debounce.test.ts`

- [ ] **Step 1: 编写失败测试**

```ts
import { debounce } from '../src/utils/debounce';

test('flush persists the latest pending arguments exactly once', async () => {
  jest.useFakeTimers();
  const save = jest.fn(async (_id: number, _text: string) => {});
  const controller = debounce(save, 900);
  controller.call(1, 'a');
  controller.call(1, 'latest');
  expect(controller.pending()).toBe(true);
  await controller.flush();
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith(1, 'latest');
  expect(controller.pending()).toBe(false);
});

test('flush surfaces save failures', async () => {
  const controller = debounce(async () => {
    throw new Error('write failed');
  }, 900);
  controller.call();
  await expect(controller.flush()).rejects.toThrow('write failed');
});
```

- [ ] **Step 2: 验证测试失败**

Run: `npx jest __tests__/debounce.test.ts --runInBand`

Expected: FAIL，现有返回值没有 `flush` 和 `pending`。

- [ ] **Step 3: 实现控制器**

```ts
export interface DebouncedAsync<TArgs extends unknown[]> {
  call: (...args: TArgs) => void;
  flush: () => Promise<void>;
  cancel: () => void;
  pending: () => boolean;
}

export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void | Promise<void>,
  delay: number,
): DebouncedAsync<TArgs> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latestArgs: TArgs | null = null;
  let running: Promise<void> | null = null;

  const execute = async () => {
    if (!latestArgs) return;
    const args = latestArgs;
    latestArgs = null;
    if (timer) clearTimeout(timer);
    timer = null;
    running = Promise.resolve(fn(...args));
    try {
      await running;
    } finally {
      running = null;
    }
  };

  return {
    call: (...args) => {
      latestArgs = args;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void execute(), delay);
    },
    flush: async () => {
      if (running) await running;
      if (latestArgs) await execute();
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      latestArgs = null;
    },
    pending: () => latestArgs !== null || running !== null,
  };
}
```

- [ ] **Step 4: 运行测试**

Run: `npx jest __tests__/debounce.test.ts --runInBand`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add src/utils/debounce.ts __tests__/debounce.test.ts
git commit -m "feat: add flushable async debounce"
```

### Task 3: 新增 schema 6 与正文版本历史

**Files:**
- Create: `src/services/migrations/v5-to-v6.ts`
- Modify: `src/services/migrations/index.ts`
- Modify: `src/services/database.ts`
- Modify: `src/services/backupService.ts`
- Create: `src/types/revision.ts`
- Create: `src/services/revisionService.ts`
- Create: `__tests__/revisionService.test.ts`
- Modify: `__tests__/migrationEngine.test.ts`

- [ ] **Step 1: 编写 schema 与服务失败测试**

测试必须覆盖：

```ts
test('skips duplicate adjacent revisions', async () => {});
test('keeps automatic revisions within 50 per target', async () => {});
test('restores chapter content after creating before_restore snapshot', async () => {});
test('migration v5 to v6 creates content_revisions and target index', async () => {});
```

Run: `npx jest __tests__/revisionService.test.ts __tests__/migrationEngine.test.ts --runInBand`

Expected: FAIL，迁移和服务不存在。

- [ ] **Step 2: 定义类型**

```ts
export type RevisionTargetType = 'chapter' | 'freeform';
export type RevisionSource =
  | 'manual_checkpoint'
  | 'before_clear'
  | 'before_ai_replace'
  | 'before_pipeline_accept'
  | 'before_restore'
  | 'before_batch_replace'
  | 'before_import_replace';

export interface ContentRevision {
  id: number;
  projectId: number;
  targetType: RevisionTargetType;
  targetId: number;
  title: string;
  content: string;
  source: RevisionSource;
  sourceRef: string | null;
  createdAt: string;
}
```

- [ ] **Step 3: 增加迁移**

`v5-to-v6.ts` 创建 spec 中的 `content_revisions` 表和
`idx_content_revisions_target`。在迁移注册表加入：

```ts
{ from: 5, to: 6, breaking: false, migrate: migrateV5toV6 }
```

并将 `SCHEMA_VERSION` 更新为 `6`。

- [ ] **Step 4: 在 database.ts 增加 CRUD**

新增：

```ts
createContentRevision(fields)
getContentRevisions(targetType, targetId)
getLatestContentRevision(targetType, targetId)
deleteContentRevision(id)
trimContentRevisions(targetType, targetId)
```

所有 SQL 仍位于 `database.ts`。`revisionService.ts` 负责去重、保留策略和恢复
编排。

- [ ] **Step 5: 将新表加入备份白名单**

在 `backupService.ts` 的表清单加入 `content_revisions`，并更新备份格式测试，保证
升级备份和手动备份都包含历史数据。

- [ ] **Step 6: 运行测试**

Run: `npx jest __tests__/revisionService.test.ts __tests__/migrationEngine.test.ts --runInBand`

Expected: PASS。

- [ ] **Step 7: Commit**

```powershell
git add src/services/migrations src/services/database.ts src/services/backupService.ts src/types/revision.ts src/services/revisionService.ts __tests__/revisionService.test.ts __tests__/migrationEngine.test.ts
git commit -m "feat: add recoverable content revision history"
```

### Task 4: 编辑器防丢保存与历史页面

**Files:**
- Modify: `src/screens/ChapterEditor.tsx`
- Modify: `src/screens/FreeformEditor.tsx`
- Create: `src/screens/RevisionHistoryScreen.tsx`
- Modify: `src/navigation/TabNavigator.tsx`
- Create: `__tests__/editorPersistence.test.tsx`
- Create: `__tests__/revisionHistoryScreen.test.tsx`

- [ ] **Step 1: 编写组件失败测试**

```tsx
test('chapter editor flushes pending content before closing', async () => {
  // render, change content, press 返回, assert updateChapter with latest text
});

test('chapter editor stays open when flush fails', async () => {
  // reject updateChapter, press 返回, assert onClose not called
});

test('restoring a revision updates content and preserves current text', async () => {
  // press 恢复, assert before_restore snapshot then update
});
```

- [ ] **Step 2: 重构编辑器保存状态**

两个编辑器使用：

```ts
type SaveStatus = 'saved' | 'saving' | 'failed';
```

实现 `flushAndClose()`，AppState 进入 `background`/`inactive` 时调用
`flush()`。卸载 cleanup 不执行异步导航，但必须触发 `void flush()`，不能再
直接 `cancel()`。

- [ ] **Step 3: 接入高风险快照**

- 清空正文前：`before_clear`
- 流水线采纳前：`before_pipeline_accept`
- 未来生成替换共用：`before_ai_replace`
- 手动“保存版本”：`manual_checkpoint`

- [ ] **Step 4: 注册历史页面**

```ts
RevisionHistory: {
  targetType: 'chapter' | 'freeform';
  targetId: number;
  projectId: number;
};
```

章节和自由写作工具区新增“历史”入口。

- [ ] **Step 5: 验证**

Run: `npx jest __tests__/editorPersistence.test.tsx __tests__/revisionHistoryScreen.test.tsx --runInBand`

Expected: PASS。

- [ ] **Step 6: Commit**

```powershell
git add src/screens/ChapterEditor.tsx src/screens/FreeformEditor.tsx src/screens/RevisionHistoryScreen.tsx src/navigation/TabNavigator.tsx __tests__/editorPersistence.test.tsx __tests__/revisionHistoryScreen.test.tsx
git commit -m "feat: protect editor saves and expose revision history"
```

### Task 5: 备份 v2 与备份中心

**Files:**
- Modify: `src/services/backupService.ts`
- Modify: `src/services/database.ts`
- Create: `src/screens/BackupCenterScreen.tsx`
- Modify: `src/screens/SettingsScreen.tsx`
- Modify: `src/navigation/TabNavigator.tsx`
- Modify: `__tests__/backupService.test.ts`
- Create: `__tests__/BackupCenterScreen.test.tsx`

- [ ] **Step 1: 扩展失败测试**

覆盖：

```ts
test('rejects backup with missing required tables before deleting data', async () => {});
test('restores all tables in one transaction', async () => {});
test('creates a pre_restore backup before restore', async () => {});
test('lists only valid backup files ordered newest first', async () => {});
```

- [ ] **Step 2: 实现备份 v2 API**

```ts
export interface BackupSummary {
  path: string;
  kind: 'automatic' | 'manual' | 'pre_restore';
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  size: number;
  valid: boolean;
}

export async function validateBackup(path: string): Promise<BackupValidation>;
export async function listBackups(): Promise<BackupSummary[]>;
export async function createManualBackup(db: SQLite.SQLiteDatabase): Promise<string>;
export async function restoreValidatedBackup(db: SQLite.SQLiteDatabase, path: string): Promise<void>;
export async function deleteBackup(path: string): Promise<void>;
```

checksum 使用稳定序列化文本的项目内确定性 hash；不要新增加密依赖。恢复调用
`database.transaction`，表删除顺序先子表后父表，插入顺序相反。

- [ ] **Step 3: 创建 BackupCenterScreen**

页面提供创建、查看元数据、恢复和删除。恢复按钮必须经过确认，校验失败时禁用。

- [ ] **Step 4: 验证**

Run: `npx jest __tests__/backupService.test.ts __tests__/BackupCenterScreen.test.tsx --runInBand`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add src/services/backupService.ts src/services/database.ts src/screens/BackupCenterScreen.tsx src/screens/SettingsScreen.tsx src/navigation/TabNavigator.tsx __tests__/backupService.test.ts __tests__/BackupCenterScreen.test.tsx
git commit -m "feat: add validated transactional backup center"
```

### Task 6: 项目包导入与 V1.4 验证

**Files:**
- Create: `src/services/projectImport.ts`
- Modify: `src/services/exportService.ts`
- Modify: `src/screens/ProjectListScreen.tsx`
- Create: `__tests__/projectImport.test.ts`
- Modify: `jest.setup.js`

- [ ] **Step 1: 编写导入失败测试**

覆盖 v1/v2 解析、非法 spec、ID 映射、事务回滚、API Key/任务/用量不导入。

- [ ] **Step 2: 实现导入合同**

```ts
export interface ProjectImportPreview {
  specVersion: 1 | 2;
  name: string;
  mode: ProjectMode;
  chapterCount: number;
  resourceCount: number;
}

export function parseProjectPackage(text: string): ParsedProjectPackage;
export async function importProjectPackage(pkg: ParsedProjectPackage): Promise<number>;
export async function pickAndPreviewProjectPackage(): Promise<{
  preview: ProjectImportPreview;
  pkg: ParsedProjectPackage;
} | null>;
```

`importProjectPackage` 必须调用 `database.ts` 提供的 transaction 导入 API，不在
服务中散写 SQL。

- [ ] **Step 3: 更新导出为 v2**

导出保留项目、章节、片段、情节线及关联、角色、世界书、笔记、预设和项目上下文
配置；不导出密钥、任务和用量日志。

- [ ] **Step 4: 项目页增加“导入”**

预览确认后导入为新项目并自动选中。

- [ ] **Step 5: V1.4 验证**

先将 `package.json` 版本更新为 `1.4.0`，运行 `npm install --package-lock-only`
同步 lockfile，再执行以下命令。

Run: `npm test -- --runInBand`

Expected: 全部 PASS。

Run: `npm run lint`

Expected: 0 errors。

Run: `npm run apk:debug`

Expected: `dist/apk/debug/ShineWriter-V1.4.0-debug.apk` 存在。

- [ ] **Step 6: Commit**

```powershell
git add src/services/projectImport.ts src/services/exportService.ts src/screens/ProjectListScreen.tsx src/services/database.ts __tests__/projectImport.test.ts jest.setup.js package.json
git commit -m "feat: complete v1.4 data safety release"
```

---

## Phase 2 / V1.5：AI 可解释与可续跑

### Task 7: 上下文追踪模型

**Files:**
- Create: `src/types/contextTrace.ts`
- Modify: `src/services/contextBuilder.ts`
- Create: `src/services/contextInspector.ts`
- Modify: `__tests__/writingContextEnhancements.test.ts`
- Create: `__tests__/contextInspector.test.ts`

- [ ] **Step 1: 编写失败测试**

测试章节、记忆、角色、笔记、世界书常驻/关键词/递归命中、裁剪项和总 token。

- [ ] **Step 2: 实现 trace 类型与构建**

将 `buildResourceContext` 的内部结果改为 `{ text, trace }`。每个候选来源都记录
`included`、`clipped`、`reason` 和 token。保持原 `messages` 内容不变，避免生成
质量回归。

- [ ] **Step 3: 验证**

Run: `npx jest __tests__/writingContextEnhancements.test.ts __tests__/contextInspector.test.ts --runInBand`

Expected: PASS，既有消息断言不变。

- [ ] **Step 4: Commit**

```powershell
git add src/types/contextTrace.ts src/services/contextBuilder.ts src/services/contextInspector.ts __tests__/writingContextEnhancements.test.ts __tests__/contextInspector.test.ts
git commit -m "feat: trace effective generation context"
```

### Task 8: 上下文预览页面

**Files:**
- Create: `src/screens/ContextPreviewScreen.tsx`
- Modify: `src/navigation/TabNavigator.tsx`
- Modify: `src/screens/ChapterEditor.tsx`
- Modify: `src/screens/FreeformEditor.tsx`
- Modify: `src/screens/OutlineEditor.tsx`
- Create: `__tests__/ContextPreviewScreen.test.tsx`

- [ ] **Step 1: 编写页面测试**

验证分类汇总、被裁剪项、展开预览和“使用此上下文生成”回调。

- [ ] **Step 2: 注册路由**

```ts
ContextPreview: {
  targetType: 'chapter' | 'freeform' | 'batch';
  targetId: number;
  batchCount?: number;
  batchOutline?: string;
};
```

- [ ] **Step 3: 改造生成入口**

章节、自由续写、流水线和批量生成先进入预览；预览页确认后才调用生成服务。

- [ ] **Step 4: 验证并提交**

Run: `npx jest __tests__/ContextPreviewScreen.test.tsx --runInBand`

```powershell
git add src/screens/ContextPreviewScreen.tsx src/navigation/TabNavigator.tsx src/screens/ChapterEditor.tsx src/screens/FreeformEditor.tsx src/screens/OutlineEditor.tsx __tests__/ContextPreviewScreen.test.tsx
git commit -m "feat: preview AI context before generation"
```

### Task 9: schema 7 与生成草稿

**Files:**
- Create: `src/services/migrations/v6-to-v7.ts`
- Modify: `src/services/migrations/index.ts`
- Create: `src/types/generationDraft.ts`
- Modify: `src/services/database.ts`
- Modify: `src/services/backupService.ts`
- Create: `src/services/generationDraftService.ts`
- Create: `__tests__/generationDraftService.test.ts`

- [ ] **Step 1: 编写失败测试**

覆盖草稿创建、重启后读取、追加采纳、替换采纳、采纳前 revision、放弃和重复采纳
保护。

- [ ] **Step 2: 新增 `generation_drafts` 与 pipeline 扩展列**

按 spec 执行 v6 -> v7 migration，更新 `SCHEMA_VERSION = 7`。

- [ ] **Step 3: 实现服务**

```ts
export async function createGenerationDraft(input: CreateGenerationDraftInput): Promise<string>;
export async function acceptGenerationDraft(id: string, action: 'append' | 'replace'): Promise<void>;
export async function rejectGenerationDraft(id: string): Promise<void>;
export async function getPendingGenerationDrafts(projectId: number): Promise<GenerationDraft[]>;
```

采纳操作必须检查 `status === 'pending'` 并在 transaction 中完成 revision、正文更新
和 draft 状态更新。

- [ ] **Step 4: 更新备份表清单**

将 `generation_drafts` 加入备份白名单。扩展后的 `pipeline_tasks` 会随原表自动备份。

- [ ] **Step 5: 验证并提交**

Run: `npx jest __tests__/generationDraftService.test.ts __tests__/migrationEngine.test.ts --runInBand`

```powershell
git add src/services/migrations src/types/generationDraft.ts src/services/database.ts src/services/backupService.ts src/services/generationDraftService.ts __tests__/generationDraftService.test.ts __tests__/migrationEngine.test.ts
git commit -m "feat: persist reviewable AI generation drafts"
```

### Task 10: 生成预览与批量采纳

**Files:**
- Create: `src/screens/GenerationPreviewScreen.tsx`
- Modify: `src/services/chapterGeneration.ts`
- Modify: `src/services/batchChapterPipeline.ts`
- Modify: `src/screens/PipelineResultScreen.tsx`
- Modify: `src/screens/PipelineTaskScreen.tsx`
- Modify: `src/navigation/TabNavigator.tsx`
- Create: `__tests__/GenerationPreviewScreen.test.tsx`
- Modify: `__tests__/batchChapterPipeline.test.ts`

- [ ] **Step 1: 编写失败测试**

验证生成只创建 pending draft、不直接写正文；替换/追加/放弃；批量全部采纳和单章
失败隔离。

- [ ] **Step 2: 创建预览页面**

实现原文、生成、并排三种视图和段落级摘要。不要引入 diff 依赖。

- [ ] **Step 3: 改造生成服务**

所有普通续写、流水线结果和批量结果先写 `generation_drafts`。移除
`batchChapterPipeline.ts` 中直接 `updateChapter(content)` 的路径。

- [ ] **Step 4: 验证并提交**

Run: `npx jest __tests__/GenerationPreviewScreen.test.tsx __tests__/batchChapterPipeline.test.ts --runInBand`

```powershell
git add src/screens/GenerationPreviewScreen.tsx src/services/chapterGeneration.ts src/services/batchChapterPipeline.ts src/screens/PipelineResultScreen.tsx src/screens/PipelineTaskScreen.tsx src/navigation/TabNavigator.tsx __tests__/GenerationPreviewScreen.test.tsx __tests__/batchChapterPipeline.test.ts
git commit -m "feat: preview and selectively accept generated text"
```

### Task 11: 管线断点续跑与 V1.5 验证

**Files:**
- Modify: `src/types/pipeline.ts`
- Modify: `src/store/pipelineTaskStore.ts`
- Modify: `src/services/pipelineRunner.ts`
- Create: `src/services/pipelineResume.ts`
- Modify: `src/main/index.tsx`
- Modify: `src/screens/PipelineTaskScreen.tsx`
- Modify: `__tests__/pipelineRunner.test.ts`
- Create: `__tests__/pipelineResume.test.ts`

- [ ] **Step 1: 编写恢复决策测试**

```ts
test.each([
  [['draft'], 'review'],
  [['draft', 'review'], 'factCheck'],
  [['draft', 'factCheck'], 'review'],
  [['draft', 'review', 'factCheck'], 'proof'],
  [['draft', 'review', 'factCheck', 'proof'], 'complete'],
])('chooses the first required missing stage', (stages, expected) => {});
```

另测 `noReview`、`twoStage`、`conditional` 和 `full` 四种模式。

- [ ] **Step 2: 扩展任务类型**

新增 `interrupted` 状态，以及 `projectId`、`pipelineMode`、`inputSnapshot`、
`contextTrace`、`resumeFrom`、`attemptCount`。

- [ ] **Step 3: 实现 resumePipelineTask**

恢复只调用缺失阶段；已有成功结果按 stage 名读取，失败 attempt 追加而非覆盖。恢复
使用 `inputSnapshot`，不得重新读取当前章节作为输入。

- [ ] **Step 4: 改造 AppState 与任务中心**

进入后台不立即判失败；下次启动/回前台把遗留 running 状态转为
`interrupted`。任务卡提供“继续”和“放弃”。

- [ ] **Step 5: V1.5 验证**

将 `package.json` 版本更新为 `1.5.0`，运行 `npm install --package-lock-only`
同步 lockfile。

Run: `npm test -- --runInBand`

Run: `npm run lint`

Run: `npm run apk:debug`

Expected: 全部通过，APK 位于 `dist/apk/debug/ShineWriter-V1.5.0-debug.apk`。

- [ ] **Step 6: Commit**

```powershell
git add src/types/pipeline.ts src/store/pipelineTaskStore.ts src/services/pipelineRunner.ts src/services/pipelineResume.ts src/main/index.tsx src/screens/PipelineTaskScreen.tsx __tests__/pipelineRunner.test.ts __tests__/pipelineResume.test.ts package.json
git commit -m "feat: complete v1.5 resumable AI workflow"
```

---

## Phase 3 / V1.6：长篇效率与工程治理

### Task 12: 项目搜索与章节排序

**Files:**
- Create: `src/services/searchService.ts`
- Create: `src/screens/ProjectSearchScreen.tsx`
- Modify: `src/services/database.ts`
- Modify: `src/screens/OutlineEditor.tsx`
- Modify: `src/navigation/TabNavigator.tsx`
- Create: `__tests__/searchService.test.ts`
- Create: `__tests__/chapterReorder.test.ts`

- [ ] **Step 1: 编写搜索与排序测试**

覆盖 2 字符门槛、分类、每类 30 条、命中摘要、transaction 排序和删除后 position
压缩。

- [ ] **Step 2: 增加 database 查询**

```ts
searchChapters(projectId, query, limit)
searchNotes(projectId, query, limit)
searchWorldbook(projectId, query, limit)
searchCharacters(projectId, query, limit)
reorderChapters(projectId, orderedIds)
normalizeChapterPositions(projectId)
```

- [ ] **Step 3: 创建搜索页面与章节控制**

输入使用 250ms 防抖；章节卡增加上移/下移和状态筛选。

- [ ] **Step 4: 验证并提交**

Run: `npx jest __tests__/searchService.test.ts __tests__/chapterReorder.test.ts --runInBand`

```powershell
git add src/services/searchService.ts src/screens/ProjectSearchScreen.tsx src/services/database.ts src/screens/OutlineEditor.tsx src/navigation/TabNavigator.tsx __tests__/searchService.test.ts __tests__/chapterReorder.test.ts
git commit -m "feat: add project search and chapter ordering"
```

### Task 13: 故事概览统计

**Files:**
- Create: `src/services/analyticsService.ts`
- Modify: `src/screens/StoryOverview.tsx`
- Create: `__tests__/analyticsService.test.ts`
- Create: `__tests__/StoryOverview.test.tsx`

- [ ] **Step 1: 编写统计测试**

验证总章节、总字数、定稿数、摘要覆盖率、空正文、缺概要、缺记忆摘要和情节线范围。

- [ ] **Step 2: 实现聚合**

```ts
export interface StoryAnalytics {
  chapterCount: number;
  totalCharacters: number;
  finalizedCount: number;
  summaryCoverage: number;
  chapterRows: ChapterAnalyticsRow[];
  plotlineRows: PlotlineAnalyticsRow[];
  warnings: StoryWarning[];
}
```

- [ ] **Step 3: 重构 StoryOverview**

使用现有 Card 和简单进度条，不新增图表库。

- [ ] **Step 4: 验证并提交**

Run: `npx jest __tests__/analyticsService.test.ts __tests__/StoryOverview.test.tsx --runInBand`

```powershell
git add src/services/analyticsService.ts src/screens/StoryOverview.tsx __tests__/analyticsService.test.ts __tests__/StoryOverview.test.tsx
git commit -m "feat: expand story overview analytics"
```

### Task 14: schema 8 与 LLM 用量统计

**Files:**
- Create: `src/services/migrations/v7-to-v8.ts`
- Modify: `src/services/migrations/index.ts`
- Modify: `src/services/database.ts`
- Modify: `src/services/llm.ts`
- Create: `src/screens/UsageStatsScreen.tsx`
- Modify: `src/screens/SettingsScreen.tsx`
- Modify: `src/navigation/TabNavigator.tsx`
- Create: `__tests__/usageAnalytics.test.ts`

- [ ] **Step 1: 编写失败测试**

验证 schema 列、项目/模型/耗时写入、7/30 天聚合、成功率和场景分组。

- [ ] **Step 2: 执行 v7 -> v8 migration**

增加 `project_id`、`model_name`、`duration_ms` 默认列并更新
`SCHEMA_VERSION = 8`。

- [ ] **Step 3: 扩展 LLM 调用配置**

```ts
export interface LLMCallConfig {
  // existing fields
  projectId?: number;
}
```

调用开始记录时间，成功和失败均写入 model、project 和 duration。日志失败不得影响
LLM 返回。

- [ ] **Step 4: 创建统计页**

提供今日/7 天/30 天筛选、输入输出 token、成功率、场景和模型分组，不显示费用。

- [ ] **Step 5: 验证并提交**

Run: `npx jest __tests__/usageAnalytics.test.ts __tests__/llm.test.ts --runInBand`

```powershell
git add src/services/migrations src/services/database.ts src/services/llm.ts src/screens/UsageStatsScreen.tsx src/screens/SettingsScreen.tsx src/navigation/TabNavigator.tsx __tests__/usageAnalytics.test.ts __tests__/llm.test.ts
git commit -m "feat: add project-aware LLM usage analytics"
```

### Task 15: 专注模式与可访问性

**Files:**
- Modify: `src/components/ui.tsx`
- Modify: `src/screens/ChapterEditor.tsx`
- Modify: `src/screens/FreeformEditor.tsx`
- Modify: `src/store/settingsStore.ts`
- Modify: `src/services/database.ts`
- Create: `__tests__/accessibilityRegression.test.tsx`

- [ ] **Step 1: 编写可访问性测试**

验证 compact 重要按钮最小 44dp、SegmentedControl 的 tab role/selected 状态、图标
按钮 label 和专注模式切换。

- [ ] **Step 2: 调整 UI 基础组件**

`buttonCompact.minHeight = 44`；SegmentedControl 每项增加：

```tsx
accessibilityRole="tab"
accessibilityState={{ selected: active }}
accessibilityLabel={option.label}
```

- [ ] **Step 3: 实现专注模式**

设置键：

```text
editor_focus_mode
editor_font_scale = small | medium | large
```

编辑器专注模式隐藏次要工具，保留返回、保存状态、历史、字数和 AI 入口。首版不实现
常亮原生模块，除非现有开发环境可在不增加依赖的前提下完成并测试。

- [ ] **Step 4: 验证并提交**

Run: `npx jest __tests__/accessibilityRegression.test.tsx --runInBand`

```powershell
git add src/components/ui.tsx src/screens/ChapterEditor.tsx src/screens/FreeformEditor.tsx src/store/settingsStore.ts src/services/database.ts __tests__/accessibilityRegression.test.tsx
git commit -m "feat: improve focused writing and accessibility"
```

### Task 16: Android-only 清理、文档和最终发布验证

**Files:**
- Delete: `ios/`
- Modify: `package.json`
- Rewrite: `README.md`
- Create: `docs/release-checklist.md`
- Modify: `.gitignore`

- [ ] **Step 1: 删除 iOS 表面**

删除 `package.json` 的 `ios` script，并使用 git 删除已跟踪 `ios/` 目录。不要修改
Android Gradle 的阿里云 Maven 镜像、签名配置或 APK 产物规则。

同时将 `package.json` 版本更新为 `1.6.0`，运行
`npm install --package-lock-only` 同步 lockfile。

- [ ] **Step 2: 重写 README**

README 必须包含：

- Android-only 产品简介和功能
- Node >= 22.11.0、Android SDK 要求
- 安装、Metro、Android 开发命令
- Jest 与 lint 命令
- debug/release APK 唯一产物路径
- release 签名环境变量
- 数据备份与升级注意事项

- [ ] **Step 3: 创建 release checklist**

```md
# Release Checklist

- [ ] package.json 版本已更新
- [ ] npm test -- --runInBand 全部通过
- [ ] npm run lint 无 error
- [ ] npm run apk:debug 成功
- [ ] npm run apk:release 成功
- [ ] APK 仅位于 dist/apk/{debug|release}
- [ ] version.json 与 APK 目标版本一致
- [ ] 升级安装保留项目、密钥和历史
- [ ] 手动备份与恢复通过真机验证
```

- [ ] **Step 4: 全量自动验证**

Run: `npm test -- --runInBand`

Expected: 全部 PASS，不接受 timeout 作为成功。

Run: `npm run lint`

Expected: 0 errors。

Run: `npm run apk:debug`

Expected: `dist/apk/debug/ShineWriter-V1.6.0-debug.apk`。

Run: `npm run apk:release`

Expected: `dist/apk/release/ShineWriter-V1.6.0-release.apk`。

- [ ] **Step 5: Android 真机检查**

1. 从 V1.3.8 覆盖安装 V1.6.0。
2. 打开旧项目并编辑，立即返回后确认内容保存。
3. 创建历史、生成草稿、采纳并恢复历史。
4. 创建手动备份，修改数据，再恢复。
5. 启动管线后强制结束 App，重开并继续。
6. 验证搜索、故事概览和用量统计。
7. 使用 TalkBack 检查底部导航、编辑器主按钮、分段控件和危险操作。

- [ ] **Step 6: 检查仓库状态**

Run: `git status --short`

Expected: 只包含本计划变更，无构建中间产物。

Run: `git ls-files ios`

Expected: 无输出。

- [ ] **Step 7: Commit**

```powershell
git add -A
git commit -m "feat: complete v1.6 personal novel workbench optimization"
```

---

## 最终完成定义

只有同时满足以下条件才算计划完成：

- schema 5 -> 6 -> 7 -> 8 升级路径有测试。
- 编辑器最后一次输入不会因正常返回或切后台静默丢失。
- 所有覆盖正文的 AI 操作经过草稿预览并保留 revision。
- 手动备份恢复、项目导入和管线续跑通过自动测试与真机检查。
- 搜索、排序、故事概览和用量统计可在真实项目使用。
- 全量 Jest 和 lint 通过。
- debug/release APK 均从规定命令生成到规定目录。
- README 与仓库只描述 Android。
