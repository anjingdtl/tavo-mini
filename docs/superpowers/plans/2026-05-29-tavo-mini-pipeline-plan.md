# tavo-mini 多角色流水线编写正文 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 tavo-maker 桌面版的 4 阶段多角色流水线写作能力完整移植到 tavo-mini 移动端。

**Architecture:** 基于现有服务层（`buildContext` / `callLLMResult`）扩展，新增 `pipelineRunner` 串联 4 阶段 LLM 调用（初稿串行 -> 审阅+核查并行 -> 终审串行），内存队列管理任务状态，新增 3 个 Screen 提供配置/任务中心/结果审阅能力。

**Tech Stack:** React Native 0.85 + TypeScript + Zustand + SQLite + OpenAI 兼容 API

---

## 文件结构映射

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/types/pipeline.ts` | 创建 | Pipeline 全部 TypeScript 类型 |
| `src/services/database.ts` | 修改 | 新增 `getPipelineConfig` / `setPipelineConfig` |
| `src/services/pipelineMessages.ts` | 创建 | 4 阶段 system/user prompt 模板工厂 |
| `src/store/pipelineTaskStore.ts` | 创建 | Zustand 内存任务队列 + badge 计算 |
| `src/services/pipelineRunner.ts` | 创建 | 4 阶段执行核心 + 状态机 |
| `src/screens/PipelineConfigScreen.tsx` | 创建 | 4 阶段 Preset 绑定 + MaxTokens 配置 |
| `src/screens/PipelineTaskScreen.tsx` | 创建 | 任务列表 + 清空已完成 |
| `src/screens/PipelineResultScreen.tsx` | 创建 | 4 阶段结果展示 + 采纳/放弃 |
| `src/screens/ChapterEditor.tsx` | 修改 | 新增「流水线」按钮 + 进行中状态检测 |
| `src/screens/FreeformEditor.tsx` | 修改 | 新增「流水线续写」按钮 + 进行中状态检测 |
| `src/screens/SettingsScreen.tsx` | 修改 | 新增配置入口 + 任务中心入口 + badge |
| `src/navigation/TabNavigator.tsx` | 修改 | 注册 3 个新 Screen |

---

## Task 1: Pipeline 类型定义

**Files:**
- Create: `src/types/pipeline.ts`

- [ ] **Step 1: 创建类型文件**

```typescript
export type PipelineStageName = 'draft' | 'review' | 'factCheck' | 'proof';

export type PipelineTaskStatus =
  | 'idle'
  | 'drafting'
  | 'reviewing'
  | 'proofing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface PipelineConfig {
  draftPresetId: number | null;
  reviewPresetId: number | null;
  factCheckPresetId: number | null;
  proofPresetId: number | null;
  draftMaxTokens: number;
  reviewMaxTokens: number;
  factCheckMaxTokens: number;
  proofMaxTokens: number;
}

export interface PipelineStageResult {
  stage: PipelineStageName;
  text: string;
  status: 'success' | 'failed';
  error?: string;
  tokens?: { input: number; output: number; total: number };
  durationMs: number;
}

export interface PipelineTask {
  id: string;
  targetType: 'chapter' | 'freeform';
  targetId: number;
  status: PipelineTaskStatus;
  stageResults: PipelineStageResult[];
  finalText: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types/pipeline.ts
git commit -m "feat(pipeline): add Pipeline type definitions"
```

---

## Task 2: 数据库层 — PipelineConfig 持久化

**Files:**
- Modify: `src/services/database.ts`

**上下文:** `database.ts` 已有 `getContextConfig` / `setContextConfig` 模式（读写 `settings` 表 JSON）。完全复用该模式。

- [ ] **Step 1: 读取现有 `database.ts` 的 `getContextConfig` / `setContextConfig` 实现，确认模式**

- [ ] **Step 2: 在文件末尾追加 PipelineConfig CRUD**

```typescript
const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  draftPresetId: null,
  reviewPresetId: null,
  factCheckPresetId: null,
  proofPresetId: null,
  draftMaxTokens: 4000,
  reviewMaxTokens: 1500,
  factCheckMaxTokens: 1500,
  proofMaxTokens: 4000,
};

export async function getPipelineConfig(): Promise<PipelineConfig> {
  const db = await openDB();
  const row = await db.executeSql(
    "SELECT value FROM settings WHERE key = 'pipeline_config' LIMIT 1"
  );
  if (row[0]?.rows?.length) {
    try {
      return { ...DEFAULT_PIPELINE_CONFIG, ...JSON.parse(row[0].rows.item(0).value) };
    } catch {
      return DEFAULT_PIPELINE_CONFIG;
    }
  }
  return DEFAULT_PIPELINE_CONFIG;
}

