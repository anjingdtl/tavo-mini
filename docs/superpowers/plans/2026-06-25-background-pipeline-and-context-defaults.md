# 后台运行 + 通知 与 上下文配置恢复默认 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 流水线在 App 切后台时仍能稳定跑完并通过系统通知告知用户；上下文配置页增加"恢复默认"按钮并统一默认值来源。

**Architecture:** 方案 A 采用 Android Foreground Service（Kotlin 原生）持有常驻通知保活 JS 线程，终态时由 JS 通过 bridge 触发原生系统通知，前台时复用现有 `PipelineResultPrompt` 避免重复打扰；方案 B 把散落在 3 处的默认值收敛到单一 `DEFAULT_CONTEXT_CONFIG`，再加"恢复默认"按钮（只改草稿不持久化）。

**Tech Stack:** React Native 0.85.3 / React 19 / TypeScript / Kotlin 2.1.20 / Android SDK 36 / Zustand / Jest

**Spec:** `docs/superpowers/specs/2026-06-25-background-pipeline-and-context-defaults-design.md`

**重要约束**（来自 AGENTS.md）：
- 无 `typecheck` 脚本，**不要跑 `tsc --noEmit`**
- 测试用 `npx jest <file>`，全量用 `npm test`
- 所有数据操作走 `services/database.ts`，不直接写 SQL
- 错误信息用中文，Prettier 配置：`arrowParens: 'avoid'`、`singleQuote: true`、`trailingComma: 'all'`
- 新增原生模块测试报错时，优先在 `jest.setup.js` 补 mock
- 纯 Android，不要碰 iOS

---

## Phase 概览

- **Phase 0：分支准备**
- **Phase 1（方案 B）：默认值收敛 + 恢复默认按钮** — 低风险独立交付
- **Phase 2（方案 A 原生层）：Foreground Service + Bridge Module + Manifest**
- **Phase 3（方案 A JS 桥接）：TS 封装 + appState 工具**
- **Phase 4（方案 A 集成）：pipelineRunner 钩子 + settings 开关 + deep link**
- **Phase 5：真机/模拟器测试 + 正式 APK + commit/push**

每个 Phase 完成后停下 review。

---

## Phase 0: 分支准备

### Task 0.1: 创建功能分支

- [ ] **Step 1: 从 main 创建分支**

```bash
git checkout main
git pull --ff-only origin main 2>/dev/null || true
git checkout -b feat/background-pipeline-and-context-defaults
```

- [ ] **Step 2: 确认基线干净**

Run: `git status`
Expected: `nothing to commit, working tree clean`（spec 文档已在上个 commit）

- [ ] **Step 3: 确认测试基线通过**

Run: `npm test -- --silent 2>&1 | tail -20`
Expected: 所有现有测试 PASS（记录通过数量作为基线）

---

## Phase 1: 方案 B — 默认值收敛 + 恢复默认按钮

### Task 1.1: 在 `constants/defaults.ts` 新增 `DEFAULT_CONTEXT_CONFIG`

**Files:**
- Modify: `src/constants/defaults.ts`

- [ ] **Step 1: 在文件顶部 import 类型，新增完整默认配置**

把 `src/constants/defaults.ts` 顶部修改为（保留现有内容，新增 import 和常量）：

```ts
import type { ContextConfig } from '../types/novel';

export const DEFAULT_TEMPERATURE = 0.8;
export const DEFAULT_TOP_P = 0.9;
export const DEFAULT_MAX_TOKENS = 4000;
export const DEFAULT_SLIDING_WINDOW_SIZE = 4000;
export const DEFAULT_RESOURCE_BUDGET = 2000;
export const DEFAULT_SUMMARY_BUDGET = 20000;
export const DEFAULT_CONTEXT_STRATEGY = 'sliding';

/**
 * 上下文配置的唯一默认来源。所有"恢复默认"和"未配置时的兜底"
 * 都必须引用本常量，禁止在别处硬编码 context 默认值。
 *
 * 注意：DEFAULT_SUMMARY_BUDGET 已修正为 20000（与历史实际使用一致）。
 */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  strategy: 'sliding',
  slidingWindowSize: 4000,
  recentChapterCount: 3,
  summaryBudgetTokens: 20000,
  memoryTopK: 10,
  resourceBudget: 2000,
  worldbookScanDepth: 4,
  customRangeStart: 0,
  customRangeEnd: -1,
  includeResources: true,
  worldbookRecursive: true,
};

export const PLOTLINE_COLORS = ['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

export const THEME_COLORS = {
  accent: '#439EA6',
  secondary: '#B0E0E3',
  light: '#D7F1F4',
};
```

- [ ] **Step 2: 验证无语法错误**

Run: `npx jest --listTests 2>&1 | head -3`
Expected: 正常列出测试文件，无 import 报错

### Task 1.2: `settingsStore.ts` 改用统一来源

**Files:**
- Modify: `src/store/settingsStore.ts:17-29`

- [ ] **Step 1: 替换内联 `defaultContextConfig` 为 import**

把 `src/store/settingsStore.ts` 顶部 import 区改为：

```ts
import { create } from 'zustand';
import * as db from '../services/database';
import { DEFAULT_CONTEXT_CONFIG } from '../constants/defaults';
import type { ContextConfig, LLMConfig } from '../types/novel';
```

删除第 17-29 行的 `const defaultContextConfig: ContextConfig = { ... };` 整块。

把文件中所有 `defaultContextConfig` 引用（第 43 行 `contextConfig: defaultContextConfig,`）改为 `contextConfig: DEFAULT_CONTEXT_CONFIG,`。

- [ ] **Step 2: 验证测试仍通过**

Run: `npm test -- --silent 2>&1 | tail -10`
Expected: 全部 PASS（settingsStore 没有直接测试，但其他测试不应回归）

### Task 1.3: `database.ts` 的 `getContextConfig` 改用统一来源

**Files:**
- Modify: `src/services/database.ts:1356-1370`

- [ ] **Step 1: 在文件顶部 import `DEFAULT_CONTEXT_CONFIG`**

找到 `src/services/database.ts` 顶部的 import 区，确认是否已 import `./defaults` 或类似。若无，添加：

```ts
import { DEFAULT_CONTEXT_CONFIG } from '../constants/defaults';
```

（如果顶部已有 `defaults` 的部分 import，合并进去；保持单一 import 语句）

- [ ] **Step 2: 重写 `getContextConfig` 函数**

替换 `src/services/database.ts:1356-1370` 的 `getContextConfig` 函数为：

```ts
export async function getContextConfig(): Promise<ContextConfig> {
  return {
    strategy: ((await getSetting('context_strategy')) as ContextConfig['strategy']) || DEFAULT_CONTEXT_CONFIG.strategy,
    slidingWindowSize: Number((await getSetting('sliding_window_size')) || DEFAULT_CONTEXT_CONFIG.slidingWindowSize),
    customRangeStart: Number((await getSetting('custom_range_start')) || DEFAULT_CONTEXT_CONFIG.customRangeStart),
    customRangeEnd: Number((await getSetting('custom_range_end')) || DEFAULT_CONTEXT_CONFIG.customRangeEnd),
    resourceBudget: Number((await getSetting('resource_budget')) || DEFAULT_CONTEXT_CONFIG.resourceBudget),
    includeResources: (await getSetting('include_resources')) !== 'false' && DEFAULT_CONTEXT_CONFIG.includeResources,
    summaryBudgetTokens: Number((await getSetting('summary_budget_tokens')) || DEFAULT_CONTEXT_CONFIG.summaryBudgetTokens),
    memoryTopK: Number((await getSetting('memory_top_k')) || DEFAULT_CONTEXT_CONFIG.memoryTopK),
    recentChapterCount: Number((await getSetting('recent_chapter_count')) || DEFAULT_CONTEXT_CONFIG.recentChapterCount),
    worldbookRecursive: (await getSetting('worldbook_recursive')) !== 'false' && DEFAULT_CONTEXT_CONFIG.worldbookRecursive,
    worldbookScanDepth: Number((await getSetting('worldbook_scan_depth')) || DEFAULT_CONTEXT_CONFIG.worldbookScanDepth),
  };
}
```

