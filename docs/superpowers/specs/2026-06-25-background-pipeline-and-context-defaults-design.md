# 后台运行 + 通知 与 上下文配置"恢复默认" 设计

- 日期：2026-06-25
- 范围：ShineWriter（Android-only React Native 0.85.3）
- 状态：待审核

## 1. 背景与目标

当前痛点：

1. **后台运行缺失**：AI 流水线（`runChapterPipeline` 等）是纯 JS async/await，依赖 RN JS 线程。App 切后台时，国产 ROM 的电池策略会冻结或杀死 JS 运行时，导致流水线中断；用户必须手动 `resumePipeline` 续跑。任务元数据虽已持久化到 SQLite，但"执行"不可恢复。
2. **通知缺失**：写作完成无系统通知，用户不知道任务何时结束。
3. **上下文配置对新人过载**：11 个字段（token 预算、章数、Top K 等），且没有"恢复默认"出口；用户调乱后无法回到出厂态。

两个目标：

- **目标 A**：流水线在后台稳定运行到任务结束，完成/失败/取消时发系统通知，点击通知可跳回对应章节结果。
- **目标 B**：上下文配置页提供"恢复默认"按钮，一键回到初始化设定。

## 2. 关键现状（已核实）

- 流水线入口：`src/services/pipelineRunner.ts`（`runChapterPipeline` / `runFreeformPipeline` / `resumePipeline`）
- 任务状态已持久化：`src/store/pipelineTaskStore.ts` → `pipeline_tasks` 表
- **取消机制是协作式 `Set`，仅在阶段间检查，无法打断进行中的 fetch**（本次改造不动它）
- 前台已有完成提示：`src/main/index.tsx` 订阅 store 终态 → `PipelineResultPrompt` 弹窗 + `navigateToPipelineResult`（`src/navigation/navigationRef.ts`）
- Android：minSdk 24 / compileSdk 36 / Kotlin 2.1.20 / AndroidX / 新架构已开
- 原生模块样板：`TtsAudioModule.kt` + `TtsAudioPackage.kt`，在 `MainApplication.kt:18` 手动 `add()`
- AndroidManifest 仅有 `INTERNET` 权限，**无任何 service / foreground / notification 声明**
- `MainActivity` 是 `ReactActivity`，`launchMode="singleTask"`（适合接收通知 Intent）
- 依赖里**没有任何** `notifee` / `react-native-background-actions` / push-notification 库
- 上下文配置界面：`src/screens/ContextConfig.tsx`（11 字段，草稿 state + "保存配置"按钮）
- **默认值散落在 3 处**（隐患）：
  1. `src/constants/defaults.ts`（仅部分常量，且 `DEFAULT_SUMMARY_BUDGET=3000` 与实际不符）
  2. `src/store/settingsStore.ts` 的 `defaultContextConfig`（完整对象，`summaryBudgetTokens=20000`）
  3. `src/services/database.ts` 的 `getContextConfig()` 硬编码 fallback（`20000`）
- 持久化：全局 `settings` key-value 表，11 个 key

## 3. 方案 A：后台运行（Foreground Service + 通知）

### 3.1 架构原则

**JS 不动业务逻辑，原生只做"保活 + 发通知"。**

- LLM 网络调用、密钥、流式逻辑全部留在 JS（避免重写 `llm.ts` 和 Keystore 跨进程问题）
- 原生 Foreground Service 的职责只有两个：① 起前台服务持有常驻通知（让系统把 App 当前台进程，JS 线程不被冻结）；② 收到 JS bridge 事件时发终态系统通知
- **前台时复用现有 `PipelineResultPrompt`**，不重复打扰；**后台时才发系统通知**

### 3.2 新增原生文件

`android/app/src/main/java/com/shinewriter/`：

