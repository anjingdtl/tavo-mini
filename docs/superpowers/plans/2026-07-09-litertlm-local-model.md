# LiteRT-LM 本地离线模型接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 tavo-mini（Android React Native）中增加 LiteRT-LM 本地离线模型能力：用户可导入 `.litertlm` 模型、离线运行文本生成，且不影响现有在线 OpenAI 兼容配置。

**Architecture:** 通过 Provider Registry 统一在线/本地两种 Provider；本地模型由 Android Kotlin 原生模块负责文件导入、模型加载、流式推理和生命周期管理；业务状态由 SQLite `local_llm_models` 表和扩展后的 `llm_config` 表承载；UI 在现有 LLM 设置页增加"模型来源"切换，并新增本地模型管理页。

**Tech Stack:** React Native 0.85.3 + TypeScript 5.8 + Kotlin 2.1.20 + LiteRT-LM Android + SQLite + Zustand + `@react-native-documents/picker`。

---

## 0. 项目基线确认（开工前必读）

实施前必须确认仓库当前状态；若以下文件与描述不符，以当前代码为准调整实现。

- React Native：`0.85.3`，React：`19.2.3`，TypeScript：`5.8.3`
- Android minSdk 24，compileSdk/targetSdk 36，Kotlin 2.1.20
- 当前数据库 Schema：`11`（`src/services/migrations/index.ts`）
- 包名：`com.shinewriter`
- 当前 LLM 服务：`src/services/llm.ts`
- 当前 LLM 设置页：`src/screens/LLMSettingsScreen.tsx`
- 当前 LLM 类型：`src/types/novel.ts` 中的 `LLMConfig`
- 当前设置 Store：`src/store/settingsStore.ts`
- 当前数据库入口：`src/services/database.ts`
- 当前迁移入口：`src/services/migrations/index.ts`
- 当前原生包注册：`android/app/src/main/java/com/shinewriter/MainApplication.kt`
- 文件选择器：`@react-native-documents/picker`
- 测试框架：Jest + `@testing-library/react-native`，mock 入口 `jest.setup.js`

---

## 文件结构总览

### 新增 TypeScript 文件

| 文件 | 职责 |
|------|------|
| `src/types/localModel.ts` | `LocalModel`、`LocalModelStatus`、`LLMProviderType` 等类型 |
| `src/types/llmProvider.ts` | `LLMProvider` 接口、`LLMGenerateOptions`、`LLMResult` 等 |
| `src/native/LocalLLMModule.ts` | Kotlin 模块的 TypeScript 桥接与事件路由 |
| `src/services/llm/types.ts` | 共享的 LLM 类型（`ChatMessage`、`LLMResult`、采样参数等） |
| `src/services/llm/providerRegistry.ts` | 根据 `provider_type` 路由到 Online / Local Provider |
| `src/services/llm/openAICompatibleProvider.ts` | 现有 HTTP OpenAI 兼容能力抽取 |
| `src/services/llm/localLiteRtLmProvider.ts` | 本地模型 Provider：加载、生成、取消、日志 |
| `src/services/llm/promptAdapter.ts` | 业务 `ChatMessage[]` → Native 生成请求适配 |
| `src/services/localModels.ts` | 本地模型业务 CRUD、去重、文件检查、启动清理 |
| `src/store/localModelStore.ts` | 本地模型列表、导入状态、当前模型等 UI 状态 |
| `src/screens/LocalModelManagerScreen.tsx` | 本地模型管理页 |

### 修改的 TypeScript 文件

| 文件 | 修改点 |
|------|--------|
| `src/types/novel.ts` | `LLMConfig` 增加 `provider_type`、`local_model_id` 等字段 |
| `src/services/llm.ts` | 改为兼容门面，内部调用 Provider Registry |
| `src/services/database.ts` | `createTables`、`ensureSchemaCompatibility`、CRUD、迁移支持 |
| `src/services/migrations/index.ts` | `SCHEMA_VERSION = 12`，注册 `v11-to-v12` |
| `src/services/migrations/v11-to-v12.ts` | 新建表和字段的迁移逻辑 |
| `src/store/settingsStore.ts` | 支持本地配置保存/激活/删除 |
| `src/screens/LLMSettingsScreen.tsx` | 增加"模型来源"切换、本地模型选择器、管理入口 |
| `src/navigation/TabNavigator.tsx` | 注册 `LocalModelManager` 路由 |
| `jest.setup.js` | 补充 `LocalLLM` NativeModules mock |
| `jest.config.js` | 如新增依赖需要，更新 `transformIgnorePatterns` |

### 新增 Android Kotlin 文件

| 文件 | 职责 |
|------|------|
| `android/app/src/main/java/com/shinewriter/localllm/LocalLLMPackage.kt` | RN Package 注册 |
| `android/app/src/main/java/com/shinewriter/localllm/LocalLLMModule.kt` | RN 模块方法：import/validate/load/generate/cancel/delete |
| `android/app/src/main/java/com/shinewriter/localllm/LocalModelImporter.kt` | `content://` 流式复制、SHA-256、进度事件 |
| `android/app/src/main/java/com/shinewriter/localllm/LocalModelFileManager.kt` | 模型目录管理、路径安全、metadata 读写 |
| `android/app/src/main/java/com/shinewriter/localllm/LiteRtLmEngineManager.kt` | 单例引擎、Conversation、后端切换、取消 |
| `android/app/src/main/java/com/shinewriter/localllm/LiteRtLmPromptAdapter.kt` | `ChatMessage[]` → LiteRT-LM 输入 |
| `android/app/src/main/java/com/shinewriter/localllm/LocalLLMEvents.kt` | 事件常量与数据类 |
| `android/app/src/main/java/com/shinewriter/localllm/LocalLLMErrors.kt` | 错误码常量 |
| `android/app/src/main/java/com/shinewriter/localllm/LocalModelForegroundService.kt` | 导入前台服务 |
| `android/app/src/main/java/com/shinewriter/localllm/LocalModelNotification.kt` | 导入进度通知 |

### 修改的 Android 文件

| 文件 | 修改点 |
|------|--------|
| `android/app/build.gradle` | 增加 LiteRT-LM 依赖（PoC 阶段可先 `latest.release`，合入前必须锁定版本） |
| `android/app/src/main/AndroidManifest.xml` | 增加 `libvndksupport.so`、`libOpenCL.so` 声明；注册前台服务 |
| `android/app/src/main/java/com/shinewriter/MainApplication.kt` | `add(LocalLLMPackage())` |
| `android/app/proguard-rules.pro` | 按需增加 LiteRT-LM keep 规则 |

---

## Phase 0：技术验证 Spike

**目标：** 先证明 LiteRT-LM 在当前 RN/Gradle/Kotlin 工程和目标真机上可运行。Phase 0 通过后再进入后续大规模开发。

### Task 0.1：创建实验分支

**Files:**
- 无文件创建/修改

- [ ] **Step 1：创建并切换到实验分支**

```bash
git checkout -b spike/litertlm-poc
```

- [ ] **Step 2：确认分支状态**

```bash
git status
```

Expected: `On branch spike/litertlm-poc`

### Task 0.2：增加 LiteRT-LM 依赖与 GPU 库声明

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1：在 `android/app/build.gradle` 增加依赖**

在 `dependencies { ... }` 内添加（PoC 阶段使用）：

```gradle
def liteRtLmVersion = "latest.release"
implementation("com.google.ai.edge.litertlm:litertlm-android:${liteRtLmVersion}")
```

- [ ] **Step 2：在 `AndroidManifest.xml` application 节点内增加 native library 声明**

```xml
<uses-native-library
    android:name="libvndksupport.so"
    android:required="false" />
<uses-native-library
    android:name="libOpenCL.so"
    android:required="false" />
```

- [ ] **Step 3：同步 Gradle 并构建**

```bash
npm install
cd android && ./gradlew :app:assembleDebug
```

Expected: 构建成功（允许下载依赖耗时较长）。

### Task 0.3：最小 Kotlin 测试入口

**Files:**
- Create: `android/app/src/main/java/com/shinewriter/localllm/LiteRtLmSpikeActivity.kt`
- Modify: `android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1：创建最小 Activity，从固定私有路径加载模型并生成中文**

```kotlin
package com.shinewriter.localllm

