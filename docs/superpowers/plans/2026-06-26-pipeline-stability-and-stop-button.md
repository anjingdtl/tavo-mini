# 流水线稳定性修复 + 写作界面停止按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复"流水线运行后切屏出 App 再返回弹出报错窗口"和"切屏出去后流水线卡住空转不停"两个根因问题，并在写作界面增加流水线停止按钮，让用户能主动终止运行中的流水线。

**Architecture:**
1. **取消即时生效**：在 `pipelineRunner` 中维护 `taskId → AbortController` 映射，`cancelPipeline` 同时 `abort()` 正在跑的 fetch；`callLLMResult` 新增可选 `externalSignal` 参数，外部 abort 通过 listener 联动内部 controller，超时逻辑不变。
2. **僵尸任务自愈**：`pipelineTaskStore` 新增 `markStaleTasksAsFailed(staleMs)`，扫描状态为 `idle/drafting/reviewing/proofing` 且 `updatedAt` 超过阈值的任务，统一标 `failed` 并写入"运行被中断（App 可能被系统挂起）"错误。
3. **回前台扫描 + 去重弹窗**：`main/index.tsx` 监听 AppState 切回 `active` 时调用 `markStaleTasksAsFailed` 并重置 `prompted` 集合，避免切屏期间 failTask 触发的双重弹窗（ChapterEditor Alert + 全局 Modal）。
4. **ChapterEditor 停止按钮**：工具栏增加"停止"按钮（仅 `generating` 时显示），点击调 `cancelPipeline(taskId)` 并立即重置本地 UI 状态；新增 `seenTerminalRef: Set<string>` 避免同一 taskId 触发多次 Alert。

**Tech Stack:** React Native 0.85.3 / React 19 / TypeScript / Zustand / Jest / Android SDK 36

**重要约束**（来自 AGENTS.md）：
- 无 `typecheck` 脚本，**不要跑 `tsc --noEmit`**
- 测试用 `npx jest <file>`，全量用 `npm test`
- 数据操作走 `services/database.ts`，不直接写 SQL
- 错误信息用中文，Prettier 配置：`arrowParens: 'avoid'`、`singleQuote: true`、`trailingComma: 'all'`
- 新增原生依赖测试报错时优先在 `jest.setup.js` 补 mock
- 纯 Android，不碰 iOS

---

## Phase 概览

- **Phase 1：取消机制可即时中断 fetch**（核心根因修复）
- **Phase 2：僵尸任务自愈**（解决空转）
- **Phase 3：回前台扫描 + 去重弹窗**（解决切屏弹窗）
- **Phase 4：ChapterEditor 停止按钮 + 本地防双弹**
- **Phase 5：全量测试 + commit/push**

---

## Phase 1: 取消机制可即时中断 fetch

### Task 1.1: 给 `callLLMResult` 增加可选 `externalSignal` 参数

**Files:**
- Modify: `src/services/llm.ts:163-242`

**根因说明**：当前 `callLLMResult` 内部用 `new AbortController()` + 60s timeout，外部无法中断。pipeline 的取消只在阶段边界检查，正在跑的 LLM 请求必须等 60s 超时才能被打断。让外部传入 signal 并通过 listener 联动内部 controller，可立即 abort fetch。

- [ ] **Step 1: 修改 `callLLMResult` 签名与 abort 联动逻辑**

把 `src/services/llm.ts` 第 163-176 行：

```ts
export async function callLLMResult(
  messages: ChatMessage[],
  maxTokens?: number,
  config?: LLMCallConfig,
): Promise<LLMResult> {
  const llmConfig = await getRequestConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const inputEstimate = estimateMessagesTokens(messages);
  const scenario = config?.scenario || 'chat';
  const modelName = llmConfig.model_name;
  const projectId = config?.projectId;
```

改为：

```ts
export async function callLLMResult(
  messages: ChatMessage[],
  maxTokens?: number,
  config?: LLMCallConfig,
  externalSignal?: AbortSignal,
): Promise<LLMResult> {
  const llmConfig = await getRequestConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  // 联动外部 signal：用户取消流水线时立即 abort，无需等 60s 超时
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  const inputEstimate = estimateMessagesTokens(messages);
  const scenario = config?.scenario || 'chat';
  const modelName = llmConfig.model_name;
  const projectId = config?.projectId;
```

