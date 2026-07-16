# Tavo Mini 下一轮可靠性与发布验收 Spec

## 1. 文档目的

本 Spec 用于指导编程 Agent 对 GitHub 仓库 `anjingdtl/tavo-mini` 开展下一轮可靠性修复与发布验收工作。

上一轮 Phase 0–8 的主体建设已基本完成，当前重点不再是继续扩展功能，而是修复已发现的回归风险、解除远端 CI 阻塞，并把“已经实现”推进到“已经验证、可以发布”。

本轮目标：

1. 修复章节自动保存失败时仍可能退出页面的问题。
2. 修复自动保存与“清空正文”之间的竞态条件。
3. 修复 GitHub Actions 中 Jest 不能自然退出的问题。
4. 删除依赖 `--forceExit` 的测试通过方式。
5. 完成核心 Maestro 流程的真实执行。
6. 完成 Minified Release 的干净设备验证。
7. 将十二项故障恢复规范升级为真实故障注入证据。
8. 完成发布清单并形成可审计交付记录。

---

# 2. 当前仓库基线

## 2.1 仓库信息

```text
Repository: anjingdtl/tavo-mini
Default branch: main
Application version: 2.4.3
Schema version: 14
React Native: 0.85.3
Node.js: 22.11.0
JDK: 17
```

## 2.2 当前验证基线

```text
Local Jest suites: 78
Local Jest tests: 381
Statements coverage: 78.21%
Branches coverage: 60.30%
Functions coverage: 85.92%
Lines coverage: 79.82%
```

## 2.3 当前远端 CI 状态

GitHub Actions `Verify` 当前已确认：

```text
Android Debug build: success
Migration matrix: success
JavaScript lint: success
JavaScript typecheck: success
JavaScript Jest: cancelled / timeout
Coverage: skipped
```

不得将当前状态描述为“CI 全绿”。

---

# 3. 本轮范围

## 3.1 必须完成

| 工作流 | 名称 | 优先级 |
|---|---|---|
| Workstream A | 自动保存可靠性修复 | P0 |
| Workstream B | GitHub Actions Jest 退出修复 | P0 |
| Workstream C | E2E 与 Minified Release 实机验收 | P1 |
| Workstream D | 真实故障注入与发布证据 | P1 |
| Workstream E | 文档、门禁与发布收口 | P1 |

## 3.2 不在本轮范围

除非修复上述问题所必需，不得：

- 新增小说创作功能。
- 新增新的 AI Provider。
- 修改数据库 Schema。
- 升级 React Native 大版本。
- 更换 SQLite 库。
- 重写现有备份格式。
- 重做 UI 设计。
- 删除已有兼容入口。
- 修改或重置现有用户数据。
- 删除历史数据库 Fixture。
- 重置测试设备数据库以规避问题。
- 使用更长 CI timeout 掩盖 Jest 卡死。
- 继续依赖 `--forceExit` 作为最终解决方案。

---

# 4. Agent 执行总原则

Agent 必须遵守：

1. 先复现问题，再修改代码。
2. 每个缺陷先写失败测试。
3. 不得通过吞掉异常制造“成功”状态。
4. 不得通过延长 timeout 解决资源泄漏。
5. 不得删除失败测试。
6. 不得跳过 Coverage。
7. 不得在保存失败时自动关闭页面。
8. 不得在保存状态未知时执行破坏性操作。
9. 不得把真实设备未执行的场景标记为通过。
10. 不得把模拟状态合同测试描述为真实故障注入。
11. 每个独立任务必须单独提交。
12. 每次提交前执行针对性测试。
13. 每个 Workstream 完成后执行全量验证。
14. 所有验证结果必须写入 `docs/optimization/next-round-progress.md`。
15. 所有失败必须保留命令、错误摘要和下一步建议。

---

# 5. Workstream A：自动保存可靠性修复

## 5.1 问题 A1：保存失败后 `flush()` 未传播错误

### 当前风险

当前自动保存逻辑在数据库写入失败时恢复 pending 字段并设置 `failed`，但没有向 `flush()` 调用方重新抛出错误。

