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
- Release 签名环境变量：四项均未设置；未读取或输出任何密钥内容。
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

- https://github.com/anjingdtl/tavo-mini/actions/runs/29495667191（全绿）。

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

- https://github.com/anjingdtl/tavo-mini/actions/runs/29495667191（全绿）。

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
- 修复后 Run：https://github.com/anjingdtl/tavo-mini/actions/runs/29495667191
- Job：JavaScript validation 59s、Migration matrix 28s、Android Debug build 9m27s，均为 success。

### Device and APK

- 不适用。

### Remaining risk

- Actions 使用的部分第三方 action 报 Node 20 runtime 将被强制切换到 Node 24 的平台 warning；不影响本次 job 结果，后续应升级 action major 版本。

### Status

`PASS`

## Workstream C：E2E 与 Minified Release

### Root cause / construction

- 初始 PATH 未暴露 `adb` 与 Maestro，但 Android SDK 实际位于 `C:\Users\Administrator\AppData\Local\Android\Sdk`；本轮安装 Maestro 2.6.1，并创建专用 AVD `ShineWriter_RC_API37`。
- 原 Maestro 脚本与当前 UI 有五处漂移：API 37 兼容提示、资源合集返回路径、Android Alert 的 `OK`、LLM 表单键盘遮挡、流水线取消依赖不确定网络。逐项红跑后用最小脚本调整修复。
- 双模拟器连接时 Maestro 默认选择 `emulator-5554`。发现后未沿用该设备归属结论，最终所有发布证据均显式 `--device emulator-5556` 重跑。

### Code changes / tests

- 调整 `e2e/maestro/01` 至 `06`；新增 `scripts/testing/hanging-http-server.js`，仅提供本地永不响应的假服务，不包含真实凭据。
- 独立提交：`49c5da0`、`6efd968`、`b814319`、`5802988`、`95a5184`。

### Commands and results

- `npm run apk:debug`：PASS，1m08s。
- 最终 Debug APK：`dist/apk/debug/ShineWriter-V2.4.3-debug.apk`，53,819,532 bytes，SHA-256 `1A4C284C2D729F2A7E30B757A8B428F823FEE7BA5891E909F378DA37E8E11FEF`。
- 干净安装/首启：PASS，`emulator-5556`，`sdk_gphone16k_x86_64`，Android 17 / API 37，x86_64。
- 最终 APK 覆盖安装后 Maestro 2.6.1（显式 `--device emulator-5556`）：6/6 PASS，4m24s；01 9s、02 48s、03 1m05s、04 51s、05 1m02s、06 29s。JUnit：`docs/optimization/evidence/maestro-debug/final-artifact-emulator-5556/01-06-junit.xml`。
- `npm run apk:release`：BLOCKED，四项 `SHINE_WRITER_RELEASE_*` 环境变量均未设置，构建在读取凭据内容前 fail fast，退出码 1。
- `npm run apk:release:minified`：同因 BLOCKED，退出码 1。
- 未把 Debug 结果描述为签名 Release/Minified 通过。

### Device / APK evidence

- API 37 首启出现 Android 原生 16KB page-size 兼容提示；至少 `libsqliteJni.so` 的 RELRO alignment 不兼容，应用以 compatibility mode 可运行。这是 RC 风险，不在本轮无关功能范围内扩修。
- 无 ARM64 物理设备、真实在线模型凭据或可控 GGUF；在线成功生成、本地 GGUF 导入/加载/生成、ARM64 性能均未验收。

### Status

`PARTIAL`：Debug 与模拟器 E2E PASS；Signed Release、Minified Release、物理设备与真实模型验收 BLOCKED。

## Workstream D：真实故障注入

### Root cause / code changes

