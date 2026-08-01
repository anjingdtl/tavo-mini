# tavo-mini 续写模块：Android 模拟器自动测试与修复长程执行计划

> **适用仓库：** `anjingdtl/tavo-mini`  
> **基线分支：** `main`  
> **编写时基线提交：** `19d8679669495cc10a9076f5404645b7652372a7`  
> **应用：** ShineWriter / `com.shinewriter`  
> **重点范围：** 原著续写模式中的原著导入、原著章节解析、续写边界、Canon 分析、风格分析，以及中断恢复和失败清理  
> **执行对象：** 能读写代码、运行 Android 模拟器、使用 `adb`、分析日志与 SQLite 数据、提交 Git 变更的 coding agent

---

## 0. 任务目标

本计划用于让 agent 在真实 Android 模拟器上持续执行以下闭环：

1. 复现“原著导入”和“原著分析”链路中的真实问题；
2. 获取 UI、日志、数据库、进程和网络请求证据；
3. 定位根因，不以猜测代替证据；
4. 编写最小范围修复；
5. 增加能稳定复现该问题的自动化测试；
6. 在模拟器上重新执行完整用户流程；
7. 运行仓库全部静态检查和测试；
8. 将每个独立问题形成一个可审查提交；
9. 持续维护测试资产、缺陷台账和回归矩阵。

最终目标不是“跑通一次”，而是建立一个可以反复执行、可恢复、可审计的续写模块质量闭环，使后续改动不再反复破坏原著导入和 Canon 分析。

---

## 1. Agent 的强制工作原则

### 1.1 不允许跳过真实模拟器验证

单元测试、类型检查和代码阅读只能证明局部逻辑。以下问题必须在 Android 模拟器上验证：

- Android 文件选择器返回的 URI 和临时副本行为；
- `react-native-fs` 文件复制、清理和磁盘异常；
- 原生 `ContinuationTextImportModule` 的编码检测和分块解码；
- App 被强制停止、Activity 重建、进程被系统杀死后的恢复；
- SQLite 实际迁移、约束、事务和 `run-as` 导出结果；
- 前台服务、通知权限、进度更新和深链返回；
- OpenAI 兼容接口的超时、截断、限流和错误响应；
- React Native JS 线程卡顿、Android ANR、原生崩溃和内存压力。

### 1.2 一个缺陷一个闭环

每个缺陷必须按以下顺序处理：

```text
稳定复现
→ 保存证据
→ 写失败测试
→ 提出根因假设
→ 用额外证据验证假设
→ 最小修复
→ 定向测试通过
→ 模拟器原路径复测通过
→ 相关回归矩阵通过
→ npm run verify 通过
→ 独立提交
```

禁止将多个不相关问题塞进同一个提交。

### 1.3 不以“没有崩溃”作为成功标准

每个流程必须检查：

- 页面显示是否正确；
- Toast/Alert 是否能说明真实错误；
- 数据库状态是否满足不变量；
- 临时文件是否清理；
- 旧的 active source / active Canon 是否被错误替换；
- 任务是否可暂停、恢复、取消；
- 失败后是否存在孤儿 source、snapshot、run、batch 或 work item；
- 进度是否真实前进，而不是只显示动画；
- 重启 App 后状态是否与重启前一致。

### 1.4 不允许用清空应用数据掩盖恢复类缺陷

`pm clear com.shinewriter` 只能用于创建新的干净测试场景。  
测试中断恢复、迁移和已有项目兼容性时，必须保留应用数据。

### 1.5 不修改生产行为来迁就自动化

优先使用：

- 可访问性标签；
- UI tree；
- `adb`；
- 可注入的服务接口；
- debug-only 测试工具；
- 本地 OpenAI 兼容 mock 服务。

禁止在生产代码中加入无鉴权的隐藏入口、固定 API Key、绕过业务校验或只为测试关闭安全检查。

### 1.6 任何数据库结构修改都必须有迁移

若修复需要改表：

- 更新当前 schema；
- 增加从当前 `SCHEMA_VERSION` 到新版本的迁移；
- 更新 schema manifest；
- 增加旧版本 fixture 迁移测试；
- 在模拟器上验证“旧 APK 数据 → 新 APK 启动迁移 → 原项目仍可用”。

---

## 2. 当前仓库事实与重点链路

### 2.1 技术基线

当前项目使用：

- React Native 0.85.3；
- React 19.2.3；
- TypeScript；
- SQLite：`react-native-sqlite-storage`；
- 文件选择：`@react-native-documents/picker`；
- 本地文件：`react-native-fs`；
- 状态管理：Zustand；
- Android applicationId：`com.shinewriter`；
- 主 Activity：`com.shinewriter.MainActivity`；
- Node 要求：`>=24.3.0`；
- 仓库全量检查：`npm run verify`；
- Android Debug 构建：`npm run apk:debug` 或 Gradle `:app:installDebug`。

### 2.2 原著导入主链路

重点代码：

| 路径 | 职责 |
|---|---|
| `src/screens/continuation/ContinuationSourceChaptersScreen.tsx` | 文件选择、多选、编码确认、错误提示、进入单文件确认或多文件排序 |
| `src/screens/continuation/ContinuationSourceOrderingScreen.tsx` | 多文件采样、LLM/文件名排序、用户调整和确认 |
| `src/services/continuation/continuationOrderingService.ts` | 多文件顺序推断及回退 |
| `src/services/continuation/continuationImportService.ts` | 私有副本、staging source、import job、流式解码、标准化、分章、校验、确认、恢复、取消 |
| `src/services/continuation/continuationParser.ts` | 流式章节识别 |
| `src/services/continuation/continuationNormalizer.ts` | 文本标准化 |
| `src/services/continuation/continuationSourceRepository.ts` | source/chunk/chapter 数据写入与读取 |
| `src/native/ContinuationTextImportModule*` | 文件元数据、编码检测和分块解码 |
| `src/services/continuation/errorMessaging.ts` | 导入错误到用户文案的映射 |

核心数据库对象：

- `continuation_sources`
- `continuation_source_text_chunks`
- `continuation_source_chapters`
- `continuation_import_jobs`
- `continuation_settings`

关键语义：

- 新导入在确认前只能是 staging / needs_review；
- 导入过程中不能改变 active source；
- 多文件合并为一个虚拟 source；
- `file_index` 仅记录来源，不参与全局 offset；
- 失败任务必须可解释、可清理或可恢复；
- chunks 的字符区间必须连续；
- source 激活必须是原子操作。

### 2.3 Canon 分析主链路

重点代码：