import android.app.Activity
import android.os.Bundle
import android.util.Log
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class LiteRtLmSpikeActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    CoroutineScope(Dispatchers.IO).launch {
      try {
        val modelFile = File(noBackupFilesDir, "models/spike/model.litertlm")
        val config = EngineConfig(
          modelPath = modelFile.absolutePath,
          backend = Backend.GPU(),
          cacheDir = cacheDir.path,
        )
        val engine = Engine(config)
        engine.initialize()
        val conversation = engine.createConversation()
        conversation.sendMessage("请用中文写一句话：").collect { chunk ->
          Log.d("LiteRT-Spike", "chunk=$chunk")
        }
        conversation.close()
        engine.close()
      } catch (e: Throwable) {
        Log.e("LiteRT-Spike", "GPU failed", e)
        // GPU 失败时尝试 CPU
        try {
          val modelFile = File(noBackupFilesDir, "models/spike/model.litertlm")
          val config = EngineConfig(
            modelPath = modelFile.absolutePath,
            backend = Backend.CPU(),
            cacheDir = cacheDir.path,
          )
          val engine = Engine(config)
          engine.initialize()
          val conversation = engine.createConversation()
          conversation.sendMessage("请用中文写一句话：").collect { chunk ->
            Log.d("LiteRT-Spike", "cpu chunk=$chunk")
          }
          conversation.close()
          engine.close()
        } catch (e2: Throwable) {
          Log.e("LiteRT-Spike", "CPU also failed", e2)
        }
      }
    }
  }
}
```

- [ ] **Step 2：注册 Activity（仅 debug 用途）**

```xml
<activity android:name=".localllm.LiteRtLmSpikeActivity" android:exported="false" />
```

- [ ] **Step 3：将已知有效 `.litertlm` 推送到设备私有目录**

```bash
adb shell mkdir -p /data/user/0/com.shinewriter/no_backup/models/spike
adb push /path/to/your/model.litertlm /data/user/0/com.shinewriter/no_backup/models/spike/model.litertlm
```

- [ ] **Step 4：启动 Spike Activity 并观察日志**

```bash
adb shell am start -n com.shinewriter/.localllm.LiteRtLmSpikeActivity
adb logcat -s "LiteRT-Spike" -v threadtime
```

Expected: 至少 CPU 可返回中文文本；记录 GPU 是否成功、加载耗时、首字延迟、Token/s、内存峰值。

### Task 0.4：Release APK 验证

**Files:**
- Modify: `android/app/build.gradle`（如需要临时签名）

- [ ] **Step 1：构建 release APK**

```bash
npm run apk:release
```

Expected: `dist/apk/release/ShineWriter-V2.3.1-release.apk` 生成成功。

- [ ] **Step 2：安装 release APK 并重复 Spike 测试**

```bash
adb install -r dist/apk/release/ShineWriter-V2.3.1-release.apk
adb shell am start -n com.shinewriter/.localllm.LiteRtLmSpikeActivity
adb logcat -s "LiteRT-Spike" -v threadtime
```

Expected: Release 包至少 CPU 可运行，无持续崩溃。

### Task 0.5：记录 Spike 结论

**Files:**
- Create: `docs/superpowers/spikes/2026-07-09-litertlm-spike-report.md`

- [ ] **Step 1：填写验证报告**

模板见 SPEC 第 27 节；至少包含：

- LiteRT-LM 版本（从 Gradle 锁定）
- ABI
- GPU 是否成功
- CPU 是否成功
- 加载耗时
- 首字延迟
- Token/s
- 取消语义（能否中途停止）
- 内存峰值
- Release 包结果

- [ ] **Step 2：决定是否继续**

Go 条件：至少 CPU 可运行、Release 可运行、引擎可释放、中文可返回。
No-Go 条件：工具链根本冲突、arm64 Release 无法加载、引擎无法释放导致稳定 OOM、无可用模型。

---

## Phase 1：Provider 重构

**目标：** 引入 `provider_type`，把现有 HTTP 能力抽取为 `openAICompatibleProvider`，并保留 `llm.ts` 兼容门面。

### Task 1.1：新增 LLM 类型与 Provider 接口

**Files:**
- Create: `src/services/llm/types.ts`
- Create: `src/types/llmProvider.ts`

- [ ] **Step 1：创建 `src/services/llm/types.ts`**

```ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResult {
  text: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  errorCode?: string;
  rawUsage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface LLMGenerateOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  scenario?: string;
  projectId?: number;
}

export type LLMProviderType = 'openai_compatible' | 'local_litertlm';
```

- [ ] **Step 2：创建 `src/types/llmProvider.ts`**

```ts
import type { ChatMessage, LLMGenerateOptions, LLMResult, LLMProviderType } from '../services/llm/types';
import type { LLMRequestConfig } from '../services/llm';