export async function setPipelineConfig(config: PipelineConfig): Promise<void> {
  const db = await openDB();
  await db.executeSql(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    ['pipeline_config', JSON.stringify(config)]
  );
}
```

注意：文件顶部需导入 `PipelineConfig`：
```typescript
import type { PipelineConfig } from '../types/pipeline';
```

- [ ] **Step 3: Commit**

```bash
git add src/services/database.ts
git commit -m "feat(pipeline): add PipelineConfig persistence"
```

---

## Task 3: Prompt 模板工厂

**Files:**
- Create: `src/services/pipelineMessages.ts`

**上下文:** 桌面版 novelist.js 第 1764-1864 行定义了 4 阶段的 system/user prompt。此处将其提取为纯函数工厂，不依赖任何 UI 状态。

- [ ] **Step 1: 创建文件**

```typescript
import type { ChatMessage } from './llm';

export function buildDraftMessages(
  baseMessages: ChatMessage[],
  chapterTitle: string,
  existingContent: string,
  userPrompt: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [...baseMessages];
  const roleInstruction = [
    `【任务】你是初稿作者。请为小说章节「${chapterTitle}」快速创作内容。`,
    '专注于创造力和流畅性，释放想象力，避免陷入空白页焦虑。',
    '不要担心细节问题，后续会有专门的编辑处理。',
  ].join('\n');

  let content = roleInstruction;
  if (existingContent.trim()) {
    const tail = existingContent.slice(-1500);
    content += `\n\n当前已有正文末尾：\n${tail}\n\n请自然续写，不要重复前文内容。`;
  }
  content += `\n\n${userPrompt}`;

  messages.push({ role: 'user', content });
  return messages;
}

export function buildReviewMessages(draftText: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是一位资深小说审阅编辑。你的职责是从宏观视角审阅文本，关注：',
        '1. 逻辑一致性——情节发展是否合理，有无矛盾',
        '2. 结构完整性——叙事节奏是否得当，场景转换是否自然',
        '3. 基调统一性——文风和情感基调是否前后一致',
        '4. 人物表现——角色言行是否符合其设定和性格',
        '5. 叙事技巧——是否有效运用了展示而非讲述(show not tell)',
        '',
        '请按以下 JSON 格式输出审阅意见，不要输出其他内容：',
        '{"strengths": [...], "issues": [...], "suggestions": [...]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请审阅以下小说初稿：\n\n${draftText}`,
    },
  ];
}

export function buildFactCheckMessages(draftText: string, contextText: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是小说事实核查员。你的职责是验证文本中的事实性内容：',
        '1. 世界观一致性——是否违反已建立的世界规则',
        '2. 角色设定匹配——角色能力、性格、外貌是否与设定一致',
        '3. 时间线逻辑——事件顺序和时间跨度是否合理',
        '4. 前文衔接——是否与前文内容存在矛盾',
        '5. 地理/空间逻辑——场景描述和位置关系是否合理',
        '',
        '请按以下 JSON 格式输出核查结果：',
        '{"errors": [...], "warnings": [...], "confirmed": [...]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '以下是小说的上下文设定（供参考）：',
        contextText.slice(0, 3000),
        '',
        '请核查以下小说初稿：',
        draftText,
      ].join('\n\n'),
    },
  ];
}