- [ ] **Step 2: 验证现有测试不破坏**

Run: `npx jest __tests__/llm.test.ts`
Expected: PASS（不改签名是兼容扩展）

---

### Task 1.2: pipelineRunner 维护 AbortController 映射，cancelPipeline 即时中断

**Files:**
- Modify: `src/services/pipelineRunner.ts:18-43, 100-104, 209-213, 258-262, 312-316, 365-374, 543-547, 580-584`

- [ ] **Step 1: 新增 controller map 与 signal 取用函数**

把 `src/services/pipelineRunner.ts` 第 18-43 行：

```ts
const cancelledTasks = new Set<string>();

export function cancelPipeline(taskId: string): void {
  cancelledTasks.add(taskId);
}

export function isPipelineCancelled(taskId: string): boolean {
  return cancelledTasks.has(taskId);
}

function resolvePreset(presetId: number | null, presets: Preset[]): Preset | null {
```

改为：

```ts
const cancelledTasks = new Set<string>();
const taskAbortControllers = new Map<string, AbortController>();

export function cancelPipeline(taskId: string): void {
  cancelledTasks.add(taskId);
  const controller = taskAbortControllers.get(taskId);
  if (controller) {
    controller.abort();
  }
}

export function isPipelineCancelled(taskId: string): boolean {
  return cancelledTasks.has(taskId);
}

function registerTaskAbort(taskId: string): AbortSignal {
  const controller = new AbortController();
  taskAbortControllers.set(taskId, controller);
  return controller.signal;
}

function releaseTaskAbort(taskId: string): void {
  taskAbortControllers.delete(taskId);
}

function resolvePreset(presetId: number | null, presets: Preset[]): Preset | null {
```

- [ ] **Step 2: 在 `runChapterPipeline` 入口注册、出口释放，并把 signal 传给每个 `callLLMResult`**

在 `src/services/pipelineRunner.ts` 第 141 行 `const store = usePipelineTaskStore.getState();` 之上插入注册，在所有 return 之前释放（用 try/finally 模式更安全）。

把第 136-145 行：

```ts
export async function runChapterPipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  let config;
  let contextConfig;
  let presets;
  try {
```

改为：

```ts
export async function runChapterPipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
): Promise<void> {
  const abortSignal = registerTaskAbort(taskId);
  const store = usePipelineTaskStore.getState();
  try {
    await runChapterPipelineInner(taskId, chapter, onStageUpdate, abortSignal);
  } finally {
    releaseTaskAbort(taskId);
  }
}

async function runChapterPipelineInner(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  let config;
  let contextConfig;
  let presets;
  try {
```

接下来把第 152-154 行 `await PipelineForeground.stop(taskId); return; }` 之后整个原函数体保持不变，只把所有 `await callLLMResult(...)` 调用追加 `abortSignal` 作为第 4 个参数。

需要改的 `callLLMResult` 调用（在 `runChapterPipelineInner` 即原 `runChapterPipeline` 函数体中）：
- 第 100-104 行（`runProofStage` 中的 proof 调用）→ 加 `abortSignal`
- 第 209-213 行（draft）→ 加 `abortSignal`
- 第 258-262 行（twoStage review）→ 加 `abortSignal`
- 第 312-316 行（conditional factCheck）→ 加 `abortSignal`
- 第 365-369 行（full review）→ 加 `abortSignal`
- 第 370-374 行（full factCheck）→ 加 `abortSignal`

`runProofStage` 也需要接受 `abortSignal` 参数：把第 75-93 行签名加 `abortSignal?: AbortSignal;` 字段，第 100-104 行 `callLLMResult` 调用追加 `abortSignal`。

- [ ] **Step 3: `resumePipeline` 同步加 abortSignal**

`resumePipeline` 也调 `callLLMResult`，需要同样处理：

把第 473-477 行 `export async function resumePipeline(...)` 签名保留，函数体首行注册 controller：

```ts
export async function resumePipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
): Promise<void> {
  const abortSignal = registerTaskAbort(taskId);
  try {
    await resumePipelineInner(taskId, chapter, onStageUpdate, abortSignal);
  } finally {
    releaseTaskAbort(taskId);
  }
}

async function resumePipelineInner(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  // 原 resumePipeline 函数体（去掉最外层函数签名）
```