| 路径 | 职责 |
|---|---|
| `src/screens/continuation/canon/CanonAnalysisOverviewScreen.tsx` | 分析入口、预检、进度、暂停、恢复、取消、激活和风格状态 |
| `src/services/continuation/canon/canonAnalysisService.ts` | 建立 snapshot/run/batches/work items、调用 LLM、校验证据、发布结果 |
| `src/services/continuation/canon/adaptiveBatchPlanner.ts` | 根据模型配置计算输入预算、batch 和超大章节 chunk |
| `src/services/continuation/canon/canonRepository.ts` | 分析运行和 Canon 数据持久化 |
| `src/services/continuation/continuationSourceReader.ts` | 按边界读取原著章节和区间 |
| `src/services/continuation/styleProfile/styleAnalysisService.ts` | Canon 后续原著风格分析 |
| `src/services/continuation/canon/activateSnapshotAndStyleProfile.ts` | Canon 与风格画像联合激活 |
| `src/services/llm/*` | OpenAI 兼容请求、配置、超时和响应解析 |
| `src/native/PipelineForegroundModule*` | 前台通知、进度和任务深链 |

核心数据库对象：

- `canon_snapshots`
- `continuation_analysis_runs`
- `continuation_analysis_batches`
- `continuation_analysis_work_items`
- `canon_evidence`
- 各类 `canon_*` 事实表
- 原著风格画像相关表
- `continuation_settings`

关键语义：

- 分析运行绑定 source/version/hash/parser/normalization/boundary 快照；
- source 或边界变化后旧 run 必须变为 outdated；
- snapshot/run/batches/work items 初始化失败不能留下孤儿数据；
- 超大章节必须 chunk，不得静默跳过；
- work item 失败必须有可见原因；
- completed snapshot 只有在风格画像满足要求后才可联合激活；
- 失败、取消、过期的 snapshot 不得成为 active Canon。

---

## 3. 长程执行状态文件

为了让 agent 在多次上下文或多次执行中不丢失进度，第一步创建：

```text
.agent/continuation-qa-state.md
```

内容模板：

```markdown
# Continuation QA State

- Repository:
- Base commit:
- Current branch:
- Current commit:
- Emulator serial:
- Emulator API:
- App version:
- Current phase:
- Active test case:
- Last successful command:
- Last failure:
- Evidence directory:
- Open bug IDs:
- Next exact command:

## Completed
- [ ]

## Blocked
- [ ]

## Notes
```

每完成一个测试用例、发现一个缺陷、提交一个修复，都必须更新此文件。  
该文件默认不提交，除非维护者明确希望保留 agent 运行记录。

---

## 4. Git 与工作区策略

### 4.1 开始前

```bash
git status --short
git rev-parse HEAD
git branch --show-current
git log -1 --oneline
```

若工作区已有用户修改：

- 不覆盖；
- 不重置；
- 不自动 stash；
- 在状态文件中记录；
- 只修改本计划范围内文件。

### 4.2 工作分支

建议：

```bash
git switch -c agent/continuation-import-canon-emulator-qa
```

每个缺陷单独提交，例如：

```text
test(continuation): reproduce interrupted multi-file import cleanup
fix(continuation): preserve resumable job after process death
test(canon): reproduce orphan run after batch insertion failure
fix(canon): atomically initialize analysis run graph
```

### 4.3 禁止事项

- 禁止 `git reset --hard`；
- 禁止强推；
- 禁止修改 release signing 配置；
- 禁止提交 API Key、模型密钥、真实原著文本或用户数据库；
- 禁止把大体积 APK、日志、数据库快照直接提交进 Git；
- 禁止将失败测试删除或改成 skip 来获得绿灯。

---

## 5. 环境准备与基线验证

## Phase A：工具链与干净基线

### A1. 检查工具

```bash
node --version
npm --version
java -version
adb version
emulator -version
```

Node 必须满足仓库 `package.json` 的要求。

### A2. 安装依赖

```bash
npm ci
```

若 `npm ci` 失败：

1. 保存完整输出；
2. 判断是环境、锁文件、postinstall 补丁还是 Android 路径问题；
3. 不直接删除 `package-lock.json`；
4. 不改依赖版本，除非问题已被证明与依赖本身相关。

### A3. 执行仓库基线

```bash
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
npm run verify
```

保存到：

```text
artifacts/qa/<run-id>/baseline/
```

建议：

```bash
mkdir -p artifacts/qa/<run-id>/baseline
npm run verify 2>&1 | tee artifacts/qa/<run-id>/baseline/npm-verify.log
```

### A4. 构建并安装 Debug APK

优先：

```bash
npm run apk:debug
```

或：

```bash
cd android
./gradlew :app:installDebug --console=plain
cd ..
```

确认 package：

```bash
adb shell pm list packages | grep com.shinewriter
adb shell cmd package resolve-activity --brief com.shinewriter
```

启动：

```bash
adb shell am start -n com.shinewriter/.MainActivity
```

### A5. 退出条件

Phase A 完成必须满足：

- `npm ci` 成功；
- `npm run verify` 成功，或已记录与本任务无关的既有失败；
- Debug APK 安装成功；
- App 可启动；
- 无启动崩溃；
- 已记录基线 commit、APK version、模拟器 API 和 serial。

---

## 6. 模拟器矩阵

至少覆盖：

| 代号 | Android API | 目的 |
|---|---:|---|
| EMU-MIN | 24 | Android 7.0 最低支持版本 |
| EMU-MID | 29 或 30 | 存储访问与旧系统兼容性 |
| EMU-LATEST | 当前稳定 API | 通知权限、后台限制、最新 DocumentsUI |

资源有限时，先在 EMU-LATEST 开发和修复，再在 EMU-MIN 做发布前回归。

列出现有设备：

```bash
adb devices -l
emulator -list-avds
```

所有命令显式指定 serial：

```bash
export SERIAL=emulator-5554
adb -s "$SERIAL" devices
```

禁止在多设备连接时省略 `-s`。

---

## 7. 统一证据采集规范

每次测试创建目录：

```text
artifacts/qa/<run-id>/<test-case-id>/
```

至少包含：

```text
metadata.txt
steps.md
before.png
after.png
ui-before.xml
ui-after.xml
logcat.txt
crash-buffer.txt
db-before.sqlite
db-after.sqlite
db-queries.txt
result.md
```

### 7.1 元数据

```bash
{
  echo "date=$(date -Iseconds)"
  echo "commit=$(git rev-parse HEAD)"
  echo "branch=$(git branch --show-current)"
  echo "serial=$SERIAL"
  adb -s "$SERIAL" shell getprop ro.build.version.sdk
  adb -s "$SERIAL" shell dumpsys package com.shinewriter | grep -E 'versionName|versionCode'
} > metadata.txt
```

### 7.2 截图

