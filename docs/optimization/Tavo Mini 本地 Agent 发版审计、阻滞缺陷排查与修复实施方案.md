# Tavo Mini 本地 Agent 发版审计、阻滞缺陷排查与修复实施方案

## 1. 任务背景

目标仓库：

```text
anjingdtl/tavo-mini
```

本轮主要变更涉及但不限于：

```text
AI 写 N 章
多章节批次状态机
单章流水线断点恢复
弹性上下文预算
流水线失败分类与重试
SQLite Schema 与迁移
前台服务及任务进度
版本构建和发版流程
```

本方案不是要求机械修复一份预先列出的 BUG 清单。

Agent 必须先检查本地仓库中的真实代码、提交记录、测试结果、构建结果和运行路径，再判断：

1. 已知风险是否真实存在；
2. 是否已被后续代码修复；
3. 是否存在比已知风险更严重的阻滞问题；
4. 当前代码是否达到正式发版标准；
5. 哪些问题必须修复，哪些问题只需要记录；
6. 修复是否引入新的回归风险。

---

# 2. Agent 最终目标

Agent 必须完成以下全部工作：

```text
1. 建立本地最新代码审计基线
2. 梳理本轮变更范围和关键执行链路
3. 运行现有静态检查、类型检查、测试和构建
4. 系统排查发版阻滞缺陷
5. 对发现的问题建立可重复证据
6. 修复经证实的问题
7. 补充能够防止回归的自动化测试
8. 重新执行全量验证
9. 输出发版审计报告
10. 明确给出“可发版”或“不可发版”结论
```

不得仅以以下内容作为“问题不存在”或“已经修复”的依据：

```text
提交信息
代码注释
计划文档
测试名称
作者描述
人工声明“已经端到端验证”
```

必须以实际代码路径、测试执行结果、数据库状态、运行日志或构建产物为证据。

---

# 3. 最高优先级执行原则

## 3.1 本地代码是唯一事实来源

本轮审计以 Agent 工作目录中的本地代码为准。

执行前必须确认：

```powershell
git status --short
git branch --show-current
git rev-parse HEAD
git log -1 --oneline
git remote -v
git fetch --all --prune
git status -sb
```

如果本地分支落后于远端，应先明确报告，不得在未说明的情况下审计旧代码。

不得覆盖或删除用户未提交的本地改动。

发现未提交改动时：

```text
1. 记录文件清单
2. 判断这些改动是否属于本轮工作
3. 不得擅自 reset、checkout 或 clean
4. 后续提交必须只包含 Agent 本轮明确修改的文件
```

---

## 3.2 所有问题必须有证据

每个被列入正式报告的问题，至少具备以下证据中的两类：

```text
A. 明确的代码调用链
B. 可重复的自动化测试失败
C. 可重复的手工运行步骤
D. SQLite 数据前后状态
E. Android 日志或 JavaScript 日志
F. 构建、Lint、TypeScript 或 Jest 错误
G. 代码实现与产品界面语义直接矛盾
H. 生命周期、并发或事务的不变量被代码路径打破
```

禁止仅凭“看起来可能”“理论上可能”将问题判为阻滞 BUG。

如果某项风险无法复现，但从代码上能够形式化证明，则必须在报告中写清楚证明过程。

---

## 3.3 先审计，后修改

不得一进入仓库就直接修改已知文件。

必须先完成：

```text
变更范围盘点
架构和调用链梳理
现有测试执行
问题证据收集
影响范围判断
```

然后形成待修复问题清单，再开始修改。

---

## 3.4 禁止无边界重构

除非现有结构无法安全修复阻滞问题，否则不得：

```text
重写整个状态机
新建第二套批次执行器
复制另一套 Pipeline Runner
大规模更换 Zustand 或 SQLite 架构
更换测试框架
升级 React Native 主版本
升级 Jest、ESLint 或 TypeScript 主版本
为了消除警告而修改无关模块
```

修复应以最小、清晰、可测试为原则。

---

## 3.5 禁止用延迟掩盖竞态

不得使用以下方式掩盖并发或持久化问题：

```text
setTimeout
sleep
固定等待 300ms
多等待几秒再读取
失败后盲目重试
关闭 SQLite 外键
忽略 rowsAffected
吞掉数据库错误
先更新内存、以后再写数据库
```