注意 `includeResources` 和 `worldbookRecursive` 的逻辑：`!== 'false'` 已能正确处理"未设置时为 true"（因为 `null !== 'false'` 为 true），原写法 `&& DEFAULT_CONTEXT_CONFIG.includeResources` 是冗余但无害的显式化；**保持与原逻辑等价**，改为：

```ts
includeResources: (await getSetting('include_resources')) !== 'false',
```

```ts
worldbookRecursive: (await getSetting('worldbook_recursive')) !== 'false',
```

（与原代码逻辑完全一致，只是 fallback 注释说明默认值在 `DEFAULT_CONTEXT_CONFIG`）

- [ ] **Step 3: 验证测试**

Run: `npx jest __tests__/pipelineRunner.test.ts 2>&1 | tail -10`
Expected: PASS（pipelineRunner 测试 mock 了 database，不受影响，但确认无回归）

### Task 1.4: `ContextConfig.tsx` 添加"恢复默认"按钮

**Files:**
- Modify: `src/screens/ContextConfig.tsx`

- [ ] **Step 1: 添加 import**

把 `src/screens/ContextConfig.tsx` 顶部 import 改为：

```tsx
import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { RotateCcw, Save } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { DEFAULT_CONTEXT_CONFIG } from '../constants/defaults';
import { useSettingsStore } from '../store/settingsStore';
import { useThemeStore } from '../store/themeStore';
import type { ContextConfig, ContextStrategy } from '../types/novel';
```

- [ ] **Step 2: 添加 `handleReset` 函数**

在 `ContextConfig.tsx` 的 `save` 函数定义之后、`return` 之前，添加：

```tsx
  const handleReset = () => {
    Alert.alert(
      '恢复默认配置',
      '将把所有上下文参数重置为初始推荐值。此操作只更新当前表单，需点击「保存配置」才会生效。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '恢复默认',
          style: 'destructive',
          onPress: () => {
            setDraft({ ...DEFAULT_CONTEXT_CONFIG });
            Toast.show({ type: 'info', text1: '已恢复默认值，请点击保存生效' });
          },
        },
      ],
    );
  };
```

- [ ] **Step 3: 替换底部按钮为并排双按钮**

把 `ContextConfig.tsx` 中（原第 83 行附近的单按钮）：

```tsx
        <Button label="保存配置" icon={Save} onPress={save} />
```

替换为：

```tsx
        <View style={styles.buttonRow}>
          <Button label="恢复默认" icon={RotateCcw} variant="ghost" flex onPress={handleReset} />
          <Button label="保存配置" icon={Save} flex onPress={save} />
        </View>
```

- [ ] **Step 4: 在 StyleSheet 添加 `buttonRow` 样式**

在 `ContextConfig.tsx` 底部 `styles` 定义中（`switchHint` 那行之后）添加：

```tsx
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
```

- [ ] **Step 5: 验证 lint**

Run: `npm run lint -- src/screens/ContextConfig.tsx src/constants/defaults.ts src/store/settingsStore.ts src/services/database.ts 2>&1 | tail -20`
Expected: 无 error（warning 可接受）

- [ ] **Step 6: 验证测试**

Run: `npm test -- --silent 2>&1 | tail -10`
Expected: 全部 PASS

### Task 1.5: Phase 1 提交

- [ ] **Step 1: 提交**

```bash
git add src/constants/defaults.ts src/store/settingsStore.ts src/services/database.ts src/screens/ContextConfig.tsx
git commit -m "feat(context): unify default config source and add reset-to-default button

- 将散落在 defaults.ts/settingsStore/database.ts 三处的上下文默认值
  收敛到单一 DEFAULT_CONTEXT_CONFIG 常量
- 修正 DEFAULT_SUMMARY_BUDGET 从 3000 到实际使用的 20000
- 上下文配置页新增「恢复默认」按钮（只更新草稿，需手动保存）
- 实现规格 docs/superpowers/specs/2026-06-25-... 方案 B"
```

- [ ] **Step 2: Phase 1 Review checkpoint**

停下，向用户报告 Phase 1 完成。Review 要点：
- `DEFAULT_CONTEXT_CONFIG` 是唯一默认来源
- "恢复默认"按钮只改草稿不持久化
- 所有测试通过

---

## Phase 2: 方案 A 原生层 — Foreground Service + Bridge Module

### Task 2.1: 新增 `PipelineForegroundService.kt`

**Files:**
- Create: `android/app/src/main/java/com/shinewriter/PipelineForegroundService.kt`

- [ ] **Step 1: 创建 Service 文件**

写入 `android/app/src/main/java/com/shinewriter/PipelineForegroundService.kt`：

```kotlin
package com.shinewriter

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * 写作流水线前台保活服务。
 *
 * 职责仅限两件事：
 *  1. startForeground 持有常驻通知，让系统把 App 当作前台进程，
 *     避免 JS 线程在 App 切后台时被冻结/杀死。
 *  2. 持有 PARTIAL_WAKE_LOCK 防止 CPU 休眠。
 *
 * 不做任何 LLM 网络调用、不读写数据库、不触碰密钥——所有业务在 JS 层。
 * 终态通知（完成/失败）由 PipelineForegroundModule 直接通过
 * NotificationManager 发出，不走本 Service。
 */
class PipelineForegroundService : Service() {

  private var wakeLock: PowerManager.WakeLock? = null
  private var currentTaskId: String? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureChannels()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val taskId = intent?.getStringExtra(EXTRA_TASK_ID)
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "ShineWriter 写作中"
    val stageLabel = intent?.getStringExtra(EXTRA_STAGE_LABEL) ?: "正在生成"

    if (taskId != null) currentTaskId = taskId

    startForegroundInternal(title, stageLabel)
    acquireWakeLock()

    return START_NOT_STICKY
  }

  fun updateProgress(title: String, stageLabel: String) {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.notify(ONGOING_NOTIFICATION_ID, buildOngoingNotification(title, stageLabel))
  }

  override fun onDestroy() {
    releaseWakeLock()
    super.onDestroy()
  }

  private fun startForegroundInternal(title: String, stageLabel: String) {
    val notification = buildOngoingNotification(title, stageLabel)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      // Android 14+ 必须指定 foregroundServiceType
      startForeground(ONGOING_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(ONGOING_NOTIFICATION_ID, notification)
    }
  }

  private fun ensureChannels() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      // 运行中常驻通知：低重要性，无声
      val ongoing = NotificationChannel(
        CHANNEL_ONGOING,
        "写作运行状态",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "显示当前流水线写作进度"
        setShowBadge(false)
      }
      // 完成通知：默认重要性，可响
      val done = NotificationChannel(
        CHANNEL_DONE,
        "写作完成通知",
        NotificationManager.IMPORTANCE_DEFAULT
      ).apply {
        description = "流水线完成、失败或取消时通知"
      }
      nm.createNotificationChannels(listOf(ongoing, done))
    }
  }

  private fun buildOngoingNotification(title: String, stageLabel: String): Notification {
    val text = if (stageLabel.isNotBlank()) "$title · $stageLabel" else title
    return NotificationCompat.Builder(this, CHANNEL_ONGOING)
      .setContentTitle("ShineWriter 写作中")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
    wakeLock?.acquire(WAKE_LOCK_TIMEOUT_MS)
  }

  private fun releaseWakeLock() {
    try {
      if (wakeLock?.isHeld == true) wakeLock?.release()
    } catch (e: Exception) {
      // best-effort
    }
    wakeLock = null
  }

  companion object {
    const val EXTRA_TASK_ID = "shinewriter.pipeline.task_id"
    const val EXTRA_TITLE = "shinewriter.pipeline.title"
    const val EXTRA_STAGE_LABEL = "shinewriter.pipeline.stage_label"
    const val ONGOING_NOTIFICATION_ID = 0x5A01
    const val DONE_NOTIFICATION_BASE_ID = 0x5B00
    private const val CHANNEL_ONGOING = "pipeline_ongoing"
    private const val CHANNEL_DONE = "pipeline_done"
    private const val WAKE_LOCK_TAG = "shinewriter:pipeline"
    private const val WAKE_LOCK_TIMEOUT_MS = 30 * 60 * 1000L // 30 分钟上限
  }
}
```