```bash
adb -s "$SERIAL" exec-out screencap -p > before.png
```

### 7.3 UI tree

```bash
adb -s "$SERIAL" exec-out uiautomator dump /dev/tty > ui-before.xml
```

必须从 UI tree 节点 `bounds` 计算点击坐标。  
禁止凭截图肉眼猜固定坐标。

若节点不存在但页面有可滚动区域：

1. 滑动；
2. 重新 dump；
3. 再搜索至少一次；
4. 才能认定元素缺失。

### 7.4 日志

测试前：

```bash
adb -s "$SERIAL" logcat -c
```

测试后：

```bash
adb -s "$SERIAL" logcat -d > logcat.txt
adb -s "$SERIAL" logcat -b crash -d > crash-buffer.txt
```

额外检查：

```bash
grep -E "FATAL EXCEPTION|AndroidRuntime|ANR|ReactNativeJS|SQLite|Continuation|Canon|OutOfMemory" logcat.txt
```

### 7.5 导出 Debug 数据库

先发现数据库名，不要假设：

```bash
adb -s "$SERIAL" shell run-as com.shinewriter find databases -maxdepth 1 -type f -print
```

导出：

```bash
adb -s "$SERIAL" exec-out run-as com.shinewriter cat databases/<actual-db-name> > db-after.sqlite
```

若启用 WAL，同时导出：

```bash
adb -s "$SERIAL" exec-out run-as com.shinewriter cat databases/<actual-db-name>-wal > db-after.sqlite-wal
adb -s "$SERIAL" exec-out run-as com.shinewriter cat databases/<actual-db-name>-shm > db-after.sqlite-shm
```

导出前可先完全停止 App，促使 checkpoint：

```bash
adb -s "$SERIAL" shell am force-stop com.shinewriter
```

### 7.6 文件系统检查

```bash
adb -s "$SERIAL" shell run-as com.shinewriter find files -maxdepth 4 -type f -print
adb -s "$SERIAL" shell run-as com.shinewriter find cache -maxdepth 4 -type f -print
```

重点检查：

- `continuation-imports/<jobId>/`
- Documents picker 临时副本是否残留；
- 失败、取消、成功后清理语义是否符合预期。

---

## 8. 自动化操作规范

### 8.1 启动与重置

普通重启：

```bash
adb -s "$SERIAL" shell am force-stop com.shinewriter
adb -s "$SERIAL" shell am start -n com.shinewriter/.MainActivity
```

仅创建全新场景时：

```bash
adb -s "$SERIAL" shell pm clear com.shinewriter
```

### 8.2 点击

```bash
adb -s "$SERIAL" shell input tap <x> <y>
```

坐标必须来自当前 UI tree。

### 8.3 输入文字

```bash
adb -s "$SERIAL" shell input text 'text'
```

中文输入优先使用：

- 预置测试数据；
- 剪贴板/IME 工具；
- App 内已有控件；
- 不依赖 `input text` 对中文字符的兼容性。

### 8.4 滑动

```bash
adb -s "$SERIAL" shell input swipe <x1> <y1> <x2> <y2> 350
```

避免从屏幕边缘起手，以免触发系统返回手势。

### 8.5 文件选择器

将 fixture 放入 Download：

```bash
adb -s "$SERIAL" shell mkdir -p /sdcard/Download/shinewriter-fixtures
adb -s "$SERIAL" push qa/fixtures/continuation/. /sdcard/Download/shinewriter-fixtures/
adb -s "$SERIAL" shell am broadcast \
  -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
  -d file:///sdcard/Download/shinewriter-fixtures/<file>
```

进入系统 DocumentsUI 后：

- dump UI tree；
- 找到 `Downloads` 或目标目录；
- 使用节点 bounds 点击；
- 多选时通过长按第一个文件进入选择模式，再选择其他文件；
- 不允许将系统 picker 的坐标硬编码到脚本。

---

## 9. 测试 fixture 体系

创建目录：

```text
qa/fixtures/continuation/
```

建议新增生成脚本：

```text
scripts/qa/generate-continuation-fixtures.mjs
```

所有大文件在测试时生成，不提交大体积 fixture。

### 9.1 基础文本

| ID | 文件 | 内容 |
|---|---|---|
| FX-001 | `single_utf8_3_chapters.txt` | UTF-8，3 章，标准标题 |
| FX-002 | `single_utf8_no_final_newline.txt` | 文件末尾无换行 |
| FX-003 | `single_utf8_crlf.txt` | CRLF |
| FX-004 | `single_utf8_bom.txt` | UTF-8 BOM |
| FX-005 | `single_gb18030.txt` | GB18030 中文 |
| FX-006 | `single_empty.txt` | 空文件 |
| FX-007 | `single_whitespace.txt` | 只有空白 |
| FX-008 | `single_no_chapter_titles.txt` | 无标准章节标题，应触发 fallback |
| FX-009 | `single_duplicate_titles.txt` | 重复章节标题 |
| FX-010 | `single_long_title.txt` | 极长标题 |
| FX-011 | `single_malformed_bytes.bin.txt` | 非法字节序列 |
| FX-012 | `single_100k_one_chapter.txt` | 单章 100K 字，供 Canon chunk 测试 |

### 9.2 多文件

| ID | 文件组 | 内容 |
|---|---|---|
| FX-M01 | `part_01.txt`, `part_02.txt`, `part_03.txt` | 顺序明确 |
| FX-M02 | `volume_10.txt`, `volume_2.txt`, `volume_1.txt` | 验证自然文件名排序回退 |
| FX-M03 | UTF-8 + GB18030 | 混合编码 |
| FX-M04 | 2 个有效 + 1 个不可读/非法 | 部分失败 |
| FX-M05 | 全部失败 | 汇总错误并阻止继续 |
| FX-M06 | 前一文件无尾换行 | 验证文件边界不合并行 |
| FX-M07 | 空文件夹杂正常文件 | 部分成功语义 |
| FX-M08 | 文件名包含空格、中文、特殊字符 | 私有副本路径清洗 |
| FX-M09 | 同名文件 | 目标命名及覆盖风险 |
| FX-M10 | 50 个小文件 | 批量压力和 UI 排序 |

### 9.3 大文本

运行时生成：

- 500 KB；
- 5 MB；
- 50 MB；
- 接近 `MAX_IMPORT_FILE_BYTES`；
- 超过 `MAX_IMPORT_FILE_BYTES`；
- 2,000 章短章节；
- 100 章，每章 20K 字；
- 一个超大章节 + 多个普通章节。

生成结果必须可重复，固定 seed，并记录 SHA-256。

---

## 10. 原著导入 E2E 测试矩阵

## Phase B：导入主路径

### IMP-001 单文件 UTF-8 成功