并发问题必须通过以下方式解决：

```text
事务
CAS
唯一约束
行版本
租约和续租
幂等键
明确的状态所有权
持久化完成后再推进
```

---

# 4. 发版阻滞问题判定标准

## 4.1 P0：必须阻止发版

符合以下任一情况即为 P0：

```text
数据丢失、数据覆盖或章节错位
重复调用模型导致不可控费用
用户选择的模式与真实执行完全不一致
应用杀进程后永久卡在运行状态
同一批次可能被两个执行器同时推进
数据库迁移可能导致旧用户无法启动
备份、恢复或升级路径可能破坏用户数据
正式 APK 无法构建、安装或启动
核心入口点击后没有反馈或进入错误页面
批次完成状态与章节实际内容不一致
取消、暂停或恢复会继续调用模型
发布版本号或 versionCode 无法正确升级
功能开关关闭后仍可进入未完成功能
```

---

## 4.2 P1：正式发版前原则上必须修复

包括：

```text
错误的重试分类
恢复入口误导用户
用量统计明显失真
任务失败后无法可靠恢复
前台服务、通知和真实状态不一致
测试覆盖明显遗漏关键主路径
长任务中租约过期
错误被吞掉后显示为空数据
异常状态缺少用户可操作出口
批次历史、任务历史或审计信息丢失
```

---

## 4.3 P2：可以延期但必须记录

包括：

```text
非关键界面文案
低概率显示问题
调试脚本可移植性
代码重复但不影响正确性
非主路径性能优化
仅开发环境出现的警告
```

---

# 5. 第一阶段：建立审计基线

## 5.1 保存仓库快照

执行：

```powershell
git rev-parse HEAD
git log --date=iso --pretty=format:"%h %ad %s" -30
git status --short
node --version
npm --version
java -version
```

记录：

```text
当前分支
HEAD SHA
本地是否干净
Node 版本
npm 版本
Java 版本
Android SDK 路径
Gradle 版本
当前应用版本
当前 Schema 版本
```

检查：

```text
package.json
package-lock.json
src/constants/version.json
android/app/build.gradle
android/build.gradle
android/gradle/wrapper/gradle-wrapper.properties
src/services/migrations/index.ts
src/services/database/schemaManifest.ts
```

---

## 5.2 盘点本轮变更

使用合适的稳定基线进行比较。

优先选择：

```text
最近一个已经确认通过完整 CI 的发布提交
最近一个公开发布版本对应提交
本轮 AI 写 N 章改造开始前的提交
```

执行示例：

```powershell
git diff --stat <BASE_SHA>..HEAD
git diff --name-status <BASE_SHA>..HEAD
git log --oneline <BASE_SHA>..HEAD
```

将变更文件按模块分类：

```text
批次数据表和迁移
批次 Repository
批次 Store
批次状态机
批次页面
单章 Pipeline
LLM 请求和失败分类
弹性预算
任务持久化
前台服务
版本和构建
测试和 QA 脚本
```

必须避免只看最后一个提交。

---

# 6. 第二阶段：运行基础质量门禁

## 6.1 依赖安装

优先使用锁文件安装：

```powershell
npm ci
```

如果失败，不得直接改用 `npm install` 掩盖问题。

先记录：

```text
失败命令
退出码
完整错误
Node/npm 版本
是否由 postinstall 引起
```

只有确认锁文件本身不适用于当前项目约定时，才允许使用其他安装方式，并在报告中说明。

---

## 6.2 执行项目既有验证

依次运行：

```powershell
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
```

最后运行：

```powershell
npm run verify
```

不得只运行新增测试。

必须记录：

```text
测试套件数
测试总数
通过数
失败数
跳过数
运行时间
是否存在 open handles
是否存在测试结束后异步报错
```

---

## 6.3 构建验证

至少执行：

```powershell
npm run apk:debug
```

具备正式签名环境时，再执行：

```powershell
npm run apk:release
```

如果没有正式签名密钥：

```text
不得伪造密钥
不得将 release 构建失败直接判断为代码 BUG
必须继续执行不依赖正式密钥的 Gradle 编译或 bundle 检查
必须明确写出“正式签名构建未验证”
```

检查 APK：