可能产生：

1. 用户修改正文。
2. 用户立即返回。
3. `flush()` 触发数据库写入。
4. 写入失败。
5. Hook 设置 `failed`，但 Promise 仍 fulfilled。
6. 退出保护继续关闭页面。
7. 未保存内容丢失。

### 修改范围

```text
src/screens/chapter-editor/hooks/useChapterAutoSave.ts
src/screens/chapter-editor/hooks/useUnsavedChangesGuard.ts
src/utils/debounce.ts
__tests__/
```

### 实现要求

#### A1.1 主动 flush 必须感知失败

保存失败时必须：

1. 把失败字段重新放回 pending 队列。
2. 设置 `saveStatus = failed`。
3. 保留原始错误。
4. 向 `flush()` 重新抛出错误。

参考行为：

```ts
catch (error) {
  pendingFieldsRef.current = {
    ...fields,
    ...pendingFieldsRef.current,
  };
  setSaveStatus('failed');
  throw error;
}
```

#### A1.2 后台自动保存不得产生未处理 Promise

后台 debounce 的 `call()` 路径应：

- 捕获异常。
- 调用可选 `onError`。
- 不产生 unhandled rejection。
- 不清除 pending 数据。
- 不伪装成 saved。

#### A1.3 保存失败后允许重试

第一次保存失败后：

- pending 数据仍然存在。
- 第二次 `flush()` 会再次尝试写入。
- 成功后状态变为 `saved`。
- pending 队列被清空。

#### A1.4 退出必须被阻止

以下两条路径保存失败时都不得退出：

```text
Header 返回按钮
React Navigation beforeRemove
```

保存失败后必须：

- 不调用 `onClose`。
- 不调用 `navigation.dispatch(event.data.action)`。
- 显示保存失败提示。
- 提供“重试保存”。
- 提供“仍然退出”。
- 只有用户明确选择“仍然退出”时才关闭。

### 必须新增的测试

建议新建：

```text
__tests__/chapterAutosaveFailure.test.tsx
__tests__/chapterUnsavedGuard.test.tsx
```

至少覆盖：

1. `updateChapter` reject 时 `flush()` reject。
2. 保存失败后 pending 数据仍存在。
3. 第二次重试成功后状态变为 saved。
4. 点击返回时保存失败，不调用 `onClose`。
5. `beforeRemove` 时保存失败，不调用 `navigation.dispatch`。
6. 点击“重试保存”后重新调用数据库。
7. 点击“仍然退出”后才调用 `onClose`。
8. 后台 debounce 保存失败不产生 unhandled rejection。
9. 保存失败后页面显示“保存失败”。
10. 成功保存后页面显示“已保存”。

### 验收命令

```bash
npx jest __tests__/chapterAutosaveFailure.test.tsx --runInBand
npx jest __tests__/chapterUnsavedGuard.test.tsx --runInBand
npm run typecheck
npm run lint
```

### Commit

```text
fix(editor): propagate autosave failures to exit guards
```

---

## 5.2 问题 A2：自动保存与“清空正文”竞态

### 当前风险

用户输入正文后，自动保存仍处于防抖等待期间。如果用户立即点击“清空正文”：

1. 清空操作写入空正文。
2. 旧 pending autosave 稍后执行。
3. 旧正文重新写回数据库。
4. UI 与数据库不一致。

### 修改范围

```text
src/screens/chapter-editor/ChapterEditorScreen.tsx
src/screens/chapter-editor/hooks/useChapterAutoSave.ts
__tests__/
```

### 实现要求

执行“清空正文”前必须：

1. 检查当前是否存在 pending 保存。
2. 执行 `await autoSaveRef.current.flush()`。
3. flush 失败时停止清空。
4. flush 成功后创建清空前版本快照。
5. 写入空正文。
6. 确认不存在旧 pending 保存。
7. 重新加载章节。
8. 设置状态为 saved。

不得：

- 直接 `cancel()` 丢弃 pending 正文。
- 清空后等待自动保存覆盖。
- 清空失败仍刷新页面。
- 忽略版本快照失败。