步骤：

1. 新建“原著续写”项目；
2. 进入原著章节页；
3. 选择 `FX-001`；
4. 检查解析完成 Alert；
5. 暂不确认，导出数据库；
6. 确认导入；
7. 再次导出数据库；
8. 重启 App；
9. 再次进入原著章节页。

断言：

- 确认前 active source 不变化；
- source 为 `needs_review`；
- job 为 `awaiting_review`；
- chapter 数为 3；
- chunk offset 连续；
- 确认后新 source 为 `ready`；
- setting 指针指向新 source；
- job 完成；
- 私有导入副本被删除；
- 重启后章节仍存在。

### IMP-002 编码低置信度确认

使用无 BOM 且可被多种编码解释的 fixture。

断言：

- 出现编码确认 Alert；
- 取消不创建 source/job；
- 选择 UTF-8/GBK 后使用对应编码；
- 乱码或解码失败时用户收到具体提示；
- 不出现静默失败。

### IMP-003 多文件排序与确认

使用 FX-M01。

断言：

- DocumentsUI 多选成功；
- 进入排序页；
- 采样结果可见；
- 用户手工调整顺序后，最终 `source_files_json` 与 UI 顺序一致；
- `file_count=3`；
- `is_multi_file=1`；
- `file_index` 分布合法；
- 全局 offsets 连续；
- 第一文件末尾和第二文件开头没有错误拼行。

### IMP-004 多文件部分失败

使用 FX-M04。

断言：

- Alert 展示成功数、失败数和每个文件原因；
- “取消”不继续创建导入；
- “继续导入成功文件”只包含成功文件；
- 失败文件的 cachesDirectory 副本被清理；
- 成功文件在进入 service 后有 durable job 副本；
- 任何后续异常也能清理 picker 临时副本。

### IMP-005 全部失败

使用 FX-M05。

断言：

- 不进入排序页；
- 不创建 import job；
- 不创建 staging source；
- Alert 包含逐文件原因；
- 无缓存残留。

### IMP-006 取消确认

导入完成进入解析完成 Alert 后点击取消。

断言：

- active source 不改变；
- awaiting_review job 的后续用户路径明确；
- 页面能再次展示、恢复或取消该任务；
- 不允许出现“UI 没入口但唯一索引被占用”的状态。

若产品定义是点击 Alert 取消即保留 awaiting_review，必须有重新进入入口；若产品定义是不保留，则必须主动清理。不得处于不可操作中间态。

### IMP-007 第二次导入替换

1. 导入并激活 source A；
2. 再导入 source B；
3. B 确认前检查 A；
4. 确认 B；
5. 检查 A/B 状态。

断言：

- B 确认前 A 仍 active；
- 确认 B 的事务完整；
- A 变为 superseded；
- 续写章节不会被误删；
- 自动章节编号按新边界正确更新；
- 失败时 A 必须仍 active。

---

## 11. 导入中断、恢复和故障注入

## Phase C：生命周期与故障

### IMP-101 解码中强制停止 App

使用 50 MB fixture。

操作：

```bash
adb -s "$SERIAL" shell am force-stop com.shinewriter
```

在明显进入 decoding 后执行。

重启后断言：

- job 被识别为 interrupted 或可恢复状态；
- 页面展示“继续导入/取消”；
- resume 不创建第二个 active job；
- resume 后不重复插入已有 chunk/chapter；
- 最终 chunks 无重复、无 gap；
- checkpoint 的 fileIndex/byteCursor 与恢复语义一致。

### IMP-102 多文件切换边界处中断

在第一个文件完成、第二个文件开始附近强制停止。

断言：

- 恢复后文件顺序不变；
- 不漏文件；
- 不重复文件；
- `file_index` 正确；
- pending partial line 不跨文件错误合并。

### IMP-103 私有副本缺失后恢复

1. 创建 interrupted job；
2. 删除 job 私有副本目录；
3. 重启并点击继续。

断言：

- 显示可理解错误；
- job/source 进入明确失败状态；
- 用户可取消并重新导入；
- 不留下永久占用唯一索引的 active job。

### IMP-104 磁盘不足/复制失败

优先通过可控故障注入实现，不要真实填满开发机磁盘。

可选方法：

- debug-only filesystem adapter；
- mock `RNFS.copyFile` 的集成测试；
- 将 job 目录权限/路径置为不可写；
- 小容量 emulator data partition。

断言：

- 半成品 jobDir 被清理；
- 未创建孤儿 staging source；
- 用户得到复制失败原因；
- 旧 active source 不受影响。

### IMP-105 原生 decode 无进展

通过测试替身让 `decodeChunk` 返回：

```text
bytesConsumed=0
atEof=false
```

断言：

- 快速失败；
- 错误提示指出编码不匹配可能；
- job/source 状态同步失败；
- 不无限循环；
- 无 ANR。

### IMP-106 chunk 完整性校验失败

注入一个 gap 或 overlap。

断言：

- source 不可进入 needs_review；
- job/source 标为 failed；
- active source 不变；
- 失败信息保留 gap 诊断；
- 重试前能清理失败 staging 数据。

### IMP-107 并发点击导入

快速双击/重复触发导入入口。

断言：

- UI busy 状态阻止重复；
- DB 最多一个 active import job；
- 无 UNIQUE 异常泄露给用户；
- 无孤儿 source。

### IMP-108 导入中旋转/Activity 重建

在支持旋转的模拟器上执行。

断言：

- 不重复弹出 picker；
- 不重复启动 import；
- 进度/状态可恢复；
- Alert 回调不会绑定失效状态造成二次确认。

---

## 12. 导入数据库不变量

每次导入测试都执行以下查询，按实际 schema 字段微调。

### 12.1 每项目最多一个 active job

```sql
SELECT project_id, COUNT(*) AS c
FROM continuation_import_jobs
WHERE state IN ('queued','running','paused','awaiting_review','interrupted')
GROUP BY project_id
HAVING c > 1;
```

期望：0 行。

### 12.2 source 与 job 状态一致

```sql
SELECT j.id, j.state, j.source_id, s.status
FROM continuation_import_jobs j
LEFT JOIN continuation_sources s ON s.id = j.source_id;
```

人工/脚本检查允许组合，不允许出现：

- job failed 但 source 仍 staging 且无恢复路径；
- job completed 但 source 不存在；
- awaiting_review 指向 failed source；
- interrupted 指向已被删除 source。

### 12.3 chunk 连续性

