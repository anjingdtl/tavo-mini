# Tavo Mini V2.11.34 阻滞问题矩阵复查与修复实施方案

> 适用对象：本地代码 Agent / Codex / 开发负责人 / 测试负责人  
> 适用仓库：`anjingdtl/tavo-mini`  
> 建议目标版本：`V2.11.34`  
> 核心原则：**先复查本地代码与真机证据，再修复；只修复被证实的问题；控制边界，禁止无关扩散。**

---

## 1. 文档目的

本方案用于修复当前 Release APK 真机测试暴露出的阻滞问题，重点覆盖：

1. 升级安装后启动阶段白屏、长时间无反馈；
2. 数据库迁移、Schema 漂移检查与用户数据安全验证不足；
3. 旧版本升级存在潜在重复迁移入口；
4. 普通启动链路执行可修改用户数据的笔记拆分；
5. 批量写章入口不可见且无用户可操作开关；
6. 备份中心进入后明显卡顿；
7. Schema Recovery、备份扫描和大文件校验阻塞首屏；
8. 数据库初始化失败后仍进入主界面，可能造成“资料丢失”误判。

本方案不要求 Agent 直接相信历史审计结论。Agent 必须以本地仓库、当前分支、真实数据库样本、真机日志和可重复测试为依据，重新判断问题是否存在。

---

## 2. 强制执行原则

### 2.1 本地代码是唯一事实来源