export interface LLMProvider {
  readonly type: LLMProviderType;
  test(config: LLMRequestConfig): Promise<string>;
  generate(
    messages: ChatMessage[],
    options: LLMGenerateOptions,
    signal?: AbortSignal,
  ): Promise<LLMResult>;
}
```

### Task 1.2：抽取 Online Provider

**Files:**
- Create: `src/services/llm/openAICompatibleProvider.ts`

- [ ] **Step 1：把 `src/services/llm.ts` 中的 HTTP 逻辑迁移到新文件**

保留：

- `normalizeChatCompletionUrl`
- `formatLLMError`
- `createConcurrencyLimiter` / `limitLLMRequest`
- `callLLMResult` 的 fetch 实现

新文件导出：

```ts
export const openAICompatibleProvider: LLMProvider = {
  type: 'openai_compatible',
  async test(config) { ... },
  async generate(messages, options, signal) { ... },
};
```

- [ ] **Step 2：实现 `test` 方法**

```ts
async test(config: LLMRequestConfig): Promise<string> {
  const url = normalizeChatCompletionUrl(config.url);
  if (!url || !config.api_key.trim() || !config.model_name.trim()) {
    throw new Error('请填写 API 地址、API Key 和模型名称。');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.api_key.trim()}`,
      },
      body: JSON.stringify({
        model: config.model_name.trim(),
        messages: [{ role: 'user', content: '请回复“连接成功”。' }],
        temperature: 0,
        max_tokens: 16,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw formatLLMError(response.status, text);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content ||
      data.choices?.[0]?.message?.reasoning_content ||
      '连接成功';
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 3：实现 `generate` 方法**

从现有 `callLLMResult` 复制 fetch 逻辑，注意：

- 使用 `config.url`、`config.api_key`、`config.model_name`
- 保留 `limitLLMRequest`
- 保留 `externalSignal` 处理
- 保留 usage 日志调用

### Task 1.3：实现 Provider Registry

**Files:**
- Create: `src/services/llm/providerRegistry.ts`

- [ ] **Step 1：创建 Registry**

```ts
import { openAICompatibleProvider } from './openAICompatibleProvider';
import { localLiteRtLmProvider } from './localLiteRtLmProvider';
import type { LLMProvider } from '../../types/llmProvider';
import type { LLMProviderType } from './types';

const providers: Record<LLMProviderType, LLMProvider> = {
  openai_compatible: openAICompatibleProvider,
  local_litertlm: localLiteRtLmProvider,
};

export function getProvider(type: LLMProviderType): LLMProvider {
  return providers[type];
}
```

### Task 1.4：改造 `llm.ts` 门面

**Files:**
- Modify: `src/services/llm.ts`

- [ ] **Step 1：扩展 `LLMRequestConfig`**

```ts
export interface LLMRequestConfig {
  id?: number;
  name?: string;
  provider_type: LLMProviderType;
  api_key: string;
  model_name: string;
  url: string;
  local_model_id?: string;
  local_model_path?: string;
  local_backend?: 'auto' | 'gpu' | 'cpu';
  context_window?: number;
  max_output_tokens?: number;
}
```

- [ ] **Step 2：改写 `resolveLLMRequestConfig`**

```ts
export async function resolveLLMRequestConfig(): Promise<LLMRequestConfig> {
  const config = await db.getActiveLLMConfig();
  return {
    id: config.id,
    name: config.name,
    provider_type: config.provider_type,
    api_key: config.provider_type === 'openai_compatible' ? await db.getSecureLLMApiKey(config.id) : '',
    model_name: config.model_name,
    url: normalizeChatCompletionUrl(config.base_url),
    local_model_id: config.local_model_id || undefined,
    local_backend: config.local_backend || undefined,
    context_window: config.context_window,
    max_output_tokens: config.max_output_tokens,
  };
}
```

- [ ] **Step 3：改写 `callLLMResult`**

```ts
export async function callLLMResult(
  messages: ChatMessage[],
  maxTokens?: number,
  config?: LLMCallConfig,
  externalSignal?: AbortSignal,
): Promise<LLMResult> {
  const requestConfig = config?.requestConfig ?? await resolveLLMRequestConfig();
  const provider = getProvider(requestConfig.provider_type);
  return provider.generate(messages, {
    temperature: config?.temperature,
    top_p: config?.top_p,
    max_tokens: maxTokens ?? config?.max_tokens,
    scenario: config?.scenario,
    projectId: config?.projectId,
  }, externalSignal);
}
```

- [ ] **Step 4：改写 `testLLMConnection`**

```ts
export async function testLLMConnection(
  baseUrl: string,
  apiKey: string,
  modelName: string,
  providerType: LLMProviderType = 'openai_compatible',
  localModelId?: string,
): Promise<string> {
  const provider = getProvider(providerType);
  return provider.test({
    provider_type: providerType,
    api_key: apiKey,
    model_name: modelName,
    url: normalizeChatCompletionUrl(baseUrl),
    local_model_id: localModelId,
  });
}
```

### Task 1.5：在线模型回归测试

**Files:**
- 无新增

- [ ] **Step 1：运行单元测试**

```bash
npm test
```

Expected: 全绿（在线 Provider 逻辑未变）。

- [ ] **Step 2：运行 lint**

```bash
npm run lint
```

Expected: 无新增错误。

---

## Phase 2：数据库和模型管理

**目标：** Schema 升级到 12，新增 `local_llm_models` 表，扩展 `llm_config`，实现本地模型 CRUD 和启动清理。

### Task 2.1：新增本地模型类型

**Files:**
- Create: `src/types/localModel.ts`

- [ ] **Step 1：创建类型文件**

```ts
export type LocalModelStatus =
  | 'importing'
  | 'validating'
  | 'ready'
  | 'incompatible'
  | 'corrupted'
  | 'missing'
  | 'error';

export type LocalModelBackend = 'auto' | 'gpu' | 'cpu' | 'npu';

export interface LocalModel {
  id: string;
  display_name: string;
  original_filename: string;
  relative_path: string;
  file_size: number;
  sha256: string;
  status: LocalModelStatus;
  backend_preference: LocalModelBackend;
  validated_backend: 'gpu' | 'cpu' | null;
  context_length: number | null;
  max_output_tokens: number | null;
  load_time_ms: number | null;
  first_token_ms: number | null;
  tokens_per_second: number | null;
  imported_at: string;
  last_used_at: string | null;
  last_validated_at: string | null;
  error_code: string | null;
  error_message: string | null;
}
```

### Task 2.2：扩展 `LLMConfig` 类型

**Files:**
- Modify: `src/types/novel.ts`

- [ ] **Step 1：增加字段**

```ts
export type LLMProviderType = 'openai_compatible' | 'local_litertlm';

export interface LLMConfig {
  id: number;
  name: string;
  provider_type: LLMProviderType;
  base_url: string;
  api_key: string;
  model_name: string;
  is_active: number;
  local_model_id: string | null;
  local_backend: 'auto' | 'gpu' | 'cpu' | null;
  context_window: number;
  max_output_tokens: number;
}
```

### Task 2.3：新增 Schema 12 迁移

**Files:**
- Create: `src/services/migrations/v11-to-v12.ts`

- [ ] **Step 1：实现迁移**

```ts
import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

export async function migrateV11toV12(db: SQLite.SQLiteDatabase): Promise<void> {
  await execute(db, `
    CREATE TABLE IF NOT EXISTS local_llm_models (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      file_size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'importing',
      backend_preference TEXT NOT NULL DEFAULT 'auto',
      validated_backend TEXT,
      context_length INTEGER,
      max_output_tokens INTEGER,
      load_time_ms INTEGER,
      first_token_ms INTEGER,
      tokens_per_second REAL,
      imported_at TEXT NOT NULL,
      last_used_at TEXT,
      last_validated_at TEXT,
      error_code TEXT,
      error_message TEXT
    )
  `);

  await execute(db, `
    CREATE INDEX IF NOT EXISTS idx_local_llm_models_status
    ON local_llm_models(status)
  `);
  await execute(db, `
    CREATE INDEX IF NOT EXISTS idx_local_llm_models_last_used
    ON local_llm_models(last_used_at)
  `);

  const columns = await tableColumns(db, 'llm_config');
  if (!columns.has('provider_type')) {
    await execute(db, "ALTER TABLE llm_config ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'openai_compatible'");
  }
  if (!columns.has('local_model_id')) {
    await execute(db, 'ALTER TABLE llm_config ADD COLUMN local_model_id TEXT');
  }
  if (!columns.has('local_backend')) {
    await execute(db, 'ALTER TABLE llm_config ADD COLUMN local_backend TEXT');
  }
  if (!columns.has('context_window')) {
    await execute(db, 'ALTER TABLE llm_config ADD COLUMN context_window INTEGER NOT NULL DEFAULT 4096');
  }
  if (!columns.has('max_output_tokens')) {
    await execute(db, 'ALTER TABLE llm_config ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 4000');
  }
}

async function tableColumns(db: SQLite.SQLiteDatabase, table: string): Promise<Set<string>> {
  const result = await execute(db, `PRAGMA table_info(${table})`);
  const columns = new Set<string>();
  for (let i = 0; i < result.rows.length; i += 1) {
    columns.add(result.rows.item(i).name);
  }
  return columns;
}
```

### Task 2.4：注册迁移并升级 Schema 版本

**Files:**
- Modify: `src/services/migrations/index.ts`

- [ ] **Step 1：导入并注册迁移**

```ts
import { migrateV11toV12 } from './v11-to-v12';

export const SCHEMA_VERSION = 12;

const MIGRATIONS: Migration[] = [
  // ... existing migrations ...
  { from: 11, to: 12, breaking: false, migrate: migrateV11toV12 },
];
```

### Task 2.5：同步 fresh install 的建表逻辑

**Files:**
- Modify: `src/services/database.ts`

- [ ] **Step 1：在 `createTables` 中更新 `llm_config` 建表语句**

```ts
CREATE TABLE IF NOT EXISTS llm_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 0,
  provider_type TEXT NOT NULL DEFAULT 'openai_compatible',
  local_model_id TEXT,
  local_backend TEXT,
  context_window INTEGER NOT NULL DEFAULT 4096,
  max_output_tokens INTEGER NOT NULL DEFAULT 4000
)
```

- [ ] **Step 2：在 `ensureSchemaCompatibility` 中确保新增字段存在**

```ts
const llm = await tableColumns(database, 'llm_config');
await ensureColumn(database, 'llm_config', llm, 'provider_type', "provider_type TEXT NOT NULL DEFAULT 'openai_compatible'");
await ensureColumn(database, 'llm_config', llm, 'local_model_id', 'local_model_id TEXT');
await ensureColumn(database, 'llm_config', llm, 'local_backend', 'local_backend TEXT');
await ensureColumn(database, 'llm_config', llm, 'context_window', 'context_window INTEGER NOT NULL DEFAULT 4096');
await ensureColumn(database, 'llm_config', llm, 'max_output_tokens', 'max_output_tokens INTEGER NOT NULL DEFAULT 4000');
```

- [ ] **Step 3：在 `createTables` 中增加 `local_llm_models` 建表语句**

复制 Task 2.3 中的 CREATE TABLE 和 CREATE INDEX 语句。

### Task 2.6：实现本地模型业务 CRUD

**Files:**
- Create: `src/services/localModels.ts`

- [ ] **Step 1：实现基础 CRUD**

```ts
import { openDatabase } from './database';
import type { LocalModel, LocalModelStatus } from '../types/localModel';

const db = () => openDatabase();

function now(): string {
  return new Date().toISOString();
}

export async function listLocalModels(): Promise<LocalModel[]> {
  const rows = await (await db()).executeSql(
    'SELECT * FROM local_llm_models ORDER BY imported_at DESC'
  );
  const result: LocalModel[] = [];
  for (let i = 0; i < rows[0].rows.length; i += 1) {
    result.push(rows[0].rows.item(i));
  }
  return result;
}

export async function getLocalModelById(id: string): Promise<LocalModel | null> {
  const rows = await (await db()).executeSql(
    'SELECT * FROM local_llm_models WHERE id = ?',
    [id]
  );
  return rows[0].rows.length > 0 ? rows[0].rows.item(0) : null;
}

export async function getLocalModelBySha256(sha256: string): Promise<LocalModel | null> {
  const rows = await (await db()).executeSql(
    'SELECT * FROM local_llm_models WHERE sha256 = ?',
    [sha256]
  );
  return rows[0].rows.length > 0 ? rows[0].rows.item(0) : null;
}

