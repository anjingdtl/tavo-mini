# 故障注入验证矩阵

执行环境：Android x86_64 模拟器（API 37），Debug 测试构建。

本报告区分真实执行、测试 wrapper 注入和合同测试。`__tests__/faultInjectionMatrix.test.ts` 仍只代表恢复合同，未计入下表的真实执行结论。

| # | 场景 | 注入方式 | 实际结果 | 状态 |
| --- | --- | --- | --- | --- |
| D1 | Migration 第三条 SQL 失败 | Jest 环境 `FAIL_MIGRATION_AT_STATEMENT=3`，实际进入 migration statement batch | transaction 回滚，`schema_version=12`，列集合不变，可重试 | PASS |
| D2 | 恢复中途失败 | Jest 环境 `FAIL_RESTORE_AT_STATEMENT=3`，实际进入 restore statement batch | 原数据库快照不变，pre-restore backup 已原子发布，无半恢复 | PASS |
| D3 | 磁盘空间不足 | RNFS wrapper 在 staging write 抛真实 `ENOSPC` | final backup 未发布，`.tmp` 被清理，错误向上抛出 | PASS |
| D4 | 备份文件损坏 | 向实际 `validateBackup` 输入损坏 JSON / 错误结构 | 恢复 transaction 未打开，原库不变，可换备份 | PASS |
| D5 | Checksum 错误 | 修改 v3 正文、保留旧 SHA-256 | 恢复前拒绝，错误包含 SHA-256，原库不变 | PASS |
| D6 | 自动保存时杀死 App | 正文输入完成后 60ms 执行 `adb shell am force-stop` | 最近提交正文存在，防抖窗口内容未写入，重启无卡死，DB 可打开且 journal 为 0 字节 | PASS |
| D7 | Migration 时杀死 App | 需要带迁移暂停点的旧 Schema 测试 APK | 仅完成 D1 transaction rollback；未把它冒充进程杀死 | BLOCKED |
| D8 | 恢复时杀死 App | 需要带恢复暂停点的测试 APK | 仅完成 D2 statement failure；未把它冒充进程杀死 | BLOCKED |
| D9 | GGUF 导入时杀死 App | 需要可导入的 GGUF 与复制中暂停窗口 | 当前无可控 GGUF 测试资产，未执行 | BLOCKED |
| D10 | 本地模型生成时 OOM | 需要可控模型或 native OOM injector | 当前无可控测试模型/native injector，未执行 | BLOCKED |
| D11 | 在线模型中途断网 | 本地 hanging HTTP server 接单后终止进程 | 用户看到“流水线失败 / Network request failed”，结果为“异常终止 / 初稿失败”，0 tokens，无永久运行状态 | PASS |
| D12 | TTS 播放时切后台 | 监听原生 `onStart`，38ms 后 HOME，275ms 内回前台 | 后台时 FGS `isForeground=true`，画面仍显示“停止”；模拟器语音引擎随后报 `-7`，未完成同一 session 的前台停止验收 | PARTIAL |

## D1：Migration 第三条 SQL 失败

- Build: Jest / Node 24.14.1，仅 `NODE_ENV=test` 可启用。
- Commit: `6009165`。
- Device: Windows 本地测试进程。
- Injection method: `FAIL_MIGRATION_AT_STATEMENT=3`；Release 无入口，远程输入不可开启，`afterEach` 自动 teardown。
- Expected result: 回滚、版本不前进、原数据存在、可重试。
- Actual result: 第三条语句抛出 `FAULT_INJECTION`，`schema_version` 保持 12，`local_llm_models` 原列集合不变。
- User-visible message: 启动层会把 migration rejection 包装为既有中文数据库启动错误；本轮未在设备旧库上重复展示。
- Database state: old schema。
- Retry result: 清除环境变量后专项与全量 migration 测试通过。
- Orphan files: 无。
- Stuck tasks: 无。
- Logcat / screenshots: 不适用；Jest 输出记录在进度文档。
- Status: PASS。

## D2：恢复中途失败

- Build: Jest / Node 24.14.1，仅测试环境可用。
- Commit: `6009165`。
- Device: Windows 本地测试进程。
- Injection method: `FAIL_RESTORE_AT_STATEMENT=3`。
- Expected result: 原库不变、pre-restore backup 存在、无半恢复、可换备份。
- Actual result: statement 3 抛错，transaction double 执行 rollback，前后数据库快照相等；pre-restore `.tmp` 已 move 为正式 JSON。
- User-visible message: 既有恢复错误通路保留原错误并允许重新选择备份。
- Database state: unchanged。
- Retry result: teardown 后恢复专项通过。
- Orphan files: 无。
- Stuck tasks: 无。
- Logcat / screenshots: 不适用；Jest 输出记录在进度文档。
- Status: PASS。

## D3：磁盘空间不足