```text
文件是否存在
文件大小是否合理
版本号
versionCode
applicationId
支持 ABI
是否包含 JS bundle
是否可安装
是否可启动
```

---

# 7. 第三阶段：建立关键执行链路图

Agent 必须先梳理调用链，禁止只在单个文件中局部判断。

## 7.1 AI 写 N 章主链路

至少追踪：

```text
OutlineEditor
→ MultiChapterBatchScreen
→ multiChapterBatchStore
→ multiChapterBatchRepository
→ reconcileMultiChapterBatch
→ determineNextBatchAction
→ createPipelineTaskForBatchItem
→ runChapterPipeline / resumePipeline
→ reconcilePipelineTask
→ checkpoint / attempt / task 持久化
→ batchAdoption
→ commitBatchItemAdoption
→ chapter 正文
→ 批次完成报告
```

对每一层记录：

```text
输入参数
真实数据来源
持久化位置
错误传播方式
是否可重复执行
是否能跨进程恢复
谁拥有状态推进权
```

---

## 7.2 单章流水线链路

至少追踪：

```text
ChapterEditor
→ useChapterPipeline
→ createTask
→ pipeline_tasks
→ pipeline_stage_checkpoints
→ runChapterPipeline
→ reconcilePipelineTask
→ determineNextPipelineAction
→ stage compile
→ LLM request
→ pipeline_stage_attempts
→ checkpoint
→ finalText
→ PipelineResult
```

重点检查：

```text
首次运行与恢复是否走同一状态机
失败阶段是否能够正确重跑
成功阶段是否会重复调用
冻结上下文是否在第一次 LLM 调用前持久化
任务状态、checkpoint 和 stageResults 是否一致
```

---

# 8. 第四阶段：系统性阻滞 BUG 审计

下面各项都必须检查。

这些条目是“审计方向”，不是预先认定的问题。只有证据成立才进入正式缺陷清单。

---

## 8.1 功能配置是否真正传递到执行层

检查所有用户可选参数：

```text
仅草稿 / 快速 / 完整
章节数
每章目标字数
批次剧情摘要
每章独立摘要
carryIn / carryOut
keyBeats
模型配置
Preset 配置
弹性预算开关
多章节功能开关
```

逐项确认：

```text
UI 选择
→ Store 参数
→ SQLite 持久化
→ 冷启动读取
→ Pipeline 冻结快照
→ 实际 Stage 决策
→ 最终模型请求
```

不得仅确认字段“被保存”。

必须确认它真实改变了执行行为。

建议检索：

```powershell
rg "pipelineMode|pipeline_mode|draft_only|fast|full" src __tests__
rg "targetWords|target_words" src __tests__
rg "sourcePrompt|source_prompt" src __tests__
rg "keyBeats|key_beats" src __tests__
```

需要新增集成测试证明：

```text
选择仅草稿时，只允许 Draft
选择快速模式时，执行阶段与产品定义一致
选择完整模式时，执行完整阶段
恢复后仍使用第一次冻结的模式
修改全局配置不得改变已启动批次
```

---

## 8.2 页面状态与真实执行状态是否一致

重点检查：

```text
点击开始后何时切到运行页
开始按钮何时禁用
重复点击是否可能创建第二个执行器
运行中退出页面再进入是否正确显示
批次完成时是否进入报告页
批次暂停时是否立即进入暂停页
错误时是否仍显示运行中
```

建立测试：

```text
开始请求尚未结束时，界面已经显示运行中
reconciling=true 时开始按钮不可点击
连续点击两次只启动一个协调器
页面卸载不会取消真实批次
页面重新进入能从 SQLite 重建状态
```

---

## 8.3 冷启动和进程死亡恢复

检查以下场景：

```text
批次刚创建章节后杀进程
任务刚创建但尚未调用模型时杀进程
Draft 请求中杀进程
Review 成功后杀进程
Proof 成功但尚未采用时杀进程
正文已写入但批次计数未提交时杀进程
批次处于 waiting_retry 时杀进程
批次处于暂停状态时杀进程
```

明确设计选择：

### 选择 A：自动恢复

冷启动后主动启动批次协调器。

要求：

```text
只恢复当前项目或所有未终态批次的明确定义
避免启动多个重复协调器
确保前台服务符合 Android 生命周期要求
恢复前重新获取 lease
```