### 建议接口

可以在 `useChapterAutoSave` 增加：

```ts
flush(): Promise<void>
cancelPending(): void
hasPending(): boolean
```

也可继续暴露 `autoSaveRef`，但调用语义必须明确。

### 必须新增的测试

建议新建：

```text
__tests__/chapterClearRace.test.tsx
```

至少覆盖：

1. 输入后立即清空时，先调用 autosave，再调用清空 SQL。
2. autosave 失败时不执行清空。
3. 清空完成后旧正文不会再次写入。
4. 清空前版本快照保存的是最新正文。
5. 清空成功后 UI 正文为空。
6. 清空成功后数据库正文为空。
7. 连续快速点击清空只执行一次。
8. 清空过程中按钮 disabled。
9. 清空失败时正文保持可恢复。
10. 清空完成后没有 pending autosave。

### 验收命令

```bash
npx jest __tests__/chapterClearRace.test.tsx --runInBand
npm run typecheck
npm run lint
```

### Commit

```text
fix(editor): serialize autosave and clear-content actions
```

---

## 5.3 Workstream A 完成标准

```text
[ ] 保存失败时 flush reject
[ ] 保存失败时页面不会自动退出
[ ] beforeRemove 不会绕过保存失败
[ ] 保存失败可重试
[ ] 输入后立即清空不会恢复旧正文
[ ] 清空前保存最新内容
[ ] 所有新增测试通过
[ ] 原 ChapterEditor 测试全部通过
```

专项测试：

```bash
npx jest \
  __tests__/chapterEditorToolbar.test.tsx \
  __tests__/chapterAutosaveFailure.test.tsx \
  __tests__/chapterUnsavedGuard.test.tsx \
  __tests__/chapterClearRace.test.tsx \
  __tests__/debounce.test.ts \
  --runInBand
```

---

# 6. Workstream B：GitHub Actions Jest 退出修复

## 6.1 目标

修复 GitHub Actions JavaScript Job 在 Jest 步骤被取消或超时的问题。

最终要求：

- Jest 自然退出。
- 不使用 `--forceExit`。
- Coverage 能运行。
- JavaScript Job 成功。
- `Verify` 三个 Job 全绿。

---

## 6.2 第一阶段：复现远端行为

### 本地命令

在 Linux 环境优先执行：

```bash
npm ci
npm run lint
npm run typecheck
npx jest --runInBand --ci --detectOpenHandles
```

如果本机是 Windows，应使用以下任一环境：

- WSL2。
- Ubuntu Docker。
- GitHub Codespace。
- 临时 GitHub Actions 诊断分支。

### 禁止

不得直接：

```text
把 timeout-minutes 从 20 改到 40
继续保留 --forceExit
把卡死 suite 从 Jest 配置中排除
删除定时器或事件监听相关测试
```

---

## 6.3 第二阶段：定位卡死 Suite

按测试目录二分运行：

```bash
npx jest __tests__/database* --runInBand --ci --detectOpenHandles
npx jest __tests__/llm* --runInBand --ci --detectOpenHandles
npx jest __tests__/voice* --runInBand --ci --detectOpenHandles
npx jest __tests__/chapter* --runInBand --ci --detectOpenHandles
npx jest __tests__/pipeline* --runInBand --ci --detectOpenHandles
npx jest __tests__/backup* --runInBand --ci --detectOpenHandles
```

如果仍无法定位，使用：

```bash
npx jest --listTests
```

按文件分批执行并记录：

```text
开始时间
结束时间
是否自然退出
open handle 类型
最后一个输出的 suite
```

### 优先检查对象

```text
src/services/llm/requestScheduler.ts
src/services/llm/requestPolicy.ts
src/navigation/navigationRef.ts
src/utils/appState.ts
src/store/voiceStore.ts
src/native/TtsAudioModule.ts
DeviceEventEmitter listeners
AppState listeners
setInterval / setTimeout
spawnSync / child_process
Python fixture validator
React Navigation listeners
Zustand subscriptions
```

---

## 6.4 第三阶段：修复资源释放