export function buildProofMessages(
  draftText: string,
  reviewText: string,
  factCheckText: string,
): ChatMessage[] {
  const reviewAvailable = reviewText && !reviewText.includes('未能完成');
  const factAvailable = factCheckText && !factCheckText.includes('未能完成');

  return [
    {
      role: 'system',
      content: [
        '你是终审校对员。你将收到一份初稿、审阅编辑的意见和事实核查的结果。',
        '请完成以下工作：',
        '1. 根据审阅编辑的建议修改结构性问题',
        '2. 修正事实核查中发现的所有错误',
        '3. 校对字词、标点、格式等微观层面的问题',
        '4. 保持原文的创意优点和叙事风格',
        '5. 确保修改后的文本整体流畅、连贯',
        '',
        '请直接输出修改后的完整文本，不要输出解释说明。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '【初稿】',
        draftText,
        '',
        '【审阅意见】',
        reviewAvailable ? reviewText : '审阅编辑未能完成审阅，请自行判断结构性问题。',
        '',
        '【事实核查结果】',
        factAvailable ? factCheckText : '事实核查员未能完成核查，请自行检查事实一致性。',
      ].join('\n\n'),
    },
  ];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/pipelineMessages.ts
git commit -m "feat(pipeline): add 4-stage prompt message factories"
```

---

## Task 4: Zustand 任务队列 Store

**Files:**
- Create: `src/store/pipelineTaskStore.ts`

- [ ] **Step 1: 创建 Store**

```typescript
import { create } from 'zustand';
import type { PipelineTask, PipelineStageResult, PipelineTaskStatus } from '../types/pipeline';

interface PipelineTaskState {
  tasks: PipelineTask[];
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
}

let taskIdCounter = 0;

export const usePipelineTaskStore = create<PipelineTaskState>((set, get) => ({
  tasks: [],

  createTask: (targetType, targetId) => {
    const id = `pt_${Date.now().toString(36)}_${++taskIdCounter}`;
    const task: PipelineTask = {
      id,
      targetType,
      targetId,
      status: 'idle',
      stageResults: [],
      finalText: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resolvedAt: null,
    };
    set((state) => ({ tasks: [...state.tasks, task] }));
    return id;
  },

  updateTaskStage: (taskId, result) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId
          ? { ...t, stageResults: [...t.stageResults, result], updatedAt: Date.now() }
          : t
      ),
    }));
  },

  setTaskStatus: (taskId, status) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, status, updatedAt: Date.now() } : t
      ),
    }));
  },

  completeTask: (taskId, finalText) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId
          ? { ...t, status: 'completed', finalText, updatedAt: Date.now() }
          : t
      ),
    }));
  },

  failTask: (taskId, error) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'failed', error, updatedAt: Date.now() } : t
      ),
    }));
  },

  cancelTask: (taskId) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'cancelled', updatedAt: Date.now() } : t
      ),
    }));
  },

  resolveTask: (taskId, action) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, resolvedAt: Date.now(), updatedAt: Date.now() } : t
      ),
    }));
  },

  clearResolved: () => {
    set((state) => ({
      tasks: state.tasks.filter((t) => t.resolvedAt === null),
    }));
  },

  getActiveTaskForTarget: (targetType, targetId) => {
    return get().tasks.find(
      (t) =>
        t.targetType === targetType &&
        t.targetId === targetId &&
        t.resolvedAt === null &&
        (t.status === 'idle' || t.status === 'drafting' || t.status === 'reviewing' || t.status === 'proofing')
    );
  },

  getUnresolvedCount: () => {
    return get().tasks.filter((t) => t.resolvedAt === null).length;
  },
}));
```

- [ ] **Step 2: Commit**

```bash
git add src/store/pipelineTaskStore.ts
git commit -m "feat(pipeline): add in-memory pipeline task queue store"
```

---

## Task 5: 流水线执行核心

**Files:**
- Create: `src/services/pipelineRunner.ts`

**上下文:** 这是整个功能的心脏。复用 `buildContext`、`callLLMResult`、`buildDraftMessages`、`buildReviewMessages`、`buildFactCheckMessages`、`buildProofMessages`。

- [ ] **Step 1: 创建 runner 文件**

```typescript
import * as db from './database';
import { callLLMResult } from './llm';
import { buildContext } from './contextBuilder';
import { createChapterGenerationRequest } from './chapterGeneration';
import {
  buildDraftMessages,
  buildReviewMessages,
  buildFactCheckMessages,
  buildProofMessages,
} from './pipelineMessages';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import type { Chapter } from '../types/novel';
import type { PipelineConfig, PipelineStageResult } from '../types/pipeline';
import type { ChatMessage } from './llm';

const cancelledTasks = new Set<string>();

export function cancelPipeline(taskId: string): void {
  cancelledTasks.add(taskId);
}

export function isPipelineCancelled(taskId: string): boolean {
  return cancelledTasks.has(taskId);
}