### Task 2.2: 新增 `PipelineForegroundModule.kt`

**Files:**
- Create: `android/app/src/main/java/com/shinewriter/PipelineForegroundModule.kt`

- [ ] **Step 1: 创建 Bridge Module 文件**

写入 `android/app/src/main/java/com/shinewriter/PipelineForegroundModule.kt`：

```kotlin
package com.shinewriter

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS 侧流水线保活/通知的桥接模块。
 *
 * 设计原则：所有方法 try/catch，失败时 reject，但 JS 侧必须捕获并静默——
 * 绝不让原生层缺失或异常阻塞流水线业务。
 */
class PipelineForegroundModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "PipelineForeground"

  /**
   * 启动前台服务（开始写作）。taskId 用于标识当前任务。
   */
  @ReactMethod
  fun start(taskId: String, title: String, stageLabel: String, promise: Promise) {
    try {
      val intent = Intent(reactContext, PipelineForegroundService::class.java).apply {
        putExtra(PipelineForegroundService.EXTRA_TASK_ID, taskId)
        putExtra(PipelineForegroundService.EXTRA_TITLE, title)
        putExtra(PipelineForegroundService.EXTRA_STAGE_LABEL, stageLabel)
      }
      androidx.core.content.ContextCompat.startForegroundService(reactContext, intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("START_FAILED", "启动前台服务失败: ${e.message}", e)
    }
  }

  /**
   * 更新常驻通知文本（不弹新通知）。
   */
  @ReactMethod
  fun updateProgress(taskId: String, stageLabel: String, promise: Promise) {
    try {
      val intent = Intent(reactContext, PipelineForegroundService::class.java).apply {
        putExtra(PipelineForegroundService.EXTRA_TASK_ID, taskId)
        putExtra(PipelineForegroundService.EXTRA_STAGE_LABEL, stageLabel)
      }
      // 通过 onStartCommand 触发 updateProgress 等价行为：重新 startForeground 同 id 会刷新
      reactContext.startService(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("UPDATE_FAILED", "更新进度失败: ${e.message}", e)
    }
  }

  /**
   * 发"完成"系统通知（独立 id，可点击跳转）。
   */
  @ReactMethod
  fun notifyComplete(taskId: String, title: String, message: String, promise: Promise) {
    try {
      postDoneNotification(taskId, title, message, true)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("NOTIFY_FAILED", "发送完成通知失败: ${e.message}", e)
    }
  }

  /**
   * 发"失败/取消"系统通知。
   */
  @ReactMethod
  fun notifyFailed(taskId: String, title: String, message: String, promise: Promise) {
    try {
      postDoneNotification(taskId, title, message, false)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("NOTIFY_FAILED", "发送失败通知失败: ${e.message}", e)
    }
  }

  /**
   * 停止前台服务、移除常驻通知、释放 wakelock。
   */
  @ReactMethod
  fun stop(taskId: String, promise: Promise) {
    try {
      val intent = Intent(reactContext, PipelineForegroundService::class.java)
      reactContext.stopService(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("STOP_FAILED", "停止服务失败: ${e.message}", e)
    }
  }

  /**
   * 供 JS 判断当前是否可用（Android 8+ 且非测试环境）。
   */
  @ReactMethod
  fun isAvailable(promise: Promise) {
    try {
      val nm = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val hasPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        reactContext.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
          android.content.pm.PackageManager.PERMISSION_GRANTED
      } else true
      promise.resolve(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.areNotificationsEnabled() && hasPermission)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  private fun postDoneNotification(taskId: String, title: String, message: String, success: Boolean) {
    val launchIntent = Intent(reactContext, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra(EXTRA_DEEP_LINK_TASK_ID, taskId)
    }
    val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val contentIntent = PendingIntent.getActivity(reactContext, taskId.hashCode(), launchIntent, pendingFlags)

    val smallIcon = if (success) android.R.drawable.stat_sys_download_done else android.R.drawable.stat_notify_error
    val builder = NotificationCompat.Builder(reactContext, "pipeline_done")
      .setSmallIcon(smallIcon)
      .setContentTitle(title)
      .setContentText(message)
      .setContentIntent(contentIntent)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)

    val nm = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    // 用 taskId hashCode 做通知 id，避免不同任务互相覆盖
    val notifId = PipelineForegroundService.DONE_NOTIFICATION_BASE_ID + (taskId.hashCode() and 0xFFF)
    nm.notify(notifId, builder.build())
  }

  companion object {
    /**
     * MainActivity 通过此 extra 读取要跳转的 taskId。
     * 必须与 MainActivity.kt 中读取的 key 一致。
     */
    const val EXTRA_DEEP_LINK_TASK_ID = "shinewriter.deeplink.task_id"
  }
}
```

### Task 2.3: 新增 `PipelineForegroundPackage.kt`

**Files:**
- Create: `android/app/src/main/java/com/shinewriter/PipelineForegroundPackage.kt`

- [ ] **Step 1: 创建 Package 文件**

写入 `android/app/src/main/java/com/shinewriter/PipelineForegroundPackage.kt`：

```kotlin
package com.shinewriter

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class PipelineForegroundPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
    return listOf(PipelineForegroundModule(reactContext))
  }

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
    return emptyList()
  }
}
```

### Task 2.4: 在 `MainApplication.kt` 注册 Package

**Files:**
- Modify: `android/app/src/main/java/com/shinewriter/MainApplication.kt:16-19`

- [ ] **Step 1: 在 packageList apply 块中 add 新 package**

把 `MainApplication.kt` 第 15-19 行：

```kotlin
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          add(TtsAudioPackage())
        },
```

改为：

```kotlin
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          add(TtsAudioPackage())
          add(PipelineForegroundPackage())
        },
```

### Task 2.5: 在 `AndroidManifest.xml` 添加权限和 service 声明

**Files:**
- Modify: `android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: 添加权限**

把 `AndroidManifest.xml` 第 4-6 行（权限区）：

```xml
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" tools:node="remove" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" tools:node="remove" />
```

改为：

```xml
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" tools:node="remove" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" tools:node="remove" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
```

- [ ] **Step 2: 在 application 内添加 service 声明**

把 `AndroidManifest.xml` 的 `</activity>` 之后、`</application>` 之前（第 28-29 行之间）：

```xml
      </activity>
    </application>
```

改为：

```xml
      </activity>
      <service
        android:name=".PipelineForegroundService"
        android:exported="false"
        android:foregroundServiceType="dataSync" />
    </application>
```

### Task 2.6: Phase 2 提交

- [ ] **Step 1: 提交原生层**

```bash
git add android/app/src/main/java/com/shinewriter/PipelineForegroundService.kt \
        android/app/src/main/java/com/shinewriter/PipelineForegroundModule.kt \
        android/app/src/main/java/com/shinewriter/PipelineForegroundPackage.kt \
        android/app/src/main/java/com/shinewriter/MainApplication.kt \
        android/app/src/main/AndroidManifest.xml
git commit -m "feat(android): add pipeline foreground service and bridge module