所有全局监听器和计时器必须支持清理。

建议增加仅用于测试或生命周期管理的接口：

```ts
dispose()
resetForTest()
removeListeners()
clearTimers()
```

### DeviceEventEmitter

必须保存 subscription：

```ts
const subscription = DeviceEventEmitter.addListener(...);
```

并在 dispose 中执行：

```ts
subscription.remove();
```

### AppState

必须保存 subscription，并支持移除。

### 定时器

所有长期定时器必须：

- 任务结束时 clear。
- 测试 teardown 时 clear。
- 能使用 `unref()` 时调用 `unref()`。
- 不让 Jest 进程保持活跃。

### Scheduler

`LLMRequestScheduler` 应支持：

```ts
dispose()
resetForTest()
```

`dispose()` 至少：

- 移除 DeviceEventEmitter 监听。
- 移除 AppState 监听。
- 取消等待队列。
- abort 运行任务。
- 清理 taskDefaults。
- 清理 active map。
- 清理 activePipelineProjects。
- 设置已释放状态。

### React Hooks

所有 `useEffect()` 必须返回正确 cleanup。

---

## 6.5 第四阶段：删除 `--forceExit`

当前：

```json
"test:ci": "jest --runInBand --ci --forceExit",
"test:coverage": "jest --runInBand --ci --coverage --forceExit"
```

目标：

```json
"test:ci": "jest --runInBand --ci",
"test:coverage": "jest --runInBand --ci --coverage"
```

如果删除后仍不能自然退出，Workstream B 不得标记完成。

---

## 6.6 第五阶段：优化 CI Job

当前 JavaScript Job 连续运行：

```text
test:ci
test:coverage
```

这会重复执行全量 Jest。

优先改为单次 Coverage：

```yaml
- name: Jest with coverage
  run: npm run test:coverage
```

删除单独 `test:ci` 步骤。

必须保留：

```text
lint
typecheck
coverage thresholds
```

---

## 6.7 GitHub Actions 验收

必须推送诊断分支，并确认：

```text
JavaScript validation: success
Android Debug build: success
Migration matrix: success
Coverage step: success
```

必须记录：

```text
Workflow run URL
Run ID
Commit SHA
Job duration
Jest suite count
Jest test count
Coverage percentages
```

### Commit

```text
test: release lingering Jest handles
ci: make JavaScript verification terminate naturally
```

---

# 7. Workstream C：E2E 与 Minified Release 实机验收

## 7.1 目标

把当前已提交的 Maestro 流程从“脚本存在”升级为“真实执行通过”。

## 7.2 测试环境要求

优先使用：

```text
Android emulator API 35 或当前 targetSdk 对应版本
至少一台 ARM64 真机
干净安装设备
独立测试数据
```

必须记录：

```text
设备型号
Android 版本
ABI
可用内存
存储空间
APK SHA-256
Git Commit SHA
测试开始和结束时间
```

## 7.3 APK 类型

必须分别验证：

```text
Debug APK
普通 signed Release APK
Minified signed Release APK
```

Minified Release 必须在干净设备安装，不得：

- 覆盖签名不同的 Debug App。
- 为安装而删除包含用户数据的现有测试 App。
- 使用 Debug 结果代替 Release 结果。

## 7.4 Maestro 流程

执行：

```text
e2e/maestro/01-first-start.yaml
e2e/maestro/02-writing-lifecycle.yaml
e2e/maestro/03-resource-library.yaml
e2e/maestro/04-backup-restore.yaml
e2e/maestro/05-llm-configuration.yaml
e2e/maestro/06-pipeline-cancel.yaml
```

每条流程必须保存：

```text
执行命令
退出码
截图
失败步骤
UI hierarchy
Logcat 摘要
```

### 核心验证点

#### 写作链路

```text
创建项目
创建章节
输入正文
自动保存
退出
重新进入
正文存在
数据库内容一致
```

#### 资源库

```text
创建人物集合
创建人物
创建世界书
创建笔记
项目资源启停
```

#### 备份恢复