```sql
WITH ordered AS (
  SELECT
    source_id,
    chunk_index,
    char_start_offset,
    char_end_offset,
    LAG(char_end_offset) OVER (
      PARTITION BY source_id ORDER BY chunk_index
    ) AS prev_end
  FROM continuation_source_text_chunks
)
SELECT *
FROM ordered
WHERE
  (chunk_index = 0 AND char_start_offset <> 0)
  OR
  (chunk_index > 0 AND char_start_offset <> prev_end)
  OR char_end_offset <= char_start_offset;
```

期望：0 行。

### 12.4 chapter 范围合法

```sql
SELECT *
FROM continuation_source_chapters
WHERE
  source_start_offset < 0
  OR content_start_offset < source_start_offset
  OR source_end_offset < content_start_offset
  OR char_count < 0
  OR paragraph_count < 0;
```

期望：0 行。

### 12.5 多文件 metadata

```sql
SELECT id, is_multi_file, file_count, source_files_json
FROM continuation_sources
WHERE is_multi_file = 1;
```

检查：

- JSON 可解析；
- 数组长度等于 `file_count`；
- fileIndex 从 0 连续；
- 文件名、大小、编码与测试输入一致。

### 12.6 active source 唯一且状态 ready

按实际 settings 字段查询 active source 指针，确认：

- 指向存在的 source；
- 该 source 状态为 ready；
- 同项目不存在两个被视为 active 的 source。

---

## 13. Canon 分析 mock LLM

## Phase D：建立确定性 OpenAI 兼容测试服务

真实线上模型不可作为自动化回归的唯一依赖。新增：

```text
scripts/qa/mock-openai-server.mjs
```

服务必须：

- 监听 host `0.0.0.0`；
- 模拟仓库当前实际使用的 OpenAI 兼容 endpoint；
- 记录请求时间、headers、model、messages、max_tokens；
- 不记录真实 API Key；
- 可按 model 名或测试场景切换响应；
- 输出 JSONL 请求日志；
- 可配置延迟、断流、错误码、截断和非法 JSON。

模拟器访问宿主机：

```text
http://10.0.2.2:<port>
```

若 App 的网络策略要求显式启用局域网 HTTP，测试前通过正常设置界面开启；不要绕过生产安全逻辑。

### 13.1 场景

| 场景 | 行为 |
|---|---|
| `valid-small` | 返回完整合法 Canon JSON |
| `valid-evidence` | 返回与输入逐字匹配的 evidence |
| `malformed-json` | 返回无法 parse 的文本 |
| `missing-fields` | 缺少八类数组字段之一 |
| `invalid-evidence` | quote 不存在于章节 |
| `finish-length` | `finish_reason=length` |
| `http-429-once` | 第一次 429，第二次成功 |
| `http-500-twice` | 前两次 500，第三次成功 |
| `timeout` | 超过 request timeout |
| `idle-timeout` | 建连后不产生有效数据 |
| `slow-valid` | 长延迟但最终成功，验证心跳 |
| `empty` | 空响应 |
| `huge-output` | 大 JSON，测试解析和内存 |
| `style-valid` | 合法风格画像 |
| `style-invalid` | Canon 成功但风格分析失败 |

### 13.2 请求断言

mock 服务必须能断言：

- `max_tokens` 与 adaptive planner 的 output reserve 一致；
- 章节正文未超过 batch/chunk 预算；
- chunk batch 只包含目标字符区间；
- 所有章节均被覆盖；
- 同一个 work item 的 retry 保持幂等键语义；
- total_timeout 不进行无意义重复请求；
- 429/5xx 按策略重试；
- 失败后 resume 只继续未完成 work items。

---

## 14. Canon 预检与 batch 计划测试

## Phase E：模型配置矩阵

### CAN-001 配置无效

- 无启用模型；
- 配置记录存在但 ID 无效；
- endpoint 空；
- model 空。

断言：

- start 前明确阻止；
- 不创建 snapshot/run；
- 用户指向设置页；
- 无孤儿数据。

### CAN-002 context=2000 / output=2000

断言：

- precheck `ok=false`；
- 显示当前配置；
- 显示建议 `max_output_tokens` 和 `context_window`；
- 点击取消不创建 run；
- 若 UI 允许“仍然尝试”，service 仍应以同一规则进行最终校验，不能绕过不变量。

### CAN-003 context=8000 / output=2000

使用普通多章原著。

断言：

- precheck 成功；
- batch 数大于大窗口配置；
- 每 batch 不超过 20 章；
- progressTotal = batches × request groups；
- 所有章节恰好覆盖。

### CAN-004 context=128000 / output=8000

断言：

- batch 数少于 CAN-003；
- 仍受每 batch 20 章质量上限约束；
- 不因为窗口大而把无限章节塞入一次调用。

### CAN-005 单章 100K 字

断言：

- 生成多个 chunk batch；
- 第一个 chunk 从 0 开始；
- 最后一个 chunk 到章节 content.length；
- chunk 之间无 gap/overlap；
- 不跳过该章；
- LLM 请求的正文与 chunk 区间一致；
- 最终 Canon coverage 包含该章。

### CAN-006 中英混合文本

断言：

- token 估算不会造成明显溢出；
- ASCII 密集文本的 chunk 大小与 CJK 密集文本不同；
- 实际请求估算不超过配置窗口；
- 若服务返回 context overflow，日志和错误包含 batch/chapter 标识。

---

## 15. Canon 主流程 E2E

### CAN-101 完整分析成功

前置：

- 已激活原著；
- 已设置边界；
- mock LLM=`valid-evidence`；
- mock style=`style-valid`。

步骤：

1. 点击完整原著分析；
2. 查看预检；
3. 开始；
4. 观察前台通知；
5. 等待所有 work item；
6. 查看 Canon 和风格状态；
7. 激活；
8. 重启 App；
9. 进入续写上下文预览。

断言：

- snapshot/run/batches/work items 全部存在；
- run 从 queued → running → completed；
- work items 全部 completed；
- progressCurrent 最终等于 progressTotal；
- evidence 均能关联 source chapter；
- 无 future evidence；
- 无 orphan evidence；
- style profile ready；
- active Canon 和 active style 指针一致；
- 重启后仍 active；
- 续写上下文预览包含 Canon/风格，且来源标识正确。

### CAN-102 快速续写分析

断言：

- 只分析定义范围内的近端章节；
- scope 和 planned chapter IDs 被持久化；
- resume 不扩大范围；
- coverage 标记 partial；
- 历史章节不会被误标为已完整分析。

### CAN-103 风格分析失败

使用 `style-invalid`。

断言：

- Canon 结果不被错误宣称“完整可用”；
- UI 显示风格失败；
- 原著续写仍被风格门禁阻止；
- 可单独重试风格；
- 重试成功后可联合激活；
- 重试不重复生成 Canon facts。

### CAN-104 证据校验失败

使用 `invalid-evidence`。