- `PipelineForegroundService.kt` — `Service` 子类
  - `onStartCommand`：`startForeground` 显示常驻通知（标题"ShineWriter 写作中"，内容"正在生成：第 X 章 · 草稿中"）
  - 持有 `PARTIAL_WAKE_LOCK`（`newWakeLock(PARTIAL_WAKE_LOCK, "shinewriter:pipeline")`）防止 CPU 睡眠，`onDestroy` 释放
  - 通知渠道：`pipeline_channel`（重要性 `IMPORTANCE_LOW`，无声，因为常驻通知不该响）
  - 通过 `stopForeground(STOP_FOREGROUND_REMOVE)` + `stopSelf()` 收尾
- `PipelineForegroundModule.kt` — `ReactContextBaseJavaModule`，暴露：
  - `start(taskId: String, title: String, stageLabel: String, promise: Promise)` — `ContextCompat.startForegroundService` + 传 intent extras
  - `updateProgress(taskId: String, stageLabel: String, promise: Promise)` — 更新常驻通知文本（用 `NotificationManager.notify` 复用同一 id）
  - `notifyComplete(taskId: String, title: String, message: String, promise: Promise)` — 在**独立**通知 id 上发终态通知（高重要性 `IMPORTANCE_DEFAULT` 渠道 `pipeline_done_channel`，可响）
  - `notifyFailed(taskId: String, title: String, message: String, promise: Promise)` — 同上
  - `stop(taskId: String, promise: Promise)` — 停常驻通知 + 释放 wakelock
  - `isAvailable(promise: Promise)` — 返回 `Build.VERSION.SDK_INT >= 26` 且通知权限已授予（用于 JS 侧优雅降级判断）
  - 所有方法内部 try/catch，失败时 `promise.reject` 但 **JS 侧必须捕获并静默**（绝不阻塞流水线）
- `PipelineForegroundPackage.kt` — `ReactPackage`，`createNativeModules` 返回 `[PipelineForegroundModule(reactContext)]`

注册：`MainApplication.kt` 的 `packageList.apply { add(TtsAudioPackage()); add(PipelineForegroundPackage()) }`

### 3.3 AndroidManifest 变更

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />

<application ...>
  <activity .../>  <!-- 现有 MainActivity -->
  <service
    android:name=".PipelineForegroundService"
    android:exported="false"
    android:foregroundServiceType="dataSync" />
</application>
```

说明：
- `FOREGROUND_SERVICE_DATA_SYNC` 是 API 34+ 的类型化前台服务权限（数据同步类，符合"长时间网络任务"语义）
- `foregroundServiceType="dataSync"` 与权限对应；targetSdk 36 强制要求声明类型
- `POST_NOTIFICATIONS` 是 API 33+ 运行时权限

### 3.4 JS 桥接（`src/native/PipelineForegroundModule.ts`）

参照 `src/native/TtsAudioModule.ts` 的封装风格：

```ts
type StageLabel = string;
interface TaskInfo { taskId: string; title: string; }

class PipelineForegroundBridge {
  private native: any;
  private enabled = false;  // 缓存 settings 开关，避免每次读 DB