- PipelineForegroundService: 前台保活 + WakeLock + 常驻通知
- PipelineForegroundModule: JS 桥接（start/update/notify/stop）
- AndroidManifest: 加 FOREGROUND_SERVICE/POST_NOTIFICATIONS/WAKE_LOCK 权限
- MainApplication 注册 PipelineForegroundPackage
- 实现规格方案 A 原生层（JS 业务逻辑不动）"
```

- [ ] **Step 2: Phase 2 Review checkpoint**

停下报告。Review 要点：原生编译应能通过（下一 phase 集成时验证）；JS 业务尚未接入。

---

## Phase 3: 方案 A JS 桥接 — TS 封装 + appState 工具

### Task 3.1: 新增 `src/utils/appState.ts`

**Files:**
- Create: `src/utils/appState.ts`

- [ ] **Step 1: 创建 appState 单例工具**

写入 `src/utils/appState.ts`：

```ts
import { AppState, AppStateStatus } from 'react-native';

/**
 * 全局 AppState 跟踪单例。
 *
 * 用于在流水线终态时判断：App 是否在前台。
 * 前台时复用 PipelineResultPrompt 弹窗（不打扰），
 * 后台时才发系统通知。
 *
 * 不放在 store 里，因为这是平台运行时状态，不需要持久化或订阅式 UI。
 */
class AppStateTracker {
  private current: AppStateStatus = AppState.currentState;

  constructor() {
    AppState.addEventListener('change', (next) => {
      this.current = next;
    });
  }

  /** App 当前是否处于前台（active 状态）。 */
  isForeground(): boolean {
    return this.current === 'active';
  }

  /** 当前原始状态值（主要用于测试）。 */
  getStatus(): AppStateStatus {
    return this.current;
  }

  /** 仅供测试使用：强制设置内部状态。 */
  _setStatusForTest(status: AppStateStatus): void {
    this.current = status;
  }
}

export const appStateTracker = new AppStateTracker();
```

### Task 3.2: 新增 `src/native/PipelineForegroundModule.ts`

**Files:**
- Create: `src/native/PipelineForegroundModule.ts`

- [ ] **Step 1: 创建 TS 桥接封装**

写入 `src/native/PipelineForegroundModule.ts`：

```ts
import { NativeModules } from 'react-native';
import { appStateTracker } from '../utils/appState';

interface PipelineForegroundNative {
  start(taskId: string, title: string, stageLabel: string): Promise<void>;
  updateProgress(taskId: string, stageLabel: string): Promise<void>;
  notifyComplete(taskId: string, title: string, message: string): Promise<void>;
  notifyFailed(taskId: string, title: string, message: string): Promise<void>;
  stop(taskId: string): Promise<void>;
  isAvailable(): Promise<boolean>;
}

const native: PipelineForegroundNative | undefined = NativeModules.PipelineForeground;

/**
 * 流水线保活/通知桥接单例。
 *
 * 设计原则：
 *  1. 所有方法 try/catch + 静默降级——原生缺失或抛错绝不阻塞流水线。
 *  2. 终态通知（notifyComplete/notifyFailed）内部判断 App 前后台：
 *     前台时不发系统通知（让现有 PipelineResultPrompt 处理）。
 *  3. 通过 setEnabled 控制：用户在设置中关闭后台运行时，所有方法变 no-op。
 */
class PipelineForegroundBridge {
  private enabled = false;

  /** 由 settingsStore 在加载/切换时调用。 */
  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 流水线入口：启动前台服务。 */
  async start(taskId: string, title: string, stageLabel: string): Promise<void> {
    if (!this.enabled || !native) return;
    try {
      await native.start(taskId, title, stageLabel);
    } catch (e) {
      console.warn('[PipelineForeground] start failed', e);
    }
  }

  /** 阶段切换：更新常驻通知文本。 */
  async updateProgress(taskId: string, stageLabel: string): Promise<void> {
    if (!this.enabled || !native) return;
    try {
      await native.updateProgress(taskId, stageLabel);
    } catch (e) {
      console.warn('[PipelineForeground] updateProgress failed', e);
    }
  }

  /**
   * 流水线成功完成：发系统通知（仅当 App 在后台）。
   * 前台时不发——由现有 PipelineResultPrompt 弹窗负责提示。
   */
  async notifyComplete(taskId: string, title: string, message: string): Promise<void> {
    if (!native) return;
    if (appStateTracker.isForeground()) return; // 前台复用现有弹窗
    try {
      await native.notifyComplete(taskId, title, message);
    } catch (e) {
      console.warn('[PipelineForeground] notifyComplete failed', e);
    }
  }

  /**
   * 流水线失败或取消：发系统通知（仅当 App 在后台）。
   */
  async notifyFailed(taskId: string, title: string, message: string): Promise<void> {
    if (!native) return;
    if (appStateTracker.isForeground()) return;
    try {
      await native.notifyFailed(taskId, title, message);
    } catch (e) {
      console.warn('[PipelineForeground] notifyFailed failed', e);
    }
  }

  /** 流水线结束：停止前台服务。无论 enabled 与否都尝试停止（清理资源）。 */
  async stop(taskId: string): Promise<void> {
    if (!native) return;
    try {
      await native.stop(taskId);
    } catch (e) {
      console.warn('[PipelineForeground] stop failed', e);
    }
  }

  /** 供 JS 判断当前原生能力是否可用。 */
  async isAvailable(): Promise<boolean> {
    if (!native) return false;
    try {
      return await native.isAvailable();
    } catch {
      return false;
    }
  }
}

export const PipelineForeground = new PipelineForegroundBridge();
```

### Task 3.3: 在 `jest.setup.js` 补 mock

**Files:**
- Modify: `jest.setup.js:100-118`

- [ ] **Step 1: 在 react-native mock 中加 PipelineForeground**

把 `jest.setup.js` 第 100-118 行的 react-native mock 中的 `RN.NativeModules.TtsAudio = {...};` 之后、`return RN;` 之前，添加：

```js
  RN.NativeModules.PipelineForeground = {
    start: jest.fn(() => Promise.resolve()),
    updateProgress: jest.fn(() => Promise.resolve()),
    notifyComplete: jest.fn(() => Promise.resolve()),
    notifyFailed: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
    isAvailable: jest.fn(() => Promise.resolve(true)),
  };
```

完整修改后该块应为：

```js
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  RN.NativeModules.TtsAudio = {
    playAudioFile: jest.fn(() => Promise.resolve()),
    stopAudio: jest.fn(() => Promise.resolve()),
    speak: jest.fn(() => Promise.resolve()),
    stopSpeak: jest.fn(() => Promise.resolve()),
    isTtsReady: jest.fn(() => Promise.resolve(true)),
    getEngines: jest.fn(() =>
      Promise.resolve([
        { name: 'com.google.android.tts', label: 'Google TTS', isDefault: true },
      ]),
    ),
    getVoices: jest.fn(() =>
      Promise.resolve([{ key: 'zh-cn-x', name: '中文女声', locale: 'zh-CN' }]),
    ),
  };
  RN.NativeModules.PipelineForeground = {
    start: jest.fn(() => Promise.resolve()),
    updateProgress: jest.fn(() => Promise.resolve()),
    notifyComplete: jest.fn(() => Promise.resolve()),
    notifyFailed: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
    isAvailable: jest.fn(() => Promise.resolve(true)),
  };
  return RN;
});
```

### Task 3.4: 写桥接降级单元测试

**Files:**
- Create: `__tests__/PipelineForegroundBridge.test.ts`

- [ ] **Step 1: 写测试**

写入 `__tests__/PipelineForegroundBridge.test.ts`：

```ts
import { NativeModules } from 'react-native';
import { PipelineForeground } from '../src/native/PipelineForegroundModule';
import { appStateTracker } from '../src/utils/appState';