`resumePipelineInner` 中需要把 `runChapterPipeline(taskId, chapter, onStageUpdate)`（第 493 行）改成 `runChapterPipelineInner`，并把 `abortSignal` 传给所有 `callLLMResult` 和 `runProofStage` 调用。

- [ ] **Step 4: 验证 pipelineRunner 测试通过**

Run: `npx jest __tests__/pipelineRunner.test.ts`
Expected: PASS（mock 的 `callLLMResult` 不在乎多传一个 signal 参数）

---

## Phase 2: 僵尸任务自愈

### Task 2.1: 给 `pipelineTaskStore` 加 `markStaleTasksAsFailed`

**Files:**
- Modify: `src/store/pipelineTaskStore.ts:5-19, 41-`

**根因说明**：当前 store 没有任何 watchdog。如果 pipelineRunner 因为 App 被系统冻结导致 fetch 永远不返回 / 状态不更新，任务会永远停留在 `drafting/reviewing/proofing`，回前台时表现为"PipelineProgress 一直转、永远停不下来"。需要主动扫描 + 标记 failed。

- [ ] **Step 1: 扩展接口与实现**

把 `src/store/pipelineTaskStore.ts` 第 5-19 行的 `PipelineTaskState` 接口，在 `getActiveTaskForTarget` 之前插入新方法签名：

```ts
interface PipelineTaskState {
  tasks: PipelineTask[];
  _loaded: boolean;
  loadFromDB: () => Promise<void>;
  createTask: (targetType: 'chapter' | 'freeform', targetId: number) => string;
  updateTaskStage: (taskId: string, result: PipelineStageResult) => void;
  setTaskStatus: (taskId: string, status: PipelineTaskStatus) => void;
  completeTask: (taskId: string, finalText: string) => void;
  failTask: (taskId: string, error: string) => void;
  cancelTask: (taskId: string) => void;
  resolveTask: (taskId: string, action: 'accept' | 'reject') => void;
  clearResolved: () => void;
  getActiveTaskForTarget: (targetType: 'chapter' | 'freeform', targetId: number) => PipelineTask | undefined;
  getUnresolvedCount: () => number;
  /** 把 updatedAt 超过 staleMs 的活跃任务标记为 failed（用于回前台自愈）。返回标记的任务数。 */
  markStaleTasksAsFailed: (staleMs?: number) => number;
}
```

在 `getActiveTaskForTarget`（第 186 行）和 `getUnresolvedCount`（第 196 行）之间插入实现：

```ts
  markStaleTasksAsFailed: (staleMs = 5 * 60 * 1000) => {
    const now = Date.now();
    const staleStatuses: PipelineTaskStatus[] = ['idle', 'drafting', 'reviewing', 'proofing'];
    let marked = 0;
    set((state) => {
      const tasks = state.tasks.map((t) => {
        if (
          !t.resolvedAt &&
          staleStatuses.includes(t.status) &&
          now - (t.updatedAt || t.createdAt) > staleMs
        ) {
          marked += 1;
          const updated = {
            ...t,
            status: 'failed' as PipelineTaskStatus,
            error: '运行被中断（App 可能被系统挂起）',
            updatedAt: now,
          };
          persistTask(updated);
          return updated;
        }
        return t;
      });
      return { tasks };
    });
    return marked;
  },
```

- [ ] **Step 2: 新增单测验证 stale 标记行为**

在 `__tests__/pipelineTaskStore.test.ts`（如不存在则创建）添加测试：