- Build: Jest / RNFS wrapper（Spec 允许方式）。
- Commit: `3cbc59c`。
- Device: Windows 本地测试进程。
- Injection method: staging write 抛带 `code=ENOSPC` 的实际异常对象。
- Expected result: 不生成损坏备份、临时文件清理、数据库保持最后提交状态、错误不吞掉。
- Actual result: `moveFile` 未调用，`.json.tmp` 被 unlink，原始 ENOSPC rejection 原样传播。
- User-visible message: 上层收到存储错误，可提示清理空间重试。
- Database state: last commit。
- Retry result: 恢复 FS wrapper 后备份专项通过。
- Orphan files: 无。
- Stuck tasks: 无。
- Logcat / screenshots: 不适用。
- Status: PASS。

## D4 / D5：损坏备份与 Checksum 错误

- Build: Jest 调用生产 `validateBackup` / `restoreFromBackup`。
- Commit: 基线实现；本轮由 `3cbc59c` 回归覆盖。
- Device: Windows 本地测试进程。
- Injection method: 非法 JSON/结构；正文篡改并保留旧 SHA-256。
- Expected result: 恢复前拒绝，原库不变。
- Actual result: validation invalid；错误分别包含解析/结构原因和 SHA-256；restore transaction 未开启。
- User-visible message: “备份验证失败”并保留详细原因。
- Database state: unchanged。
- Retry result: 可信备份仍可验证和恢复。
- Orphan files / stuck tasks: 无 / 无。
- Logcat / screenshots: 不适用。
- Status: PASS / PASS。

## D6：自动保存时杀死 App

- Build: Debug APK，SHA-256 `（APK SHA-256 已记录）`。
- Commit: `6a2535c`（流程），`415883e` / `6262e52`（保存修复）。
- Device: `Android 模拟器`，Android 17 / API 37。
- Injection method: 已提交正文重新打开后聚焦输入框；ADB 输入 `D6_UNCOMMITTED_WINDOW`，输入完成后 60ms `force-stop`。
- Expected result: 最多丢失未提交防抖窗口，最近提交存在，无损坏/卡死。
- Actual result: `D6_LAST_COMMITTED_CONTENT` 存在，未提交串不存在，状态“已保存”；数据库，可打开，journal 0 bytes。
- User-visible message: 正常恢复编辑页，无错误弹窗。
- Database state: last commit。
- Retry result: 可继续编辑。
- Orphan files / stuck tasks: 无 / 无。
- Logcat：本地 test-logs/ 证据。
- Screenshots：本地 test-logs/ 证据。
- Status: PASS。

## D7 / D8 / D9 / D10：外部条件阻塞

- Build: 当前 Debug APK 未包含可远程开启的暂停/OOM 开关，符合 Release 默认关闭原则。
- Commit: 无伪造提交。
- Device: `Android 模拟器`。
- Injection method: 未执行进程杀死/OOM；D1/D2 合同与 transaction 注入不替代 D7/D8。
- Expected result: 见 Spec 8.2。
- Actual result: 缺少旧 Schema 设备夹具、restore pause test build、可控 GGUF 与 native OOM injector。
- User-visible message / Database state / Retry result: 未取得真实证据。
- Orphan files / stuck tasks: 未验证。
- 后续命令: 使用专用测试 APK 和固定 GGUF，分别在 pause 日志出现后执行 `adb -s <device> shell am force-stop com.shinewriter`；OOM 场景使用 native test injector 后检查任务终态和卸载。
- Status: BLOCKED / BLOCKED / BLOCKED / BLOCKED。

## D11：在线模型中途断网

- Build: Debug APK。
- Commit: `6a2535c`。
- Device: `Android 模拟器`，Android 17 / API 37。
- Injection method: 私网 HTTP 配置连接 `10.0.2.2:8000` 的 hanging server；任务进入运行态后终止 server 进程。
- Expected result: network error、正文不覆盖、可重试、无永久 loading。
- Actual result: 冷启动提示“流水线失败 / Network request failed”；结果页为“异常终止 · 0 tokens”“初稿 · 失败”，无“运行中”。
- User-visible message: `Network request failed`。
- Database state: 原正文未被生成结果覆盖。
- Retry result: 网络/服务恢复后可重新发起；本轮未使用真实在线凭据执行成功生成。
- Orphan files: 无。
- Stuck tasks: 无。
- Logcat：本地 test-logs/ 证据。
- Screenshots/UI：本地 test-logs/ 证据。
- Status: PASS。

## D12：TTS 播放时切后台

- Build: Debug APK。
- Commit: `6a2535c`。
- Device: `Android 模拟器`，Android 17 / API 37，默认系统 TTS。
- Injection method: 监听 `ShineWriterTts onStart`，38ms 后发送 HOME；抓取 service 后 275ms 内回前台。
- Expected result: 状态正确、停止可用、无重复 session、无泄漏 FGS。
- Actual result: 后台抓到 `TtsForegroundService isForeground=true` 与 ongoing notification；回前台画面仍显示“停止”。模拟器引擎随后在第二段报 `-7` 并自动回收服务，无法完成同一 session 的手动停止断言。
- User-visible message: 播放中显示“停止”；引擎失败走既有 TTS error 通路。
- Database state: unchanged。
- Retry result: 可重新点击朗读；同一模拟器仍会受语音数据限制。
- Orphan files: 无。
- Stuck tasks: 无。
- Logcat：本地 test-logs/ 证据。
- Screenshots：本地 test-logs/ 证据。
- Status: PARTIAL。