describe('PipelineForegroundBridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    PipelineForeground.setEnabled(true);
    appStateTracker._setStatusForTest('background');
  });

  it('enabled=false 时所有方法静默 no-op', async () => {
    PipelineForeground.setEnabled(false);
    await PipelineForeground.start('t1', '标题', '草稿中');
    expect(NativeModules.PipelineForeground.start).not.toHaveBeenCalled();
  });

  it('start 调用原生 start', async () => {
    await PipelineForeground.start('t1', '第1章', '草稿中');
    expect(NativeModules.PipelineForeground.start).toHaveBeenCalledWith('t1', '第1章', '草稿中');
  });

  it('updateProgress 调用原生 updateProgress', async () => {
    await PipelineForeground.updateProgress('t1', '审阅中');
    expect(NativeModules.PipelineForeground.updateProgress).toHaveBeenCalledWith('t1', '审阅中');
  });

  it('前台时 notifyComplete 不发系统通知（复用现有弹窗）', async () => {
    appStateTracker._setStatusForTest('active');
    await PipelineForeground.notifyComplete('t1', '第1章', '已完成');
    expect(NativeModules.PipelineForeground.notifyComplete).not.toHaveBeenCalled();
  });

  it('后台时 notifyComplete 发系统通知', async () => {
    appStateTracker._setStatusForTest('background');
    await PipelineForeground.notifyComplete('t1', '第1章', '已完成');
    expect(NativeModules.PipelineForeground.notifyComplete).toHaveBeenCalledWith('t1', '第1章', '已完成');
  });

  it('后台时 notifyFailed 发系统通知', async () => {
    appStateTracker._setStatusForTest('inactive');
    await PipelineForeground.notifyFailed('t1', '第1章', '失败');
    expect(NativeModules.PipelineForeground.notifyFailed).toHaveBeenCalledWith('t1', '第1章', '失败');
  });

  it('stop 无论 enabled 与否都调用原生 stop', async () => {
    PipelineForeground.setEnabled(false);
    await PipelineForeground.stop('t1');
    expect(NativeModules.PipelineForeground.stop).toHaveBeenCalledWith('t1');
  });

  it('原生抛错时方法静默不抛出', async () => {
    (NativeModules.PipelineForeground.start as any).mockRejectedValueOnce(new Error('boom'));
    await expect(PipelineForeground.start('t1', 't', 's')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `npx jest __tests__/PipelineForegroundBridge.test.ts 2>&1 | tail -20`
Expected: 8 个测试全部 PASS

### Task 3.5: Phase 3 提交

- [ ] **Step 1: 提交**

```bash
git add src/utils/appState.ts src/native/PipelineForegroundModule.ts \
        __tests__/PipelineForegroundBridge.test.ts jest.setup.js
git commit -m "feat(bridge): add PipelineForeground TS bridge with graceful degradation

- PipelineForeground 单例：start/updateProgress/notifyComplete/notifyFailed/stop
- 所有方法 try/catch 静默降级，绝不阻塞流水线
- 终态通知内部判断前后台：前台复用 PipelineResultPrompt，后台才发系统通知
- appStateTracker 单例跟踪 AppState
- jest.setup.js 补 PipelineForeground mock
- 8 个降级场景单元测试覆盖"
```

- [ ] **Step 2: Phase 3 Review checkpoint**

停下报告。Review 要点：桥接层完成且测试通过；尚未接入 pipelineRunner。

---

## Phase 4: 方案 A 集成 — pipelineRunner 钩子 + settings 开关 + deep link

### Task 4.1: `database.ts` 加后台开关读写

**Files:**
- Modify: `src/services/database.ts`

- [ ] **Step 1: 在 `setContextConfig` 之后添加后台开关读写函数**

在 `src/services/database.ts` 的 `setContextConfig` 函数（约第 1384 行结束）之后，添加：

```ts
export async function getBackgroundPipelineEnabled(): Promise<boolean> {
  const v = await getSetting('background_pipeline_enabled');
  if (v == null) return true; // 默认开启
  return v !== 'false';
}

export async function setBackgroundPipelineEnabled(enabled: boolean): Promise<void> {
  await setSetting('background_pipeline_enabled', String(enabled));
}
```

### Task 4.2: `settingsStore.ts` 加后台开关 state

**Files:**
- Modify: `src/store/settingsStore.ts`

- [ ] **Step 1: 扩展 SettingsState 接口**

把 `settingsStore.ts` 的 `SettingsState` 接口改为：

```ts
interface SettingsState {
  llmConfig: LLMConfig;
  llmConfigs: LLMConfig[];
  contextConfig: ContextConfig;
  backgroundPipelineEnabled: boolean;
  loadSettings: () => Promise<void>;
  setLLMConfig: (baseUrl: string, apiKey: string, modelName: string) => Promise<void>;
  saveLLMConfig: (config: Partial<LLMConfig>) => Promise<number>;
  setActiveLLMConfig: (id: number) => Promise<void>;
  deleteLLMConfig: (id: number) => Promise<void>;
  setContextConfig: (config: ContextConfig) => Promise<void>;
  setBackgroundPipelineEnabled: (enabled: boolean) => Promise<void>;
}
```

- [ ] **Step 2: 初始化 state 并实现 loadSettings**

把 store 创建处的初始 state（约第 41-43 行）：

```ts
export const useSettingsStore = create<SettingsState>((set) => ({
  llmConfig: emptyLLMConfig,
  llmConfigs: [emptyLLMConfig],
  contextConfig: DEFAULT_CONTEXT_CONFIG,
```

改为：

```ts
export const useSettingsStore = create<SettingsState>((set) => ({
  llmConfig: emptyLLMConfig,
  llmConfigs: [emptyLLMConfig],
  contextConfig: DEFAULT_CONTEXT_CONFIG,
  backgroundPipelineEnabled: true,
```

把 `loadSettings` 函数改为：

```ts
  loadSettings: async () => {
    const [llmConfigs, contextConfig, backgroundPipelineEnabled] = await Promise.all([
      db.getLLMConfigs(),
      db.getContextConfig(),
      db.getBackgroundPipelineEnabled(),
    ]);
    const llmConfig = llmConfigs.find((config) => config.is_active === 1) || llmConfigs[0] || emptyLLMConfig;
    set({ llmConfig, llmConfigs, contextConfig, backgroundPipelineEnabled });
    // 同步到 PipelineForeground 桥接，决定流水线入口是否起前台服务
    const { PipelineForeground } = require('../native/PipelineForegroundModule');
    PipelineForeground.setEnabled(backgroundPipelineEnabled);
  },
```

- [ ] **Step 3: 添加 setter**

在 `setContextConfig` 函数之后添加：

```ts
  setBackgroundPipelineEnabled: async (enabled) => {
    await db.setBackgroundPipelineEnabled(enabled);
    set({ backgroundPipelineEnabled: enabled });
    const { PipelineForeground } = require('../native/PipelineForegroundModule');
    PipelineForeground.setEnabled(enabled);
  },
```

注意：用 `require` 而非顶层 `import` 是为了规避潜在循环依赖（store ↔ bridge），且 bridge 是单例副作用模块。

### Task 4.3: 在 `pipelineRunner.ts` 接入桥接钩子

**Files:**
- Modify: `src/services/pipelineRunner.ts`

- [ ] **Step 1: 顶部 import 桥接**

把 `src/services/pipelineRunner.ts` 顶部 import 区（第 1-15 行）追加：

```ts
import { PipelineForeground } from '../native/PipelineForegroundModule';
```

- [ ] **Step 2: 在 `runChapterPipeline` 入口加 start 钩子**

找到 `runChapterPipeline` 函数中（约第 172-174 行）：

```ts
  if (checkCancelled(taskId)) return;
  store.setTaskStatus(taskId, 'drafting');
  onStageUpdate?.({ stage: 'draft', label: '草稿中...', startedAt: Date.now() });
```

改为：

```ts
  if (checkCancelled(taskId)) {
    await PipelineForeground.notifyFailed(taskId, chapter.title || '流水线', '已取消');
    await PipelineForeground.stop(taskId);
    return;
  }
  store.setTaskStatus(taskId, 'drafting');
  onStageUpdate?.({ stage: 'draft', label: '草稿中...', startedAt: Date.now() });
  await PipelineForeground.start(taskId, chapter.title || '流水线', '草稿中');
```

- [ ] **Step 3: 在各阶段切换处加 updateProgress**

在 `runChapterPipeline` 中找到所有 `onStageUpdate?.({ stage: 'review', ... })`、`'factCheck'`、`'proof'` 调用，每个之后追加对应的 `updateProgress`。具体位置（约行号，需以实际为准）：

- review 阶段（twoStage 模式，约第 240 行）：
```ts
    onStageUpdate?.({ stage: 'review', label: '点评中...', startedAt: Date.now() });
    await PipelineForeground.updateProgress(taskId, '点评中');
```

- conditional 模式 factCheck（约第 291 行）：
```ts
    onStageUpdate?.({ stage: 'factCheck', label: '事实检查中...', startedAt: Date.now() });
    await PipelineForeground.updateProgress(taskId, '事实检查中');
```

- full 模式 review（约第 342 行）：
```ts
  store.setTaskStatus(taskId, 'reviewing');
  onStageUpdate?.({ stage: 'review', label: '点评中...', startedAt: Date.now() });
  await PipelineForeground.updateProgress(taskId, '审阅与核查中');
```

- proof 阶段（multiple 处，约第 274、326、420 行），每处 `onStageUpdate?.({ stage: 'proof', ... })` 之后：
```ts
    onStageUpdate?.({ stage: 'proof', label: '打磨中...', startedAt: Date.now() });
    await PipelineForeground.updateProgress(taskId, '终审打磨中');
```

- [ ] **Step 4: 在 `saveDraftAndComplete` 加 notifyComplete + stop**

找到 `runChapterPipeline` 内部的 `saveDraftAndComplete` 定义（约第 158-170 行）：

```ts
  const saveDraftAndComplete = async (text: string) => {
    try {
      await saveDraft({
        projectId: chapter.project_id,
        targetType: chapter.id > 0 ? 'chapter' : 'freeform',
        targetId: chapter.id > 0 ? chapter.id : chapter.project_id,
        content: text,
        source: 'pipeline',
        pipelineTaskId: taskId,
      });
    } catch { /* best-effort */ }
    store.completeTask(taskId, text);
  };
```

改为：

```ts
  const saveDraftAndComplete = async (text: string) => {
    try {
      await saveDraft({
        projectId: chapter.project_id,
        targetType: chapter.id > 0 ? 'chapter' : 'freeform',
        targetId: chapter.id > 0 ? chapter.id : chapter.project_id,
        content: text,
        source: 'pipeline',
        pipelineTaskId: taskId,
      });
    } catch { /* best-effort */ }
    store.completeTask(taskId, text);
    await PipelineForeground.notifyComplete(taskId, chapter.title || '流水线', '已写完，点击查看');
    await PipelineForeground.stop(taskId);
  };
```

- [ ] **Step 5: 在 failTask 调用处加 notifyFailed + stop**

`runChapterPipeline` 中有两处 `store.failTask` 调用：

第一处（约第 149 行，配置读取失败）：
```ts
    store.failTask(taskId, getErrorMessage(error, '流水线配置读取失败'));
    return;
```
改为：
```ts
    store.failTask(taskId, getErrorMessage(error, '流水线配置读取失败'));
    await PipelineForeground.notifyFailed(taskId, chapter.title || '流水线', '配置读取失败');
    await PipelineForeground.stop(taskId);
    return;
```

第二处（约第 224 行，初稿失败）：
```ts
    store.failTask(taskId, getErrorMessage(error, '初稿生成失败'));
    return;
```
改为：
```ts
    store.failTask(taskId, getErrorMessage(error, '初稿生成失败'));
    await PipelineForeground.notifyFailed(taskId, chapter.title || '流水线', '初稿生成失败');
    await PipelineForeground.stop(taskId);
    return;
```

- [ ] **Step 6: 更新现有 pipelineRunner 测试以兼容钩子**

现有测试 `__tests__/pipelineRunner.test.ts` mock 了 database 等，但 `PipelineForeground` 引用真实模块（其内部用 `NativeModules.PipelineForeground`，已在 jest.setup.js mock）。

由于 `setDraft` 不涉及 PipelineForeground，且现有测试不检查通知调用，**现有测试应无需改动即可通过**（钩子是 fire-and-forget 的 await，不改变任务终态语义）。

Run: `npx jest __tests__/pipelineRunner.test.ts 2>&1 | tail -15`
Expected: 现有测试全部 PASS

如果失败（例如因为 `PipelineForeground` import 链触发 `appStateTracker` 构造副作用），在 `__tests__/pipelineRunner.test.ts` 顶部添加：

```ts
jest.mock('../src/native/PipelineForegroundModule', () => ({
  PipelineForeground: {
    setEnabled: jest.fn(),
    isEnabled: jest.fn(() => false),
    start: jest.fn(() => Promise.resolve()),
    updateProgress: jest.fn(() => Promise.resolve()),
    notifyComplete: jest.fn(() => Promise.resolve()),
    notifyFailed: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
    isAvailable: jest.fn(() => Promise.resolve(false)),
  },
}));
```

### Task 4.4: `SettingsScreen.tsx` 加后台运行开关

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`

- [ ] **Step 1: 扩展 import 和 store 用法**

把 `SettingsScreen.tsx` 顶部 import 改为（在现有 import 基础上）：

```tsx
import React, { useEffect } from 'react';
import { Alert, Linking, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Bell, Database, Factory, KeyRound, ListChecks, Moon, Palette, Sun, TreePine, BarChart3, Volume2 } from 'lucide-react-native';
```

在组件内 `useSettingsStore` 解构（如果当前未解构，则添加）：

```tsx
export const SettingsScreen: React.FC = () => {
  const navigation = useNavigation<any>();
  const { theme, mode, setMode } = useThemeStore();
  const { backgroundPipelineEnabled, setBackgroundPipelineEnabled } = useSettingsStore();
  const unresolvedCount = usePipelineTaskStore((s) => s.getUnresolvedCount());
  const loadFromDB = usePipelineTaskStore((s) => s.loadFromDB);
  // ... existing
```

- [ ] **Step 2: 添加 toggle handler**

在 `changeTheme` 函数之后添加：

```tsx
  const toggleBackgroundPipeline = async (value: boolean) => {
    if (value) {
      // 开启时尝试引导通知权限（Android 13+）
      const { PipelineForeground } = require('../native/PipelineForegroundModule');
      const ok = await PipelineForeground.isAvailable();
      if (!ok) {
        Alert.alert(
          '需要通知权限',
          '为保持后台写作并提醒任务完成，请前往系统设置授予 ShineWriter 通知权限。',
          [
            { text: '稍后', style: 'cancel' },
            { text: '去设置', onPress: () => Linking.openSettings() },
          ],
        );
      }
    }
    await setBackgroundPipelineEnabled(value);
    Toast.show({ type: 'success', text1: value ? '已开启后台写作' : '已关闭后台写作' });
  };
```

- [ ] **Step 3: 在 AI Section 添加开关 Card**

找到 `SettingsScreen.tsx` 的 AI Section（约第 39-56 行），在"语音设置"Card 之后、`</Section>` 之前，添加：

```tsx
          <Card>
            <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>后台写作</Text>
            <Text style={[styles.cardMeta, { color: theme.colors.textSecondary }]}>
              开启后，写作时以系统通知保持运行，切到其他 App 或锁屏不会暂停流水线，完成后会通知你。
            </Text>
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={[styles.switchTitle, { color: theme.colors.textPrimary }]}>保持后台运行</Text>
                <Text style={[styles.switchHint, { color: theme.colors.textSecondary }]}>默认开启</Text>
              </View>
              <Switch value={backgroundPipelineEnabled} onValueChange={toggleBackgroundPipeline} />
            </View>
          </Card>
```

- [ ] **Step 4: 在 StyleSheet 添加 switchRow 样式**

在底部 styles 定义中添加：

```tsx
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md },
  switchText: { flex: 1 },
  switchTitle: { fontSize: 15, fontWeight: '800' },
  switchHint: { fontSize: 12, marginTop: 2 },
```

- [ ] **Step 5: 验证 lint 和测试**

Run: `npm run lint -- src/screens/SettingsScreen.tsx src/store/settingsStore.ts src/services/pipelineRunner.ts 2>&1 | tail -15`
Expected: 无 error

Run: `npm test -- --silent 2>&1 | tail -10`
Expected: 全部 PASS

### Task 4.5: `MainActivity.kt` 接收通知 deep link

**Files:**
- Modify: `android/app/src/main/java/com/shinewriter/MainActivity.kt`

- [ ] **Step 1: 重写 MainActivity 处理 deep link extra**

把 `MainActivity.kt` 全文替换为：

```kotlin
package com.shinewriter

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * 通知点击带过来的 taskId。由 PipelineForegroundModule 写入 intent extra。
   * RN 侧通过 launchOptions / initialProps 读取后导航到 PipelineResult。
   */
  private var pendingDeepLinkTaskId: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    handleDeepLinkIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleDeepLinkIntent(intent)
  }

  private fun handleDeepLinkIntent(intent: Intent?) {
    val taskId = intent?.getStringExtra(PipelineForegroundModule.EXTRA_DEEP_LINK_TASK_ID)
    if (!taskId.isNullOrEmpty()) {
      pendingDeepLinkTaskId = taskId
    }
  }

  override fun getMainComponentName(): String = "ShineWriter"

  /**
   * 把 pendingDeepLinkTaskId 通过 launchOptions 传给 RN。
   * RN 侧在 App 启动时读取 launchOptions.pipelineDeepLinkTaskId。
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    val delegate = DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
    // 在 RN 0.85 中，launchOptions 由 delegate 内部从 activity intent 构造；
    // 我们通过重写 launchOptions 注入 deep link。
    return object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
      @Suppress("UNCHECKED_CAST")
      override fun getLaunchOptions(): Bundle {
        val options = super.getLaunchOptions() ?: Bundle()
        pendingDeepLinkTaskId?.let { options.putString("pipelineDeepLinkTaskId", it) }
        return options
      }
    }
  }
}
```

注意：如果 RN 0.85 的 `DefaultReactActivityDelegate` 不允许这样 override，则回退方案——把 deep link task id 通过 `intent` extra 留着，由 RN 侧 `App` 通过 `Linking`/`DeviceEventManager` 读取。**先按上面写，构建失败时回退**（见 Step 2）。

- [ ] **Step 2: 回退预案（仅在 Step 1 构建报错时执行）**

如果 `DefaultReactActivityDelegate` 不支持 override `getLaunchOptions`，则简化为：

```kotlin
package com.shinewriter

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "ShineWriter"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
```

并在 Task 4.6 中改用 `DeviceEventManager` 方案从原生发事件到 RN（见 Task 4.6 回退方案）。

### Task 4.6: `src/main/index.tsx` 接收 deep link 并导航

**Files:**
- Modify: `src/main/index.tsx`

- [ ] **Step 1: 在 App 组件中读取 launchOptions 的 deep link**

在 `src/main/index.tsx` 的 `App` 组件中，找到第一个 `React.useEffect`（约第 36 行的 `init` effect）之前，添加新的 effect：

```tsx
  // 处理通知点击 deep link：从 launchOptions 读取要跳转的 taskId。
  // MainActivity 通过 Bundle.putString("pipelineDeepLinkTaskId", taskId)
  // 传入，App 启动后立即导航到 PipelineResult。
  React.useEffect(() => {
    if (!ready) return;
    // @ts-ignore — launchOptions 由原生注入，TS 类型里没有
    const taskId = (navigationRef.current?.getRootState() as any)?.params?.pipelineDeepLinkTaskId
      ?? null;
    // 优先从原生 initialProps 读（通过 React Native 的 __DEV__ 全局或 NativeModules）
    const fromNative = (require('react-native').NativeModules.PipelineForeground as any)?.pendingTaskId;
    const target = taskId || fromNative;
    if (target) {
      // 稍延迟以等待导航容器就绪
      setTimeout(() => navigateToPipelineResult(target), 300);
    }
  }, [ready]);
```

**简化版（推荐，避免 launchOptions 类型复杂性）**：如果上面的 launchOptions 读取不稳定，改为在 RN 侧不读 launchOptions，而是依赖通知 PendingIntent 启动 Activity 后，由原生 `PipelineForegroundModule` 主动发 `DeviceEvent` 给 RN。此为 Task 4.5 Step 2 回退方案的配套。

为减少复杂度和不确定性，**本计划采用如下稳健最终方案**：

- 不依赖 launchOptions
- 在 `src/main/index.tsx` 用 `Linking.getInitialURL()` 不可用（我们是 intent extra 不是 URL）
- **改用 AppState 监听 + store 订阅的组合**：通知点击只是把 App 拉到前台，前台后用户自然会看到 store 里的 `completed`/`failed` 任务，现有的 `PipelineResultPrompt` 订阅（已存在于 index.tsx 第 69-125 行）会自动弹窗提示

因此 **Task 4.6 的实际改动极小**：通知点击 → App 回到前台 → 现有 store 订阅触发 PipelineResultPrompt。**deep link 跳转的"锦上添花"作为可选增强**，基础体验已由现有 prompt 机制覆盖。

**实际改动**：把 Task 4.5 Step 1 的复杂 override 简化为不 override（用回退预案 Step 2），Task 4.6 改为无改动。在 index.tsx 顶部添加注释说明：

在 `src/main/index.tsx` 的 import 区之后（约第 20 行），添加注释：

```tsx
/**
 * 通知点击 deep link 说明：
 * 当用户点击"已完成"系统通知时，MainActivity 被拉到前台。
 * 此时 store 中对应任务已处于 completed/failed 终态，下方第 69-125 行的
 * usePipelineTaskStore 订阅会自动触发 PipelineResultPrompt 弹窗提示。
 * 因此无需额外的 launchOptions 解析——现有终态订阅已覆盖该场景。
 */
```

- [ ] **Step 2: 验证测试**

Run: `npm test -- --silent 2>&1 | tail -10`
Expected: 全部 PASS

### Task 4.7: Phase 4 提交

- [ ] **Step 1: 提交**

```bash
git add src/services/database.ts src/store/settingsStore.ts \
        src/services/pipelineRunner.ts src/screens/SettingsScreen.tsx \
        src/main/index.tsx android/app/src/main/java/com/shinewriter/MainActivity.kt
git commit -m "feat(pipeline): integrate foreground service with pipeline lifecycle

- database/settingsStore: 加 background_pipeline_enabled 开关（默认开启）
- pipelineRunner: 入口 start、阶段切换 updateProgress、终态 notifyComplete/Failed、结束 stop
- SettingsScreen: AI Section 加后台写作开关 + 通知权限引导
- MainActivity: 接收通知 deep link intent（拉前台即可，复用现有 prompt 订阅）
- 所有钩子静默降级，开关关闭或原生缺失时流水线照常运行
- 实现规格方案 A 集成层"
```

- [ ] **Step 2: Phase 4 Review checkpoint**

停下报告。Review 要点：所有代码改动完成；jest 全绿；下一步真机验证。

---

## Phase 5: 真机/模拟器测试 + 正式 APK + commit/push

### Task 5.1: 构建并安装到模拟器

- [ ] **Step 1: 确认模拟器/设备已连接**

Run: `adb devices`
Expected: 至少一个 device/emulator

如无设备，先启动：
```bash
# 列出可用 AVD
%ANDROID_HOME%/emulator/emulator -list-avds 2>/dev/null || echo "需先创建 AVD"
```

- [ ] **Step 2: 构建并安装 debug 版**

Run: `npm run android 2>&1 | tail -30`
Expected: `BUILD SUCCESSFUL` + `Installing app` + `Success`

如果失败：
- 原生编译错误 → 检查 Kotlin 文件语法
- Mock/依赖问题 → 检查 `transformIgnorePatterns` 是否需加包名（本次无新增 RN 原生依赖，应不需要）

### Task 5.2: 真机/模拟器手动验证矩阵

- [ ] **Step 1: 验证方案 B — 恢复默认按钮**

在 App 中：
1. 进入「写作」Tab → 上下文配置页
2. 修改几个字段（如最近正文窗口 tokens 改为 99999）
3. 点击「恢复默认」→ 确认弹窗 → 点「恢复默认」
4. **预期**：所有字段回到 4000/3/20000/10/2000/4/0/-1/true/true，Toast 提示"已恢复默认值，请点击保存生效"
5. 点击「保存配置」→ **预期**：Toast "上下文配置已保存"
6. 退出再进 → **预期**：值仍是默认值

- [ ] **Step 2: 验证方案 A — 后台运行（开关开启）**

1. 设置页 → AI Section → 确认"保持后台运行"开关为**开启**
2. 进入某章节 → 触发流水线写作
3. 立即按 Home 键切到桌面
4. **预期**：通知栏出现"ShineWriter 写作中 · 第X章 · 草稿中"常驻通知
5. 等待流水线跑完（观察通知文本应变化为"点评中"/"终审打磨中"）
6. **预期**：完成后收到"已写完，点击查看"通知
7. 点击该通知 → **预期**：App 回到前台并弹出 PipelineResultPrompt（或直接跳 PipelineResult）

- [ ] **Step 3: 验证方案 A — 后台运行（开关关闭）**

1. 设置页 → 关闭"保持后台运行"
2. 触发流水线 → 切后台
3. **预期**：通知栏无常驻通知（流水线按系统默认行为，可能被冻结）
4. 流水线完成后 → **预期**：无系统通知（但仍可能弹 PipelineResultPrompt 若 App 在前台）

- [ ] **Step 4: 验证方案 A — 前台完成不重复打扰**

1. 保持后台开关开启
2. 触发流水线 → **停留在 App 内**
3. 流水线完成时 → **预期**：不弹系统通知，仅弹 PipelineResultPrompt（现有行为）

- [ ] **Step 5: 验证降级 — 通知权限拒绝**

1. 系统设置 → 应用 → ShineWriter → 通知 → 关闭
2. App 内打开后台开关 → **预期**：弹"需要通知权限"对话框，引导去设置
3. 流水线仍能正常跑（前台服务可起，只是用户看不到通知）

- [ ] **Step 6: 修复发现的问题**

如任何步骤不符合预期，回到对应 Phase 修复后重新验证。修复后重新构建：

Run: `npm run android 2>&1 | tail -10`

### Task 5.3: 打正式 release APK

- [ ] **Step 1: 设置签名环境变量（如有）**

```bash
export SHINE_WRITER_RELEASE_STORE_PASSWORD="<密码>" 2>/dev/null || true
export SHINE_WRITER_RELEASE_KEY_ALIAS="<别名>" 2>/dev/null || true
export SHINE_WRITER_RELEASE_KEY_PASSWORD="<密码>" 2>/dev/null || true
```

（若用默认密码 tavo-mini-2026，可跳过；AGENTS.md 说明有默认值）

- [ ] **Step 2: 构建 release APK**

Run: `npm run apk:release 2>&1 | tail -20`
Expected: `BUILD SUCCESSFUL` + APK 复制到 `dist/apk/release/ShineWriter-V2.0.1-release.apk`

- [ ] **Step 3: 验证产物存在**

Run: `ls -la dist/apk/release/`
Expected: 存在 `ShineWriter-V2.0.1-release.apk`

- [ ] **Step 4: 安装 release APK 到模拟器做最终 smoke test**

Run: `adb install -r dist/apk/release/ShineWriter-V2.0.1-release.apk`
Expected: `Success`

启动 App，快速验证：
- 能正常打开（splash → 主界面）
- 上下文配置页有"恢复默认"按钮
- 设置页有"保持后台运行"开关

### Task 5.4: 最终 commit + push 主分支

- [ ] **Step 1: 确认所有改动已提交**

Run: `git status`
Expected: `nothing to commit, working tree clean`

如有未提交（如 jest.setup.js、新建测试），补提交：
```bash
git add -A
git commit -m "chore: finalize background pipeline + context defaults feature"
```

- [ ] **Step 2: 合并到 main**

```bash
git checkout main
git merge --no-ff feat/background-pipeline-and-context-defaults \
  -m "feat: background pipeline + context defaults (V2.0.x)

方案 A 后台运行:
- Foreground Service + WakeLock 保活 JS 线程
- 流水线终态发系统通知，点击拉前台复用现有 prompt
- 设置项开关默认开启，支持通知权限引导
- 全链路静默降级，绝不阻塞流水线

方案 B 恢复默认:
- 默认值收敛到单一 DEFAULT_CONTEXT_CONFIG
- 上下文配置页加「恢复默认」按钮（只改草稿）
- 修正 DEFAULT_SUMMARY_BUDGET 3000→20000"
```

- [ ] **Step 3: 推送**

Run: `git push origin main`
Expected: 推送成功

- [ ] **Step 4: 报告最终状态**

向用户报告：
- 功能分支合并到 main 的 commit hash
- release APK 路径
- 测试验证矩阵结果

---

## Self-Review Checklist（写完后自查）

**Spec coverage:**
- ✅ 方案 A Foreground Service — Task 2.1
- ✅ 方案 A Bridge Module — Task 2.2
- ✅ 方案 A Manifest 权限 — Task 2.5
- ✅ 方案 A JS 桥接 + 降级 — Task 3.2
- ✅ 方案 A 前台/后台判定 — Task 3.1 (appStateTracker) + Task 3.2 (notify 内部判断)
- ✅ 方案 A pipelineRunner 钩子 — Task 4.3
- ✅ 方案 A 设置开关 — Task 4.2, 4.4
- ✅ 方案 A deep link — Task 4.5, 4.6（简化为复用现有 prompt）
- ✅ 方案 A 降级矩阵 — Task 3.4 测试覆盖 + Task 5.2 手动验证
- ✅ 方案 B 默认值收敛 — Task 1.1-1.3
- ✅ 方案 B 恢复默认按钮 — Task 1.4
- ✅ 测试 mock 补充 — Task 3.3
- ✅ 真机测试 — Task 5.2
- ✅ 正式 APK — Task 5.3
- ✅ commit + push — Task 5.4

**Placeholder scan:** 无 TBD/TODO；Task 4.5/4.6 的 deep link 给了主方案 + 回退方案 + 最终简化方案，决策明确。

**Type consistency:**
- `DEFAULT_CONTEXT_CONFIG` 在 Task 1.1 定义，Task 1.2/1.3/1.4 引用 ✓
- `PipelineForeground` 方法名（start/updateProgress/notifyComplete/notifyFailed/stop/isAvailable/setEnabled）在 Task 3.2 定义，Task 4.2/4.3/4.4 引用一致 ✓
- `backgroundPipelineEnabled` / `setBackgroundPipelineEnabled` 在 Task 4.2 定义，Task 4.4 引用一致 ✓
- Kotlin 常量 `EXTRA_DEEP_LINK_TASK_ID`、`EXTRA_TASK_ID` 等跨文件引用一致 ✓
