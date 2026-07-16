# 下一轮可靠性与发布验收进度

## 施工基线

- 时间：2026-07-16 19:25:02 +08:00
- 分支：`main`
- 基线提交：`af849a5466c7617c476d7757dc385092733e873f`
- 远端状态：开始施工时 `main` 与 `origin/main` 同步。
- Node.js：`v24.14.1`（项目最低要求 `>=22.11.0`）
- npm：`11.14.1`
- JDK：Temurin 17.0.19
- Android 工具：本轮基线环境未发现 `adb`。
- Maestro：本轮基线环境未发现 `maestro`。
- Linux 复现环境：发现 `wsl.exe`；尚未确认是否安装可用发行版。
- Release 签名环境变量：三项均未设置；未读取或输出任何密钥内容。
- 用户已有未提交内容：`docs/superpowers/specs/Tavo-Mini-Agent-Optimization-Plan.md`、`.zcode/`、`docs/superpowers/specs/tavo-mini-next-round-spec.md`。这些内容不属于本轮 Agent 修改，不还原、不清理、不混入功能提交。
- 总体状态：`PARTIAL`

## Workstream A：自动保存可靠性

### A1 保存失败传播与退出保护

#### Root cause

- 基线代码在 `useChapterAutoSave` 中捕获数据库异常后只恢复 pending 字段并设置 `failed`，没有重新抛出原始错误，因此主动 `flush()` 会错误地 fulfilled。
- `beforeRemove` 失败后只设置状态，没有提供“重试保存 / 仍然退出”的显式决策入口。

#### Code changes

- `useChapterAutoSave` 在数据库失败时恢复 pending 字段、保存原始错误并重新抛出；成功或新编辑时清理旧错误。
- `debounce` 在异步执行失败后保留最新参数，使显式 `flush()` 可以重试；后台 `call()` 仍捕获 rejection 并转交可选 `onError`。
- `useUnsavedChangesGuard` 为 Header 与 `beforeRemove` 统一提供“重试保存 / 仍然退出”，导航强退仅放行一次 removal action。

#### Tests added

- 新增 `__tests__/chapterAutosaveFailure.test.tsx`。
- 新增 `__tests__/chapterUnsavedGuard.test.tsx`。
- 扩充 `__tests__/debounce.test.ts` 的失败 pending、重试与后台 rejection 回归。

#### Commands run

- `git status`
- `git branch --show-current`
- `git log -1 --oneline`
- `npx jest __tests__/chapterAutosaveFailure.test.tsx __tests__/chapterUnsavedGuard.test.tsx --runInBand`（修复前）
- `npx jest __tests__/chapterAutosaveFailure.test.tsx __tests__/chapterUnsavedGuard.test.tsx __tests__/debounce.test.ts --runInBand`
- `npm run typecheck`
- `npm run lint`

#### Results

- 修复前：退出码 1；2 suites failed、3 tests failed，准确复现 `flush()` fulfilled、retry pending 丢失、`beforeRemove` 无提示。
- 修复后专项：退出码 0；3 suites、14 tests 全部通过。
- TypeScript：退出码 0。
- ESLint：退出码 0；仅有 4 条既有 `no-bitwise` warning，无 error。

#### Commit

- `415883e` — `fix(editor): propagate autosave failures to exit guards`

#### CI Run URL

- 待推送诊断分支后记录。

#### Device and APK

- 不适用。

#### Remaining risk

- AppState/卸载阶段仍采用 best-effort flush；失败状态由 autosave Hook 保留，但后台时不弹退出确认框。

#### Status

`PASS`

### A2 自动保存与清空正文竞态

#### Root cause

- 基线 `clearContent` 在创建快照和写空正文前没有等待 pending autosave，旧正文可在清空后回写。

#### Code changes

- `ChapterEditorScreen` 在打开清空确认时同步取得互斥锁并禁用清空入口；取消或结束后释放。
- 清空确认后先 `await autoSaveRef.current.flush()`；失败立即停止，不创建快照、不写空正文、不刷新页面。
- 用同步维护的最新章节引用创建快照，确保立即点击清空也保存最新正文。
- 清空期间拒绝新的字段编辑；成功写空并重新加载后才标记 `saved`。全程未调用 `cancel()`。

#### Tests added

- 新增 `__tests__/chapterClearRace.test.tsx`，覆盖调用顺序、flush 失败阻断、debounce 窗口后无旧正文回写、最新快照、UI/数据库均为空、保存状态、快速重复点击、禁用态、清空写入失败可恢复、无残留 pending 写入。

#### Commands run

- 已检查 `ChapterEditorScreen.tsx` 清空流程及自动保存 Hook。
- `npx jest __tests__/chapterClearRace.test.tsx --runInBand`（修复前）
- `npx jest __tests__/chapterEditorToolbar.test.tsx __tests__/chapterAutosaveFailure.test.tsx __tests__/chapterUnsavedGuard.test.tsx __tests__/chapterClearRace.test.tsx __tests__/debounce.test.ts --runInBand`
- `npm run typecheck`
- `npm run lint`