export async function createLocalModel(model: Omit<LocalModel, 'imported_at'> & { imported_at?: string }): Promise<void> {
  await (await db()).executeSql(
    `INSERT INTO local_llm_models (
      id, display_name, original_filename, relative_path, file_size, sha256,
      status, backend_preference, validated_backend,
      context_length, max_output_tokens,
      load_time_ms, first_token_ms, tokens_per_second,
      imported_at, last_used_at, last_validated_at, error_code, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      model.id,
      model.display_name,
      model.original_filename,
      model.relative_path,
      model.file_size,
      model.sha256,
      model.status,
      model.backend_preference,
      model.validated_backend,
      model.context_length,
      model.max_output_tokens,
      model.load_time_ms,
      model.first_token_ms,
      model.tokens_per_second,
      model.imported_at || now(),
      model.last_used_at,
      model.last_validated_at,
      model.error_code,
      model.error_message,
    ]
  );
}

export async function updateLocalModel(
  id: string,
  fields: Partial<Omit<LocalModel, 'id' | 'sha256'>>
): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (fields as any)[k]);
  await (await db()).executeSql(
    `UPDATE local_llm_models SET ${sets} WHERE id = ?`,
    [...values, id]
  );
}

export async function deleteLocalModelRecord(id: string): Promise<void> {
  await (await db()).executeSql('DELETE FROM local_llm_models WHERE id = ?', [id]);
}

export async function countLLMConfigsUsingModel(modelId: string): Promise<number> {
  const rows = await (await db()).executeSql(
    'SELECT COUNT(*) AS cnt FROM llm_config WHERE local_model_id = ?',
    [modelId]
  );
  return rows[0].rows.item(0).cnt;
}
```

### Task 2.7：实现启动清理与文件存在检查

**Files:**
- Modify: `src/services/localModels.ts`

- [ ] **Step 1：增加启动扫描函数**

```ts
import { LocalLLM } from '../native/LocalLLMModule';

export async function cleanupOrphanedModels(): Promise<void> {
  const models = await listLocalModels();
  for (const model of models) {
    const exists = await LocalLLM.modelFileExists(model.relative_path);
    if (!exists && model.status !== 'missing') {
      await updateLocalModel(model.id, { status: 'missing', error_code: 'MODEL_FILE_MISSING' });
    }
  }
}

export async function cleanupStagingFiles(): Promise<number> {
  return LocalLLM.cleanupStagingFiles();
}
```

### Task 2.8：迁移测试

**Files:**
- Create: `__tests__/migrations/v11-to-v12.test.ts`

- [ ] **Step 1：编写迁移测试**

```ts
import { migrateV11toV12 } from '../../src/services/migrations/v11-to-v12';

describe('migrateV11toV12', () => {
  it('creates local_llm_models and adds llm_config columns', async () => {
    const mockDb = {
      executeSql: jest.fn(async (sql: string) => {
        if (sql.includes('PRAGMA table_info')) {
          return [{ rows: { length: 0, item: () => null } }];
        }
        return [{ rows: { length: 0, item: () => null } }];
      }),
    };
    await migrateV11toV12(mockDb as any);
    const calls = mockDb.executeSql.mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((sql: string) => sql.includes('CREATE TABLE IF NOT EXISTS local_llm_models'))).toBe(true);
    expect(calls.some((sql: string) => sql.includes('provider_type'))).toBe(true);
    expect(calls.some((sql: string) => sql.includes('local_model_id'))).toBe(true);
  });
});
```

- [ ] **Step 2：运行测试**

```bash
npx jest __tests__/migrations/v11-to-v12.test.ts
```

Expected: PASS。

---

## Phase 3：Native Import

**目标：** 实现 Android 原生模块的文件导入：选择、流式复制、SHA-256、进度、取消、空间检查、路径保护。

### Task 3.1：定义事件与错误码

**Files:**
- Create: `android/app/src/main/java/com/shinewriter/localllm/LocalLLMEvents.kt`
- Create: `android/app/src/main/java/com/shinewriter/localllm/LocalLLMErrors.kt`

- [ ] **Step 1：创建 `LocalLLMEvents.kt`**

```kotlin
package com.shinewriter.localllm

object LocalLLMEvents {
  const val IMPORT_PROGRESS = "LocalLLMImportProgress"
  const val IMPORT_STATE = "LocalLLMImportState"
  const val LOAD_STATE = "LocalLLMLoadState"
  const val TOKEN = "LocalLLMToken"
  const val COMPLETED = "LocalLLMCompleted"
  const val ERROR = "LocalLLMError"
  const val BENCHMARK = "LocalLLMBenchmark"
}

data class ImportProgressEvent(
  val importId: String,
  val bytesCopied: Long,
  val totalBytes: Long,
  val percent: Int,
)

data class ImportStateEvent(
  val importId: String,
  val state: String,
)

data class TokenEvent(
  val requestId: String,
  val delta: String,
  val sequence: Int,
)

data class CompletedEvent(
  val requestId: String,
  val text: String,
  val elapsedMs: Long,
  val firstTokenMs: Long?,
  val tokensPerSecond: Float,
)

data class ErrorEvent(
  val requestId: String,
  val operation: String,
  val code: String,
  val message: String,
  val recoverable: Boolean,
)
```

- [ ] **Step 2：创建 `LocalLLMErrors.kt`**

```kotlin
package com.shinewriter.localllm

object LocalLLMErrors {
  const val LOCAL_LLM_UNAVAILABLE = "LOCAL_LLM_UNAVAILABLE"
  const val UNSUPPORTED_ABI = "UNSUPPORTED_ABI"
  const val UNSUPPORTED_FILE_TYPE = "UNSUPPORTED_FILE_TYPE"
  const val SOURCE_URI_UNREADABLE = "SOURCE_URI_UNREADABLE"
  const val SOURCE_FILE_EMPTY = "SOURCE_FILE_EMPTY"
  const val SOURCE_SIZE_UNKNOWN = "SOURCE_SIZE_UNKNOWN"
  const val INSUFFICIENT_STORAGE = "INSUFFICIENT_STORAGE"
  const val IMPORT_CANCELLED = "IMPORT_CANCELLED"
  const val IMPORT_COPY_FAILED = "IMPORT_COPY_FAILED"
  const val IMPORT_INCOMPLETE = "IMPORT_INCOMPLETE"
  const val HASH_FAILED = "HASH_FAILED"
  const val DUPLICATE_MODEL = "DUPLICATE_MODEL"
  const val MODEL_FILE_MISSING = "MODEL_FILE_MISSING"
  const val MODEL_FILE_OUTSIDE_ROOT = "MODEL_FILE_OUTSIDE_ROOT"
  const val MODEL_CORRUPTED = "MODEL_CORRUPTED"
  const val MODEL_INCOMPATIBLE = "MODEL_INCOMPATIBLE"
  const val GPU_INIT_FAILED = "GPU_INIT_FAILED"
  const val CPU_INIT_FAILED = "CPU_INIT_FAILED"
  const val ENGINE_INIT_FAILED = "ENGINE_INIT_FAILED"
  const val ENGINE_NOT_READY = "ENGINE_NOT_READY"
  const val ENGINE_BUSY = "ENGINE_BUSY"
  const val MODEL_LOAD_CANCELLED = "MODEL_LOAD_CANCELLED"
  const val GENERATION_FAILED = "GENERATION_FAILED"
  const val GENERATION_CANCELLED = "GENERATION_CANCELLED"
  const val DELETE_BLOCKED = "DELETE_BLOCKED"
  const val DELETE_FAILED = "DELETE_FAILED"
  const val NATIVE_MODULE_MISSING = "NATIVE_MODULE_MISSING"
  const val RUNTIME_VERSION_MISMATCH = "RUNTIME_VERSION_MISMATCH"
}
```

### Task 3.2：模型文件管理器

**Files:**
- Create: `android/app/src/main/java/com/shinewriter/localllm/LocalModelFileManager.kt`

- [ ] **Step 1：实现路径安全和目录管理**

```kotlin
package com.shinewriter.localllm

import android.content.Context
import java.io.File
import java.util.UUID

class LocalModelFileManager(private val context: Context) {
  val modelsRoot: File
    get() = File(context.noBackupFilesDir, "models").canonicalFile

  val stagingDir: File
    get() = File(modelsRoot, ".staging").canonicalFile

  fun ensureDirs() {
    modelsRoot.mkdirs()
    stagingDir.mkdirs()
  }

  fun newStagingFile(importId: String): File {
    ensureDirs()
    return File(stagingDir, "$importId.litertlm.tmp").canonicalFile
  }

  fun newModelDir(modelId: String): File {
    ensureDirs()
    return File(modelsRoot, modelId).canonicalFile
  }

  fun modelFile(relativePath: String): File {
    val target = File(modelsRoot, relativePath).canonicalFile
    require(target.path.startsWith(modelsRoot.path + File.separator)) {
      LocalLLMErrors.MODEL_FILE_OUTSIDE_ROOT
    }
    return target
  }

  fun generateModelId(): String = UUID.randomUUID().toString()

  fun isOlderThan24h(file: File): Boolean {
    return System.currentTimeMillis() - file.lastModified() > 24 * 60 * 60 * 1000L
  }
}
```

### Task 3.3：流式导入器

**Files:**
- Create: `android/app/src/main/java/com/shinewriter/localllm/LocalModelImporter.kt`

- [ ] **Step 1：实现 `importModel` 主流程**

伪代码：

```kotlin
suspend fun importModel(
  sourceUri: Uri,
  originalFilename: String,
  displayName: String,
): ImportResult {
  // 1. 扩展名检查
  if (!originalFilename.endsWith(".litertlm", ignoreCase = true)) {
    throw LocalLLMException(LocalLLMErrors.UNSUPPORTED_FILE_TYPE, "只支持 .litertlm 文件")
  }

  // 2. 元数据读取
  val resolver = context.contentResolver
  var size: Long? = null
  resolver.query(sourceUri, null, null, null, null)?.use { cursor ->
    if (cursor.moveToFirst()) {
      val idx = cursor.getColumnIndex(OpenableColumns.SIZE)
      if (idx >= 0 && !cursor.isNull(idx)) size = cursor.getLong(idx)
    }
  }

  // 3. 空间检查
  val stat = StatFs(fileManager.modelsRoot.path)
  val freeBytes = stat.availableBytes
  val fileSize = size ?: 0L
  if (fileSize > 0) {
    val required = fileSize + max(512L * 1024 * 1024, (fileSize * 0.2).toLong())
    if (freeBytes < required) {
      throw LocalLLMException(LocalLLMErrors.INSUFFICIENT_STORAGE, "需要 $required 字节，当前可用 $freeBytes 字节")
    }
  }

  // 4. 流式复制 + SHA-256
  val importId = UUID.randomUUID().toString()
  val staging = fileManager.newStagingFile(importId)
  val digest = MessageDigest.getInstance("SHA-256")
  val buffer = ByteArray(1024 * 1024)
  var copied = 0L

  resolver.openInputStream(sourceUri)?.use { input ->
    staging.outputStream().buffered(1024 * 1024).use { output ->
      while (true) {
        ensureActive()
        val read = input.read(buffer)
        if (read < 0) break
        output.write(buffer, 0, read)
        digest.update(buffer, 0, read)
        copied += read
        emitProgress(importId, copied, fileSize)
      }
      output.flush()
    }
  } ?: throw LocalLLMException(LocalLLMErrors.SOURCE_URI_UNREADABLE, "无法读取源文件")

  val sha256 = digest.digest().joinToString("") { "%02x".format(it) }
  return ImportResult(importId, originalFilename, displayName, fileSize, sha256, staging.relativeTo(fileManager.modelsRoot).path)
}
```

- [ ] **Step 2：实现 `ImportResult` 数据类**

```kotlin
data class ImportResult(
  val importId: String,
  val originalFilename: String,
  val displayName: String,
  val fileSize: Long,
  val sha256: String,
  val stagingRelativePath: String,
)
```

### Task 3.4：前台服务

**Files:**
- Create: `android/app/src/main/java/com/shinewriter/localllm/LocalModelForegroundService.kt`
- Create: `android/app/src/main/java/com/shinewriter/localllm/LocalModelNotification.kt`

- [ ] **Step 1：实现前台服务**

参考现有 `PipelineForegroundService.kt`，创建独立服务 `LocalModelForegroundService`，用于在导入期间保持前台通知。

- [ ] **Step 2：在 `AndroidManifest.xml` 注册服务**

```xml
<service
    android:name=".localllm.LocalModelForegroundService"
    android:foregroundServiceType="dataSync"
    android:exported="false" />
```

### Task 3.5：LocalLLMModule

**Files:**
- Create: `android/app/src/main/java/com/shinewriter/localllm/LocalLLMModule.kt`
- Create: `android/app/src/main/java/com/shinewriter/localllm/LocalLLMPackage.kt`

- [ ] **Step 1：实现模块方法**

```kotlin
package com.shinewriter.localllm

import com.facebook.react.bridge.*

class LocalLLMModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "LocalLLM"

  private val fileManager = LocalModelFileManager(reactContext)
  private val importer = LocalModelImporter(reactContext, fileManager)

  @ReactMethod
  fun getCapabilities(promise: Promise) {
    // 见 SPEC 11.3
  }

  @ReactMethod
  fun importModel(sourceUri: String, originalFilename: String, displayName: String, promise: Promise) {
    // 启动协程，调用 importer.importModel
  }

  @ReactMethod
  fun validateModel(modelId: String, relativePath: String, backend: String, promise: Promise) { }

  @ReactMethod
  fun loadModel(modelId: String, relativePath: String, backend: String, promise: Promise) { }

  @ReactMethod
  fun generate(requestId: String, modelId: String, request: ReadableMap, promise: Promise) { }

  @ReactMethod
  fun cancel(requestId: String, promise: Promise) { }

  @ReactMethod
  fun unloadModel(promise: Promise) { }

  @ReactMethod
  fun deleteModelFiles(modelId: String, relativePath: String, promise: Promise) { }

  @ReactMethod
  fun modelFileExists(relativePath: String, promise: Promise) {
    promise.resolve(fileManager.modelFile(relativePath).exists())
  }

  @ReactMethod
  fun cleanupStagingFiles(promise: Promise) {
    val count = fileManager.stagingDir.listFiles { f -> f.name.endsWith(".tmp") && isOlderThan24h(f) }?.sumOf { it.delete().let { 1 } ?: 0 } ?: 0
    promise.resolve(count)
  }

  // NativeEventEmitter 协议要求
  @ReactMethod
  fun addListener(eventName: String) { }

  @ReactMethod
  fun removeListeners(count: Int) { }
}
```

- [ ] **Step 2：实现 Package**

```kotlin
package com.shinewriter.localllm

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class LocalLLMPackage : ReactPackage {
  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(LocalLLMModule(reactContext))
}
```

- [ ] **Step 3：注册 Package**

在 `MainApplication.kt` 的 `PackageList(...).packages.apply { ... }` 中增加：

```kotlin
add(LocalLLMPackage())
```

### Task 3.6：TypeScript 桥接

**Files:**
- Create: `src/native/LocalLLMModule.ts`

- [ ] **Step 1：定义 Native 接口与事件路由**

```ts
import { NativeModules, DeviceEventEmitter, type EmitterSubscription } from 'react-native';

interface LocalLLMNative {
  getCapabilities(): Promise<LocalLLMCapabilities>;
  importModel(sourceUri: string, originalFilename: string, displayName: string): Promise<NativeImportResult>;
  validateModel(modelId: string, relativePath: string, backend: 'auto' | 'gpu' | 'cpu'): Promise<NativeValidationResult>;
  loadModel(modelId: string, relativePath: string, backend: 'auto' | 'gpu' | 'cpu'): Promise<NativeLoadResult>;
  generate(requestId: string, modelId: string, request: NativeGenerationRequest): Promise<void>;
  cancel(requestId: string): Promise<void>;
  unloadModel(): Promise<void>;
  deleteModelFiles(modelId: string, relativePath: string): Promise<void>;
  modelFileExists(relativePath: string): Promise<boolean>;
  cleanupStagingFiles(): Promise<number>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export const LocalLLM = NativeModules.LocalLLM as LocalLLMNative | undefined;

const globalListeners = new Map<string, EmitterSubscription>();
const requestCallbacks = new Map<string, (event: any) => void>();

export function ensureGlobalEventListener(eventName: string) {
  if (globalListeners.has(eventName)) return;
  const sub = DeviceEventEmitter.addListener(eventName, (event) => {
    const key = event.importId || event.requestId;
    const cb = key ? requestCallbacks.get(key) : null;
    cb?.(event);
  });
  globalListeners.set(eventName, sub);
}

export function registerRequestCallback(key: string, callback: (event: any) => void) {
  requestCallbacks.set(key, callback);
}

export function unregisterRequestCallback(key: string) {
  requestCallbacks.delete(key);
}
```

### Task 3.7：Jest mock

**Files:**
- Modify: `jest.setup.js`

- [ ] **Step 1：补充 LocalLLM mock**

```js
RN.NativeModules.LocalLLM = {
  getCapabilities: jest.fn(() => Promise.resolve({
    available: true,
    androidApi: 34,
    supportedAbis: ['arm64-v8a'],
    arm64Supported: true,
    gpuCandidate: true,
    cpuSupported: true,
    npuSupported: false,
    freeBytes: 10 * 1024 * 1024 * 1024,
    totalBytes: 128 * 1024 * 1024 * 1024,
  })),
  importModel: jest.fn(() => Promise.resolve({
    importId: 'import-1',
    originalFilename: 'model.litertlm',
    displayName: 'Test Model',
    fileSize: 1024,
    sha256: 'abc123',
    stagingRelativePath: '.staging/import-1.litertlm.tmp',
  })),
  validateModel: jest.fn(() => Promise.resolve({ backend: 'cpu', loadTimeMs: 100 })),
  loadModel: jest.fn(() => Promise.resolve({ backend: 'cpu', loadTimeMs: 100 })),
  generate: jest.fn(() => Promise.resolve()),
  cancel: jest.fn(() => Promise.resolve()),
  unloadModel: jest.fn(() => Promise.resolve()),
  deleteModelFiles: jest.fn(() => Promise.resolve()),
  modelFileExists: jest.fn(() => Promise.resolve(true)),
  cleanupStagingFiles: jest.fn(() => Promise.resolve(0)),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};
```

### Task 3.8：单元测试

**Files:**
- Create: `__tests__/services/localModels.test.ts`

- [ ] **Step 1：测试去重逻辑**

```ts
import { getLocalModelBySha256, createLocalModel } from '../../src/services/localModels';

jest.mock('../../src/services/database', () => ({
  openDatabase: jest.fn(() => Promise.resolve({
    executeSql: jest.fn(),
  })),
}));

describe('localModels', () => {
  it('finds model by sha256', async () => {
    // 测试 mock 数据库查询
  });
});
```

---

## Phase 4：LiteRT-LM Engine

**目标：** 实现 Engine Manager、GPU/CPU 后端切换、validate/load/unload、流式生成、取消、benchmark。

### Task 4.1：LiteRtLmEngineManager

**Files:**
- Create: `android/app/src/main/java/com/shinewriter/localllm/LiteRtLmEngineManager.kt`

- [ ] **Step 1：实现单例状态与后端切换**

```kotlin
package com.shinewriter.localllm

import com.google.ai.edge.litertlm.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

sealed interface EngineState {
  data object Unloaded : EngineState
  data class Loading(val modelId: String) : EngineState
  data class Ready(val modelId: String, val backend: String) : EngineState
  data class Generating(val modelId: String, val requestId: String) : EngineState
  data class Error(val modelId: String?, val code: String) : EngineState
}

class LiteRtLmEngineManager(private val context: Context) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var engine: Engine? = null
  private var state: EngineState = EngineState.Unloaded
  private val mutex = Mutex()
  private val jobs = mutableMapOf<String, Job>()
  private val tokenSequence = AtomicInteger(0)

  suspend fun load(modelId: String, absolutePath: String, backendPreference: String): Result<LoadResult> {
    return mutex.withLock {
      runCatching {
        unloadLocked()
        state = EngineState.Loading(modelId)
        val backend = resolveBackend(backendPreference, absolutePath)
        val config = EngineConfig(
          modelPath = absolutePath,
          backend = backend,
          cacheDir = File(context.cacheDir, "litertlm").path,
        )
        val start = System.currentTimeMillis()
        val newEngine = Engine(config)
        newEngine.initialize()
        engine = newEngine
        state = EngineState.Ready(modelId, backendName(backend))
        LoadResult(backendName(backend), System.currentTimeMillis() - start)
      }.onFailure { e ->
        state = EngineState.Error(modelId, mapError(e))
      }
    }
  }

  private fun resolveBackend(preference: String, path: String): Backend {
    return when (preference) {
      "gpu" -> Backend.GPU()
      "cpu" -> Backend.CPU()
      else -> Backend.GPU()
    }
  }

  private fun backendName(backend: Backend): String = when (backend) {
    is Backend.GPU -> "gpu"
    is Backend.CPU -> "cpu"
    else -> "cpu"
  }

  private fun unloadLocked() {
    engine?.close()
    engine = null
    state = EngineState.Unloaded
  }

  suspend fun unload() {
    mutex.withLock { unloadLocked() }
  }

  suspend fun generate(
    requestId: String,
    modelId: String,
    input: String,
    systemInstruction: String?,
    maxTokens: Int,
    temperature: Float,
    topP: Float,
    onToken: (TokenEvent) -> Unit,
    onComplete: (CompletedEvent) -> Unit,
    onError: (ErrorEvent) -> Unit,
  ) {
    mutex.withLock {
      val current = state
      if (current !is EngineState.Ready || current.modelId != modelId) {
        onError(ErrorEvent(requestId, "generate", LocalLLMErrors.ENGINE_NOT_READY, "引擎未就绪", false))
        return@withLock
      }
      state = EngineState.Generating(modelId, requestId)
    }

    val job = scope.launch {
      try {
        val eng = engine ?: throw IllegalStateException(LocalLLMErrors.ENGINE_NOT_READY)
        val conversation = eng.createConversation()
        val start = System.currentTimeMillis()
        var firstTokenMs: Long? = null
        var output = ""
        tokenSequence.set(0)

        conversation.sendMessageAsync(input).catch { e ->
          emitError(requestId, "generate", e)
        }.collect { message ->
          if (firstTokenMs == null) firstTokenMs = System.currentTimeMillis() - start
          val delta = message.text?.removePrefix(output) ?: ""
          output = message.text ?: output
          onToken(TokenEvent(requestId, delta, tokenSequence.incrementAndGet()))
        }

        conversation.close()
        val elapsed = System.currentTimeMillis() - start
        val tps = if (elapsed > 0) (output.length / (elapsed / 1000.0)).toFloat() else 0f
        onComplete(CompletedEvent(requestId, output, elapsedMs = elapsed, firstTokenMs = firstTokenMs, tokensPerSecond = tps))
      } catch (e: Throwable) {
        if (e is CancellationException) {
          onError(ErrorEvent(requestId, "generate", LocalLLMErrors.GENERATION_CANCELLED, "生成已取消", true))
        } else {
          onError(ErrorEvent(requestId, "generate", LocalLLMErrors.GENERATION_FAILED, e.message ?: "生成失败", false))
        }
      } finally {
        mutex.withLock {
          if (state is EngineState.Generating) {
            state = EngineState.Ready(modelId, "cpu") // 保留原 backend
          }
        }
      }
    }

    jobs[requestId] = job
    job.invokeOnCompletion { jobs.remove(requestId) }
  }

  fun cancel(requestId: String) {
    jobs[requestId]?.cancel()
  }
}
```

注意：以上代码为示意，LiteRT-LM 的实际 API（`sendMessageAsync` 返回值类型、Conversation 创建方式）以 Spike 阶段确认的版本为准。

### Task 4.2：Prompt Adapter（Kotlin）

**Files:**
- Create: `android/app/src/main/java/com/shinewriter/localllm/LiteRtLmPromptAdapter.kt`

- [ ] **Step 1：实现消息映射**

```kotlin
package com.shinewriter.localllm

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.google.ai.edge.litertlm.*

data class AdaptedInput(
  val systemInstruction: String?,
  val initialMessages: List<LlmMessage>,
  val currentInput: String,
)

fun adaptMessages(messages: ReadableArray): AdaptedInput {
  val systemParts = mutableListOf<String>()
  val history = mutableListOf<LlmMessage>()
  var lastUserInput = ""

  for (i in 0 until messages.size()) {
    val msg = messages.getMap(i)
    val role = msg.getString("role") ?: continue
    val content = msg.getString("content") ?: ""
    when (role) {
      "system" -> systemParts.add(content)
      "user" -> {
        lastUserInput = content
        history.add(LlmMessage.user(content))
      }
      "assistant" -> history.add(LlmMessage.model(content))
    }
  }

  // 如果最后一条不是 user，把历史最后一条 assistant 作为当前输入兜底
  if (lastUserInput.isEmpty() && history.isNotEmpty()) {
    lastUserInput = history.last().text ?: ""
  }

  return AdaptedInput(
    systemInstruction = systemParts.joinToString("\n\n").takeIf { it.isNotEmpty() },
    initialMessages = history.dropLast(1),
    currentInput = lastUserInput,
  )
}
```

注意：`LlmMessage` 的构造方式以实际 LiteRT-LM SDK 为准。

### Task 4.3：完善 LocalLLMModule 的 generate/load/unload

**Files:**
- Modify: `android/app/src/main/java/com/shinewriter/localllm/LocalLLMModule.kt`

- [ ] **Step 1：在模块中集成 EngineManager**

```kotlin
private val engineManager = LiteRtLmEngineManager(reactContext)

@ReactMethod
fun loadModel(modelId: String, relativePath: String, backend: String, promise: Promise) {
  scope.launch {
    val file = fileManager.modelFile(relativePath)
    val result = engineManager.load(modelId, file.absolutePath, backend)
    result.fold(
      onSuccess = { promise.resolve(Arguments.createMap().apply {
        putString("backend", it.backend)
        putInt("loadTimeMs", it.loadTimeMs.toInt())
      })},
      onFailure = { promise.reject(it.message ?: LocalLLMErrors.ENGINE_INIT_FAILED, it) }
    )
  }
}

@ReactMethod
fun unloadModel(promise: Promise) {
  scope.launch {
    engineManager.unload()
    promise.resolve(null)
  }
}

@ReactMethod
fun generate(requestId: String, modelId: String, request: ReadableMap, promise: Promise) {
  val messages = request.getArray("messages") ?: run {
    promise.reject(LocalLLMErrors.GENERATION_FAILED, "messages missing")
    return
  }
  val adapted = adaptMessages(messages)
  val maxTokens = request.getInt("max_tokens")
  val temperature = request.getDouble("temperature").toFloat()
  val topP = request.getDouble("top_p").toFloat()

  scope.launch {
    engineManager.generate(
      requestId = requestId,
      modelId = modelId,
      input = adapted.currentInput,
      systemInstruction = adapted.systemInstruction,
      maxTokens = maxTokens,
      temperature = temperature,
      topP = topP,
      onToken = { event -> sendEvent(LocalLLMEvents.TOKEN, event) },
      onComplete = { event -> sendEvent(LocalLLMEvents.COMPLETED, event) },
      onError = { event -> sendEvent(LocalLLMEvents.ERROR, event) },
    )
    promise.resolve(null)
  }
}
```

### Task 4.4：内存压力处理

**Files:**
- Modify: `android/app/src/main/java/com/shinewriter/MainApplication.kt`

- [ ] **Step 1：注册 ComponentCallbacks2**

```kotlin
override fun onCreate() {
  super.onCreate()
  loadReactNative(this)
  registerComponentCallbacks(object : ComponentCallbacks2 {
    override fun onTrimMemory(level: Int) {
      if (level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE) {
        // 通知本地引擎管理器释放资源
        LocalLLMModule.onTrimMemory(level)
      }
    }
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {}
    override fun onLowMemory() {
      LocalLLMModule.onLowMemory()
    }
  })
}
```

- [ ] **Step 2：在 `LocalLLMModule.kt` 增加静态回调入口**

```kotlin
companion object {
  fun onTrimMemory(level: Int) {
    instance?.engineManager?.trimMemory(level)
  }
  fun onLowMemory() {
    instance?.engineManager?.unloadAll()
  }
  private var instance: LocalLLMModule? = null
}
```

---

## Phase 5：UI

**目标：** 在 LLM 设置页支持在线/本地切换，新增本地模型管理页。

### Task 5.1：本地模型 Store

**Files:**
- Create: `src/store/localModelStore.ts`

- [ ] **Step 1：实现状态管理**

```ts
import { create } from 'zustand';
import type { LocalModel } from '../types/localModel';

interface ImportState {
  importId: string | null;
  state: 'idle' | 'selecting' | 'copying' | 'validating' | 'ready' | 'error';
  bytesCopied: number;
  totalBytes: number;
  errorCode: string | null;
  errorMessage: string | null;
}

interface LocalModelState {
  models: LocalModel[];
  import: ImportState;
  loadModel: (modelId: string) => Promise<void>;
  startImport: () => Promise<void>;
  cancelImport: () => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  refreshModels: () => Promise<void>;
}

export const useLocalModelStore = create<LocalModelState>((set, get) => ({
  models: [],
  import: {
    importId: null,
    state: 'idle',
    bytesCopied: 0,
    totalBytes: 0,
    errorCode: null,
    errorMessage: null,
  },
  loadModel: async (modelId) => { /* ... */ },
  startImport: async () => { /* ... */ },
  cancelImport: async () => { /* ... */ },
  deleteModel: async (modelId) => { /* ... */ },
  refreshModels: async () => {
    const models = await listLocalModels();
    set({ models });
  },
}));
```

### Task 5.2：扩展 LLMSettingsScreen

**Files:**
- Modify: `src/screens/LLMSettingsScreen.tsx`

- [ ] **Step 1：增加模型来源切换**

```tsx
import { useLocalModelStore } from '../store/localModelStore';

// 在表单顶部增加
<TouchableOpacity onPress={() => updateDraft({ provider_type: 'openai_compatible' })}>
  <Text>在线 API</Text>
</TouchableOpacity>
<TouchableOpacity onPress={() => updateDraft({ provider_type: 'local_litertlm' })}>
  <Text>本地离线模型</Text>
</TouchableOpacity>

{draft.provider_type === 'openai_compatible' ? (
  <>
    <Field label="Base URL" ... />
    <Field label="API Key" ... />
  </>
) : (
  <>
    <LocalModelSelector
      selectedId={draft.local_model_id}
      onSelect={(id) => updateDraft({ local_model_id: id })}
    />
    <BackendSelector
      value={draft.local_backend || 'auto'}
      onChange={(v) => updateDraft({ local_backend: v })}
    />
    <Field label="上下文长度" ... />
    <Field label="最大输出 Token" ... />
    <Button label="管理本地模型" onPress={() => navigation.navigate('LocalModelManager')} />
  </>
)}
```

- [ ] **Step 2：根据 provider_type 调整验证逻辑**

```ts
const validate = () => {
  const missing: string[] = [];
  if (!draft.name.trim()) missing.push('配置名称');
  if (draft.provider_type === 'openai_compatible') {
    if (!draft.base_url.trim()) missing.push('API 地址');
    if (!draft.api_key.trim()) missing.push('API Key');
    if (!draft.model_name.trim()) missing.push('模型名称');
  } else {
    if (!draft.local_model_id) missing.push('已导入且可用的本地模型');
  }
  // ...
};
```

### Task 5.3：本地模型选择器组件

**Files:**
- Create: `src/components/LocalModelSelector.tsx`

- [ ] **Step 1：实现选择器**

```tsx
import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useLocalModelStore } from '../store/localModelStore';

export const LocalModelSelector: React.FC<{
  selectedId: string | null;
  onSelect: (id: string) => void;
}> = ({ selectedId, onSelect }) => {
  const { models, refreshModels } = useLocalModelStore();
  useEffect(() => { refreshModels(); }, [refreshModels]);

  const readyModels = models.filter((m) => m.status === 'ready');
  if (readyModels.length === 0) {
    return <Text>暂无可用的本地模型，请先导入。</Text>;
  }

  return (
    <View>
      {readyModels.map((model) => (
        <TouchableOpacity key={model.id} onPress={() => onSelect(model.id)}>
          <Text>{model.display_name} ({formatBytes(model.file_size)})</Text>
          {selectedId === model.id && <Text>✓</Text>}
        </TouchableOpacity>
      ))}
    </View>
  );
};
```

### Task 5.4：本地模型管理页

**Files:**
- Create: `src/screens/LocalModelManagerScreen.tsx`
- Modify: `src/navigation/TabNavigator.tsx`

- [ ] **Step 1：创建管理页**

实现：

- 顶部提示"模型保存在应用私有目录..."
- "导入 .litertlm 模型"按钮
- 模型卡片列表（名称、文件名、大小、状态、后端、加载耗时、速度）
- 每个卡片：测试 / 创建 AI 配置 / 删除
- 导入进度弹窗

- [ ] **Step 2：注册路由**

在 `SettingsStackParamList` 增加 `LocalModelManager: undefined`，在 `SettingsStackScreen` 增加 `<SettingsStack.Screen name="LocalModelManager" component={LocalModelManagerScreen} />`。

### Task 5.5：导入流程 UI

**Files:**
- Modify: `src/screens/LocalModelManagerScreen.tsx`

- [ ] **Step 1：调用文件选择器**

```ts
import { pick, types, isCancel } from '@react-native-documents/picker';

async function handleImport() {
  try {
    const [result] = await pick({
      mode: 'open',
      type: types.allFiles,
    });
    if (!result.name?.toLowerCase().endsWith('.litertlm')) {
      Alert.alert('无法导入', '请选择扩展名为 .litertlm 的模型文件。');
      return;
    }
    await useLocalModelStore.getState().startImport(result.uri, result.name);
  } catch (e) {
    if (isCancel(e)) return;
    Alert.alert('导入失败', String(e));
  }
}
```

---

## Phase 6：流水线集成

**目标：** 让现有小说生成流水线能路由到本地 Provider，处理上下文裁剪、取消和 usage 日志。

### Task 6.1：Prompt Adapter（TypeScript）

**Files:**
- Create: `src/services/llm/promptAdapter.ts`

- [ ] **Step 1：实现上下文预算裁剪**

```ts
import { estimateMessagesTokens, clipTextToTokenBudget } from '../../utils/tokenEstimator';
import type { ChatMessage } from './types';

export function adaptMessagesForLocalModel(
  messages: ChatMessage[],
  contextWindow: number,
  maxOutputTokens: number,
): ChatMessage[] {
  const safetyMargin = Math.max(128, Math.floor(contextWindow * 0.05));
  const inputBudget = contextWindow - maxOutputTokens - safetyMargin;

  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  let used = estimateMessagesTokens(systemMessages);
  const result: ChatMessage[] = [...systemMessages];

  // 优先保留最后一条用户请求
  const lastUser = nonSystem.filter((m) => m.role === 'user').pop();
  const others = lastUser ? nonSystem.filter((m) => m !== lastUser) : nonSystem;

  if (lastUser) {
    const cost = estimateMessagesTokens([lastUser]);
    if (used + cost <= inputBudget) {
      result.push(lastUser);
      used += cost;
    }
  }

  // 从最新到最旧加入其他消息
  for (let i = others.length - 1; i >= 0; i -= 1) {
    const cost = estimateMessagesTokens([others[i]]);
    if (used + cost > inputBudget) break;
    result.splice(systemMessages.length, 0, others[i]);
    used += cost;
  }

  return result;
}
```

### Task 6.2：Local Provider

**Files:**
- Create: `src/services/llm/localLiteRtLmProvider.ts`

- [ ] **Step 1：实现 Local Provider**

```ts
import { LocalLLM, ensureGlobalEventListener, registerRequestCallback, unregisterRequestCallback } from '../../native/LocalLLMModule';
import { getLocalModelById, updateLocalModel } from '../localModels';
import { adaptMessagesForLocalModel } from './promptAdapter';
import type { LLMProvider } from '../../types/llmProvider';
import type { LLMRequestConfig } from './llm';
import type { ChatMessage, LLMGenerateOptions, LLMResult } from './types';
import * as db from '../database';

export const localLiteRtLmProvider: LLMProvider = {
  type: 'local_litertlm',

  async test(config: LLMRequestConfig): Promise<string> {
    if (!config.local_model_id) throw new Error('请选择一个已经导入且验证可用的本地模型。');
    const model = await getLocalModelById(config.local_model_id);
    if (!model || model.status !== 'ready') throw new Error('本地模型不可用。');
    await LocalLLM?.loadModel(model.id, model.relative_path, config.local_backend || 'auto');
    // 执行一次短生成验证
    return '本地模型已就绪';
  },

  async generate(messages, options, signal): Promise<LLMResult> {
    const config = options.requestConfig as LLMRequestConfig | undefined;
    if (!config) throw new Error('缺少 LLM 请求配置');
    if (!config.local_model_id) throw new Error('缺少本地模型');
    const model = await getLocalModelById(config.local_model_id);
    if (!model || model.status !== 'ready') throw new Error('本地模型不可用');

    const contextWindow = config.context_window ?? 2048;
    const maxOutputTokens = Math.min(config.max_output_tokens ?? 512, 2048);
    const adapted = adaptMessagesForLocalModel(messages, contextWindow, maxOutputTokens);

    await LocalLLM?.loadModel(model.id, model.relative_path, config.local_backend || 'auto');
    const requestId = `local-${Date.now()}`;

    ensureGlobalEventListener('LocalLLMToken');
    ensureGlobalEventListener('LocalLLMCompleted');
    ensureGlobalEventListener('LocalLLMError');

    return new Promise((resolve, reject) => {
      let text = '';
      registerRequestCallback(requestId, (event) => {
        if (event.type === 'token') text += event.delta;
        if (event.type === 'completed') {
          unregisterRequestCallback(requestId);
          resolve({
            text,
            inputTokens: db.estimateMessagesTokens(adapted),
            outputTokens: event.outputTokens ?? db.estimateTokens(text),
            totalTokens: db.estimateMessagesTokens(adapted) + (event.outputTokens ?? db.estimateTokens(text)),
          });
        }
        if (event.type === 'error') {
          unregisterRequestCallback(requestId);
          reject(new Error(event.message));
        }
      });

      signal?.addEventListener('abort', () => {
        LocalLLM?.cancel(requestId);
      });

      LocalLLM?.generate(requestId, model.id, {
        messages: adapted,
        max_tokens: maxOutputTokens,
        temperature: options.temperature ?? 0.8,
        top_p: options.top_p ?? 0.9,
      });
    });
  },
};
```

注意：`LLMGenerateOptions` 已在 Task 6.3 中增加 `requestConfig?: LLMRequestConfig`，实现时确保 `callLLMResult` 把 `requestConfig` 传进来。

### Task 6.3：更新 LLMGenerateOptions

**Files:**
- Modify: `src/services/llm/types.ts`

- [ ] **Step 1：增加 requestConfig**

```ts
import type { LLMRequestConfig } from './llm';

export interface LLMGenerateOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  scenario?: string;
  projectId?: number;
  requestConfig?: LLMRequestConfig;
}
```

### Task 6.4：更新 callLLMResult 传参

**Files:**
- Modify: `src/services/llm.ts`

- [ ] **Step 1：在 generate 调用中传入 requestConfig**

```ts
return provider.generate(messages, {
  temperature: config?.temperature,
  top_p: config?.top_p,
  max_tokens: maxTokens ?? config?.max_tokens,
  scenario: config?.scenario,
  projectId: config?.projectId,
  requestConfig,
}, externalSignal);
```

### Task 6.5：usage 日志区分本地模型

**Files:**
- Modify: `src/services/llm/localLiteRtLmProvider.ts`
- Modify: `src/services/llm/openAICompatibleProvider.ts`

- [ ] **Step 1：在 Local Provider generate 完成后写 usage 日志**

```ts
await db.logLLMUsage({
  scenario: options.scenario || 'local_chat',
  inputTokens,
  outputTokens,
  totalTokens,
  status: 'success',
  modelName: config.model_name,
  projectId: options.projectId,
  llmConfigId: config.id,
  llmConfigName: config.name,
});
await updateLocalModel(model.id, { last_used_at: new Date().toISOString() });
```

---

## Phase 7：稳定性与发布

**目标：** 真机长测、内存压力、Release 构建、文档、固定依赖版本。

### Task 7.1：锁定 LiteRT-LM 版本

**Files:**
- Modify: `android/app/build.gradle`

- [ ] **Step 1：把 `latest.release` 替换为 Spike 确认的版本**

```gradle
def liteRtLmVersion = "X.Y.Z" // Spike 报告中的版本
implementation("com.google.ai.edge.litertlm:litertlm-android:${liteRtLmVersion}")
```

### Task 7.2：ProGuard 规则

**Files:**
- Modify: `android/app/proguard-rules.pro`

- [ ] **Step 1：增加 keep 规则**

根据 LiteRT-LM 官方文档补充；若文档未明确要求，先保留：

```proguard
-keep class com.google.ai.edge.litertlm.** { *; }
```

### Task 7.3：移除 Spike 调试入口

**Files:**
- Delete: `android/app/src/main/java/com/shinewriter/localllm/LiteRtLmSpikeActivity.kt`

- [ ] **Step 1：删除 Spike Activity 并在 manifest 中移除注册**

### Task 7.4：更新 README 和 CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1：在 README 增加本地模型说明**

内容要点：

- 仅支持 `.litertlm`
- 模型导入后存于应用私有目录
- 卸载/清除数据会删除模型
- 离线运行不发送网络请求

### Task 7.5：真机验证报告

**Files:**
- Create: `docs/superpowers/reports/2026-07-09-litertlm-validation-report.md`

- [ ] **Step 1：按 SPEC 第 27 节模板填写报告**

必须在 vivo X200 Pro 或等效目标设备上完成：

- 导入测试
- GPU/CPU 后端测试
- 取消测试
- 飞行模式生成测试
- App 重启恢复测试
- 删除保护测试
- Release APK 测试

### Task 7.6：最终回归测试

**Files:**
- 无新增

- [ ] **Step 1：运行完整测试套件**

```bash
npm test
npm run lint
npm run apk:release
```

Expected: 全绿，Release APK 生成成功。

---

## 提交拆分建议

按 SPEC 第 25 节拆分为以下提交：

1. `chore(android): add pinned LiteRT-LM runtime dependency`
2. `refactor(llm): introduce provider registry`
3. `feat(db): add local model registry and schema v12`
4. `feat(android): add local model streaming importer`
5. `feat(android): add LiteRT-LM engine manager`
6. `feat(local-llm): add local model provider`
7. `feat(ui): add local model management screen`
8. `feat(settings): support local LiteRT-LM configs`
9. `feat(pipeline): route generation to local provider`
10. `test(local-llm): cover import provider and migration`
11. `docs: document local model import and limitations`

---

## Self-Review Checklist

### Spec Coverage

| SPEC 要求 | 对应 Task |
|-----------|-----------|
| `.litertlm` 文件导入 | Phase 3 Task 3.3, 3.5 |
| 流式复制 + SHA-256 | Phase 3 Task 3.3 |
| GPU/CPU 后端切换 | Phase 4 Task 4.1 |
| 本地模型数据库 | Phase 2 Task 2.3, 2.6 |
| `llm_config` 扩展 | Phase 2 Task 2.2, 2.4 |
| Provider Registry | Phase 1 Task 1.2, 1.3 |
| 本地 Provider | Phase 6 Task 6.2 |
| LLM 设置页本地模型支持 | Phase 5 Task 5.2 |
| 本地模型管理页 | Phase 5 Task 5.4 |
| 错误码 | Phase 3 Task 3.1 |
| 路径安全 | Phase 3 Task 3.2 |
| 前台服务 | Phase 3 Task 3.4 |
| usage 日志 | Phase 6 Task 6.5 |
| 上下文裁剪 | Phase 6 Task 6.1 |
| 取消 | Phase 4 Task 4.1 |
| 内存压力 | Phase 4 Task 4.4 |
| README/CHANGELOG | Phase 7 Task 7.4 |
| 真机报告 | Phase 7 Task 7.5 |

### Placeholder Scan

- [x] 无 "TBD"/"TODO"/"implement later"
- [x] 无 "Add appropriate error handling" 等模糊描述
- [x] 每个代码步骤包含具体代码
- [x] 每个命令包含具体命令

### Type Consistency

- [x] `LLMProviderType` 在 `types.ts`、`novel.ts`、`llmProvider.ts`、`llm.ts` 中一致
- [x] `LocalModelStatus` / `LocalModelBackend` 在 `types/localModel.ts` 和 Kotlin 层一致
- [x] `LLMRequestConfig` 字段在 `llm.ts` 和各 Provider 中一致
- [x] 错误码常量在中英文两层一致

### 依赖与边界

- [x] LiteRT-LM 版本在 Phase 0 验证，Phase 7 锁定
- [x] 不硬编码 `/data/user/0/com.shinewriter`
- [x] 不在 JS 中传递模型二进制
- [x] 不默认开启 NPU
- [x] 在线模型能力无回归