开始前必须记录：

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -10 --oneline
git remote -v
```

若工作区存在未提交改动：

- 不得覆盖；
- 不得执行 `git reset --hard`；
- 不得自动删除未知文件；
- 必须在报告中列出；
- 修复仅修改本方案明确涉及的文件。

### 2.2 先验真，后修复

每个问题必须至少具备两项证据：

- 真机复现步骤；
- Logcat / JS 日志；
- 本地代码调用链；
- SQLite 状态或文件系统状态；
- 稳定失败的自动化测试；
- 升级前后数据指纹差异；
- 性能采样结果。

不允许仅因代码注释写了“已修复”就判定问题不存在。

### 2.3 控制修复边界

禁止：

- 顺便重构整个数据库层；
- 顺便重写导航或主题系统；
- 顺便升级 React Native、SQLite 或 RNFS；
- 用固定延时掩盖竞态；
- 用空 `catch` 隐藏失败；
- 为通过测试修改断言而不修生产路径；
- 将启动问题改成“后台静默继续”而缺少数据安全保护。

### 2.4 修复顺序

必须按以下顺序：

1. 数据安全；
2. 启动状态与迁移唯一入口；
3. 启动动态进度 UI；
4. 备份中心性能；
5. Feature Flag 与入口；
6. 真机升级回归；
7. 发版门禁。

---

## 3. 问题矩阵

| ID | 级别 | 模块 | 风险描述 | 初始判断 |
|---|---:|---|---|---|
| RB-13 | P0 | 启动 UI | Splash 固定时间隐藏，但初始化未完成时无内容渲染，形成白屏 | 必须复查 |
| RB-14 | P0 | 数据安全 | 升级前后只比较行数或 ID，无法证明正文、人物、世界书、笔记内容未丢失 | 必须复查 |
| RB-15 | P0 | 迁移 | `initializeDatabase` 已执行迁移，旧 Schema 仍可能进入升级确认并再次迁移 | 必须复查 |
| RB-16 | P1 | 启动/笔记 | 普通启动执行 `repairOversizedNotes`，可能修改用户数据并产生崩溃窗口 | 必须复查 |
| RB-17 | P1 | Feature Flag | 批量写章默认关闭，设置页无入口，Release 包用户不可见 | 已有真机证据，仍需本地确认 |
| RB-18 | P1 | 备份中心 | 列表页完整读取并 `JSON.parse` 所有备份文件 | 已有真机证据，仍需性能确认 |
| RB-19 | P1 | Schema Recovery | 创建、校验、复制全量备份全部阻塞首屏 | 必须量化 |
| RB-20 | P1 | 错误呈现 | 初始化失败后仍进入主界面，用户可能误以为项目和资料丢失 | 必须复查 |
| RB-21 | P1 | 启动性能 | 每次启动均执行全量 Schema 校验、数据召回快照或重型维护任务 | Agent 扩展检查 |
| RB-22 | P1 | 备份索引 | 备份列表没有轻量元数据索引，旧备份越多越慢 | Agent 扩展检查 |
| RB-23 | P2 | 可观测性 | 启动过程无阶段、耗时、失败码和恢复建议 | 必须补齐 |

---

## 4. Phase 0：基线、样本与保护措施

### 4.1 建立测试数据矩阵

至少准备四类数据库：

| 样本 | 来源 | 用途 |
|---|---|---|
| A | 全新安装空库 | 验证首装 |
| B | V2.11.24 升级前真实或脱敏库 | 复现历史白屏/漂移风险 |
| C | V2.11.32 大型用户库 | 验证相邻升级 |
| D | 人工构造漂移库 | 缺列、缺索引、版本号与物理结构不一致 |

大型库至少包含：

- 20 个项目；
- 500 个章节；
- 大体量章节正文；
- 人物卡与世界书；
- 大笔记；
- 5～15 个历史备份；
- Pipeline 任务及内容修订记录。

### 4.2 升级前强制保存原始证据

升级前保存：

```bash
adb shell run-as <package> cp databases/shine_writer.db files/pre-upgrade.db
adb logcat -c
```

同时导出：

- 数据库文件大小；
- `PRAGMA user_version`；
- `settings.schema_version`；
- 表清单；
- 每张关键表行数；
- 关键用户内容指纹；
- 备份目录文件清单及大小。

禁止只通过 UI 查看项目数量来判断是否安全。

### 4.3 记录性能基线

记录以下时间点：

```text
T0：进程启动
T1：JS Bundle 可执行
T2：SQLite 打开
T3：安装类型识别完成
T4：漂移扫描完成
T5：迁移前备份完成
T6：迁移完成
T7：Schema 校验完成
T8：用户数据校验完成
T9：导航界面可操作
```

输出：

- 总启动时长；
- 每阶段耗时；
- 主线程最长卡顿；
- 峰值内存；
- 备份文件数量与总大小；
- 是否发生 GC 抖动或 ANR。

---

## 5. Phase 1：先写验真测试，不修改生产代码

### 5.1 RB-13 启动白屏验真

检查：

- Splash 是否在 `init()` 完成前固定隐藏；
- `showSplash=false && ready=false` 时渲染什么；
- `UpgradeScreen` 不可见且 `NavigationContainer` 不渲染时是否为空白；
- 数据库初始化超过 1.2 秒时是否稳定白屏。

新增测试：

```text
1. init 延迟 5 秒；
2. Splash 至少保持到 init 完成；
3. 或显示明确的启动加载界面；
4. 任意时刻不得渲染空白根节点；
5. 初始化失败显示恢复页，不进入普通项目列表。
```

真机验证：

```bash
adb shell am force-stop <package>
adb shell monkey -p <package> 1
adb shell screenrecord /sdcard/startup.mp4
```

### 5.2 RB-14 用户数据内容完整性验真

现有召回快照不能只比较 ID。

新增内容指纹测试，至少覆盖：

- `projects`: `id + name + mode`
- `chapters`: `id + project_id + position + title + synopsis + content + summary_json`
- `characters`: 关键文本字段
- `worldbook_entries`: 标题、内容、集合归属
- `notes`: 标题、正文、集合归属
- `project_resources`
- `project_collection_settings`

推荐指纹：

```text
table name
+ ordered primary key
+ normalized field values
+ per-row SHA-256
+ table aggregate SHA-256
```

要求：

- 读取失败必须抛错；
- 不得用空数组代替失败；
- before/after 任一关键表无法读取，升级必须停止；
- 项目和章节不能只做 count guard。

### 5.3 RB-15 双重迁移验真

建立调用计数测试：

```text
openDatabase()
→ initializeDatabase()
→ runMigrations() 调用次数必须为 0 或 1
```

模拟旧 Schema，验证：

- 初始化已迁移后不再显示需要再次迁移的确认页；
- `handleUpgradeConfirm` 不得基于旧的 `lastInstallInfo.schemaVersion` 再跑一次；
- 每个 migration step 只能执行一次；
- Schema 版本写入与迁移事务一致。

### 5.4 RB-16 启动笔记改写验真

构造大笔记：

```text
启动前记录原 note id/content/resource links
→ 启动应用
→ 检查是否自动拆分或删除原 note
```

测试要求：

- 普通启动不应修改用户正文型数据；
- 维护任务应独立、可确认、可取消、可回滚；
- 任一拆分操作必须全事务；
- 失败不得留下新笔记、空合集或重复链接。

### 5.5 RB-18 备份中心性能验真

准备 10 个 20MB～100MB 备份文件。

检测进入备份中心时：

- `RNFS.readFile` 调用次数；
- `JSON.parse` 调用次数；
- 首屏时间；
- 主线程阻塞；
- 峰值内存。

门禁目标：

```text
进入备份中心时，不读取任何完整备份正文。
列表首屏 P95 < 500ms。
```

### 5.6 RB-17 Feature Flag 验真

检查：

- 默认值；
- 新装与升级后的 setting 值；
- 设置页是否有开关；
- 候选测试包是否自动打开；
- 正式包是否明确保持关闭；
- Flag 读取失败时 UI 是否静默隐藏。

---

## 6. Phase 2：最小修复设计

## 6.1 启动状态机重构

不要继续使用两个松散布尔值表达启动状态。引入明确状态：

```ts
type StartupPhase =
  | 'splash'
  | 'opening_database'
  | 'checking_schema'
  | 'backing_up'
  | 'migrating'
  | 'verifying_data'
  | 'loading_settings'
  | 'recovering_tasks'
  | 'ready'
  | 'failed';