```ts
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';

jest.mock('../src/services/database', () => ({
  getAllPipelineTasks: jest.fn(async () => []),
  savePipelineTask: jest.fn(async () => undefined),
  deleteResolvedPipelineTasks: jest.fn(async () => undefined),
}));

describe('pipelineTaskStore.markStaleTasksAsFailed', () => {
  beforeEach(async () => {
    usePipelineTaskStore.setState({ tasks: [], _loaded: true });
    jest.clearAllMocks();
  });

  it('marks tasks whose updatedAt exceeds the stale threshold as failed', () => {
    const now = Date.now();
    const staleTask: any = {
      id: 'stale-1',
      targetType: 'chapter',
      targetId: 1,
      status: 'drafting',
      stageResults: [],
      finalText: null,
      error: null,
      createdAt: now - 10 * 60 * 1000,
      updatedAt: now - 10 * 60 * 1000,
      resolvedAt: null,
    };
    const freshTask: any = {
      ...staleTask,
      id: 'fresh-1',
      status: 'reviewing',
      updatedAt: now - 1000,
    };
    usePipelineTaskStore.setState({ tasks: [staleTask, freshTask] });

    const marked = usePipelineTaskStore.getState().markStaleTasksAsFailed();

    expect(marked).toBe(1);
    const tasks = usePipelineTaskStore.getState().tasks;
    expect(tasks.find(t => t.id === 'stale-1')?.status).toBe('failed');
    expect(tasks.find(t => t.id === 'fresh-1')?.status).toBe('reviewing');
  });

  it('does not touch terminal or resolved tasks', () => {
    const now = Date.now();
    const completedStale: any = {
      id: 'done-1',
      targetType: 'chapter',
      targetId: 1,
      status: 'completed',
      stageResults: [],
      finalText: 'done',
      error: null,
      createdAt: now - 10 * 60 * 1000,
      updatedAt: now - 10 * 60 * 1000,
      resolvedAt: null,
    };
    usePipelineTaskStore.setState({ tasks: [completedStale] });

    const marked = usePipelineTaskStore.getState().markStaleTasksAsFailed();

    expect(marked).toBe(0);
    expect(usePipelineTaskStore.getState().tasks[0].status).toBe('completed');
  });
});
```

- [ ] **Step 3: 跑测试**

Run: `npx jest __tests__/pipelineTaskStore.test.ts`
Expected: PASS

---

## Phase 3: 回前台扫描 + 去重弹窗

### Task 3.1: `main/index.tsx` 监听 AppState 切回 active，调用 `markStaleTasksAsFailed` 并重置 `prompted`

**Files:**
- Modify: `src/main/index.tsx:1-21, 70-126`

**根因说明**：当前 `App` 组件只在 mount 时 seed 一次 `prompted`，但 subscribe 永远在跑。用户切走期间 fetch 因后台被 OS 冻结/超时触发 `failTask`，subscribe 立即把任务塞进 `pendingPrompt`，用户回前台就看到弹窗——而且因为 ChapterEditor 也在订阅，会同时弹一次 Alert，造成"双弹"。回前台时主动扫描僵尸任务并清空 `pendingPrompt`，配合下一阶段 ChapterEditor 的 `seenTerminalRef`，从根本上消除多重弹窗。

- [ ] **Step 1: 顶部 import AppState 与 store 方法**

把 `src/main/index.tsx` 第 1-21 行：

```ts
import React from 'react';
import { ImageBackground, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
```

改为：

```ts
import React from 'react';
import { AppState, ImageBackground, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
```

- [ ] **Step 2: 在终态 subscribe effect 内部加 AppState 监听**

把第 70-126 行的 `React.useEffect(() => { ... }, [])` 改造：保留原 subscribe 逻辑，新增 AppState 监听。完整新版：