### 选择 B：落为可恢复暂停

冷启动将批次明确改为：

```text
paused_interrupted
```

用户点击恢复后继续。

不得出现：

```text
数据库显示 running
界面显示运行中
实际上没有任何执行器
```

必须增加真实冷启动状态测试。

---

## 8.4 幂等性和重复执行

逐项验证：

```text
章节只能创建一次
Pipeline Task 只能绑定一次
单章结果只能采用一次
completed_count 只能加一次
current_ordinal 只能推进一次
token 用量不能重复累计
通知不能重复完成
全局结果弹窗不能弹出批次子任务
```

需要针对以下崩溃点测试：

```text
章节 INSERT 后、Item 绑定前
Task INSERT 后、checkpoint 写入前
Task 创建后、Item 绑定前
LLM 成功后、checkpoint 写入前
checkpoint 成功后、task projection 写入前
正文写入后、adoption fingerprint 写入前
fingerprint 写入后、completed_count 提交前
最后一章完成后、batch completed 写入前
```

每个测试必须重复调用 reconcile 两次或更多次，确认结果不重复。

---

## 8.5 SQLite 事务、外键和 rowsAffected

检查所有涉及以下表的写入：

```text
pipeline_tasks
pipeline_stage_checkpoints
pipeline_stage_attempts
multi_chapter_batches
multi_chapter_batch_items
multi_chapter_batch_item_runs
chapters
chapter_revisions
```

重点确认：

```text
父记录必须先存在
子记录和父记录的关键创建必须同事务
事务断言失败必须真正触发 rollback
rowsAffected=0 必须被识别为冲突
INSERT OR REPLACE 不得删除子记录
ON DELETE 行为符合业务语义
```

必须在真实 `react-native-sqlite-storage` 行为和测试替身之间核对：

```text
事务 callback 抛错是否真的回滚
测试内存数据库是否模拟了原生回滚语义
executeSql 成功回调的 index 是否正确
insertId 与 rowsAffected 是否按真实插件返回
```

不得因为内存测试通过，就自动认定 Android SQLite 行为一致。

---

## 8.6 批次租约和并发所有权

检查：

```text
lease 时长是否覆盖一次正常章节生成
长任务是否续租
lease 到期后第二个 owner 是否可能进入
同一 owner 是否可以重复 claim
页面重复点击是否绕过 lease
应用重启后的旧 lease 如何处理
releaseLease 失败后会发生什么
```

建议设计：

```text
协调器运行时定期续租
每完成一个状态机动作续租
LLM 长请求期间用安全心跳续租
续租失败立即停止推进
```

需要测试：

```text
单章执行超过 leaseMs
第二个 owner 尝试进入
原 owner 续租成功
原 owner 失去 lease 后不得继续提交状态
```

---

## 8.7 暂停、取消和恢复语义

分别定义：

```text
用户暂停
用户取消
安全重试等待
配额不足
上下文不足
请求结果未知
项目结构变化
应用中断
不可恢复数据库错误
```

每类状态必须明确：

```text
能否自动恢复
能否用户恢复
恢复时复用旧 Task 还是创建新 Task
是否复用已成功阶段
是否允许重新调用可能已经执行的请求
是否保留旧 attempt 审计记录
是否清空错误字段
```

禁止用一个通用“恢复”按钮处理所有失败类型。

---

## 8.8 单章失败任务的可恢复判断

检查恢复入口是否真正验证：

```text
任务是否有有效冻结上下文
是否至少有可复用成功 checkpoint
失败阶段是否允许重试
失败分类是否 safe_retry
任务是否因数据库错误而失败
模型配置是否仍与冻结快照一致
章节和项目是否发生漂移
```

可恢复判定必须成为一个独立、可测试的纯函数或服务。

不得仅用：

```text
status === failed
status === interrupted
resolvedAt === null
```

判定任务可恢复。

---

## 8.9 失败分类和重试策略

逐类检查：

```text
网络连接失败
DNS 失败
连接超时
读取超时
429
500 / 502 / 503 / 504
401 / 403
账户额度不足
模型不存在
上下文超限
请求格式错误
响应 JSON 错误
连接在发送后中断
用户取消
```

明确区分：