export async function runChapterPipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (status: string) => void,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const config = await db.getPipelineConfig();
  const contextConfig = await db.getContextConfig();
  const presets = await db.getPresetsByProject(chapter.project_id);

  // Resolve preset for each stage (fallback to first/default preset)
  const draftPreset = resolvePreset(config.draftPresetId, presets);
  const proofPreset = resolvePreset(config.proofPresetId, presets);

  // Stage 1: Draft
  if (checkCancelled(taskId)) return;
  store.setTaskStatus(taskId, 'drafting');
  onStageUpdate?.('正在创作初稿...');

  const baseContext = await buildContext(chapter, contextConfig, chapter.project_id, draftPreset);
  const request = createChapterGenerationRequest(chapter);
  const draftMessages = buildDraftMessages(
    baseContext,
    chapter.title || `第 ${chapter.position + 1} 章`,
    chapter.content || '',
    request.userPrompt,
  );

  let draftText = '';
  try {
    const draftResult = await callLLMResult(draftMessages, config.draftMaxTokens, {
      max_tokens: config.draftMaxTokens,
      scenario: 'pipeline_draft',
    });
    draftText = draftResult.text || '';
    store.updateTaskStage(taskId, {
      stage: 'draft',
      text: draftText,
      status: 'success',
      tokens: {
        input: draftResult.inputTokens,
        output: draftResult.outputTokens,
        total: draftResult.totalTokens,
      },
      durationMs: 0, // Approximate by caller if needed
    });
  } catch (error: any) {
    store.updateTaskStage(taskId, {
      stage: 'draft',
      text: '',
      status: 'failed',
      error: error.message || '初稿生成失败',
      durationMs: 0,
    });
    store.failTask(taskId, error.message || '初稿生成失败');
    return;
  }

  // Stage 2a + 2b: Review & FactCheck (parallel)
  if (checkCancelled(taskId)) return;
  store.setTaskStatus(taskId, 'reviewing');
  onStageUpdate?.('正在并行审阅与事实核查...');

  const contextText = buildContextPreview(baseContext);

  const reviewPromise = callLLMResult(
    buildReviewMessages(draftText),
    config.reviewMaxTokens,
    { max_tokens: config.reviewMaxTokens, scenario: 'pipeline_review' },
  );

  const factCheckPromise = callLLMResult(
    buildFactCheckMessages(draftText, contextText),
    config.factCheckMaxTokens,
    { max_tokens: config.factCheckMaxTokens, scenario: 'pipeline_factcheck' },
  );

  let reviewText = '';
  let factCheckText = '';
  let reviewFailed = false;
  let factCheckFailed = false;

  try {
    const [reviewResult, factResult] = await Promise.allSettled([reviewPromise, factCheckPromise]);

    if (reviewResult.status === 'fulfilled') {
      reviewText = reviewResult.value.text || '';
      store.updateTaskStage(taskId, {
        stage: 'review',
        text: reviewText,
        status: 'success',
        tokens: {
          input: reviewResult.value.inputTokens,
          output: reviewResult.value.outputTokens,
          total: reviewResult.value.totalTokens,
        },
        durationMs: 0,
      });
    } else {
      reviewFailed = true;
      store.updateTaskStage(taskId, {
        stage: 'review',
        text: '',
        status: 'failed',
        error: reviewResult.reason?.message || '审阅失败',
        durationMs: 0,
      });
    }

    if (factResult.status === 'fulfilled') {
      factCheckText = factResult.value.text || '';
      store.updateTaskStage(taskId, {
        stage: 'factCheck',
        text: factCheckText,
        status: 'success',
        tokens: {
          input: factResult.value.inputTokens,
          output: factResult.value.outputTokens,
          total: factResult.value.totalTokens,
        },
        durationMs: 0,
      });
    } else {
      factCheckFailed = true;
      store.updateTaskStage(taskId, {
        stage: 'factCheck',
        text: '',
        status: 'failed',
        error: factResult.reason?.message || '事实核查失败',
        durationMs: 0,
      });
    }
  } catch {
    // Promise.allSettled should never throw, but guard anyway
  }

  // If both review and factcheck failed, abort
  if (reviewFailed && factCheckFailed) {
    store.completeTask(taskId, draftText);
    return;
  }

  // Stage 3: Proofreading
  if (checkCancelled(taskId)) return;
  store.setTaskStatus(taskId, 'proofing');
  onStageUpdate?.('正在终审校对...');

  try {
    const proofResult = await callLLMResult(
      buildProofMessages(draftText, reviewText, factCheckText),
      config.proofMaxTokens,
      { max_tokens: config.proofMaxTokens, scenario: 'pipeline_proof' },
    );
    const finalText = proofResult.text || draftText;
    store.updateTaskStage(taskId, {
      stage: 'proof',
      text: finalText,
      status: 'success',
      tokens: {
        input: proofResult.inputTokens,
        output: proofResult.outputTokens,
        total: proofResult.totalTokens,
      },
      durationMs: 0,
    });
    store.completeTask(taskId, finalText);
  } catch (error: any) {
    store.updateTaskStage(taskId, {
      stage: 'proof',
      text: draftText,
      status: 'failed',
      error: error.message || '终审失败，回退到初稿',
      durationMs: 0,
    });
    store.completeTask(taskId, draftText);
  }
}

export async function runFreeformPipeline(
  taskId: string,
  projectId: number,
  documentText: string,
  steerText: string,
  onStageUpdate?: (status: string) => void,
): Promise<void> {
  const pseudoChapter: Chapter = {
    id: 0,
    project_id: projectId,
    position: Number.MAX_SAFE_INTEGER,
    title: '自由写作',
    synopsis: steerText,
    content: documentText,
    status: 'draft',
    summary_json: null,
    created_at: '',
    updated_at: '',
  };
  await runChapterPipeline(taskId, pseudoChapter, onStageUpdate);
}

function resolvePreset(presetId: number | null, presets: any[]): any {
  if (presetId != null) {
    const found = presets.find((p) => p.id === presetId);
    if (found) return found;
  }
  return presets[0] || null;
}

function checkCancelled(taskId: string): boolean {
  if (cancelledTasks.has(taskId)) {
    cancelledTasks.delete(taskId);
    usePipelineTaskStore.getState().cancelTask(taskId);
    return true;
  }
  return false;
}