```text
创建备份
修改正文
恢复备份
确认正文回滚
确认人物和世界书存在
确认 API Key 未恢复
确认本地模型状态为 missing
```

#### 在线 LLM

```text
HTTPS 正常连接
公网 HTTP 被阻止
私有 IPv4 HTTP 默认被阻止
开启开关后私有 IPv4 可连接
```

#### 流水线

```text
任务进入 queued
任务进入 running
同项目串行
取消排队任务
取消运行任务
失败提示
结果页跳转
```

## 7.5 Minified Release 验收矩阵

```text
[ ] 冷启动
[ ] 新建项目
[ ] 新建章节
[ ] 编辑和自动保存
[ ] 人物和世界书
[ ] 在线 LLM
[ ] 本地 GGUF 导入
[ ] 本地模型加载
[ ] 本地模型生成
[ ] TTS
[ ] 备份
[ ] 恢复
[ ] 前后台切换
[ ] 流水线取消
[ ] 低内存事件
```

任何原生模块反射、JNI、Keychain、SQLite、RNFS、TTS 问题都必须修复 ProGuard 规则，不得关闭 Minification 作为最终方案。

### Commit

代码修复：

```text
fix(android): preserve release runtime integrations under R8
```

仅记录证据：

```text
docs: record minified release device verification
```

---

# 8. Workstream D：真实故障注入与发布证据

## 8.1 目标

现有 `faultInjectionMatrix.test.ts` 只锁定恢复合同。本轮必须建立真实故障执行证据。

## 8.2 十二项故障场景

### D1：Migration 第三条 SQL 失败

仅测试构建允许注入：

```text
FAIL_MIGRATION_AT_STATEMENT=3
```

验证：

```text
事务回滚
schema_version 不前进
原数据存在
启动显示可理解错误
可重试
```

### D2：恢复中途失败

在恢复 statement batch 中注入失败，验证：

```text
原数据库不变
pre-restore backup 存在
无半恢复状态
可选择其他备份
```

### D3：磁盘空间不足

可使用：

- 限制模拟器分区。
- 测试文件系统 wrapper 注入 ENOSPC。
- 写 staging 文件时强制失败。

验证：

```text
不生成损坏备份
临时文件清理
数据库保持最后提交状态
用户收到空间不足提示
```

### D4：备份文件损坏

修改 JSON 结构，验证恢复前拒绝且原数据库不变。

### D5：Checksum 错误

修改正文但保留旧 checksum，验证恢复前拒绝。

### D6：自动保存时杀死 App

步骤：

```text
输入正文
在 debounce 或 SQLite 写入阶段 adb shell am force-stop
重新启动
```

验证：

```text
最多丢失未提交防抖窗口数据
最近提交内容存在
无数据库损坏
无卡死保存状态
```

### D7：Migration 时杀死 App

验证：

```text
事务未提交时保持旧 Schema
重新启动可继续迁移
无半迁移
```

### D8：恢复时杀死 App

验证：

```text
未提交事务保持原数据库
已提交事务通过启动验证
pre-restore backup 存在
```

### D9：GGUF 导入时杀死 App

验证：

```text
staging 临时文件清理
模型记录不永久停留 importing
可重新导入
无孤儿大文件
```

### D10：本地模型生成时 OOM

使用可控测试模型或 native 测试注入，验证：

```text
生成停止
模型可卸载
任务状态不是永久 running
用户收到降低模型或上下文提示
```

### D11：在线模型中途断网

验证：

```text
任务进入 network_error
正文不被错误覆盖
可重试
无永久 loading
```

### D12：TTS 播放时切后台

验证：

```text
播放状态正确
恢复前台后按钮状态正确
停止操作可用
无重复 session
无泄漏前台服务
```

## 8.3 故障注入实现原则

所有故障注入开关必须：

- 仅测试环境可用。
- 正式 Release 默认关闭。
- 不接受远程用户输入开启。
- 不包含真实密钥。
- 有自动 teardown。
- 不污染下一项测试。

推荐增加：

```text
src/testing/faultInjection.ts
android/.../TestFaultInjector.kt
```