```text
safe_retry
rate_limit
outcome_unknown
account_quota
context_error
blocked
fatal
cancelled
```

必须验证：

```text
outcome_unknown 不得自动重试
safe_retry 重试次数有上限
Retry-After 得到尊重
恢复后使用同一冻结请求
重试不会重新编译不同 Prompt
成功阶段不会因为后续失败而重跑
```

---

## 8.10 批次费用和 Token 统计

必须以 `pipeline_stage_attempts` 为审计来源，核对当前计数是否遗漏：

```text
失败请求
超时请求
安全重试
同阶段多次请求
格式修复请求
Reasoning-only 重试
部分成功任务
用户取消前已经发生的调用
```

明确产品定义：

```text
实际发出的 HTTP 请求数
模型成功调用数
可计费调用数
成功采用章节的调用数
```

数据库字段名称和 UI 文案必须对应真实定义。

批次上限若声称是硬上限，必须在每次请求前检查，而不是章节采用后补记。

---

## 8.11 项目和章节漂移保护

检查批次开始时是否冻结：

```text
startPosition
expectedTailChapterId
项目 ID
当前章节尾部
每章计划哈希
模型配置快照
Pipeline 配置快照
```

检查运行过程中以下操作：

```text
用户新增章节
删除批次创建的章节
手工移动章节
修改章节 position
修改项目模式
删除项目
修改计划
切换模型
```

必须定义每种变化：

```text
允许继续
自动适配
暂停等待用户
彻底阻止
```

测试不得在 fixture 中手工设置生产路径没有设置的字段。

所有测试数据必须尽可能通过真实业务入口创建。

---

## 8.12 Feature Flag 安全

检查：

```text
功能关闭时入口是否隐藏
通过深链或导航名能否直接进入
页面内部是否二次校验
批次已经运行时关闭开关会发生什么
升级后默认值是什么
设置读取失败时默认值是什么
调试脚本是否可能误开启正式用户功能
```

两个新功能需要分别验证：

```text
multi_chapter_batch_enabled
elastic_budget_v2_enabled
```

不得把“入口隐藏”等同于功能完全不可达。

---

## 8.13 Schema 迁移和旧用户升级

必须建立升级矩阵。

至少验证：

```text
Schema 39 → 当前
Schema 40 → 当前
Schema 41 → 当前
新安装 → 当前
存在缺失非核心表的旧数据库 → 当前
存在大量章节和资料的数据库 → 当前
迁移中断后重新启动
```

检查：

```text
迁移是否事务化
Schema version 何时更新
表已部分创建时能否重跑
外键是否在迁移后启用
索引是否存在
Manifest 与真实表结构是否一致
备份表清单是否包含新表
恢复时是否恢复批次元数据
```

---

## 8.14 备份与恢复

新表必须验证：

```text
是否包含在备份
备份 checksum 是否覆盖
恢复顺序是否满足外键
恢复旧版本备份时是否兼容
恢复不含批次表的备份时是否正常
大体积备份是否会 OOM
```

需要检查用户真实数据安全：

```text
批次元数据丢失是否影响章节正文
恢复后非终态批次应如何处理
旧 Pipeline Task 是否会误恢复
```

---

## 8.15 前台服务和 Android 生命周期

检查：

```text
任务开始前是否及时启动前台服务
批次是否只拥有一个聚合通知
单章子任务是否错误启动自己的通知
暂停、失败、完成、取消是否停止服务
切后台后是否继续
应用被杀后通知是否残留
无通知权限时是否仍可安全运行
Android 12+ 启动限制是否满足
```

需要至少执行一次：

```text
真机或模拟器
切后台
锁屏
恢复前台
强制停止
重新启动
```

---

## 8.16 UI 错误出口

所有错误状态必须有用户可理解的操作：

```text
重试
更换模型
充值后继续
重新开始
放弃批次
导出数据
重新打开应用
查看错误详情
```

不得出现：

```text
无限转圈
按钮无效
运行状态与实际不一致
错误被吞掉
只打印 console.warn
```

---

## 8.17 版本和发版构建

核对：

```text
package.json version
src/constants/version.json
Android versionName
Android versionCode
README Badge
CHANGELOG
APK 文件名
```

检查同一版本是否已经存在多个代码状态。

如果当前版本提交后又进行了核心修复，必须提升版本号。