断言：

- 无效条目被丢弃或 work item 按设计失败；
- 错误诊断包含分类统计和首个 drop reason；
- 不激活 evidence 不完整的 snapshot；
- UI 不只显示“未知错误”。

### CAN-105 非法 JSON 后修复重试

使用 `malformed-json`。

断言：

- 输出解析失败可见；
- 若存在合法 retry instruction，确认重试次数符合策略；
- 最终失败后 run 可 resume；
- 切换 mock 为合法输出后，resume 只重做失败 work item。

---

## 16. Canon 中断、暂停、恢复与取消

### CAN-201 LLM 请求中强制停止 App

使用 `slow-valid`。

在请求进行中：

```bash
adb -s "$SERIAL" shell am force-stop com.shinewriter
```

重启后断言：

- run 不会错误标为 completed；
- UI 能识别可恢复状态；
- resume 使用持久化 source snapshot 和 batch plan；
- 已完成 work items 不重复写入；
- 未完成 work items 继续；
- 无重复 Canon facts；
- active snapshot 不提前切换。

### CAN-202 点击暂停

断言：

- 当前安全点后停止；
- run state=paused；
- 前台服务停止；
- resume 后继续；
- progress 不倒退；
- checkpoint 不丢失。

### CAN-203 点击取消

断言：

- run state=cancelled；
- staging snapshot 不 active；
- 前台服务停止；
- 已有 active Canon 不变化；
- 后续重新分析可正常开始；
- 取消 run 不占用不可恢复的全局状态。

### CAN-204 source 变化导致 outdated

1. 启动分析；
2. 分析中替换原著或改变边界；
3. 继续/恢复分析。

断言：

- snapshot 校验失败；
- run state=outdated；
- snapshot status=outdated；
- settings analysis_status=outdated；
- 旧结果不能激活；
- 错误明确说明源快照已变化。

### CAN-205 初始化中途失败

分别注入：

- insertSnapshot 成功、insertRun 失败；
- insertRun 成功、insertBatches 失败；
- insertBatches 成功、insertWorkItems 失败。

断言：

- 补偿后四类主记录均无孤儿；
- settings 不错误保持 running；
- 用户可重新发起；
- 不存在 progressTotal=0 的 queued run。

---

## 17. Canon 网络错误矩阵

### CAN-N01 429 一次后成功

断言：

- 重试；
- 延迟符合策略；
- 最终成功；
- 不重复写 facts。

### CAN-N02 500 两次后成功

断言：

- 最多按策略尝试；
- 第三次成功；
- attempt 数记录可审计。

### CAN-N03 持续 500

断言：

- 达到最大尝试后失败；
- run/work item 状态明确；
- 可 resume；
- UI 显示服务端错误。

### CAN-N04 total timeout

断言：

- 不进行相同请求的无意义重试；
- 失败时间与配置相符；
- 错误建议调整输入或输出配置；
- progress 不永久卡在 0%。

### CAN-N05 idle timeout

断言：

- 按 transient 策略处理；
- retry 次数正确；
- 最终状态正确。

### CAN-N06 网络断开与恢复

```bash
adb -s "$SERIAL" shell svc wifi disable
adb -s "$SERIAL" shell svc data disable
```

恢复：

```bash
adb -s "$SERIAL" shell svc wifi enable
```

断言：

- 网络错误可见；
- App 不崩溃；
- 恢复网络后 resume 成功；
- 不产生重复 work items。

---

## 18. Canon 数据库不变量

### 18.1 run 图完整性

```sql
SELECT r.id
FROM continuation_analysis_runs r
LEFT JOIN canon_snapshots s ON s.id = r.canon_snapshot_id
WHERE s.id IS NULL;
```

期望：0 行。

```sql
SELECT b.run_id
FROM continuation_analysis_batches b
LEFT JOIN continuation_analysis_runs r ON r.id = b.run_id
WHERE r.id IS NULL;
```

期望：0 行。

```sql
SELECT w.run_id
FROM continuation_analysis_work_items w
LEFT JOIN continuation_analysis_runs r ON r.id = w.run_id
WHERE r.id IS NULL;
```

期望：0 行。

### 18.2 batch 与 work item 数量

```sql
SELECT
  r.id,
  r.progress_total,
  COUNT(DISTINCT b.batch_index) AS batch_count,
  COUNT(w.id) AS work_item_count
FROM continuation_analysis_runs r
LEFT JOIN continuation_analysis_batches b ON b.run_id = r.id
LEFT JOIN continuation_analysis_work_items w ON w.run_id = r.id
GROUP BY r.id;
```

检查：

- progress_total 等于实际 work item 数；
- 每 batch 有完整 request groups；
- 不存在空 run。

### 18.3 completed run 无未完成 work item

```sql
SELECT r.id, w.state, COUNT(*) AS c
FROM continuation_analysis_runs r
JOIN continuation_analysis_work_items w ON w.run_id = r.id
WHERE r.state = 'completed'
  AND w.state <> 'completed'
GROUP BY r.id, w.state;
```

期望：0 行。

### 18.4 active snapshot 合法

检查 active snapshot：

- status 合法；
- 对应 run completed；
- sourceId/version/hash 与当前 source 兼容；
- boundary 未过期；
- style profile ready 且未 ignored；
- 不允许 failed/cancelled/outdated snapshot active。

### 18.5 evidence 关联

使用仓库已有 count helper 对应 SQL，确认：

- orphan evidence=0；
- future evidence=0；
- quotePreview 能在对应章节/区间找到；
- charStart/charEnd 在边界内。

### 18.6 重复事实

按表的业务唯一键抽查：

- 同一 snapshot 内重复 character；
- 同一关系重复；
- 同一 event_key 重复；
- resume 后同一 evidence 重复。

发现重复必须判断是合法多证据还是幂等性缺陷。

---

## 19. 性能、内存与卡顿测试

## Phase F：压力测试

### PERF-001 50 MB 导入

采集：

```bash
adb -s "$SERIAL" shell dumpsys meminfo com.shinewriter
adb -s "$SERIAL" shell dumpsys gfxinfo com.shinewriter
```

在导入前、中、后分别采集。

通过标准：

- 无 OOM；
- 无 ANR；
- UI 至少周期性更新；
- JS 线程不出现长时间完全无响应；
- 内存峰值在流程结束后明显回落；
- 数据库无 gap/重复；
- 不将整本书长期保留在 JS 内存。

### PERF-002 2,000 章 Canon 预检

通过标准：

- 预检可完成；
- 不因 O(N²) 明显恶化；
- 主线程无 ANR；
- 分析阶段按 batch 区间读取；
- finalize 不重新加载全部正文。

### PERF-003 单章超大 chunk