正式 Release 中应通过编译标志移除或恒定关闭。

## 8.4 故障证据文档

更新：

```text
docs/FAULT_INJECTION_MATRIX.md
```

每项增加：

```markdown
### 场景名称

- Build:
- Commit:
- Device:
- Injection method:
- Expected result:
- Actual result:
- User-visible message:
- Database state:
- Retry result:
- Orphan files:
- Stuck tasks:
- Logcat:
- Screenshots:
- Status: PASS / FAIL / BLOCKED
```

### Commit

```text
test(reliability): execute real fault injection scenarios
```

---

# 9. Workstream E：文档、门禁与发布收口

## 9.1 更新进度文档

新建：

```text
docs/optimization/next-round-progress.md
```

每个任务记录：

```markdown
## Task

### Root cause
### Code changes
### Tests added
### Commands run
### Results
### Device evidence
### Commit
### Remaining risk
```

## 9.2 更新发布清单

`docs/RELEASE_CHECKLIST.md` 必须填入真实证据，不得只保留空复选框并声称完成。

必须填写：

```text
Workflow URL
APK path
APK SHA-256
Signer certificate digest
Device model
Android version
Maestro result
Fault injection result
GitHub Release URL
Rollback artifact
```

## 9.3 分支保护建议

远端 CI 全绿后，建议为 `main` 设置：

```text
Require pull request before merging
Require Verify / JavaScript validation
Require Verify / Android Debug build
Require Verify / Migration matrix
Require branches to be up to date
Block force pushes
```

如果 Agent 无权限修改仓库设置，应输出明确操作步骤，不得声称已启用。

## 9.4 发布候选版本

建议先创建：

```text
V2.4.4-rc.1
```

版本内容只包含：

```text
autosave failure propagation
clear-content race fix
Jest natural exit
CI green
release verification evidence
```

不得在 RC 中混入新产品功能。

---

# 10. 测试要求

## 10.1 单元与集成测试

```bash
npm ci
npm run lint
npm run typecheck
npm run test:ci
npm run test:coverage
npm test -- migration --runInBand
```

## 10.2 Jest 自然退出验证

```bash
npx jest --runInBand --ci --detectOpenHandles
```

必须满足：

```text
退出码 0
无 --forceExit
无 open handle 报告
无超时
```

## 10.3 Android 构建

```bash
npm run apk:debug
npm run apk:release
npm run apk:release:minified
```

Release 只允许通过进程环境变量读取签名信息。

## 10.4 安全扫描

```bash
git grep -n "SHINE_WRITER_RELEASE_STORE_PASSWORD"
git grep -n "api_key"
git grep -n "Bearer "
git grep -n "password"
git grep -n "transaction(async"
```

检查要求：

- 不存在硬编码签名密码。
- 不存在真实 API Key。
- 不存在新的异步 SQLite transaction callback。
- 备份中不包含凭据。
- 测试密钥必须明显为假值。

---

# 11. 提交计划

建议顺序：

```text
fix(editor): propagate autosave failures to exit guards
fix(editor): serialize autosave and clear-content actions
test: release lingering Jest handles
ci: make JavaScript verification terminate naturally
test(e2e): verify core flows on release builds
test(reliability): execute real fault injection scenarios
docs: complete release verification evidence
```

每个 Commit：

- 只处理一个问题。
- 有对应测试。
- 使用 Conventional Commits。
- 不格式化整个仓库。
- 不修改无关文件。

---

# 12. Pull Request 结构

PR 标题建议：

```text
fix: complete reliability and release verification
```

PR 描述必须包含：

```markdown
## Summary

## Root causes fixed

## Autosave behavior

## CI termination

## Tests

## Android builds

## Device verification

## Fault injection

## Security checks

## Known limitations

## Release recommendation
```

---

# 13. 完成定义

只有以下条件全部满足，本轮才可标记完成。

## 自动保存

```text
[ ] 保存失败会传播到退出保护
[ ] 保存失败不会自动退出
[ ] 保存失败可重试
[ ] 清空正文不会与 pending autosave 竞争
[ ] 相关测试通过
```