验证：

```text
旧 APK → 新 APK 覆盖安装
应用数据保留
Schema 正常升级
版本页面正确显示
```

---

## 8.18 安全和隐私

检查新增代码是否：

```text
把 API Key 写入 SQLite、日志或快照
把请求正文写入不安全日志
把用户小说正文写入外部目录
在 QA 脚本中提交本地数据库
将 keystore、签名信息或设备路径提交仓库
允许公共 HTTP 请求
```

特别检查：

```text
pipeline_stage_attempts
llm_config_snapshot_json
planner_request_json
QA dump 脚本
数据库拉取脚本
```

---

# 9. 第五阶段：测试覆盖要求

Agent 必须补充缺失测试，不得只修改实现。

## 9.1 纯函数测试

覆盖：

```text
批次状态决策
可恢复任务判定
失败分类
预算判定
项目漂移判定
模式对应阶段
```

---

## 9.2 Repository 事务测试

覆盖：

```text
创建章节和绑定 Item 原子性
创建 Task、checkpoint、run 和 Item 绑定原子性
结果采用和批次计数原子性
rowsAffected=0 回滚
外键错误回滚
重复执行幂等
```

---

## 9.3 Store 测试

覆盖：

```text
开始
暂停
恢复
取消
失败后创建新 run
可恢复阶段继续
不可恢复错误拒绝继续
冷启动重建
```

---

## 9.4 页面测试

至少新增：

```text
开始后立即进入运行页
开始按钮防重复点击
运行时进度刷新
暂停页操作
恢复按钮按错误类型显示
功能开关关闭
冷启动活跃批次显示
完成后报告页
```

---

## 9.5 状态机故障矩阵

必须覆盖至少以下崩溃点：

```text
CP01 批次创建后
CP02 规划结果写入前
CP03 计划确认后
CP04 章节创建后
CP05 Task 创建后
CP06 Draft 请求前
CP07 Draft 请求后
CP08 Review 请求后
CP09 Proof 请求后
CP10 正文写入后
CP11 fingerprint 写入后
CP12 completed_count 更新前
CP13 最后一章完成前
CP14 lease 过期
CP15 应用冷启动
```

---

# 10. 第六阶段：问题修复流程

每个问题都按以下顺序处理：

## 10.1 建立问题卡

```text
问题编号
严重级别
用户影响
代码证据
复现步骤
期望结果
实际结果
根本原因
涉及文件
修复方案
回归风险
新增测试
```

---

## 10.2 先写失败测试

能自动化的问题必须先添加失败测试。

确认测试在修复前能够稳定失败。

不允许添加一个从未失败过的“装饰性测试”，然后宣称覆盖了问题。

---

## 10.3 最小修复

修复必须满足：

```text
不破坏既有数据格式
不改变无关模块
不重复实现现有逻辑
不引入新的状态来源
不吞掉错误
不降低外键和事务保护
```

---

## 10.4 修复后专项验证

运行：

```powershell
npx jest <新增或相关测试文件> --runInBand
npm run typecheck
npm run lint
```

确认专项测试通过后，才进入下一个问题。

---

# 11. 第七阶段：全量回归

所有修复完成后必须执行：

```powershell
npm run verify
npm run apk:debug
```

具备条件时：

```powershell
npm run apk:release
```

并执行 Android 运行矩阵：

```text
新安装
旧版本覆盖升级
创建单章流水线
单章失败恢复
创建 1 章批次
创建 3 章批次
创建 10 章批次
暂停与恢复
取消批次
切后台
杀进程
冷启动
网络断开
429
上下文超限
```

不得只在 Jest 环境中宣称发版就绪。

---

# 12. Agent 必须输出的交付物

## 12.1 审计报告

建议文件：

```text
docs/release-audit/V2.11.xx-release-blocker-audit.md
```

包含：

```text
审计基线
本轮变更范围
基础验证结果
问题清单
每个问题的证据
修复内容
测试结果
未验证项
剩余风险
最终发版结论
```

---

## 12.2 问题矩阵

格式：

| ID | 级别 | 模块 | 问题 | 证据 | 是否复现 | 是否修复 | 测试 |
|---|---|---|---|---|---|---|---|

---

## 12.3 测试结果

必须记录真实数字：