通过标准：

- chunk 计划无 gap；
- 每次请求大小受预算限制；
- 调用次数虽增加但进度真实；
- 不跳过章节。

### PERF-004 连续执行 10 次

对 IMP-001、IMP-003、CAN-101 各连续执行至少 10 次。

通过标准：

- 0 次随机失败；
- 无 source/job/run 数量持续泄漏；
- 缓存目录不持续增长；
- DB 文件体积增长符合新增数据量，不出现异常膨胀；
- 无偶发重复 Alert、重复提交和重复事实。

### 性能回归判定

首次测量建立 baseline。后续修复若使以下指标恶化超过 2 倍，必须解释：

- 导入总耗时；
- 峰值 PSS；
- batch 预检耗时；
- 单次 DB 查询次数；
- mock LLM 调用次数；
- 最终 DB 体积。

不允许为了追求速度破坏完整性或证据校验。

---

## 20. UI 与可访问性检查

每个关键按钮必须能通过 UI tree 唯一定位，优先使用：

- `accessibilityLabel`
- `text`
- `content-desc`
- 稳定 resource-id

重点元素：

- 新建原著续写项目；
- 原著章节；
- 导入 TXT 原著；
- 多文件排序上移/下移/移除；
- 确认顺序；
- 确认导入；
- 继续导入；
- 取消未完成导入；
- 续写起点；
- 完整原著分析；
- 快速续写分析；
- 开始；
- 暂停；
- 继续；
- 取消；
- 单独重试风格分析；
- 激活原著资料与风格。

若关键元素无法稳定定位，应增加语义化 `accessibilityLabel`，并为该改动增加组件测试。

---

## 21. 自动化脚本建议结构

```text
scripts/qa/
├── generate-continuation-fixtures.mjs
├── mock-openai-server.mjs
├── run-continuation-import-e2e.sh
├── run-canon-analysis-e2e.sh
├── adb-ui-find.py
├── adb-ui-tap.py
├── capture-android-evidence.sh
├── export-debug-db.sh
├── assert-import-invariants.py
├── assert-canon-invariants.py
└── summarize-run.mjs

qa/
├── fixtures/
│   └── continuation/
├── scenarios/
│   ├── import.yaml
│   └── canon.yaml
└── README.md
```

脚本要求：

- `set -euo pipefail`；
- 所有命令显式接收 `SERIAL`；
- 不硬编码数据库名；
- 不硬编码屏幕坐标；
- 失败时仍执行日志、截图和数据库导出；
- 输出机器可读结果 JSON；
- 同时生成 Markdown 摘要；
- 可从任意失败步骤恢复或重跑单个 case。

---

## 22. 缺陷台账

创建：

```text
artifacts/qa/<run-id>/bug-ledger.md
```

模板：

```markdown
## BUG-XXX 标题

- Severity:
- First seen commit:
- Emulator/API:
- Test case:
- Reproduction rate:
- User impact:
- Preconditions:
- Exact steps:
- Expected:
- Actual:
- UI evidence:
- Log evidence:
- DB evidence:
- Suspected layer:
- Root cause:
- Failing automated test:
- Fix commit:
- Emulator retest:
- Regression result:
- Remaining risk:
```

严重级别：

- **P0：** 数据丢失、旧原著/续写章节被误删、错误激活 Canon、不可恢复崩溃；
- **P1：** 核心流程无法完成、任务永久卡死、重复数据、孤儿任务阻塞后续操作；
- **P2：** 错误提示缺失、恢复体验差、进度错误、局部兼容问题；
- **P3：** 文案、布局、轻微可访问性或低风险性能问题。

优先处理 P0/P1。

---

## 23. 每个缺陷的修复工作包

每个 BUG 必须产出以下内容。

### 23.1 复现测试

优先级：

1. 纯函数单元测试；
2. repository/service 集成测试；
3. React Native 组件测试；
4. Android 模拟器 E2E；
5. 迁移 fixture 测试。

至少必须有一个自动测试在修复前失败、修复后通过。

### 23.2 根因说明

必须回答：

- 错误状态是在哪里首次产生的；
- 为什么现有测试没有发现；
- 为什么之前的修复会反复失效；
- 修复保护了哪个不变量；
- 是否影响旧数据；
- 是否需要迁移或补偿清理。

### 23.3 最小修改

避免：

- 顺手重构整个模块；
- 同时更换架构；
- 在导入修复中修改不相关生成逻辑；
- 在 Canon 修复中重写全部 LLM 层；
- 用 catch-all 吞掉异常；
- 用更宽松校验掩盖非法状态。

### 23.4 定向回归

导入缺陷至少跑：

```bash
npx jest __tests__/continuationImport*.test.ts --runInBand
npx jest __tests__/continuationMultiFileImport.test.ts --runInBand
npx jest __tests__/continuationImportErrorHandling.test.ts --runInBand
```

Canon 缺陷至少跑：

```bash
npx jest __tests__/adaptiveBatchPlanner.test.ts --runInBand
npx jest __tests__/*canon*.test.ts --runInBand
```

实际文件名以仓库为准，不得因为 glob 不匹配而误判成功。

### 23.5 全量回归

```bash
npm run verify
```

### 23.6 模拟器回归

必须重跑：

- 原始失败 case；
- 同模块 happy path；
- 中断/恢复 case；
- 数据库不变量；
- App 重启后的状态；
- 相关最低 API case。

---

## 24. 迁移专项

当修复涉及 schema 或现有坏数据补偿时，执行：

### MIG-001 新安装

- 清空应用数据；
- 安装新 APK；
- 创建项目；
- 导入；
- 分析；
- 验证当前 schema。

### MIG-002 从上一正式版升级

1. 安装上一版 APK；
2. 创建原著续写项目并导入 fixture；
3. 可选创建中断 job / failed run；
4. 覆盖安装新 APK，不清数据；
5. 启动并等待迁移；
6. 验证原著、边界、续写章节、Canon、配置；
7. 再执行一次新导入和新分析。

### MIG-003 失败迁移保护

注入迁移中断或错误。

断言：

- 不把 DB 错误标为已完成迁移；
- 下次启动可重试或给出明确恢复路径；
- 不静默丢数据。

---

## 25. 发布前完整回归门槛

所有条件必须满足：

### 代码

- [ ] `npm run lint` 通过
- [ ] `npm run typecheck` 通过
- [ ] `npm run verify:version` 通过
- [ ] `npm run test:ci` 通过
- [ ] `npm run verify` 通过
- [ ] 无新增 skip
- [ ] 无未解释 snapshot 更新

### 导入