```

同时维护：

```ts
interface StartupProgress {
  phase: StartupPhase;
  percent: number;
  message: string;
  detail?: string;
  recoverable?: boolean;
}
```

### 6.1.1 系统载入动态进度条

进度条必须反映真实阶段，不得只做循环动画。

推荐权重：

| 阶段 | 进度 |
|---|---:|
| 启动运行环境 | 0～5% |
| 打开数据库 | 5～12% |
| 检测版本与结构 | 12～22% |
| 创建升级安全备份 | 22～45% |
| 执行数据库迁移 | 45～65% |
| 校验表结构 | 65～75% |
| 校验用户资料 | 75～90% |
| 加载设置和任务 | 90～98% |
| 进入工作台 | 100% |

UI 文案示例：

```text
正在载入本地工作台
正在检查本地资料结构
正在创建升级安全备份
正在升级数据库，请勿关闭应用
正在核对项目与正文完整性
正在恢复未完成任务
```

要求：

- Splash 最短显示时间可以保留；
- Splash 只能在 `ready` 后隐藏；
- 初始化未结束时显示动态进度界面；
- 超过 8 秒显示当前阶段和“请勿强制关闭”；
- 超过 30 秒增加诊断信息；
- 失败显示错误码、备份路径和下一步操作；
- 不得显示空白页面。

### 6.1.2 进度来源

进度必须由服务层回调产生：

```ts
initializeDatabase(database, onProgress)
createSchemaRecoveryBackup(database, kind, onProgress)
runMigrations(database, fromVersion, options)
captureUserDataSnapshot(database, onProgress)
```

不得由 UI 使用随机定时器伪造。

---

## 6.2 迁移唯一入口

推荐由 `initializeDatabase()` 统一负责：

- 检测；
- 备份；
- 迁移；
- 校验；
- 完成状态写入。

UI 只展示进度，不再次执行迁移。

删除或禁用：

```text
UpgradeScreen.onConfirm → runMigrations(...)
```

如仍保留升级确认，确认必须发生在迁移前，由初始化状态机暂停等待用户决定，而不是迁移后再确认。

门禁：

- 同一次进程启动中 `runMigrations` 最多调用一次；
- 同一 Schema step 最多执行一次；
- 测试记录所有迁移调用顺序；
- 升级完成后重新读取当前 Schema，不使用初始化前缓存。

---

## 6.3 数据完整性指纹

新增不可变快照：

```ts
interface UserContentFingerprint {
  schemaVersion: number;
  tables: Record<string, {
    rowCount: number;
    digest: string;
  }>;
}
```

关键要求：

- 使用稳定排序；
- 对文本按原值哈希，不得截断正文；
- `null`、空字符串和缺失字段必须区分；
- 只读；
- before 快照失败则禁止迁移；
- after 快照失败则禁止进入主界面；
- mismatch 时保留原库和迁移前备份；
- 不得自动清空或重新创建关键表。

---

## 6.4 移除启动期用户数据改写

从启动主链路移除：

```ts
repairOversizedNotes(database)
```

改为独立维护任务：

```text
设置 → 数据维护 → 优化超大笔记
```

执行前：

1. 展示预计影响条数；
2. 创建安全备份；
3. 生成迁移计划；
4. 单事务执行；
5. 校验正文哈希；
6. 提供恢复入口。

若短期不实现完整维护 UI，V2.11.34 应先停止自动拆分，而不是继续在启动时静默修改。

---

## 6.5 Schema Recovery 性能优化

避免当前重复工作：

```text
createBackup
→ cleanupOldBackups
→ listBackups 全量读取
→ readAndValidateBackup 再次全量读取
→ copyFile
```

修复方向：

1. Schema Recovery 使用专用写入函数；
2. 不触发普通备份目录清理；
3. 写入时同步生成 checksum 和 row counts；
4. 原子完成后直接返回已验证元数据；
5. 不再完整重读同一个文件；
6. 优先直接写目标目录；
7. 数据安全标准不得下降。

禁止为了提速取消迁移前备份。

---

## 6.6 备份中心轻量索引

新增 sidecar：

```text
backup_xxx.json
backup_xxx.meta.json
```

元数据结构：

```json
{
  "formatVersion": 1,
  "backupPath": "...",
  "kind": "manual",
  "appVersion": "2.11.34",
  "schemaVersion": 42,
  "createdAt": "...",
  "size": 123456,
  "checksum": "...",
  "validationState": "created"
}
```

列表加载规则：

1. 只读目录；
2. 只读 `.meta.json`；
3. 无 sidecar 的旧备份先用文件名、mtime、size 立即展示；
4. 后台逐个补索引；
5. 不阻塞首屏；
6. 完整校验仅在“验证”或“恢复”时执行。

兼容性要求：

- 不改变原备份格式；
- 旧备份仍可恢复；
- sidecar 损坏不影响备份本体；
- 删除备份时同时删除 sidecar；
- cleanup 不能解析完整正文。

---

## 6.7 批量写章入口策略

由于 AI 写 N 章仍有独立 P0/P1 问题，本方案只负责入口可控，不负责状态机修复。

设置页新增：

```text
实验功能
- AI 写 N 章
- 弹性上下文预算
```

构建策略：

| 构建类型 | 默认值 |
|---|---|
| 开发调试包 | 开启或可见开关 |
| 真机验收包 | 默认开启，带“实验功能”标识 |
| 正式生产包 | 状态机验收前默认关闭 |
| 正式开放后 | 默认开启，可紧急关闭 |

要求：

- Flag 读取失败时显示诊断，不要静默隐藏；
- 新旧项目行为一致；
- 入口显示有 UI 测试；
- 升级后 Flag 不被意外重置。

---

## 6.8 初始化失败安全页面

数据库初始化失败时不得进入普通工作台。

应显示：

```text
本地资料暂时无法载入
错误码：SCHEMA_VALIDATION_FAILED
原数据库未删除
安全备份路径：...
操作：
- 重试
- 导出诊断
- 打开备份中心只读模式
- 退出应用
```

禁止：

- 展示空项目列表；
- 自动创建新空库覆盖旧库；
- 提示“暂无项目”；
- 静默继续。

---

## 7. Phase 3：自动化测试要求

### 7.1 启动状态测试

覆盖：

- 新装；
- 同版本启动；
- 普通升级；
- 漂移修复；
- 大数据库；
- 初始化失败；
- 备份失败；
- 数据指纹不一致；
- 进程中断后重启。

断言：

- 永不白屏；
- 进度单调不回退；
- 100% 后才进入主界面；
- 失败不会进入普通工作台；
- Migration 只执行一次。

### 7.2 数据安全测试

```text
升级前生成 digest
→ 升级
→ 升级后生成 digest
→ 完全一致
```

允许变更的 Schema 元数据必须单独白名单，不允许宽泛忽略。

### 7.3 备份中心测试

- 100 个元数据文件加载；
- 10 个 100MB 备份本体存在；
- 进入页面不调用完整 `readFile`；
- 首屏可交互；
- 后台索引失败不影响列表；
- 删除和恢复兼容旧备份。

### 7.4 大笔记测试

- 启动不修改；
- 用户触发维护后完整事务；
- 崩溃注入点逐项回滚；
- 原正文哈希与拆分后拼接哈希一致。

---

## 8. Phase 4：真机升级验收矩阵

至少两台设备：

- 中低端 Android；
- 高性能 Android；
- Android 版本至少覆盖 12 和 14/15。

| 编号 | 场景 |
|---|---|
| U01 | V2.11.24 → V2.11.34 |
| U02 | V2.11.32 → V2.11.34 |
| U03 | V2.11.33 → V2.11.34 |
| U04 | 带已知 Schema 漂移库升级 |
| U05 | 10 个大备份存在时升级 |
| U06 | 大笔记存在时升级 |
| U07 | 升级中切后台 |
| U08 | 升级中锁屏 |
| U09 | 升级前备份阶段磁盘不足 |
| U10 | 数据指纹不一致时阻断进入 |

每次记录：

- 全程录屏；
- Logcat；
- 阶段耗时；
- 升级前后 DB；
- 指纹报告；
- 内存峰值；
- 是否白屏；
- 是否出现空项目或资料。

---

## 9. 修复提交边界

建议拆分：

```text
fix(startup): keep startup UI visible and add real progress state
fix(database): enforce single migration owner
fix(database): strengthen user-content fingerprint verification
fix(notes): remove destructive note maintenance from startup
perf(backup): add lightweight backup metadata index
fix(backup): avoid full-file parsing on backup list
feat(settings): add guarded experimental feature switches
test(release): add upgrade and startup regression matrix
chore: bump V2.11.34
```

每个提交必须：

- 单一目的；
- 有对应测试；
- 不夹带全仓格式化；
- 不改无关模块；
- 可独立回滚。

---

## 10. 发版门禁

- [ ] 启动过程任意时刻有可见 UI；
- [ ] 动态进度条由真实阶段驱动；
- [ ] 迁移入口唯一；
- [ ] 关键用户内容指纹升级前后完全一致；
- [ ] 初始化查询失败不会被当作空数据；
- [ ] 启动不再自动拆分用户笔记；
- [ ] 备份中心不完整读取全部备份；
- [ ] 旧备份兼容恢复；
- [ ] 初始化失败进入安全页面；
- [ ] 三个历史版本升级真机通过；
- [ ] Release APK 签名、安装、覆盖升级通过；
- [ ] CI 结果可核验；
- [ ] 版本提升至 V2.11.34 或更高。

---

## 11. Agent 最终输出格式

Agent 必须生成：

```text
docs/release-audit/V2.11.34-startup-database-backup-audit.md
```

报告包含：

1. 本地基线；
2. 每个 RB 问题是否复现；
3. 证据；
4. 根因；
5. 修改文件；
6. 新增测试；
7. 测试命令及真实结果；
8. 真机结果；
9. 升级前后数据指纹；
10. 未解决问题；
11. 最终发版结论。

最终结论只能是：

```text
A. 允许发版
B. 仅允许内部验收，禁止公开分发
C. 禁止发版
```

不得使用“基本可用”“大概率安全”等模糊结论。

---

## 12. Agent 执行总指令

```text
以当前本地仓库为唯一事实来源，不要直接相信历史审计文档、提交说明或测试注释。

先完成：
1. 记录 Git 基线和未提交改动；
2. 运行 lint、typecheck、version verify、完整测试；
3. 使用旧版本真实或脱敏数据库复现升级；
4. 按 RB-13～RB-23 逐项复查；
5. 对每个确认问题先新增稳定失败测试；
6. 只做最小修复；
7. 不修改无关模块，不进行全仓重构；
8. 不得覆盖用户未提交改动；
9. 每修一项执行定向测试；
10. 完成后执行完整回归和真机升级矩阵；
11. 输出数据指纹、性能结果和明确发版结论。
```
