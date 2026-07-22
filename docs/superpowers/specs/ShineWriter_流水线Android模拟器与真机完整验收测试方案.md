# ShineWriter 流水线 Android 模拟器 / 真机完整验收测试方案

> 文档类型：执行型测试方案  
> 项目目录：`D:\Claudeworkspace\Tavo-mini`  
> 当前基线提交：`67a73109105486828e9083d16970c4bfb26304ac`  
> 当前应用版本：`2.5.17`  
> Android Application ID：`com.shinewriter`  
> 适用对象：自动化测试 Agent、Android 模拟器测试 Agent、真机测试 Agent  
> 文档日期：2026-07-22  
> 结论要求：不得只给“测试通过”口头结论，必须提交可复核证据

---

## 1. 测试目的

本轮测试用于对 ShineWriter 流水线近期多轮改造进行一次完整的 Android 端闭环验收。

测试范围不只包含最近的“审核结果有效性”修复，还必须覆盖此前尚未完成模拟器或真机验收的内容：

1. 四种流水线模式的阶段顺序和依赖关系。
2. `content` 与 `reasoning_content` 分离。
3. 文学评估、事实核查 JSON 有效性校验。
4. 完整正文、初稿回显、截断 JSON、隐藏正文字段的拦截。
5. 审核格式异常时最多一次修复重试。
6. 单侧审核失败、双侧审核失败和终审失败的降级行为。
7. 失败任务保留初稿但不得伪装成完成。
8. 任务状态、通知栏、结果页和数据库持久化的一致性。
9. 初稿后二次召回、角色召回、世界书召回和记忆召回。
10. 空 LLM 输出是否仍可能被误判为成功。
11. 前后台切换、进程中断、取消和续跑。
12. 网络异常、超时、限流、JSON Mode 不兼容和 Token 截断。
13. 长上下文和推理模型实际行为。
14. 并发任务、重复启动和队列行为。
15. Debug APK 在 Android 模拟器和至少一台真机上的一致性。

---

## 2. 执行原则和修改边界

本轮任务的主要目标是测试，不是继续无边界改造。

Agent 必须遵守：

- 测试开始前固定 Git 基线并记录当前提交。
- 不覆盖用户未提交修改。
- 不执行 `git reset --hard`、强制清理或其他破坏性命令。
- 不把 API Key 写入仓库、日志、截图或测试报告。
- 不直接修改生产逻辑来“让测试通过”。
- 发现缺陷后先记录证据、复现步骤和严重级别。
- 只有用户明确授权后才进行生产代码修复。
- 为确定性测试新增的 Mock Server、测试脚本或测试数据，应放在测试目录，或保持为未提交的临时工具。
- 不把“真实模型偶然返回正确结果”当作异常场景已覆盖。
- 审核异常、重试、降级必须使用可控 Mock API 确定性复现。
- 每个失败必须区分：产品缺陷、测试环境问题、模型不可控行为、测试脚本问题。
- 不能因某项是“历史已知问题”就标记 PASS。

---

## 3. 当前代码基线

本轮重点改造由以下三个提交构成：

```text
94c8e1c  拒绝无效审核结果并分离 reasoning content
224df92  审核/终审失败保留 failed 状态并保存初稿
67a7310  拒绝审核数组中的空字符串和纯空白字符串
```

从 `768040c` 到当前基线主要涉及：

```text
src/services/llm/openAICompatibleProvider.ts
src/services/llm/types.ts
src/services/pipelineAuditValidator.ts
src/services/pipelineMessages.ts
src/services/pipelineRunner.ts
src/store/pipelineTaskStore.ts
src/components/PipelineResultPrompt.tsx
src/screens/PipelineResultScreen.tsx
```

已有测试或辅助脚本：

```text
__tests__/llm.test.ts
__tests__/pipelineAuditValidator.test.ts
__tests__/pipelineRunner.test.ts
__tests__/pipelineTaskStore.test.ts
__tests__/pipelineResultFormatStageText.test.ts
__tests__/pipelineResultPrompt.test.tsx
scripts/verify-pipeline-audit-validity.js
scripts/live-deepseek-audit-verify.mjs
```

---

## 4. 测试环境要求

### 4.1 主机环境

最低要求：

```text
Windows 10/11
Node.js >= 24.3.0
npm
JDK / Android SDK
ADB
Android Studio
可用的 Android 模拟器
至少一个可访问的在线 OpenAI Compatible API
```

推荐准备：

```text
Android API 35 或当前项目 targetSdk 对应镜像
x86_64 模拟器
至少 6 GB RAM
稳定网络
一台 Android 真机
可访问主机的局域网
```

### 4.2 测试设备矩阵

至少完成：