```ts
  React.useEffect(() => {
    // Track which taskIds have already been prompted in this session, so a
    // store reload (e.g. on app cold start) does not re-prompt historical
    // tasks.
    const prompted = new Set<string>();

    const seedPromptedFromCurrentState = () => {
      usePipelineTaskStore.getState().tasks.forEach((t) => {
        if (t.resolvedAt === null && (t.status === 'completed' || t.status === 'failed')) {
          prompted.add(t.id);
        }
      });
    };
    seedPromptedFromCurrentState();

    const unsubscribe = usePipelineTaskStore.subscribe((state, prevState) => {
      if (state.tasks === prevState.tasks) return;
      const tasks = state.tasks;
      const finished = tasks
        .filter((t: PipelineTask) => {
          const isEligible = !prompted.has(t.id)
            && t.resolvedAt === null
            && (t.status === 'completed' || t.status === 'failed');
          if (!isEligible) return false;
          if (consumeSuppressedPipelinePrompt(t.id)) {
            prompted.add(t.id);
            return false;
          }
          return true;
        })
        .sort((a: PipelineTask, b: PipelineTask) => b.updatedAt - a.updatedAt);
      if (finished.length === 0) return;
      const task = finished[0];
      prompted.add(task.id);
      setPendingPrompt(task);
    });

    // 回前台时：1) 把僵尸任务（被系统挂起导致 fetch 永不返回）标 failed；
    // 2) 重新 seed prompted，避免刚刚被 mark 的任务立即弹窗（因为是自愈触发，
    //    不是用户当前会话感知到的失败，应当静默）。
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const marked = usePipelineTaskStore.getState().markStaleTasksAsFailed();
      if (marked > 0) {
        // 把刚刚被自愈标记的任务纳入 prompted，避免 Modal 弹"运行被中断"
        seedPromptedFromCurrentState();
        // 同时清空已经在 pending 的同类弹窗（如果有的话）
        setPendingPrompt((prev) => {
          if (!prev) return prev;
          if (prompted.has(prev.id)) return null;
          return prev;
        });
      }
    });

    return () => {
      unsubscribe();
      appStateSub.remove();
    };
  }, []);
```

- [ ] **Step 3: 验证 App 启动测试通过**

Run: `npx jest __tests__/App.test.tsx __tests__/pipelineAutoPrompt.test.tsx __tests__/appPipelineReminder.test.tsx`
Expected: PASS

---

## Phase 4: ChapterEditor 停止按钮 + 本地防双弹

### Task 4.1: 新增 `seenTerminalRef`，避免同 taskId 多次弹 Alert

**Files:**
- Modify: `src/screens/ChapterEditor.tsx:54-185`

**根因说明**：ChapterEditor 第 169-183 行的 store subscribe 在用户切走期间 failTask 触发时也会调 `handleTerminal` 弹 `Alert.alert('流水线失败', ...)`，而 main/index.tsx 的 PipelineResultPrompt Modal 也会弹同一任务的失败提示——这就是"切屏出去再回来弹报错窗口"的直接表现。加 `seenTerminalRef: Set<string>` 保证每个 taskId 在本屏只 Alert 一次，并让失败提示统一交给全局 Modal（仍保留 completed → 跳结果页逻辑）。

- [ ] **Step 1: 加 ref 并在 handleTerminal 中查重**

把 `src/screens/ChapterEditor.tsx` 第 54-56 行：

```ts
  // Tracks the most recent taskId whose result screen we have surfaced, so a
  // redundant store update does not navigate to the same result twice.
  const resultTaskIdRef = useRef<string | null>(null);
```

之后新增：

```ts
  // 每个终态 taskId 在本屏只触发一次 Alert/跳转，避免切屏期间 failTask
  // 触发的 subscribe 与全局 PipelineResultPrompt Modal 双弹。
  const seenTerminalRef = useRef<Set<string>>(new Set());
```

把第 146-156 行的 `handleTerminal`：

```ts
    const handleTerminal = (t: { id: string; status: string; error?: string | null }) => {
      if (t.id === resultTaskIdRef.current) return;
      if (t.status === 'completed') {
        openPipelineResult(t.id);
      } else if (t.status === 'failed') {
        resultTaskIdRef.current = t.id;
        setProgressVisible(false);
        setGenerating(false);
        Alert.alert('流水线失败', t.error || '未知错误');
      }
    };
```

改为：

```ts
    const handleTerminal = (t: { id: string; status: string; error?: string | null }) => {
      if (t.id === resultTaskIdRef.current) return;
      if (seenTerminalRef.current.has(t.id)) return;
      seenTerminalRef.current.add(t.id);
      if (t.status === 'completed') {
        openPipelineResult(t.id);
      } else if (t.status === 'failed') {
        resultTaskIdRef.current = t.id;
        setProgressVisible(false);
        setGenerating(false);
        // 失败提示交给全局 PipelineResultPrompt Modal 统一展示，避免双重弹窗
      }
    };
```

---

### Task 4.2: 加流水线停止按钮

**Files:**
- Modify: `src/screens/ChapterEditor.tsx:3-13, 407-501`

- [ ] **Step 1: import `cancelPipeline`**

把 `src/screens/ChapterEditor.tsx` 第 6 行：

```ts
import { runChapterPipeline } from '../services/pipelineRunner';
```