  async start(taskId: string, title: string, stageLabel: StageLabel): Promise<void> {
    if (!this.enabled) return;
    try { await this.native?.start(taskId, title, stageLabel); }
    catch (e) { console.warn('[PipelineForeground] start failed', e); }
  }
  // updateProgress / notifyComplete / notifyFailed / stop 同构，全部 try/catch 静默
  setEnabled(v: boolean) { this.enabled = v; }
}
```

- 单例导出
- `NativeModules.PipelineForeground` 通过 `NativeModules` 直接拿（和 TtsAudio 一致）
- **所有方法无 native 时（老 APK、被 strip）直接 no-op**，保证流水线绝不因原生层缺失而中断

### 3.5 流水线集成（`pipelineRunner.ts`）

在 `runChapterPipeline` / `runFreeformPipeline` / `resumePipeline` 的关键节点插入钩子（**纯增量，不改既有逻辑**）：

| 节点 | 现有代码 | 新增钩子 |
|---|---|---|
| 入口（拿到 chapter.title 后） | `store.setTaskStatus(taskId, 'drafting')` | `PipelineForeground.start(taskId, title, '草稿中')` |
| 阶段切换 | `onStageUpdate?.({stage:'review',...})` | `PipelineForeground.updateProgress(taskId, '审阅中')` |
| `saveDraftAndComplete` 内 | `store.completeTask(taskId, text)` | `PipelineForeground.notifyComplete(taskId, title, '已写完，点击查看')` 然后 `stop(taskId)` |
| `store.failTask` 调用处 | （多处） | `PipelineForeground.notifyFailed(taskId, title, errMsg)` 然后 `stop(taskId)` |
| `checkCancelled` 命中 | `cancelTask` | `notifyFailed(taskId, title, '已取消')` 然后 `stop(taskId)` |

**前台/后台判定**（关键，避免重复打扰）：

- 在 `src/main/index.tsx` 已有的 store 订阅里，**只有 `AppState` 非 active 时**才走系统通知路径；前台时仍走 `PipelineResultPrompt`
- 实现方式：新增 `src/utils/appState.ts` 单例，跟踪当前 `AppState`，`notifyComplete`/`notifyFailed` 内部读取：前台 → 跳过（让现有 prompt 处理）；后台 → 调原生通知

### 3.6 通知点击 deep link

- 终态通知的 `PendingIntent` → `MainActivity`，Intent extra 带 `taskId`
- `MainActivity`（singleTask）：onNewIntent / getIntent 读 extra，通过 ReactNative 的 `launchOptions` 或自定义 `initialProps` 传入 RN
- `src/main/index.tsx` 启动时检查传入的 `taskId`：若存在，调 `navigateToPipelineResult(taskId)`（已有降级逻辑，自动落到 `PipelineTask` 中心）
- 跳转目标：**`PipelineResult` 屏幕**（展示完整阶段产物，符合"查看结果"心智）

### 3.7 用户控制

- `settingsStore` + `settings` 表新增 key `background_pipeline_enabled`（默认 `'true'`）
- `database.ts`：`getBackgroundPipelineEnabled()` / `setBackgroundPipelineEnabled(v)`
- `SettingsScreen.tsx` 的 **AI Section** 加一个 Card：Switch + 说明文字"开启后，写作时以系统通知形式保持运行，切到其他 App 或锁屏不会暂停流水线"
- 首次开启时（Android 13+）：检测 `POST_NOTIFICATIONS` 权限，未授予则 `Linking.openSettings()` 引导，并 Toast 说明"需授予通知权限才能后台运行"
- `pipelineRunner.ts` 入口读取该开关决定是否调 `PipelineForeground.start`

### 3.8 降级矩阵（每个失败点都有兜底）

| 失败场景 | 行为 |
|---|---|
| 用户关闭"后台运行"开关 | 不起 service，流水线照旧（和现在一样） |
| `POST_NOTIFICATIONS` 未授予 | service 仍可起（前台服务在 API 33+ 不需通知权限即可 startForeground），但用户看不到通知；流水线仍能后台跑 |
| 原生模块缺失（旧 APK 回滚） | JS bridge no-op，流水线照旧 |
| `startForegroundService` 抛异常（极少） | JS 捕获静默，流水线照旧 |
| App 被系统强杀（极端 OOM） | 任务元数据仍在 DB，用户重开 App 后看到 `failed` 状态，可手动续跑（和现状一致） |

## 4. 方案 B：上下文配置"恢复默认"

### 4.1 步骤 1 — 收敛默认值到单一来源

在 `src/constants/defaults.ts` 新增完整的 `DEFAULT_CONTEXT_CONFIG`：

```ts
import type { ContextConfig } from '../types/novel';

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  strategy: 'sliding',
  slidingWindowSize: 4000,
  recentChapterCount: 3,
  summaryBudgetTokens: 20000,   // ← 采用实际使用的值，废弃旧的 DEFAULT_SUMMARY_BUDGET=3000
  memoryTopK: 10,
  resourceBudget: 2000,
  worldbookScanDepth: 4,
  customRangeStart: 0,
  customRangeEnd: -1,
  includeResources: true,
  worldbookRecursive: true,
};
```

引用收敛：
- `settingsStore.ts`：`import { DEFAULT_CONTEXT_CONFIG } from '../constants/defaults'`，删除内联 `defaultContextConfig`
- `database.ts`：`getContextConfig()` 每个 fallback 改读 `DEFAULT_CONTEXT_CONFIG[field]`，删除硬编码
- 旧的零散常量（`DEFAULT_SLIDING_WINDOW_SIZE` 等）若只被 `defaults.ts` 自身引用则删除；被别处引用则保留为 `DEFAULT_CONTEXT_CONFIG.slidingWindowSize` 的别名（搜索确认）

**验证标准**：全局搜索 `20000` / `4000` 等魔法数字在 context 相关路径下不应再出现，只能从 `DEFAULT_CONTEXT_CONFIG` 流入。

### 4.2 步骤 2 — UI 改动（`ContextConfig.tsx`）

把底部单按钮改成两按钮并排：

```tsx
<View style={{ flexDirection: 'row', gap: spacing.sm }}>
  <Button label="恢复默认" icon={RotateCcw} variant="ghost" flex onPress={handleReset} />
  <Button label="保存配置" icon={Save} flex onPress={save} />