## CI

```text
[ ] package.json 不包含 --forceExit
[ ] Jest 自然退出
[ ] detectOpenHandles 无异常
[ ] GitHub Actions JavaScript Job 成功
[ ] Coverage 成功
[ ] Android Debug Job 成功
[ ] Migration Matrix Job 成功
```

## 实机

```text
[ ] 全部 Maestro 流程真实执行
[ ] 普通 Release 实机通过
[ ] Minified Release 干净设备通过
[ ] 在线 LLM 通过
[ ] 本地 GGUF 通过
[ ] TTS 通过
[ ] 备份恢复通过
```

## 故障注入

```text
[ ] 十二项场景均有真实执行证据
[ ] 每项记录数据库状态
[ ] 每项记录用户反馈
[ ] 每项确认无孤儿文件
[ ] 每项确认无卡死任务
```

## 发布

```text
[ ] Release Checklist 有完整证据
[ ] APK SHA-256 已记录
[ ] 签名证书已验证
[ ] GitHub Actions 全绿
[ ] RC Release 已创建
[ ] 回滚方案已记录
```

---

# 14. Agent 首轮执行指令

将以下内容直接交给编程 Agent：

```text
你正在维护 GitHub 仓库 anjingdtl/tavo-mini。

请严格按照 docs/spec.md 执行下一轮可靠性与发布验收工作。

第一轮只执行 Workstream A 和 Workstream B，不得提前执行 E2E、真实故障注入或发布。

第一轮任务：

1. 修复 useChapterAutoSave 在数据库写入失败时不向 flush 调用方传播错误的问题。
2. 确保 Header 返回和 React Navigation beforeRemove 在保存失败时都不会退出。
3. 增加保存失败、重试保存、用户确认强制退出的回归测试。
4. 修复自动保存与“清空正文”之间的竞态。
5. 增加输入后立即清空、保存失败时禁止清空、清空后旧正文不回写的回归测试。
6. 复现 GitHub Actions 中 Jest 卡住的问题。
7. 使用 --detectOpenHandles 和测试二分法定位未释放资源。
8. 修复计时器、DeviceEventEmitter、AppState、Zustand 或子进程等资源泄漏。
9. 从 test:ci 和 test:coverage 中删除 --forceExit。
10. 优化 GitHub Actions，避免无必要地连续执行两遍全量 Jest。
11. 推送分支并确认 JavaScript、Android Debug、Migration Matrix 三个 Job 全部成功。

约束：

- 不新增产品功能。
- 不修改数据库 Schema。
- 不删除已有测试。
- 不延长 CI timeout 掩盖问题。
- 不把 --forceExit 保留下来作为最终方案。
- 不吞掉自动保存错误。
- 不允许保存失败后自动退出页面。
- 不允许 cancel pending autosave 来实现清空正文。
- 每个独立问题单独提交。
- 每次提交前运行专项测试。
- Workstream A 完成后运行 ChapterEditor 全部相关测试。
- Workstream B 完成后运行 npm run lint、npm run typecheck、npm run test:ci、npm run test:coverage 和 npx jest --runInBand --ci --detectOpenHandles。
- 所有结果写入 docs/optimization/next-round-progress.md。

完成后输出：

- 根因分析
- 修改文件
- 新增测试
- 删除的 --forceExit 配置
- detectOpenHandles 结果
- GitHub Actions Run URL
- 三个 Job 状态
- Commit SHA
- 剩余风险
- 下一轮 Workstream C/D 建议
```

---

# 15. Agent 阶段报告模板

每完成一个 Workstream，必须输出：

```markdown
# Workstream 完成报告

## 状态
PASS / PARTIAL / BLOCKED

## 根因
- ...

## 修改
- ...

## 新增测试
- ...

## 本地验证
- Command:
- Exit code:
- Result:

## GitHub Actions
- Run URL:
- JavaScript:
- Android:
- Migration:

## 设备验证
- Device:
- APK:
- Result:

## Commit
- SHA:
- Message:

## 剩余风险
- ...

## 下一步
- ...
```

不得只回复“已完成”。