改为：

```ts
import { cancelPipeline, runChapterPipeline } from '../services/pipelineRunner';
```

- [ ] **Step 2: 新增 `stopPipeline` handler**

在 `executeRunPipeline`（第 333 行）之后插入：

```ts
  const stopPipeline = () => {
    // 立即重置 UI 状态，避免用户点完按钮还要等 fetch 超时
    setGenerating(false);
    setProgressVisible(false);
    // 找到当前章节正在跑的 taskId，通知 runner 立即 abort fetch
    const runningTask = usePipelineTaskStore
      .getState()
      .tasks.find(
        (t) =>
          t.targetType === 'chapter' &&
          t.targetId === chapterId &&
          (t.status === 'idle' || t.status === 'drafting' || t.status === 'reviewing' || t.status === 'proofing') &&
          t.resolvedAt === null,
      );
    if (runningTask) {
      cancelPipeline(runningTask.id);
    }
  };
```

- [ ] **Step 3: 工具栏在 `generating` 时渲染停止按钮**

把 `src/screens/ChapterEditor.tsx` 第 415-422 行（续写按钮）：

```tsx
            <Button
              label={generating ? '续写中…' : '续写'}
              icon={Bot}
              onPress={runPipeline}
              disabled={generating || finalizing}
              compact
              minWidth={72}
            />
```

改为（在续写按钮之后追加停止按钮）：

```tsx
            <Button
              label={generating ? '续写中…' : '续写'}
              icon={Bot}
              onPress={runPipeline}
              disabled={generating || finalizing}
              compact
              minWidth={72}
            />
            {generating && (
              <Button
                label="停止"
                icon={Square}
                variant="secondary"
                onPress={stopPipeline}
                compact
                minWidth={72}
              />
            )}
```

`Square` 图标已在第 3 行 import 中存在（用于朗读按钮 toggle），无需新增。

- [ ] **Step 4: 更新现有测试期望（按钮数量从 9 变为只在 generating 时 +1）**

`__tests__/chapterEditorToolbar.test.tsx` 第 134-143 行的 `renders all 9 short-label buttons` 在非 generating 状态下仍应该是 9 个，无需改动。但需要补一个测试验证 generating 时出现停止按钮。

在 `__tests__/chapterEditorToolbar.test.tsx` 末尾追加：

```ts
  it('shows a stop button while pipeline is generating and triggers cancelPipeline', async () => {
    const { cancelPipeline } = require('../src/services/pipelineRunner');
    // 让 runChapterPipeline 永远不 resolve，保持 generating 状态
    let releasePipeline!: () => void;
    mockRunChapterPipeline.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releasePipeline = resolve; }),
    );
    const { findByText } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );
    const continueButton = await findByText('续写');
    await act(async () => { fireEvent.press(continueButton); });
    const stopButton = await findByText('停止');
    expect(stopButton).toBeTruthy();
    await act(async () => { fireEvent.press(stopButton); });
    expect(cancelPipeline).toHaveBeenCalledWith('task-1');
    releasePipeline();
  });
```

注意：`mockRunChapterPipeline` 已 mock 在文件顶部第 8 行，但 `cancelPipeline` 是从 `../src/services/pipelineRunner` 来的，第 46-48 行的 `jest.mock('../src/services/pipelineRunner', ...)` 只 mock 了 `runChapterPipeline`。需要在那个 mock 块里加 `cancelPipeline`：

把第 46-48 行：

```ts
jest.mock('../src/services/pipelineRunner', () => ({
  runChapterPipeline: (...args: any[]) => mockRunChapterPipeline(...args),
}));
```

改为：

```ts
const mockCancelPipeline = jest.fn();
jest.mock('../src/services/pipelineRunner', () => ({
  runChapterPipeline: (...args: any[]) => mockRunChapterPipeline(...args),
  cancelPipeline: (...args: any[]) => mockCancelPipeline(...args),
}));
```

测试中改用 `mockCancelPipeline`：