| 设备 | 构建 | 网络 | 必测范围 |
|---|---|---|---|
| Android 模拟器 | Debug APK | 在线 API | 全量确定性用例 |
| Android 模拟器 | Debug APK | Mock API | 全量异常、重试、降级 |
| Android 真机 | Debug APK | 在线 API | 正常流程、前后台、通知、持久化 |
| Android 真机 | Debug APK | 局域网 Mock API | 至少一组审核异常和一组终审失败 |

可选：

| 设备 | 构建 | 必测范围 |
|---|---|---|
| Android 模拟器 | Release APK | 核心回归 |
| Android 真机 | Release APK | 发布前完整回归 |
| Android 真机 | 本地 GGUF | 本地模型冒烟和长耗时任务 |

---

## 5. 证据目录

在项目根目录创建：

```text
test-logs/
└─ pipeline-device-validation/
   ├─ 00-baseline/
   ├─ 01-build/
   ├─ 02-offline-validation/
   ├─ 03-online-provider/
   ├─ 04-mode-matrix/
   ├─ 05-audit-validation/
   ├─ 06-degradation/
   ├─ 07-retrieval/
   ├─ 08-empty-output/
   ├─ 09-ui/
   ├─ 10-background-resume/
   ├─ 11-network/
   ├─ 12-token-context/
   ├─ 13-concurrency/
   ├─ 14-real-device/
   └─ final-report/
```

每个测试用例至少保存：

```text
CASE-ID/
├─ steps.md
├─ result.md
├─ screenshot-before.png
├─ screenshot-result.png
├─ logcat.txt
├─ mock-requests.jsonl
├─ task-state.json
└─ notes.txt
```

不适用的文件可以省略，但每个用例必须有 `result.md`。

---

## 6. 测试前基线记录

在 PowerShell 中执行：

```powershell
cd D:\Claudeworkspace\Tavo-mini

git status --short
git rev-parse HEAD
git log -5 --oneline
node --version
npm --version
adb version
adb devices -l
```

保存为：

```text
test-logs/pipeline-device-validation/00-baseline/environment.txt
```

基线必须满足：

```text
HEAD = 67a73109105486828e9083d16970c4bfb26304ac
```

如果 HEAD 不一致：

1. 不擅自切换或重置分支。
2. 记录实际 HEAD。
3. 对比与基线差异。
4. 在最终报告中明确测试对应的实际提交。

---

## 7. 测试前自动化门禁

### 7.1 安装依赖

```powershell
npm install
```

若已安装依赖，也必须确认 `postinstall` 成功。

### 7.2 全量校验

```powershell
npm run verify
```

该命令应包含：

```text
lint
typecheck
version consistency
Jest
```

保存完整输出：

```powershell
npm run verify *>&1 |
  Tee-Object test-logs\pipeline-device-validation\01-build\npm-verify.txt
```

### 7.3 重点测试

```powershell
npx jest `
  __tests__/llm.test.ts `
  __tests__/pipelineAuditValidator.test.ts `
  __tests__/pipelineMessages.test.ts `
  __tests__/pipelineRunner.test.ts `
  __tests__/pipelineTaskStore.test.ts `
  __tests__/pipelineResultFormatStageText.test.ts `
  __tests__/pipelineResultPrompt.test.tsx `
  --runInBand
```

### 7.4 离线场景证据

```powershell
node scripts/verify-pipeline-audit-validity.js
```

应生成：

```text
test-logs/pipeline-audit-validity-evidence.json
test-logs/pipeline-audit-validity-evidence.md
```

### 7.5 在线 Provider 探针

使用 PowerShell 临时环境变量：

```powershell
$env:DEEPSEEK_API_KEY="<仅在当前终端设置>"
$env:DEEPSEEK_MODEL="<实际使用的模型>"
node scripts/live-deepseek-audit-verify.mjs
Remove-Item Env:\DEEPSEEK_API_KEY
```

应生成：

```text
test-logs/deepseek-live-probe.json
test-logs/deepseek-live-probe.md
```

检查：

- `reasoning-only rejected = PASS`
- `new path never puts reasoning into text = PASS`
- 实际 Review 和 FactCheck JSON 请求有明确结果
- 日志中没有 API Key

---

## 8. APK 构建和安装

### 8.1 构建 Debug APK

```powershell
npm run apk:debug
```

保存输出：

```powershell
npm run apk:debug *>&1 |
  Tee-Object test-logs\pipeline-device-validation\01-build\apk-debug-build.txt
```

### 8.2 确认设备

```powershell
adb devices -l
```

### 8.3 安装

优先使用项目构建脚本输出的 APK 路径。

```powershell
adb install -r "<DEBUG_APK_PATH>"
```

全新安装场景：

```powershell
adb uninstall com.shinewriter
adb install "<DEBUG_APK_PATH>"
```

### 8.4 启动和停止

```powershell
adb shell am force-stop com.shinewriter
adb shell monkey -p com.shinewriter 1
```

如需指定 Activity：

```powershell
adb shell am start -n com.shinewriter/.MainActivity
```