- 原 `faultInjectionMatrix.test.ts` 只写入期望状态，未调用生产恢复路径，因此不能作为故障执行证据。
- 新增 `src/testing/faultInjection.ts`：仅 `NODE_ENV=test` 读取 SQL statement 注入变量；Release 默认恒定关闭、远程输入不可开启、测试自动 teardown。
- migration 与 restore 的生产 transaction executor 接入独立 fault domain。
- 发现备份直接写正式文件，ENOSPC 可留下损坏 JSON；改为 `.tmp` staging 后 `moveFile` 原子发布，失败 best-effort 清理并保留原错误。
- 新增 `e2e/fault-injection` 中 D6/D11/D12 设备流程。

### Tests / commands / results

- 专项：`databaseTransaction`、`migrationAtomicity`、`backupService` 3 suites / 28 tests PASS；全量 82 suites / 401 tests PASS。
- D1 PASS：第三条 migration SQL 注入后 rollback，schema version 与列集合不变。
- D2 PASS：restore statement 3 失败后原库快照不变，pre-restore backup 存在。
- D3 PASS：ENOSPC staging 清理、未发布 final backup。
- D4 PASS：损坏 JSON/结构在 transaction 前拒绝。
- D5 PASS：正文篡改+旧 SHA-256 在恢复前拒绝。
- D6 PASS：ADB 输入完成后 60ms force-stop；最近提交正文恢复，防抖窗口内容允许丢失，无卡死/损坏。
- D7 BLOCKED：无旧 Schema pause test APK；D1 不冒充 kill。
- D8 BLOCKED：无 restore pause test APK；D2 不冒充 kill。
- D9 BLOCKED：无可控 GGUF 测试资产与导入窗口。
- D10 BLOCKED：无可控模型/native OOM injector。
- D11 PASS：hanging server 中断后显示 `Network request failed`，流水线异常终止、0 tokens、无永久运行。
- D12 PARTIAL：原生 `onStart` 后 38ms 切后台时 FGS 为 foreground，275ms 回前台画面显示“停止”；模拟器系统 TTS 随后报 `-7`，未取得同 session 手动停止证据。

### Commits / evidence / risk

- `3cbc59c` — `fix(backup): publish backup files atomically`
- `6009165` — `test(reliability): inject migration and restore transaction failures`
- `6a2535c` — `test(reliability): automate device fault injection scenarios`
- 逐项字段、命令和证据路径见 `docs/FAULT_INJECTION_MATRIX.md`。
- 当前状态：`PARTIAL`。12 项中 7 PASS、1 PARTIAL、4 BLOCKED。

## Workstream E：文档与发布收口

- 更新 `docs/FAULT_INJECTION_MATRIX.md` 与 `docs/RELEASE_CHECKLIST.md`，空缺发布字段明确写 `BLOCKED`，不伪造 signer、Release URL 或 rollback artifact。
- Draft PR：https://github.com/anjingdtl/tavo-mini/pull/1
- CI：https://github.com/anjingdtl/tavo-mini/actions/runs/29495667191（当前已推送 A/B 范围全绿；C/D/E 提交推送后需再取最终 Run）。
- 未创建 `V2.4.4-rc.1`：签名 Release、Minified Release、D7-D10、D12 完整验收和 ARM64 物理设备仍缺证据。
- 最终本地门禁：`npm ci` PASS（npm audit 报 3 个 moderate dependency vulnerabilities）；lint PASS（4 warnings/0 errors）；typecheck PASS；test:ci 82 suites/401 tests PASS；coverage 78.33% statements / 60.37% branches / 86.05% functions / 79.95% lines；migration 7 suites/37 tests PASS；detectOpenHandles 82 suites/401 tests 自然退出，无 open handle 报告；最终 Debug APK 重建及 6/6 设备回归 PASS。
- 安全扫描：签名相关命中均为环境变量名称/文档/Gradle 读取；API key/Bearer/password 命中为生产字段、明显假测试值或 vendored llama.cpp 示例，未发现真实凭据；`src`、`android`、`__tests__` 无 `transaction(async`。备份测试继续证明凭据不写入 JSON。
- 当前状态：`PARTIAL`，不建议发布 RC。