```ts
  it('shows a stop button while pipeline is generating and triggers cancelPipeline', async () => {
    let releasePipeline!: () => void;
    mockRunChapterPipeline.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releasePipeline = resolve; }),
    );
    mockCancelPipeline.mockClear();
    const { findByText } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );
    const continueButton = await findByText('续写');
    await act(async () => { fireEvent.press(continueButton); });
    const stopButton = await findByText('停止');
    expect(stopButton).toBeTruthy();
    await act(async () => { fireEvent.press(stopButton); });
    expect(mockCancelPipeline).toHaveBeenCalledWith('task-1');
    releasePipeline();
  });
```

并在顶部 `const mockRunChapterPipeline = jest.fn();` 旁加 `const mockCancelPipeline = jest.fn();`，并在 `beforeEach` 里 `mockCancelPipeline.mockClear()`。

- [ ] **Step 5: 跑 ChapterEditor 测试**

Run: `npx jest __tests__/chapterEditorToolbar.test.tsx`
Expected: PASS

---

## Phase 5: 全量测试 + commit/push

### Task 5.1: 全量回归

- [ ] **Step 1: 跑全量测试**

Run: `npm test`
Expected: 所有测试 PASS（特别注意 pipelineRunner / pipelineTaskStore / chapterEditorToolbar / App / pipelineAutoPrompt / appPipelineReminder 这几个文件）

- [ ] **Step 2: 跑 ESLint**

Run: `npm run lint`
Expected: 无新增错误（不强制无 warning）

### Task 5.2: commit + push

- [ ] **Step 1: 暂存改动**

```bash
git add src/services/llm.ts \
        src/services/pipelineRunner.ts \
        src/store/pipelineTaskStore.ts \
        src/main/index.tsx \
        src/screens/ChapterEditor.tsx \
        __tests__/pipelineTaskStore.test.ts \
        __tests__/chapterEditorToolbar.test.tsx \
        docs/superpowers/plans/2026-06-26-pipeline-stability-and-stop-button.md
```

- [ ] **Step 2: commit（conventional commit）**

```bash
git commit -m "$(cat <<'EOF'
fix(pipeline): 修复切屏后流水线卡住/弹窗与新增停止按钮

- llm.callLLMResult 增加可选 externalSignal，外部 abort 通过 listener
  联动内部 controller，让取消能立即中断 fetch 而非等 60s 超时
- pipelineRunner 维护 taskId→AbortController 映射，cancelPipeline 即时
  abort，并改 runChapterPipeline/resumePipeline 为 outer+inner 结构以
  保证 controller 一定释放
- pipelineTaskStore 新增 markStaleTasksAsFailed，扫描 updatedAt 超过 5
  分钟仍处于活跃状态的任务标记 failed（解决空转）
- main/index.tsx 监听 AppState 切回 active，调用 markStaleTasksAsFailed
  并重新 seed prompted，消除切屏期间 failTask 触发的双弹窗
- ChapterEditor 新增 seenTerminalRef 防同 taskId 多次 Alert，并把失败
  提示交给全局 Modal 统一展示；工具栏在 generating 时显示"停止"按钮，
  点击调用 cancelPipeline 并立即重置 UI 状态
EOF
)"
```

- [ ] **Step 3: push 到 main**

```bash
git push origin main
```

---

## Self-Review

**1. Spec coverage**：
- "切屏出 App 再返回会弹出报错窗口" → Phase 3（回前台扫描 + 重置 prompted）+ Phase 4（seenTerminalRef 防双弹 + 失败交给全局 Modal）✓
- "切屏出去后不能稳定执行，经常卡住或空转" → Phase 1（取消可即时中断 fetch，避免 60s 等待）+ Phase 2（僵尸任务自愈）+ Phase 3（回前台扫描）✓
- "写作界面增加流水线停止按钮" → Phase 4 Task 4.2 ✓

**2. Placeholder scan**：无 TBD/TODO 占位；所有改动均给出完整代码块。✓

**3. Type consistency**：
- `markStaleTasksAsFailed(staleMs?: number) => number` 在 store 接口和 main/index.tsx 调用签名一致 ✓
- `cancelPipeline(taskId: string)` 签名不变，新增副作用（abort controller）✓
- `callLLMResult(messages, maxTokens?, config?, externalSignal?)` 第 4 个参数是新增可选参数 ✓
- `runChapterPipelineInner / resumePipelineInner` 是新增私有函数，外部仍用 `runChapterPipeline / resumePipeline` ✓