---

## 9. ADB 证据采集

### 9.1 Logcat

测试开始前：

```powershell
adb logcat -c
```

持续采集：

```powershell
adb logcat -v threadtime |
  Tee-Object test-logs\pipeline-device-validation\<GROUP>\<CASE>\logcat.txt
```

建议重点过滤：

```powershell
adb logcat -v threadtime |
  Select-String "pipeline|pipeline-audit|ShineWriter|ReactNativeJS|AndroidRuntime"
```

### 9.2 截图

```powershell
adb shell screencap -p /sdcard/shine-test.png
adb pull /sdcard/shine-test.png "<LOCAL_PATH>"
adb shell rm /sdcard/shine-test.png
```

### 9.3 UI 树

```powershell
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "<LOCAL_PATH>"
```

### 9.4 数据库

先确认数据库文件名：

```powershell
adb shell run-as com.shinewriter ls -la databases
```

导出数据库：

```powershell
adb exec-out run-as com.shinewriter cat databases/<DB_FILE> `
  > test-logs\pipeline-device-validation\<GROUP>\<CASE>\app.db
```

使用本机 SQLite 检查相关表：

```sql
.tables
SELECT * FROM pipeline_tasks ORDER BY updated_at DESC LIMIT 10;
```

实际表名和字段名以数据库为准，不要猜测后强行执行。

### 9.5 Shared Preferences 和文件目录

```powershell
adb shell run-as com.shinewriter ls -R shared_prefs
adb shell run-as com.shinewriter ls -R files
adb shell run-as com.shinewriter ls -R no_backup
```

禁止把包含 API Key 的明文文件提交到测试证据。

---

## 10. 标准测试数据工程

创建专用项目：

```text
项目名：流水线验收工程
目标章节：第 12 章《钟楼下的银钥匙》
```

### 10.1 角色数据

#### 林深

```text
正式名称：林深
别名：阿深
特征：左手有旧伤
当前状态：没有银钥匙
```

#### 阿乙

```text
正式名称：阿乙
别名：乙叔
特征：保管银钥匙
当前状态：上一章已收到林深交出的银钥匙
```

#### 顾寒

```text
正式名称：顾寒
别名：寒叔
特征：左腿微跛
历史状态：很久以前曾在黑沙城出现
```

### 10.2 世界书数据

#### 银钥匙规则

```text
第 11 章结尾，林深已经把银钥匙交给阿乙。
除非阿乙归还，否则林深不应再次持有银钥匙。
```

#### 钟楼规则

```text
黑沙城东钟楼午夜只响两次。
响三次代表城门发生重大警报。
```

#### 地理规则

```text
黑沙城西门夜间封闭。
东城墙可以通往钟楼。
```

### 10.3 前文章节

至少建立 11 个章节。

关键章节：

```text
第 1 章：顾寒登场，明确左腿微跛
第 2 章：林深常被称为“阿深”
第 11 章：林深把银钥匙交给阿乙
```

第 3 至第 10 章填入足够长度的正文，使第 1、2 章可能离开最近章节窗口。

### 10.4 目标生成指令

基础指令：

```text
林深沿东城墙走向钟楼，途中遇到多年未见的顾寒。
保持人物特征、物品归属和地理规则一致。
```

冲突指令：

```text
林深从口袋里拿出银钥匙，钟楼在午夜敲响三次。
请写一段完整场景。
```

别名指令：

```text
阿深在城墙下认出了寒叔，并注意到他走路有些异常。
```

### 10.5 长文本数据

准备：

```text
长世界书条目：不少于 8,000 中文字
长前文：至少 10 个章节，每章 2,000 至 5,000 字
长目标初稿：3,000 至 6,000 字
```

用于测试：

- 召回预算顺序
- 高优先级角色是否被挤出
- Token 截断
- 推理模型输出预算
- UI 长文本性能

---

## 11. 确定性 Mock OpenAI Compatible API

真实模型无法稳定产生所有异常，因此必须使用 Mock API。

### 11.1 Mock 服务要求

测试 Agent 可以创建临时工具：

```text
test-tools/mock-openai-server.mjs
```

服务要求：

```text
监听：0.0.0.0:18080
接口：POST /v1/chat/completions
格式：OpenAI Compatible
记录：每次请求的阶段、调用次数、response_format、max_tokens
输出：test-logs/mock-api-requests.jsonl
禁止：记录 Authorization 完整内容
```

模拟器访问地址：

```text
http://10.0.2.2:18080/v1/chat/completions
```

真机访问地址：

```text
http://<电脑局域网IP>:18080/v1/chat/completions
```

### 11.2 阶段识别

Mock Server 根据 messages 内容识别：

```text
draft
review
factCheck
proof
reviewRepair
factCheckRepair
```

不得只按固定调用序号判断，因为 full 模式中的 review 和 factCheck 并行。

### 11.3 标准响应结构

```json
{
  "choices": [
    {
      "message": {
        "content": "正式内容",
        "reasoning_content": "内部推理"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150
  }
}
```

### 11.4 必备场景

| 场景 | 行为 |
|---|---|
| `all_valid` | 所有阶段正常 |
| `review_prose_then_valid` | Review 第一次正文，修复重试返回合法 JSON |
| `fact_prose_then_valid` | FactCheck 第一次正文，修复重试返回合法 JSON |
| `review_always_prose` | Review 两次均返回完整正文 |
| `fact_always_prose` | FactCheck 两次均返回完整正文 |
| `both_audits_invalid` | 两侧两次都无效 |
| `reasoning_only_review` | Review content 为空，只有 reasoning |
| `reasoning_only_fact` | FactCheck content 为空，只有 reasoning |
| `proof_reasoning_only` | Proof content 为空，只有 reasoning |
| `proof_empty` | Proof content 和 reasoning 都为空 |
| `truncated_review` | 不完整 JSON + finish_reason=length |
| `truncated_fact` | 不完整 JSON + finish_reason=length |
| `complete_json_length` | 合法完整 JSON + finish_reason=length |
| `extra_body_field` | 额外顶层字段包含整篇正文 |
| `nested_body_field` | 嵌套未知字段包含整篇正文 |
| `empty_array_item` | 数组中包含 `""` |
| `whitespace_array_item` | 数组中包含 `"   "` |
| `invalid_array_item` | 数字、布尔、null 或空对象 |
| `empty_draft` | Draft content 为空 |
| `draft_reasoning_only` | Draft content 为空，reasoning 有内容 |
| `json_mode_unsupported` | 第一次带 response_format 返回 400，第二次成功 |
| `http_401` | 鉴权失败 |
| `http_429` | 限流 |
| `http_500` | 服务端失败 |
| `slow_response` | 延迟 30 至 120 秒 |
| `connection_drop` | 请求中断 |

### 11.5 Mock 计数要求

每次执行后必须能证明：

```text
审核首次异常 → 只修复重试一次
审核第二次仍异常 → 不进行第三次调用
full 模式 review 与 factCheck 均结束后才调用 proof
两侧都失败 → proof 调用次数为 0
单侧有效 → proof 调用次数为 1
```

---

# 12. 测试用例矩阵

## G 组：基础门禁和安装

### G01 自动化门禁

步骤：

1. 执行 `npm run verify`。
2. 执行重点 Jest。
3. 执行离线验证脚本。

预期：

```text
全部命令退出码为 0
没有 TypeScript 错误
没有 Jest 失败
证据文件正常生成
```

### G02 Debug APK 构建

预期：

```text
APK 构建成功
versionName 与 package.json 一致
没有缺失 JS Bundle
```

### G03 全新安装

步骤：

```powershell
adb uninstall com.shinewriter
adb install "<APK>"
```

预期：首次启动正常、无闪退、基础配置页可打开。

### G04 覆盖安装

步骤：

```powershell
adb install -r "<APK>"
```

预期：原项目和配置保留，数据库可以正常继续使用。

### G05 冷启动

步骤：强制停止后再次启动。

预期：无白屏、无 `PlatformConstants` 错误、无数据库初始化异常。

---

## P 组：Provider 和 reasoning 分离

### P01 content 与 reasoning 同时存在

Mock 返回合法 `content` 和内部推理。

预期：审核只使用 `content`，UI 和终审输入均不包含 reasoning。

### P02 只有 reasoning_content

预期：审核判定 `reasoning_only`，触发一次格式修复重试，reasoning 不进入审核卡片。

### P03 content 为空字符串、reasoning 有值

预期同 P02。

### P04 content 和 reasoning 都为空

预期：`empty_content`，审核失败或执行一次修复重试。

### P05 JSON Mode 不兼容

Mock 第一次对带 `response_format` 请求返回 400。

预期：Provider 移除 `response_format` 后重试，但业务层仍执行本地结构校验。

### P06 真实推理模型

使用实际线上模型完成短 Ping、Review JSON、FactCheck JSON。

预期：reasoning 和 content 分离，无 reasoning 泄露，真实 JSON 可被验证器接受。

---

## M 组：四种流水线模式

### M01 noReview 正常

预期：

```text
draft = success
review = skipped
factCheck = skipped
proof = skipped
task = completed
```

### M02 twoStage 正常

预期顺序：`draft → review → proof`。

验证：Proof 请求中存在 reviewText，不存在 factCheckText。

### M03 conditional 正常

预期顺序：`draft → factCheck → proof`。

验证：Proof 请求中存在 factCheckText，不存在 reviewText。

### M04 full 正常

预期：Draft 完成后 Review 与 FactCheck 并行，Proof 等待两侧完成。

### M05 full 单侧 Review 有效

设置：Review 有效，FactCheck 两次无效。

预期：Review success、FactCheck failed、Proof 仅接收 Review、UI 明确显示事实核查失败。

### M06 full 单侧 FactCheck 有效

预期与 M05 对称。

### M07 full 双侧无效

预期：

```text
review = failed
factCheck = failed
proof = skipped
task = failed
finalText = 初稿
通知栏不得显示已完成
```

### M08 twoStage 审核无效

预期：Review 两次无效后 Proof 不调用，任务失败并保留初稿。

### M09 conditional 审核无效

预期：FactCheck 两次无效后 Proof 不调用，任务失败并保留初稿。

---

## A 组：审核结果有效性

### A01 合法 Review JSON

```json
{
  "strengths": ["节奏清晰"],
  "issues": ["结尾过快"],
  "suggestions": ["补充收束"]
}
```

预期：成功。

### A02 合法 FactCheck 字符串数组

预期：成功。

### A03 合法 FactCheck 对象数组

预期：成功，字段正确展示。

### A04 Markdown JSON 围栏

预期：围栏可清理，JSON 成功解析。

### A05 完整正文

预期：`novel_output` 或 `draft_echo`，不得标记 success。

### A06 初稿大段回显

预期：`draft_echo`。

### A07 截断 JSON

设置：`finish_reason=length` 且 JSON 不完整。

预期：`truncated_output`。

### A08 完整 JSON 但 finish_reason=length

预期：只要 JSON 完整并通过结构校验，可以接受。

### A09 缺少必要字段

预期：`missing_required_fields`。

### A10 顶层额外字段含正文

预期：`unexpected_shape`。

### A11 嵌套未知字段含正文

预期：`unexpected_shape` 或正文回显类失败。

### A12 非法数组元素

测试数字、布尔、null、空对象和嵌套数组。

预期：整份报告 `unexpected_shape`。

### A13 空字符串数组元素

预期：`unexpected_shape`，错误详情包含字段名和下标。

### A14 纯空白字符串数组元素

预期同 A13。

### A15 空字符串与有效项混合

预期：整份报告失败，不得过滤空字符串后继续成功。

### A16 合法空数组

预期：`[]` 允许，代表该类别没有内容。

### A17 单项过长

预期：`oversized_report` 或 `draft_echo`。

### A18 JSON 围栏外存在长篇正文

预期：`novel_output`。

---

## T 组：格式修复重试

### T01 Review 第一次正文、第二次合法

预期：Review 请求总数等于 2，第二次成功，Proof 执行。

### T02 FactCheck 第一次截断、第二次合法

预期同 T01。

### T03 两次都正文

预期：请求总数等于 2，不存在第三次，Stage failed。

### T04 两次 reasoning-only

预期同 T03。

### T05 两次空内容

预期同 T03。

### T06 修复提示内容

检查第二次请求：

```text
明确要求只输出 JSON
明确禁止重写、续写、复述正文
不包含第一次完整无效输出
```

### T07 full 两侧同时触发修复重试

预期：两侧分别最多 2 次，等待两个分支最终结束，再决定是否调用 Proof。

---

## D 组：失败降级和任务终态

### D01 Review 失败保留初稿

预期：任务 `failed`、finalText 为初稿、error 明确、不得变成 completed。

### D02 FactCheck 失败保留初稿

预期同 D01。

### D03 双审核失败保留初稿

预期同 D01。

### D04 Proof reasoning-only

预期：Proof failed、任务 failed、finalText 为初稿、reasoning 不作为终稿。

### D05 Proof 空内容

预期同 D04。

### D06 Proof 请求异常

模拟 HTTP 500 或断开连接。

预期：任务 failed、初稿保留、UI 显示终审失败。

### D07 失败状态重启后持久化

步骤：产生审核失败，强制停止 App，重新启动，读取任务详情和数据库。

预期：仍为 failed，错误信息和初稿仍存在。

### D08 成功路径未受影响

预期：Proof 成功后任务 completed，成功通知正常，finalText 为终审稿。

### D09 降级通知

预期：显示“已保留初稿”或明确失败提示，不显示“已写完”。

---

## R 组：召回、上下文和历史遗留风险

### R01 full 初稿后二次召回

使用目标初稿中的顾寒、银钥匙和钟楼三响。

预期 Logcat 出现 post-draft retrieval 及各类 hits 统计，FactCheck 获得对应上下文。

### R02 旧章节角色召回

“顾寒”只在很早章节出现。

预期：full 模式生成后能召回顾寒设定，核查能识别左腿微跛。

### R03 正式名称直接召回

目标初稿出现“顾寒”，预期角色卡召回成功。

### R04 别名召回

目标初稿只出现“寒叔”“阿深”。

正确预期：映射到顾寒和林深，并召回对应角色卡。

若失败：记录为角色别名召回缺陷，不得标记 PASS。

### R05 世界书规则召回

目标初稿写林深再次拿出银钥匙、钟楼午夜三响。

预期 FactCheck 指出与世界书冲突。

### R06 Episodic Memory 召回

上一章明确钥匙已交给阿乙。

预期 FactCheck 使用前章事件证据，不能只依靠模型常识。

### R07 召回预算顺序

加入很长的世界书和笔记，使总上下文超预算。

正确预期：高优先级直接相关角色和事件不应被无关长文本挤出。

### R08 conditional 初稿后二次召回

正确预期：conditional 的事实核查也应基于初稿触发二次召回，能够发现初稿刚引入的角色和事件冲突。

当前历史风险是仅 full 执行二次召回。若未执行，记录为 P1，不得以“当前设计如此”标记通过。

### R09 full Proof 使用增强上下文

验证 Proof 的 constraints 和审核输入使用增强后的 auditContext。

### R10 二次召回回退

模拟召回异常。

预期：流水线不崩溃，回退原 pipelineContext，并记录 non-fatal 日志。

---

## E 组：空 LLM 输出历史遗留风险

### E01 Draft 空 content

Mock：Draft content 和 reasoning 均为空。

正确预期：Draft failed、任务 failed、不得保存空正文、不得继续审核。

若仍标记 Draft success，记录为 P0。

### E02 Draft 只有 reasoning

正确预期：不得把 reasoning 当初稿，Draft failed。

### E03 Draft 空白字符串

正确预期同 E01。

### E04 noReview 空 Draft

正确预期：不得 task=completed。

### E05 twoStage 空 Draft

正确预期：不得继续 Review。

### E06 conditional 空 Draft

正确预期：不得继续 FactCheck。

### E07 full 空 Draft

正确预期：不得启动并行审核。

---

## U 组：结果页和 UI

### U01 合法 Review 展示

预期：显示优点、问题、建议，不展示原始长 JSON。

### U02 合法 FactCheck 展示

预期：显示错误、警告、已确认，结构清晰。

### U03 无效第一次响应不可见

场景：第一次返回完整正文，第二次修复成功。

预期：结果页只显示第二次有效报告，第一次正文不显示。

### U04 reasoning 不可见

检查任务详情、阶段卡片、通知、终稿和导出内容，均不得出现 reasoning。

### U05 单侧审核失败

预期：失败侧明确显示失败，成功侧正常显示，整体终审结果可查看。

### U06 双侧审核失败

预期：任务失败、显示已保留初稿、Proof skipped。

### U07 Proof 失败

预期：结果页显示初稿，明确说明终审失败，不得显示“终审完成”。

### U08 长报告滚动

预期：页面不卡死，可以完整滚动，没有内容重叠。

### U09 空数组显示

合法空数组不应显示为错误。

### U10 失败任务重启后展示

预期与数据库状态一致。

---

## B 组：前后台、取消、进程中断和续跑

### B01 Draft 阶段切后台

使用 `slow_response`。进入后台等待完成，再返回 App。

预期：前台服务通知存在，任务不被系统静默杀死，完成状态正确。

### B02 Review 阶段切后台

预期同 B01。

### B03 full 并行审核切后台

预期：两个审核继续，Proof 等待两侧，通知进度不倒退。

### B04 Proof 阶段切后台

预期同 B01。

### B05 用户取消 Draft

预期：任务 cancelled，后续阶段不启动，不发送伪失败或伪成功通知。

### B06 用户取消并行审核

预期：两侧调用停止或结果被忽略，Proof 不启动，任务 cancelled。

### B07 用户取消 Proof

预期：任务 cancelled，不保存半截终稿。

### B08 强制停止进程

```powershell
adb shell am force-stop com.shinewriter
```

重启后预期：活跃任务不得伪装继续运行，应标记中断/失败或提供明确续跑入口。

### B09 续跑 twoStage

准备 Draft 已成功，Review 或 Proof 缺失。

预期：不重跑 Draft，按 Review → Proof 恢复。

### B10 续跑 conditional

预期：不重跑 Draft，按 FactCheck → Proof 恢复。

### B11 续跑 full

测试两侧都缺失、只缺 Review、只缺 FactCheck、只缺 Proof。

预期：只重跑缺失阶段，不覆盖已有成功结果。

### B12 冷启动数据库恢复

预期：任务状态、stageResults、finalText、error 一致。

---

## N 组：网络和 Provider 异常

### N01 401

预期：任务失败，错误提示可理解，不泄露 API Key。

### N02 429

预期：不会无限重试，任务终态明确。

### N03 500

预期同 N02。

### N04 超时

预期：可取消，任务不会永久卡在 active。

### N05 网络断开

发起请求后关闭模拟器网络。

预期：最终失败或可取消，不假完成。

### N06 网络恢复

重新联网后启动新任务，预期正常。

### N07 response_format 400 回退

预期见 P05。

### N08 非 JSON Content-Type 但合法响应

按 Provider 实际兼容范围测试，不得崩溃。

### N09 malformed response

例如 `{"choices":[]}`。

预期：空 content 失败，不得成功。

---

## L 组：Token、长上下文和性能

### L01 审核 Token 足够

真实模型返回完整合法 JSON。

### L02 审核截断

降低审核 Max Tokens。

预期：截断 JSON 被拒绝，最多修复一次。

### L03 Draft 长文本

生成 3,000 至 6,000 字。

预期：UI 可用、保存完整、进入审核正常。

### L04 长世界书

预期：上下文构建不崩溃，直接相关条目仍可召回。

### L05 推理模型输出预算

记录 input tokens、output tokens、reasoning length、finish_reason 和阶段耗时。

### L06 full 总耗时

记录 Draft、Review、FactCheck、Proof 和总时长，确认审核并行效果。

### L07 低内存

预期：无明显崩溃，任务状态可恢复。

### L08 结果页大文本性能

检查首次打开耗时、滚动流畅度和返回导航。

---

## C 组：并发和任务队列

### C01 不同章节连续启动

预期：任务按队列策略执行，不混淆 taskId。

### C02 同章节重复启动

正确预期：阻止重复活跃任务或明确排队，不得同时覆盖同一章节。

### C03 full 与 noReview 并发

检查模型请求和任务结果不串线。

### C04 取消排队任务

预期：不会执行。

### C05 前一个失败后下一个继续

预期：队列不被永久阻塞。

### C06 Mock 请求 taskId 隔离

日志必须能按 taskId 区分。

---

## O 组：可选本地模型和 Release 验收

### O01 本地 GGUF noReview

预期：Draft 可完成，上下文预算自动收紧。

### O02 本地 GGUF full

记录耗时和是否能完成，不强制与在线模型同速度。

### O03 Release APK 构建

仅在签名环境可用时执行：

```powershell
npm run apk:release
```

### O04 Release 核心回归

至少执行 M01、M02、M03、M04、D04、B01、U04。

---

# 13. 测试执行顺序

## Phase 0：基线与自动化

```text
G01
离线验证脚本
在线 Provider 探针
```

门禁失败则停止设备测试，并先提交环境或代码失败报告。

## Phase 1：构建和安装

执行 G02 至 G05。

## Phase 2：Mock API 基础链路

执行 P01 至 P05、M01 至 M09。

## Phase 3：审核有效性和重试

执行 A01 至 A18、T01 至 T07。

## Phase 4：降级和任务持久化

执行 D01 至 D09、U01 至 U10。

## Phase 5：历史遗留项

执行 R01 至 R10、E01 至 E07，并单独输出缺陷清单。

## Phase 6：生命周期和网络

执行 B01 至 B12、N01 至 N09。

## Phase 7：性能、并发、真机

执行 L01 至 L08、C01 至 C06，以及真机核心矩阵。

## Phase 8：可选 Release 和本地模型

执行 O01 至 O04。

---

# 14. 真机最小必测集

至少在一台真实 Android 设备完成：

```text
G03 全新安装
M01 noReview
M02 twoStage
M03 conditional
M04 full
T01 第一次无效、第二次成功
M07 full 双侧无效
D04 Proof reasoning-only
D07 失败状态重启持久化
U03 无效正文不显示
U04 reasoning 不显示
B01 后台运行
B05 用户取消
B08 强制停止
N05 网络断开
R04 别名召回
R08 conditional 二次召回
E01 Draft 空输出
```

真机 Mock API 使用电脑局域网 IP，不使用 `10.0.2.2`。

---

# 15. 严重级别

## P0 阻断

- 审核正文再次被当成报告。
- reasoning 被当成正文、报告或终稿。
- 失败任务最终显示 completed。
- 双审核失败仍调用 Proof。
- Proof 失败仍发送完成通知。
- Draft 空输出被标记完成。
- 数据丢失或初稿被错误覆盖。
- App 崩溃、死循环、无限重试。

## P1 高优先级

- conditional 无法进行必要的初稿后二次召回。
- 角色别名无法召回，导致连续性核查失效。
- 召回预算顺序导致关键角色或事件被挤出。
- 单侧审核失败 UI 误导。
- 重启后状态与数据库不一致。
- 取消无效或后续阶段继续运行。
- 前台服务或通知状态严重错误。

## P2 中优先级

- 展示格式不佳。
- 错误提示不清楚。
- 长文本明显卡顿但不崩溃。
- 日志信息不足。

## P3 低优先级

- 文案、间距、小范围视觉问题。

---

# 16. 通过标准

## 16.1 自动化门禁

```text
npm run verify = PASS
重点 Jest = PASS
离线证据脚本 = PASS
Debug APK = PASS
```

## 16.2 核心流水线

```text
M01 至 M09 全部 PASS
P01 至 P06 全部 PASS
A01 至 A18 全部 PASS
T01 至 T07 全部 PASS
D01 至 D09 全部 PASS
```

## 16.3 历史遗留

以下项目不能跳过：

```text
R04 角色别名召回
R07 召回预算顺序
R08 conditional 初稿后二次召回
E01 至 E07 Draft 空输出
```

若失败，整体测试结论不得写“全部通过”。

## 16.4 设备一致性

```text
模拟器核心矩阵通过
真机最小必测集通过
任务状态与数据库一致
UI 与通知一致
```

## 16.5 发布判定

允许发布：

```text
P0 = 0
P1 = 0
核心用例通过率 = 100%
模拟器和真机均有证据
```

不允许发布：

```text
存在任一 P0
存在未评估的 P1
只有单元测试、没有设备测试
只有真实模型正常结果、没有 Mock 异常测试
没有数据库或 Logcat 证据
```

---

# 17. 用例结果模板

每个 `result.md` 使用：

```markdown
# CASE-ID 测试结果

- 提交：
- APK：
- 设备：
- Android 版本：
- 模型 / Mock 场景：
- 开始时间：
- 结束时间：
- 结果：PASS / FAIL / BLOCKED
- 严重级别：

## 前置条件

## 操作步骤

## 预期结果

## 实际结果

## Task ID

## 阶段状态

| Stage | Status | Text Length | Error |
|---|---|---:|---|
| draft | | | |
| review | | | |
| factCheck | | | |
| proof | | | |

## Mock 请求次数

| Stage | Calls |
|---|---:|
| draft | |
| review | |
| factCheck | |
| proof | |

## 数据库结果

## 通知栏结果

## UI 结果

## Logcat 摘要

## 证据路径

## 是否可稳定复现

## 初步根因

## 建议处理
```

---

# 18. 缺陷报告模板

```markdown
# BUG-编号 标题

- 严重级别：
- 发现用例：
- 提交：
- 设备：
- APK：
- 模型 / Mock 场景：
- 复现率：

## 问题描述

## 最小复现步骤

## 预期行为

## 实际行为

## 关键日志

## 数据库状态

## Mock 请求记录

## 截图 / 录像

## 影响范围

## 是否为历史遗留项

## 初步根因判断

## 修复建议

## 回归用例建议
```

---

# 19. 最终测试报告要求

Agent 完成后必须生成：

```text
test-logs/pipeline-device-validation/final-report/
├─ SUMMARY.md
├─ CASE-MATRIX.csv
├─ BUG-LIST.md
├─ ENVIRONMENT.md
├─ EVIDENCE-INDEX.md
└─ RELEASE-RECOMMENDATION.md
```

## 19.1 SUMMARY.md 必须包含

1. 实际测试提交。
2. APK 文件及哈希。
3. 模拟器和真机信息。
4. 在线模型和 Mock Server 信息。
5. 自动化测试结果。
6. 用例总数。
7. PASS、FAIL、BLOCKED 数量。
8. P0、P1、P2、P3 数量。
9. 四种流水线模式结果。
10. 审核有效性结果。
11. 降级和持久化结果。
12. 历史遗留项结果。
13. 真机结果。
14. 未执行项目及原因。
15. 发布建议。

## 19.2 CASE-MATRIX.csv 字段

```text
case_id
group
title
device
model_or_scenario
result
severity
bug_id
evidence_path
notes
```

## 19.3 RELEASE-RECOMMENDATION.md

只能给出以下结论之一：

```text
PASS：可以进入发布候选
CONDITIONAL PASS：仅存在明确接受的 P2/P3
FAIL：存在 P0/P1 或核心用例失败
BLOCKED：环境导致核心测试无法完成
```

不得使用含糊结论：

```text
基本没问题
应该可以
大部分通过
看起来正常
```

---

# 20. Agent 开工指令

Agent 收到本文档后应直接开始执行，不要只重新复述测试计划。

执行要求：

1. 先固定基线和环境证据。
2. 完成自动化门禁。
3. 构建并安装 Debug APK。
4. 创建或使用确定性 Mock API。
5. 按 Phase 顺序执行。
6. 每个用例即时保存证据。
7. 发现 P0 后仍应完成同一问题域的最小关联测试，以确认影响范围。
8. 不在未授权情况下修改生产代码。
9. 不跳过历史遗留项。
10. 不把 Mock 测试替代真机测试。
11. 不把真机正常测试替代异常 Mock 测试。
12. 完成后统一提交测试报告和缺陷清单。

最终必须明确回答：

```text
审核正文问题是否在设备端真正闭环？
reasoning 是否在任何 UI 或正文路径泄露？
失败状态是否在重启后仍保持 failed？
full 单侧/双侧失败行为是否正确？
conditional 是否完成初稿后二次召回？
角色别名和旧角色是否能被召回？
Draft 空输出是否被正确拒绝？
模拟器和真机结果是否一致？
是否达到发布条件？
```