</View>
```

`handleReset`：

```tsx
const handleReset = () => {
  Alert.alert(
    '恢复默认配置',
    '将把所有上下文参数重置为初始推荐值。此操作只更新当前表单，需点击「保存配置」才会生效。',
    [
      { text: '取消', style: 'cancel' },
      { text: '恢复默认', style: 'destructive', onPress: () => {
        setDraft({ ...DEFAULT_CONTEXT_CONFIG });
        Toast.show({ type: 'info', text1: '已恢复默认值，请点击保存生效' });
      }},
    ],
  );
};
```

**交互决策**：恢复后**只更新草稿 state，不直接持久化**。理由：① 符合现有"草稿→保存"心智；② 让用户审查恢复后的值，避免误触丢失自定义；③ 与"保存配置"按钮形成对称（一改一存）。

### 4.3 图标

`RotateCcw`（lucide-react-native 已有，`^1.16.0`），语义契合"回退/恢复"。

## 5. 涉及文件清单

**方案 A（新增 4 + 改 7）**：
- 新增：`android/app/src/main/java/com/shinewriter/PipelineForegroundService.kt`
- 新增：`android/app/src/main/java/com/shinewriter/PipelineForegroundModule.kt`
- 新增：`android/app/src/main/java/com/shinewriter/PipelineForegroundPackage.kt`
- 新增：`src/native/PipelineForegroundModule.ts`
- 新增：`src/utils/appState.ts`
- 改：`android/app/src/main/AndroidManifest.xml`
- 改：`android/app/src/main/java/com/shinewriter/MainApplication.kt`
- 改：`android/app/src/main/java/com/shinewriter/MainActivity.kt`（读通知 intent extra）
- 改：`src/services/pipelineRunner.ts`
- 改：`src/main/index.tsx`（deep link 接收）
- 改：`src/store/settingsStore.ts` + `src/services/database.ts`（`background_pipeline_enabled`）
- 改：`src/screens/SettingsScreen.tsx`（开关 + 权限引导）
- 改：`jest.setup.js`（mock `PipelineForeground` 模块）+ `jest.config.js`（无需，因为是自写原生模块不走 ESM）

**方案 B（改 3）**：
- 改：`src/constants/defaults.ts`（新增 `DEFAULT_CONTEXT_CONFIG`，清理冲突常量）
- 改：`src/store/settingsStore.ts`（引用统一来源）
- 改：`src/services/database.ts`（`getContextConfig` 引用统一来源）
- 改：`src/screens/ContextConfig.tsx`（按钮 + handler）

## 6. 测试策略

**单元测试（Jest）**：
- `defaults.ts` 的 `DEFAULT_CONTEXT_CONFIG` 字段完整性（11 个字段都有值）
- `ContextConfig` 恢复默认 handler：调用后 `draft` 等于 `DEFAULT_CONTEXT_CONFIG`，且**未调用** `setContextConfig`（验证只改草稿）
- `PipelineForegroundBridge`：native 为 undefined 时所有方法不抛错（优雅降级）
- `pipelineRunner` 现有测试（`__tests__/pipelineRunner.test.ts`）注入 mock bridge，验证 start/notifyComplete/stop 调用次数与任务终态匹配

**Mock 补充**（`jest.setup.js`）：
```js
NativeModules.PipelineForeground = {
  start: jest.fn(() => Promise.resolve()),
  updateProgress: jest.fn(() => Promise.resolve()),
  notifyComplete: jest.fn(() => Promise.resolve()),
  notifyFailed: jest.fn(() => Promise.resolve()),
  stop: jest.fn(() => Promise.resolve()),
  isAvailable: jest.fn(() => Promise.resolve(true)),
};
```

**手动验证（真机/模拟器）**：
1. 开启后台开关 → 跑流水线 → 切到桌面 → 通知栏出现"ShineWriter 写作中"常驻通知
2. 等流水线跑完 → 收到"已写完"通知 → 点击 → 跳到 PipelineResult 屏幕
3. 关闭后台开关 → 跑流水线 → 切后台 → 无常驻通知（流水线仍按系统默认行为跑）
4. App 在前台时完成 → 不弹系统通知，走现有 PipelineResultPrompt 弹窗
5. 上下文页点"恢复默认" → 确认 → 表单回到 4000/3/20000/10/... → 再点"保存配置" → Toast 成功

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 部分国产 ROM（小米/华为）限制第三方前台服务 | 文案引导用户在系统设置中允许"后台运行"和"自启动"；service 失败时 JS 静默降级 |
| 通知渠道在 Android 8+ 必须先创建 | Service `onCreate` 里 `NotificationManager.createNotificationChannel` 两个渠道（运行中 LOW / 完成 DEFAULT） |
| `foregroundServiceType=dataSync` 在某些低版本报错 | 运行时 `Build.VERSION.SDK_INT` 判断，<34 时不带 type 参数 startForeground |
| "恢复默认"与现有 `DEFAULT_SUMMARY_BUDGET=3000` 常量冲突 | 步骤 1 显式收敛，删除或重命名冲突常量，全文搜索确认无遗漏引用 |
| 原生新增导致 release 构建 ProGuard strip | 当前 `enableProguardInReleaseBuilds=false`，无影响；若未来开启需加 keep 规则 |

## 8. 非目标（明确排除）

- **不重写 LLM 调用到原生层**（排除 WorkManager 方案，工作量与 Keystore 跨进程风险过高）
- **不改取消机制**（协作式 Set 保留，本次只加保活）
- **不做跨进程任务恢复**（App 被强杀后仍需手动续跑，和现状一致；本次只降低被杀概率）
- **不引入第三方通知库**（自写原生模块，复用 TtsAudio 模式，零新依赖）
- **不改 iOS**（项目无 iOS 工程）

## 8.5 交付独立性

方案 A 与方案 B **互不依赖，可独立交付上线**。方案 B（恢复默认）改动小、风险低，建议先行发布；方案 A（后台运行）涉及原生层，建议单独构建验证。两者合并到同一个 spec 是因为同属"写作体验改进"主题，但实施和发布可解耦。

## 9. 实施顺序建议

1. **方案 B 先做**（独立、低风险、立即可见）— 收敛默认值 → 加按钮
2. **方案 A 原生层** — Service + Module + Manifest + MainApplication 注册
3. **方案 A JS 桥接** — `PipelineForegroundModule.ts` + `appState.ts`
4. **方案 A 集成** — pipelineRunner 钩子 + index.tsx deep link + settings 开关
5. **测试 + mock 补充**
6. 真机验证降级矩阵