```text
Lint：
TypeScript：
Jest suites：
Jest tests：
Debug APK：
Release APK：
模拟器：
真机：
```

---

## 12.4 变更清单

列出每个修改文件及目的。

不得仅输出 Git diff 数量。

---

## 12.5 未解决问题

对未处理问题明确说明：

```text
为什么没有修
是否阻滞发版
临时规避方式
建议后续版本
```

---

# 13. 最终发版判定模板

Agent 最终必须从以下三个结论中选择一个。

## 结论 A：允许正式发版

只有满足以下条件时才能给出：

```text
全部 P0 已修复
全部 P1 已修复或有明确批准的非阻滞理由
npm run verify 全绿
Debug APK 构建、安装和启动成功
升级迁移验证通过
AI 写 N 章主路径通过
暂停、恢复、取消和冷启动通过
无未解释的数据一致性问题
```

---

## 结论 B：仅允许关闭新功能发版

适用于：

```text
旧功能稳定
新功能仍有问题
Feature Flag 能可靠隔离
迁移不影响旧用户
新表和代码不会破坏旧路径
```

必须写明：

```text
哪些开关必须保持关闭
如何确认默认关闭
后续如何开启
```

---

## 结论 C：禁止发版

出现以下任一情况必须禁止：

```text
存在未解决 P0
全量测试失败
构建失败
迁移未验证
冷启动可能卡死
可能重复调用模型
用户模式选择不生效
批次可能并发推进
版本升级路径不成立
```

---

# 14. 必须重点核验的已知风险假设

以下内容只是待核验假设，不得直接当作结论。

Agent 必须根据当前本地代码逐项确认是否仍成立：

```text
1. 批次页面的模式选择是否真实进入单章 Pipeline 冻结配置
2. 点击开始后是否要等待整批完成才进入运行页
3. 运行期间是否可以重复点击开始
4. 应用杀进程后批次是否显示运行但实际无人执行
5. 项目尾部漂移保护字段是否在生产路径真实写入
6. 批次用量是否漏算失败和重试请求
7. failed / interrupted 是否被错误当作全部可恢复
8. lease 是否会在长章节执行时过期
9. 同一 owner 是否可重复进入协调器
10. 测试 fixture 是否人为设置了生产代码从未设置的字段
11. Feature Flag 关闭是否真正隔离全部入口
12. 当前版本号是否已经对应多个不同代码状态
```

如果本地最新代码已经修复其中某项：

```text
必须指出对应提交或代码位置
必须运行相关测试
必须说明为什么当前实现已经消除风险
```

---

# 15. 推荐检索命令

```powershell
rg "reconcileMultiChapterBatch|determineNextBatchAction" src __tests__
rg "pipelineMode|pipeline_mode|draft_only|fast|full" src __tests__
rg "startPosition|start_position|expectedTailChapterId" src __tests__
rg "claimBatchLease|releaseBatchLease|leaseExpiresAt|lease_expires_at" src __tests__
rg "resumePipeline|runChapterPipeline|getLatestResumable" src __tests__
rg "pipeline_stage_attempts|incrementBatchUsage|used_llm_calls" src __tests__
rg "multi_chapter_batch_enabled|elastic_budget_v2_enabled" src __tests__
rg "AppState|cold.start|interrupted|markActiveTasksAsInterrupted" src __tests__
rg "INSERT OR REPLACE|foreign_keys|ON DELETE" src
rg "catch \{\}|catch \(\) => \{\}|catch.*undefined" src
rg "setTimeout|sleep\(" src/services/multiChapterBatch src/store
rg "console.warn|console.error" src/services/multiChapterBatch src/store
```

---

# 16. 最终执行纪律

Agent 必须遵守：

```text
不要根据问题清单机械改代码
不要假设远端审查结果仍适用于本地 HEAD
不要只修 UI，不修真实状态机
不要只修状态机，不补测试
不要只跑目标测试，不跑全量验证
不要把功能开关关闭当作所有问题的修复
不要用代码注释代替证据
不要在未验证 APK 的情况下宣称正式可发版
不要在存在未提交用户改动时执行破坏性 Git 命令
```

最终结果必须让另一位开发者能够根据报告：

```text
复现每个问题
理解根因
审查修复
重复运行验证
独立判断是否可以发版
```