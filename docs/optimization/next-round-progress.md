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

- 提交信息计划为 `fix(editor): propagate autosave failures to exit guards`；SHA 在提交完成后补录。

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

- 待实施。

#### Tests added

- 待先编写失败测试并记录复现。

#### Commands run

- 已检查 `ChapterEditorScreen.tsx` 清空流程及自动保存 Hook。

#### Results

- 已从调用顺序静态确认竞态窗口；动态失败测试待执行。

#### Commit

- 待提交。

#### CI Run URL

- 待记录。

#### Device and APK

- 待 Workstream C。

#### Remaining risk

- 必须保存最新正文后再创建版本快照；不得通过取消 pending autosave 规避竞态。

#### Status

`PARTIAL`

## Workstream B：Jest 与 GitHub Actions

### Root cause

- `package.json` 的 `test:ci` 与 `test:coverage` 均仍使用 `--forceExit`。
- `.github/workflows/verify.yml` 连续执行两次全量 Jest，且当前基线无法证明 Jest 自然退出。

### Code changes

- 待定位真实未释放资源后实施；不得仅删除参数或延长 timeout。

### Tests added

- 待定位后记录。

### Commands run

- 已核对 package scripts 和 Verify workflow。

### Results

- 基线状态与 Spec 描述一致，当前为 `PARTIAL`。

### Commit

- 待提交。

### CI Run URL

- 待推送后记录。

### Device and APK

- 不适用。

### Remaining risk

- Windows 本机只能作为一条证据；还需 WSL2 或 GitHub Actions 的 Linux 自然退出证据。

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