- [ ] 单文件 UTF-8
- [ ] 低置信度编码
- [ ] GB18030
- [ ] 多文件排序
- [ ] 部分失败
- [ ] 全部失败
- [ ] 取消
- [ ] 替换 active source
- [ ] 50 MB
- [ ] 进程强停恢复
- [ ] 缺失副本
- [ ] 并发点击
- [ ] DB 全部不变量

### Canon

- [ ] 无效配置
- [ ] 小上下文拒绝
- [ ] 小窗口多 batch
- [ ] 大窗口少 batch
- [ ] 超大章节 chunk
- [ ] 完整分析
- [ ] 快速分析
- [ ] 非法 JSON
- [ ] 证据失败
- [ ] 429/500/timeout
- [ ] 暂停/恢复/取消
- [ ] 进程强停恢复
- [ ] source 改变 outdated
- [ ] 风格失败和单独重试
- [ ] DB 全部不变量

### Android

- [ ] EMU-LATEST 全部 P0/P1
- [ ] EMU-MIN 核心 happy path + 中断恢复
- [ ] 无 crash
- [ ] 无 ANR
- [ ] 无 OOM
- [ ] 前台通知可正常开始、更新、停止
- [ ] App 重启后状态正确
- [ ] 临时文件无持续泄漏

---

## 26. Agent 停止和升级条件

遇到以下情况，停止自动修改，保存证据并请求维护者决定：

- 修复可能删除或迁移用户原著/续写正文；
- 需要改变产品定义，例如“取消解析完成 Alert 后是否保留 awaiting_review”；
- 需要修改在线模型隐私或 HTTP 安全策略；
- 需要 release 签名密钥；
- 需要真实付费模型 API；
- 发现生产数据库已有大规模不可逆损坏；
- 需要把 Canon 证据校验改为更宽松规则；
- 同一问题有两种互斥业务方案；
- 修复会改变导出/备份格式；
- 需要重建整个续写架构而非局部修复。

停止时必须提供：

1. 已确认事实；
2. 未确认假设；
3. 两个以上可选方案；
4. 每个方案的数据风险和兼容性；
5. 推荐方案；
6. 可继续执行的准确起点。

---

## 27. 每次工作会话结束前

必须执行：

```bash
git status --short
git diff --stat
git diff --check
```

更新 `.agent/continuation-qa-state.md`，并生成：

```text
artifacts/qa/<run-id>/session-summary.md
```

内容：

```markdown
# Session Summary

## Base
- Commit:
- Emulator:
- App version:

## Completed
- Test cases:
- Bugs fixed:
- Commits:

## Evidence
- Paths:

## Tests
- Commands:
- Results:

## Open issues
- IDs:
- Severity:

## Exact next step
- Command:
- Expected observation:
```

不得以“继续调查”作为下一步。下一步必须是可执行的准确命令或测试 case。

---

## 28. 推荐首轮执行顺序

首次执行不要立刻修改代码。按以下顺序建立可信基线：

1. Phase A：工具链、`npm run verify`、Debug APK；
2. IMP-001：单文件成功；
3. IMP-003：多文件排序成功；
4. IMP-004：部分文件失败；
5. IMP-101：导入中强制停止并恢复；
6. CAN-002：明显不足的模型配置预检；
7. CAN-005：100K 单章 chunk；
8. CAN-101：mock LLM 完整分析；
9. CAN-105：非法 JSON 后恢复；
10. CAN-201：分析中强制停止并恢复；
11. PERF-001：50 MB 导入；
12. 汇总首轮缺陷，按 P0/P1 排序；
13. 一次只修复一个缺陷；
14. 每个修复完成后重新执行相关矩阵；
15. 最后执行 EMU-MIN 核心回归。

---

## 29. 首轮重点怀疑点，但不得未经复现直接修改

以下是代码审阅后需要重点验证的风险，不等于已确认缺陷：

1. **解析完成 Alert 点击“取消”后的 awaiting_review 可达性**  
   需要确认用户是否能重新进入确认或取消任务，避免唯一 active job 被长期占用。

2. **多文件 UI 层临时副本与排序页生命周期**  
   `ContinuationSourceChaptersScreen` 的 `finally` 会清理 picker 临时副本，需要验证导航到排序页后副本是否在排序页读取/确认前已被删除。若排序页已在导航前完成自己的 durable copy，则应以证据确认；否则可能出现时序缺陷。

3. **恢复路径是否真正从 checkpoint 增量继续**  
   代码注释声明可恢复，但必须验证当前实现是否会清理旧 chunk 后重跑、重复写入或从零开始，以及这是否符合 UX 和幂等性要求。

4. **多文件 chapter 的 `file_index` 边界语义**  
   跨文件 chunk 以“完成该 band 的文件”作为 fileIndex；需要确认所有消费方只把它当 provenance hint，而不会据此重建文件区间。

5. **Canon 预检加载全部章节正文的 UI 内存压力**  
   分析执行已改为按 batch 区间读取，但预检页面仍需验证 `listBoundedSourceChapters` 对 2,000+ 章和超大原著是否造成主线程卡顿或 OOM。

6. **Canon 初始化补偿与 settings 状态更新的原子边界**  
   当前已有补偿删除，但需注入每个 insert 阶段失败并验证 settings、snapshot、run、batch、work item 全部一致。

7. **chunk batch 合并后的证据绝对 offset**  
   必须验证传给 LLM 的 chunk 文本、metadata bodyStart/bodyEnd 和返回 evidence 的绝对 offset 转换一致。

8. **工作项完成计数与异步 UI 轮询竞态**  
   页面根据 work item 终态重算 progressCurrent，需要验证快速回写、暂停、恢复和失败时不出现 100% 但 run 未完成或负向倒退。

9. **Canon 成功但风格失败时的激活门禁**  
   必须确认任何入口都不能绕过有效风格画像要求。

10. **错误信息是否经过 sanitize 后仍保留可诊断性**  
    需要同时避免泄露敏感请求信息，并保留文件名、阶段、错误码、batch、material type 等关键诊断字段。

---

## 30. 完成定义

本计划完成的标志不是所有 checkbox 被机械勾选，而是：

- 原著导入和 Canon 分析存在稳定、可重复、无需人工猜坐标的模拟器自动化；
- 每次失败都会自动保存 UI、日志、数据库和文件系统证据；
- 关键数据库不变量可由脚本验证；
- LLM 成功和失败路径可由本地 mock 确定性复现；
- 中断、恢复、取消、替换和过期语义均有 E2E 测试；
- 已发现的 P0/P1 缺陷完成单缺陷闭环；
- 所有修复有回归测试；
- `npm run verify` 保持通过；
- Android 最低版本和最新版本核心路径通过；
- 后续 agent 可以从状态文件和精确命令继续工作，而不是重新理解整个仓库。