function buildContextPreview(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/pipelineRunner.ts
git commit -m "feat(pipeline): add 4-stage pipeline execution core"
```

---

## Task 6: 配置页面 PipelineConfigScreen

**Files:**
- Create: `src/screens/PipelineConfigScreen.tsx`

- [ ] **Step 1: 创建配置页面**

```typescript
import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Field, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import type { Preset, PipelineConfig } from '../types/novel';

const STAGE_LABELS = [
  { key: 'draft', name: '初稿作者', maxKey: 'draftMaxTokens' as const, presetKey: 'draftPresetId' as const },
  { key: 'review', name: '审阅编辑', maxKey: 'reviewMaxTokens' as const, presetKey: 'reviewPresetId' as const },
  { key: 'factCheck', name: '事实核查员', maxKey: 'factCheckMaxTokens' as const, presetKey: 'factCheckPresetId' as const },
  { key: 'proof', name: '终审校对员', maxKey: 'proofMaxTokens' as const, presetKey: 'proofPresetId' as const },
];

export const PipelineConfigScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [config, setConfig] = useState<PipelineConfig>({
    draftPresetId: null,
    reviewPresetId: null,
    factCheckPresetId: null,
    proofPresetId: null,
    draftMaxTokens: 4000,
    reviewMaxTokens: 1500,
    factCheckMaxTokens: 1500,
    proofMaxTokens: 4000,
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const [savedConfig, projectPresets] = await Promise.all([
      db.getPipelineConfig(),
      db.getPresets(), // global presets; adapt if per-project
    ]);
    setConfig(savedConfig);
    setPresets(projectPresets as Preset[]);
  };

  const save = async () => {
    await db.setPipelineConfig(config);
    Alert.alert('保存成功', '流水线配置已更新。');
  };

  const renderPresetPicker = (presetKey: keyof PipelineConfig, label: string) => {
    const selectedId = config[presetKey] as number | null;
    return (
      <View style={styles.row}>
        <Text style={[styles.label, { color: theme.colors.textPrimary }]}>{label}</Text>
        <View style={styles.presetList}>
          {presets.map((preset) => (
            <Button
              key={preset.id}
              label={preset.name}
              variant={selectedId === preset.id ? 'primary' : 'secondary'}
              onPress={() => setConfig({ ...config, [presetKey]: preset.id })}
            />
          ))}
          <Button
            label="不绑定"
            variant={selectedId === null ? 'primary' : 'ghost'}
            onPress={() => setConfig({ ...config, [presetKey]: null })}
          />
        </View>
      </View>
    );
  };

  return (
    <Screen>
      <Header title="流水线配置" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
          为每个阶段绑定一个写作预设。未绑定时将使用项目默认预设。
        </Text>
        {STAGE_LABELS.map((stage) => (
          <View key={stage.key} style={[styles.card, { backgroundColor: theme.colors.card }]}>
            <Text style={[styles.stageTitle, { color: theme.colors.textPrimary }]}>{stage.name}</Text>
            {renderPresetPicker(stage.presetKey, '绑定预设')}
            <Field
              label="Max Tokens"
              value={String(config[stage.maxKey])}
              onChangeText={(value) => {
                const num = parseInt(value, 10);
                if (!isNaN(num)) setConfig({ ...config, [stage.maxKey]: num });
              }}
              keyboardType="numeric"
            />
          </View>
        ))}
        <Button label="保存配置" onPress={save} />
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 120, gap: spacing.md },
  hint: { fontSize: 13, marginBottom: spacing.md },
  card: { borderRadius: 8, padding: spacing.md, gap: spacing.sm },
  stageTitle: { fontSize: 16, fontWeight: '800' },
  row: { gap: spacing.xs },
  label: { fontSize: 14, fontWeight: '700' },
  presetList: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
```

注意：`db.getPresets()` 需要根据实际 API 调整（如果只有 `getPresetsByProject`，需要从 navigation/route 传入 projectId，或从 store 读取 currentProject）。此处简化展示，实现时根据实际数据库 API 修正。

- [ ] **Step 2: Commit**

```bash
git add src/screens/PipelineConfigScreen.tsx
git commit -m "feat(pipeline): add PipelineConfigScreen"
```

---

## Task 7: 任务中心 PipelineTaskScreen

**Files:**
- Create: `src/screens/PipelineTaskScreen.tsx`

- [ ] **Step 1: 创建任务中心页面**

```typescript
import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Button, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { useNavigation } from '@react-navigation/native';
import type { PipelineTask } from '../types/pipeline';

const STATUS_EMOJI: Record<string, string> = {
  idle: '⏳',
  drafting: '✍️',
  reviewing: '🔍',
  proofing: '✒️',
  completed: '✅',
  cancelled: '🚫',
  failed: '❌',
};

const STATUS_LABEL: Record<string, string> = {
  idle: '等待中',
  drafting: '创作初稿',
  reviewing: '审阅核查',
  proofing: '终审校对',
  completed: '已完成',
  cancelled: '已取消',
  failed: '已失败',
};

export const PipelineTaskScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const navigation = useNavigation();
  const { tasks, clearResolved, resolveTask } = usePipelineTaskStore();

  const unresolvedTasks = tasks.filter((t) => t.resolvedAt === null);

  const renderItem = ({ item }: { item: PipelineTask }) => {
    const isRunning = ['idle', 'drafting', 'reviewing', 'proofing'].includes(item.status);
    const stageCount = item.stageResults.length;
    const totalStages = 4;
    const duration = item.updatedAt - item.createdAt;
    const durationText = duration > 60000 ? `${Math.round(duration / 60000)}m` : `${Math.round(duration / 1000)}s`;

    return (
      <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <View style={styles.row}>
          <Text style={{ fontSize: 20 }}>{STATUS_EMOJI[item.status] || '•'}</Text>
          <View style={styles.info}>
            <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
              {item.targetType === 'chapter' ? `章节 #${item.targetId}` : '自由写作'}
            </Text>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
              {STATUS_LABEL[item.status]} · {stageCount}/{totalStages} 阶段 · {durationText}
            </Text>
          </View>
        </View>
        {!isRunning && item.status !== 'cancelled' && (
          <View style={styles.actions}>
            <Button
              label="查看结果"
              variant="secondary"
              onPress={() => {
                // @ts-ignore
                navigation.navigate('PipelineResult', { taskId: item.id });
              }}
            />
            <Button
              label="删除"
              variant="ghost"
              onPress={() => resolveTask(item.id, 'reject')}
            />
          </View>
        )}
      </View>
    );
  };

  return (
    <Screen>
      <Header title="流水线任务" />
      {unresolvedTasks.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>没有进行中的流水线任务</Text>
        </View>
      ) : (
        <FlatList
          data={unresolvedTasks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={renderItem}
        />
      )}
      <View style={styles.footer}>
        <Button label="清空已完成" variant="ghost" onPress={clearResolved} />
      </View>
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.lg, gap: spacing.md, paddingBottom: 100 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 16 },
  card: { borderRadius: 8, padding: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  info: { flex: 1 },
  title: { fontSize: 15, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 2 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  footer: { padding: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth },
});
```

- [ ] **Step 2: Commit**

```bash
git add src/screens/PipelineTaskScreen.tsx
git commit -m "feat(pipeline): add PipelineTaskScreen"
```

---

## Task 8: 结果详情页 PipelineResultScreen

**Files:**
- Create: `src/screens/PipelineResultScreen.tsx`

- [ ] **Step 1: 创建结果页面**

```typescript
import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { mergeChapterGenerationResult } from '../services/chapterGeneration';
import * as db from '../services/database';
import type { PipelineStageResult } from '../types/pipeline';

type ResultRouteProp = RouteProp<{ PipelineResult: { taskId: string } }, 'PipelineResult'>;

export const PipelineResultScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const navigation = useNavigation();
  const route = useRoute<ResultRouteProp>();
  const { tasks, resolveTask } = usePipelineTaskStore();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const task = tasks.find((t) => t.id === route.params.taskId);
  if (!task) {
    return (
      <Screen>
        <Header title="流水线结果" action={<Button label="返回" variant="ghost" onPress={() => navigation.goBack()} />} />
        <Text style={{ padding: spacing.lg, color: theme.colors.textSecondary }}>任务不存在或已被清除。</Text>
      </Screen>
    );
  }

  const totalTokens = task.stageResults.reduce(
    (sum, r) => sum + (r.tokens?.total || 0),
    0,
  );
  const duration = task.updatedAt - task.createdAt;
  const durationText = duration > 60000
    ? `${Math.floor(duration / 60000)}m ${Math.round((duration % 60000) / 1000)}s`
    : `${Math.round(duration / 1000)}s`;

  const toggleExpanded = (stage: string) => {
    const next = new Set(expanded);
    if (next.has(stage)) next.delete(stage);
    else next.add(stage);
    setExpanded(next);
  };

  const handleAccept = async () => {
    if (!task.finalText || task.targetType !== 'chapter') {
      Alert.alert('无法采纳', '该任务不支持直接采纳，请手动复制文本。');
      return;
    }
    try {
      const chapter = await db.getChapterById(task.targetId);
      if (!chapter) {
        Alert.alert('章节不存在');
        return;
      }
      const merged = mergeChapterGenerationResult(chapter, task.finalText);
      await db.updateChapter(chapter.id, merged);
      resolveTask(task.id, 'accept');
      Alert.alert('已采纳', '文本已合并到章节并保存。');
      navigation.goBack();
    } catch (error: any) {
      Alert.alert('采纳失败', error.message);
    }
  };

  const handleReject = () => {
    resolveTask(task.id, 'reject');
    navigation.goBack();
  };

  const renderStageCard = (stage: PipelineStageResult) => {
    const isExpanded = expanded.has(stage.stage);
    const textLength = stage.text?.length || 0;
    const isJson = stage.stage === 'review' || stage.stage === 'factCheck';

    return (
      <View key={stage.stage} style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <Button
          label={`${stage.stage === 'draft' ? '初稿' : stage.stage === 'review' ? '审阅' : stage.stage === 'factCheck' ? '核查' : '终稿'} ${stage.status === 'success' ? '✅' : '⚠️'} (${textLength} 字)`}
          variant="ghost"
          onPress={() => toggleExpanded(stage.stage)}
        />
        {isExpanded && (
          <Text
            style={[styles.stageText, { color: theme.colors.textPrimary }]}
            selectable
          >
            {isJson ? JSON.stringify(stage.text, null, 2) : stage.text}
          </Text>
        )}
      </View>
    );
  };

  return (
    <Screen>
      <Header
        title="流水线结果"
        action={<Button label="返回" variant="ghost" onPress={() => navigation.goBack()} />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.summary, { color: theme.colors.textSecondary }]}>
          {task.status === 'completed' ? '✅ 已完成' : '❌ 异常终止'} · 耗时 {durationText} · {totalTokens.toLocaleString()} tokens
        </Text>
        {task.stageResults.map(renderStageCard)}
        {task.finalText && (
          <View style={styles.actions}>
            <Button label="放弃" variant="ghost" onPress={handleReject} />
            <Button label="采纳" onPress={handleAccept} />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: 120 },
  summary: { fontSize: 13, fontWeight: '700' },
  card: { borderRadius: 8, padding: spacing.md },
  stageText: { fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md, marginTop: spacing.lg },
});
```

- [ ] **Step 2: Commit**

```bash
git add src/screens/PipelineResultScreen.tsx
git commit -m "feat(pipeline): add PipelineResultScreen"
```

---

## Task 9: ChapterEditor 新增流水线入口

**Files:**
- Modify: `src/screens/ChapterEditor.tsx`

- [ ] **Step 1: 导入新增依赖**

在文件顶部添加：
```typescript
import { GitBranch } from 'lucide-react-native';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { runChapterPipeline, cancelPipeline } from '../services/pipelineRunner';
import Toast from 'react-native-toast-message';
```

- [ ] **Step 2: 在组件内获取 store 和状态**

```typescript
const { createTask, getActiveTaskForTarget, cancelTask } = usePipelineTaskStore();
```

注意：`usePipelineTaskStore` 的 hook 调用必须放在组件函数内。

- [ ] **Step 3: 新增 `runPipeline` 函数**

```typescript
const runPipeline = async () => {
  if (!chapter) return;
  if (chapter.status === 'final') {
    Alert.alert('章节已定稿', '请先将章节状态切回“修订”，再使用流水线写作。');
    return;
  }

  const existing = getActiveTaskForTarget('chapter', chapter.id);
  if (existing) {
    Alert.alert('已有进行中的流水线', '请等待当前任务完成或到任务中心取消。');
    return;
  }

  const config = await db.getPipelineConfig();
  const presets = await db.getPresetsByProject(chapter.project_id);
  const hasBinding = config.draftPresetId != null || presets.length === 0;
  if (!hasBinding && presets.length > 0) {
    // Use default preset if none bound
  }

  const taskId = createTask('chapter', chapter.id);
  Toast.show({ type: 'info', text1: '流水线已启动', text2: '初稿创作中...' });

  try {
    await runChapterPipeline(taskId, chapter, (status) => {
      Toast.show({ type: 'info', text1: '流水线更新', text2: status });
    });

    const store = usePipelineTaskStore.getState();
    const finishedTask = store.tasks.find((t) => t.id === taskId);
    if (finishedTask?.status === 'completed') {
      Toast.show({
        type: 'success',
        text1: '流水线完成！',
        text2: '点击查看最终结果',
        onPress: () => {
          // @ts-ignore
          navigation.navigate('PipelineResult', { taskId });
        },
      });
    } else if (finishedTask?.status === 'failed') {
      Toast.show({ type: 'error', text1: '流水线失败', text2: finishedTask.error || '' });
    }
  } catch (error: any) {
    Toast.show({ type: 'error', text1: '流水线异常', text2: error.message });
  }
};
```

注意：如果组件没有 `navigation` prop，需要从 `useNavigation` hook 获取。当前 `ChapterEditor` 接收 `onClose` 而没有 `navigation`，所以需要添加 `const navigation = useNavigation();`。

- [ ] **Step 4: 在 toolbar 中新增「流水线」按钮**

找到现有 toolbar：
```jsx
<View style={styles.toolbar}>
  <Button label={generating ? '生成中...' : chapter.status === 'revision' ? 'AI 修订' : 'AI 续写'} icon={Bot} onPress={generateContinuation} disabled={generating || finalizing} />
  <Button label="保存" icon={Save} variant="secondary" onPress={...} />
  ...
</View>
```

在其后或其中插入：
```jsx
<Button
  label="流水线"
  icon={GitBranch}
  variant="secondary"
  onPress={runPipeline}
  disabled={generating || finalizing}
/>
```

- [ ] **Step 5: Commit**

```bash
git add src/screens/ChapterEditor.tsx
git commit -m "feat(pipeline): add pipeline button to ChapterEditor"
```

---

## Task 10: FreeformEditor 新增流水线续写入口

**Files:**
- Modify: `src/screens/FreeformEditor.tsx`

- [ ] **Step 1: 导入新增依赖**

```typescript
import { GitBranch } from 'lucide-react-native';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { runFreeformPipeline } from '../services/pipelineRunner';
import Toast from 'react-native-toast-message';
```

- [ ] **Step 2: 新增 `runFreeformPipelineFlow` 函数**

```typescript
const runFreeformPipelineFlow = async () => {
  if (!currentProject) return;

  const existing = usePipelineTaskStore.getState().getActiveTaskForTarget('freeform', currentProject.id);
  if (existing) {
    Alert.alert('已有进行中的流水线', '请等待当前任务完成或到任务中心取消。');
    return;
  }

  const taskId = usePipelineTaskStore.getState().createTask('freeform', currentProject.id);
  Toast.show({ type: 'info', text1: '流水线已启动', text2: '初稿创作中...' });

  try {
    await runFreeformPipeline(taskId, currentProject.id, documentText, steerText, (status) => {
      Toast.show({ type: 'info', text1: '流水线更新', text2: status });
    });

    const finishedTask = usePipelineTaskStore.getState().tasks.find((t) => t.id === taskId);
    if (finishedTask?.status === 'completed') {
      Toast.show({
        type: 'success',
        text1: '流水线完成！',
        text2: '点击查看最终结果',
      });
    }
  } catch (error: any) {
    Toast.show({ type: 'error', text1: '流水线异常', text2: error.message });
  }
};
```

- [ ] **Step 3: 在 toolbar 中新增按钮**

在现有 AI 续写按钮旁边插入：
```jsx
<Button
  label="流水线续写"
  icon={GitBranch}
  variant="secondary"
  onPress={runFreeformPipelineFlow}
  disabled={generating}
/>
```

- [ ] **Step 4: Commit**

```bash
git add src/screens/FreeformEditor.tsx
git commit -m "feat(pipeline): add pipeline button to FreeformEditor"
```

---

## Task 11: SettingsScreen 新增入口 + Badge

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`

- [ ] **Step 1: 导入**

```typescript
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { Factory, ListChecks } from 'lucide-react-native';
```

- [ ] **Step 2: 在组件内获取 badge 数量**

```typescript
const unresolvedCount = usePipelineTaskStore((s) => s.getUnresolvedCount());
```

- [ ] **Step 3: 在设置列表中新增两个入口**

在现有设置项（如 LLM 设置、主题切换等）之间插入：

```jsx
<View style={styles.section}>
  <Text style={[styles.sectionTitle, { color: theme.colors.textPrimary }]}>多角色流水线</Text>
  <Button
    label={`流水线配置${unresolvedCount > 0 ? ` (${unresolvedCount})` : ''}`}
    icon={Factory}
    variant="secondary"
    onPress={() => navigation.navigate('PipelineConfig')}
  />
  <Button
    label={`流水线任务${unresolvedCount > 0 ? ` · ${unresolvedCount} 个未处理` : ''}`}
    icon={ListChecks}
    variant="secondary"
    onPress={() => navigation.navigate('PipelineTask')}
  />
</View>
```

注意：需要根据 `SettingsScreen` 实际使用的导航方式调整（可能是 `navigation.navigate('PipelineConfig')` 或别的路由名）。确保与 `SettingsStackParamList` 定义一致。

- [ ] **Step 4: Commit**

```bash
git add src/screens/SettingsScreen.tsx
git commit -m "feat(pipeline): add pipeline entries to SettingsScreen"
```

---

## Task 12: TabNavigator 注册新页面

**Files:**
- Modify: `src/navigation/TabNavigator.tsx`

- [ ] **Step 1: 导入新 Screen**

```typescript
import { PipelineConfigScreen } from '../screens/PipelineConfigScreen';
import { PipelineTaskScreen } from '../screens/PipelineTaskScreen';
import { PipelineResultScreen } from '../screens/PipelineResultScreen';
```

- [ ] **Step 2: 扩展类型定义**

```typescript
export type EditorStackParamList = {
  EditorMain: undefined;
  ChapterEditor: { chapterId: number };
  ChapterSummary: { chapterId: number };
  PlotlineManager: undefined;
  StoryOverview: undefined;
  ContextConfig: undefined;
  PipelineResult: { taskId: string };
};

export type SettingsStackParamList = {
  SettingsMain: undefined;
  LLMSettings: undefined;
  PipelineConfig: undefined;
  PipelineTask: undefined;
};
```

- [ ] **Step 3: 注册 Screen**

在 `EditorStackScreen` 中追加：
```jsx
<EditorStack.Screen name="PipelineResult" component={PipelineResultScreen} />
```

在 `SettingsStackScreen` 中追加：
```jsx
<SettingsStack.Screen name="PipelineConfig" component={PipelineConfigScreen} />
<SettingsStack.Screen name="PipelineTask" component={PipelineTaskScreen} />
```

- [ ] **Step 4: Commit**

```bash
git add src/navigation/TabNavigator.tsx
git commit -m "feat(pipeline): register pipeline screens in navigation"
```

---

## Spec 覆盖自检

| 设计要求 | 对应 Task | 状态 |
|---------|----------|------|
| 4 阶段状态机（初稿串行->审阅+核查并行->终审串行） | Task 5 | ✅ |
| Stage 2a/2b 并行，单个失败降级，双失败终止 | Task 5 | ✅ |
| Stage 3 失败回退初稿 | Task 5 | ✅ |
| 取消机制（设置 cancelled flag） | Task 5 | ✅ |
| 每阶段 Toast 通知 | Task 9, 10 | ✅ |
| 最终完成可点击 Toast 跳转结果页 | Task 9, 10 | ✅ |
| 全局 PipelineConfig 持久化（settings 表） | Task 2 | ✅ |
| 每阶段绑定 Preset | Task 6 | ✅ |
| 任务中心列表 + badge | Task 7, 11 | ✅ |
| 结果页 4 阶段可展开 + 采纳/放弃 | Task 8 | ✅ |
| ChapterEditor / FreeformEditor 入口 | Task 9, 10 | ✅ |
| 导航注册 | Task 12 | ✅ |
| 类型定义 | Task 1 | ✅ |
| 内存队列 Store | Task 4 | ✅ |
| Prompt 模板（与桌面版对齐） | Task 3 | ✅ |

---

## 执行选项

**Plan complete.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — 每个 Task 由一个独立子代理执行，我在每轮后做代码审查和校验

**2. Inline Execution** — 我在当前会话中按 Task 顺序批量执行，带检查点

**Which approach do you prefer?**