#### Results

- 修复前：退出码 1；4 tests failed，实际观察到快照内容为旧正文、第一次写入为空正文、旧 pending 回写风险，以及重复弹出两个确认框。
- 修复后专项：退出码 0；5 suites、28 tests 全部通过。
- TypeScript：退出码 0。
- ESLint：退出码 0；仅有 4 条既有 `no-bitwise` warning，无 error。

#### Commit

- `6262e52` — `fix(editor): serialize autosave and clear-content actions`

#### CI Run URL

- 待记录。

#### Device and APK

- 待 Workstream C。

#### Remaining risk

- 清空确认框设置为不可点击外部区域取消，避免锁状态无法被明确释放；用户仍可使用“取消”按钮。

#### Status

`PASS`

## Workstream B：Jest 与 GitHub Actions

### Root cause

- 远端 Run `29433210552` 的 JavaScript job 在 Linux Node 22.11.0 上执行全量 Jest 时，完成 `noteImport.test.ts` 后进入 `appPipelineReminder.test.tsx` 卡住，直至 20 分钟 job timeout；runner 最后强杀 `npm`、`sh`、`node`，Coverage 被跳过。
- WSL2 同一提交、同一依赖复现：Node 22.11.0 与 22.13.0 单独执行 `appPipelineReminder.test.tsx` 均在产生测试结果前挂住；Node 24.14.1 在约 9 秒通过该 suite，完整 81 suites / 393 tests 在 11.965 秒自然退出。
- `package.json` 的 `test:ci` 与 `test:coverage` 使用 `--forceExit`，掩盖本地自然退出状态。
- `.github/workflows/verify.yml` 连续执行两次全量 Jest，第一遍卡住导致 Coverage 永远无法开始。

### Code changes

- 将项目 Node engine 收紧为 `>=24.3.0`，CI 三个 job 固定 Node 24.14.1。
- 从 `test:ci`、`test:coverage` 删除 `--forceExit`。
- JavaScript job 合并为单次 `Jest with coverage`，保留 lint、typecheck 和 coverage threshold，不修改 timeout。

### Tests added

- 新增 `__tests__/ciConfiguration.test.ts`，锁定 Node engine、Actions Node 版本、无 `--forceExit`、且 workflow 只执行一次 coverage Jest。

### Commands run

- `npx jest --runInBand --ci --detectOpenHandles`（Windows Node 24.14.1）
- WSL2 Node 22.11.0/22.13.0：`npx jest __tests__/appPipelineReminder.test.tsx --runInBand --ci --detectOpenHandles`
- WSL2 Node 24.14.1：同一专项命令及全量 `npx jest --runInBand --ci --detectOpenHandles`
- `npm run lint`
- `npm run typecheck`
- `npm run test:ci`
- `npm run test:coverage`
- `npm test -- migration --runInBand`
- `npx jest --runInBand --ci --detectOpenHandles`

### Results

- 配置红测：修复前 3 tests failed，分别锁定不支持的 Node、`--forceExit` 和重复 Jest 步骤。
- Windows 最终门禁：82 suites / 396 tests，退出码 0，自然退出，无 open handle 报告，无超时。
- Coverage：Statements 78.29%、Branches 60.36%、Functions 86.05%、Lines 79.92%，退出码 0。
- Migration：7 suites / 36 tests，退出码 0。
- WSL2 Node 24.14.1：81 suites / 393 tests，11.965 秒，自然退出，无 open handle 报告。该克隆位于 `/tmp`，未触碰用户工作区。

### Commit

- `f361b4f` — `test: make Jest terminate naturally on a supported runtime`
- `9b6cc7d` — `ci: make JavaScript verification terminate naturally`

### CI Run URL

- 失败基线：https://github.com/anjingdtl/tavo-mini/actions/runs/29433210552
- 修复后 Run：待诊断分支 PR 触发并记录。

### Device and APK

- 不适用。

### Remaining risk

- WSL2 已提供 Linux 自然退出证据；Workstream B 仍需 GitHub Actions 三 job 全绿才可改为 PASS。

### Status

`PARTIAL`

## Workstream C：E2E 与 Minified Release

- 当前状态：`BLOCKED`
- 基线缺失条件：未发现 `adb`、Maestro，Release 签名环境变量未设置。
- 后续仍会完成全部不依赖这些条件的构建和自动化建设，并重新探测可用 Android/WSL 环境。

## Workstream D：真实故障注入

- 当前状态：`PARTIAL`
- 尚未施工。真实 kill/OOM/后台切换等设备场景当前受 `adb` 缺失阻塞；可自动化的测试构建注入将按 Spec 建设并执行。

## Workstream E：文档与发布收口

- 当前状态：`PARTIAL`
- 本文档已建立并将随每个任务持续更新。
