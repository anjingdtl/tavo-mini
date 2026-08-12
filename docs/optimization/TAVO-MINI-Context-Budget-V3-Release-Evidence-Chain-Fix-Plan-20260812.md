# TAVO-MINI Context Budget V3 发布级证据链修复与最终封板方案

> 文档日期：2026-08-12  
> 项目：`anjingdtl/tavo-mini`  
> 当前远端 HEAD：`ac5aa818ad4cfd1a1b91ee8a1a86e2a13bce3606`  
> 核心收口代码提交：`ee8d88e9fb8b8e876bee63d5205aeb598e4acadd`  
> 当前版本：ShineWriter `V2.11.49`  
> 当前状态：**NO-GO**  
> 本轮性质：**发布级证据链修复 / Final Seal 最后一轮，不属于功能扩展或算法优化。**

---

# 1. 当前验收结论

上一轮建设后，Context Budget V3 的代码层和 CI 层已经基本收口。

已经确认：

- Post-Coverage Episodic Demand Reclaim 主逻辑正常；
- T02 已补齐 Phase A → Phase B 的直接因果断言；
- final Resources allocation 明确高于 preliminary allocation；
- `borrowedTokens > 0` 自动化成立；
- hard input limit 未突破；
- V2 Proof Resume CI 红灯已通过 deterministic fake timer 修复；
- GitHub Actions 已全绿；
- JavaScript validation / Migration Matrix / Android Debug build 均通过；
- Batch Frozen Policy 自动化已覆盖；
- 3-child Batch cold-start resume 自动化已覆盖；
- `adb install -r` 已验证；
- 数据库 integrity 和数据保留已验证；
- 未发现需要继续修改 Context Budget V3 allocator / Story Coverage / Recent Raw Bridge / Episodic Reclaim 的生产 BUG。

因此：

> **本轮不再修改 Context Budget V3 主算法。**

剩余发布阻断集中在“Android 直接实证链”。

---

# 2. 本轮最终目标

只解决以下 5 个真正阻断发布的 Gate：

| Gate | 当前 | 本轮目标 |
|---|---|---|
| H Cross-board Borrow | NO-GO | GO |
| J Batch Policy Freeze Mutation | NO-GO | GO |
| K Single Resume | NO-GO | GO |
| L Batch Resume | NO-GO | GO |
| M Derived Final Android E2E | NO-GO | GO |

其余已经通过的核心代码与 CI Gate：

> **默认保持 GO，不因本轮没有重复截图而主动降级。**

除非本轮实机测试发现新的、可稳定复现的生产回归。

---

# 3. 严格建设边界

本轮禁止继续调整：

- hierarchical allocator 数学规则；
- board priority；
- soft / burst / hard envelope；
- Story Coverage；
- Recent Raw Bridge；
- Episodic demand reclaim；
- 32K / 64K / 128K / 1M 预算算法；
- context automation policy 默认值；
- Story Memory 主逻辑；
- pipeline protocol version；
- unknown outcome fail-closed 语义。

只有发现以下情况才允许修改生产代码：

```text
真实 Android / 自动化
可稳定复现
明确违反现有协议
并且能够证明不是测试夹具问题
```

所有修复必须遵循：

```text
复现
→ 保存原始证据
→ 定位
→ 最小修复
→ targeted
→ regression
→ Android 重测
→ full verify
```

---

# 4. Gate H — Cross-board Borrow 可观察性修正

## 4.1 当前问题

上一轮实现方向与封板方案发生偏差。

当前 Context Preview 被修改为：

> 只展示 V3 envelope 摘要，不展示 board 明细。

这导致 Android 无法直接观察四个板块：

```text
Story State
Resources
Sliding Window
Episodic
```

各自的：

```text
actualDemandTokens
softTargetTokens
allocatedTokens
borrowedTokens
```

因此即使自动化已经证明：

```text
Resources borrowedTokens > 0
```

也无法形成发布级 Android 直接证据。

## 4.2 修复原则

恢复 **只读诊断可观察性**。

不得：

- 增加 allocator 设置入口；
- 让用户修改 board 参数；
- 暴露 secret；
- 写入数据库；
- 修改 Context Builder 行为；
- 改变发送 payload。

推荐在 Context Preview 的 V3 budget 区域增加：

```text
展开详细分配
```

或仅在 debug / diagnostics 模式显示。

默认可保持紧凑，避免影响普通用户 UI。

## 4.3 必须展示

至少为 Story State、Resources、Sliding Window、Episodic Memory 分别展示：

```text
Demand
Soft
Allocated
Borrowed
```

同时保留 envelope：

```text
contextWindow
softInputLimit
burstInputLimit
hardInputLimit
mandatoryTokens
totalEstimatedInputTokens
```

## 4.4 建议 UI

示例：

```text
Resources
需求 8,420
软目标 5,300
最终分配 7,180
跨板借调 +1,880
```

若：

```text
borrowedTokens = 0
```

可显示：

```text
借调 0
```

不要隐藏 0 值，以便验收。

## 4.5 自动化

更新：

```text
__tests__/contextPreviewV4.test.tsx
```

不能再断言“不展示 board detail”。应改为至少覆盖：

```text
source contains demandTokens
source contains softTargetTokens
source contains allocatedTokens
source contains borrowedTokens
```

并确认：

```text
只读展示
无编辑控件
无 allocator mutation
```

## 4.6 Android 验收

必须构造一个真正满足：

```text
Resources demand > soft target
Resources borrowedTokens > 0
```

的场景。

实机证据至少：

```text
Resources borrowedTokens > 0
Resources allocatedTokens > Resources softTargetTokens
totalEstimatedInputTokens <= hardInputLimit
```

保存：

```text
screen-h-borrow.png
ui-h-borrow.xml
trace-h-borrow.json / txt
db-h-borrow.sqlite（如需要）
```

并记录：

```text
git SHA
app version
project id
chapter id
model context window
```

Gate H 满足后方可 GO。

---

# 5. Gate J — Android Batch Policy Freeze Mutation

## 5.1 目标

自动化已经证明：

```text
Batch created under Policy A
live settings changed to Policy B
later child still uses frozen A
```

本轮只补 Android 真实链。

## 5.2 测试要求

准备至少 3 个 child 的 Batch。

### Step 1

创建 Policy A，修改一个容易辨识、但不破坏运行的字段，例如：

```text
resources priority / elastic ratio
```

记录：

```text
Policy A JSON
Policy A hash
```

### Step 2

用 Policy A 创建 Batch，确认数据库：

```text
batch.contextAutomationPolicyHash = A
```

### Step 3

让 child #1 开始或完成。保存 child #1：

```text
pipeline_context_json
policy hash
```

### Step 4

Batch 不删除、不重建。直接修改 live settings 为 Policy B。

记录：

```text
live settings hash = B
A != B
```

### Step 5

继续执行 child #2 / #3。

## 5.3 必须证明

最终：

```text
batch frozen hash = A

live settings hash = B

child #1 = A
child #2 = A
child #3 = A
```

严格不得：

```text
child #2 = B
child #3 = B
```

## 5.4 证据

保存：

```text
screen-j-before-policy-mutation.png
screen-j-after-policy-mutation.png
db-j-before.sqlite
db-j-after.sqlite
j-policy-hashes.txt
```

建议输出：

```text
Policy A hash
Policy B hash
Batch hash
Child 1 hash
Child 2 hash
Child 3 hash
```

## 5.5 Gate J GO 条件

必须同时：

```text
自动化 PASS
Android 实机 PASS
DB snapshot PASS
hash 对照 PASS
```

---

# 6. Gate K — Single Pipeline Resume Android 闭环

## 6.1 目标

证明：

> 单章节 Pipeline 在部分 stage 已成功后发生中断，恢复后不重跑成功 stage，只继续未完成 stage。

## 6.2 推荐中断点

优先：

```text
draft       succeeded
review      succeeded
factCheck   succeeded
proof       running / interrupted
```

或当前生产协议中最稳定的等价节点。

## 6.3 中断方式

优先真实 Android：

```text
adb shell am force-stop com.shinewriter
```

前提：

- 不清数据；
- 不 uninstall；
- 不修改 DB；
- 不人工将 stage 改 completed。

## 6.4 Resume

重新启动 App，通过正常 Resume 路径恢复。

## 6.5 必须证明

Resume 前 attempts：

```text
draft = 1
review = 1
factCheck = 1
proof >= 1
```

Resume 后：

```text
draft = 1
review = 1
factCheck = 1
proof 增加 / 继续
```

最终：

```text
proof succeeded
task completed
```

并确认：

```text
workflow version 不变
context budget version 不变
frozen policy hash 不变
```

## 6.6 不允许

禁止为了测试制造：

```text
直接 UPDATE pipeline_tasks SET status='interrupted'
```

作为唯一实机证据。可以用于辅助诊断，但不能替代真实中断。

## 6.7 证据

```text
db-k-before-force-stop.sqlite
db-k-after-resume.sqlite
screen-k-before.png
screen-k-completed.png
logcat-k.txt
k-attempt-diff.txt
```

---

# 7. Gate L — Batch Resume Android 闭环

## 7.1 目标

必须证明：

> 真实 3-child Batch 中 child #2 中途被打断，冷启动后恢复，child #1 不重跑，child #2 继续，child #3 正常执行，parent 最终 completed。

## 7.2 起始状态

目标状态：

```text
child #1 = completed
child #2 = running
child #3 = pending
```

确认后保存 DB。

## 7.3 中断

真实：

```text
adb shell am force-stop com.shinewriter
```

不要：

```text
pm clear
uninstall
删除 batch
重新创建 batch
```

## 7.4 冷启动恢复

重新启动 App，让 Batch reconcile / resume 正常运行。

## 7.5 最终必须证明

```text
child #1 = succeeded
child #2 = succeeded
child #3 = succeeded
parent batch = completed
```

同时：

```text
child #1 pipeline attempt count 不增加
child #2 从原 active task resume
child #3 新建/执行正常
```

## 7.6 Unknown Outcome 处理

如果中断正好落在 LLM 请求 outcome unknown：

必须保持：

```text
fail-closed
不自动重复发送 LLM
```

此场景作为 safety 证据记录。

然后重新建立一个 **确定性可恢复中断场景** 完成 Gate L。

不得为了 Gate L：

```text
把 outcome_unknown 改成自动 retry
```

## 7.7 证据

```text
db-l-before-force-stop.sqlite
db-l-after-resume.sqlite
screen-l-1-completed-2-running.png
screen-l-final-3of3.png
logcat-l.txt
l-child-attempt-diff.txt
```

---

# 8. Gate M — Derived Final Android E2E

## 8.1 目标

证明 Derived Final 在当前最终 APK 上完整运行。

不能只用：

```text
derivedFinalPolicyFreeze.test
Final Seal shrink test
artifact validator
```

替代实机 E2E。

## 8.2 测试链

完整执行：

```text
Draft
→ Review
→ Fact Check
→ Proof / Final Reviser
→ Derived Final
→ Final validation
→ Chapter adoption
```

## 8.3 必须校验

```text
final artifact 非空
final revision 正确
source revision 对应正确
final validation PASS
chapter content 已采用最终结果
pipeline task = completed
```

若存在 Final Seal shrink：

```text
final input <= hard input limit
```

## 8.4 Resume 附加验证

如果 Derived Final 已 completed 后重启 App：

```text
不得重复生成 Derived Final
```

可记录为附加证据，不强制增加一次新的 LLM 调用。

## 8.5 证据

```text
db-m-final.sqlite
screen-m-final.png
m-final-artifact.txt
m-final-revision.txt
logcat-m.txt
```

注意：不得在证据中保存完整敏感 prompt、API key 或 credential。

---

# 9. E/F/G/I Gate 的处理规则

上一轮 Final Seal 将以下 Gate 降级：

```text
E 32K / 64K / 128K / 1M
F Big Resources
G Poison Legacy
I Model Switch
```

本轮不要求重新全面建设。

原因：

- 本轮核心代码提交没有继续修改 allocator；
- 没有继续修改 Coverage / Episodic / Raw Bridge；
- 已有自动化仍全绿；
- 当前问题主要为 Android 发布证据链。

因此：

> E/F/G/I 可沿用此前有效代码/自动化结论，不因“本轮没重新截图”自动降成生产 NO-GO。

但若 Agent 能低成本重新采证，可作为 Final Seal 附加证据。

不得为了重新采证：

- 修改算法；
- 修改生产参数；
- 删除测试数据；
- 延长本轮范围。

---

# 10. Gate O — Release Seal

当前 GitHub Actions 已全绿。

本轮完成 H/J/K/L/M 后必须重新执行：

```bash
npm ci
npm run verify:version
npm run lint
npm run typecheck
npm run test:ci
npm run verify
```

然后：

```bash
npm run apk:debug
```

或当前项目正式 debug build 命令。

安装：

```bash
adb install -r <apk>
```

## 10.1 GitHub Actions

推送最终提交后检查最终 HEAD：

```text
JavaScript validation = success
Migration Matrix = success
Android Debug build = success
```

只接受最终 HEAD 的 run。

不能用旧 commit 的 green run 替代。

---

# 11. 数据保护要求

全程：

```text
禁止 adb uninstall
禁止 pm clear
禁止删除数据库
禁止清空项目
```

每轮最终验证：

```text
pragma integrity_check = ok
projects count 合理
chapters count 不减少
```

检查：

```text
API key / credential 不进入 DB
API key / credential 不进入 git
API key / credential 不进入 test logs
```

---

# 12. 证据目录规范

统一保存到：

```text
test-logs/final-release-evidence-20260812/
```

建议结构：

```text
H-cross-board-borrow/
J-batch-policy-freeze/
K-single-resume/
L-batch-resume/
M-derived-final/
release/
```

每个 Gate 至少：

```text
README.txt
screen*.png
ui*.xml（如适用）
db*.sqlite（如适用）
trace*.txt/json
logcat*.txt
```

---

# 13. 每个 Gate 的 README 格式

示例：

```text
Gate: H
Git SHA:
App Version:
Device:
Project ID:
Chapter ID:
Start Time:
End Time:

Scenario:
...

Expected:
...

Actual:
...

Key Evidence:
...

Result:
GO / NO-GO
```

---

# 14. Final Seal 文档要求

更新：

```text
docs/optimization/Context-Budget-V3-Final-Seal-Verification-20260812.md
```

最终 Gate 表不要机械地把未重新截图的旧 Gate 全部改 NO-GO。

应区分：

```text
Code/Automation Regression Gate
Android Direct Evidence Gate
```

## 14.1 推荐最终表

| Gate | Code/Automation | Android Evidence | Final |
|---|---|---|---|
| A | PASS | N/A | GO |
| B | PASS | Existing | GO |
| C | PASS | N/A | GO |
| D | PASS | PASS | GO |
| E | PASS | Existing / optional refresh | GO |
| F | PASS | Existing / optional refresh | GO |
| G | PASS | Existing / optional refresh | GO |
| H | PASS | **必须新证据** | GO/NO-GO |
| I | PASS | Existing / optional refresh | GO |
| J | PASS | **必须新证据** | GO/NO-GO |
| K | PASS | **必须新证据** | GO/NO-GO |
| L | PASS | **必须新证据** | GO/NO-GO |
| M | PASS | **必须新证据** | GO/NO-GO |
| N | PASS | PASS | GO |
| O | PASS | Final HEAD CI | GO/NO-GO |

---

# 15. 发布 GO 的唯一条件

以下全部满足：

```text
[ ] Gate H Android Resources borrowedTokens > 0 直接证据
[ ] Gate J Android live policy A→B mutation 后 children 仍 frozen A
[ ] Gate K Android Single Resume 成功 stage 不重跑
[ ] Gate L Android Batch child 中断后 resume 到 3/3 completed
[ ] Gate M Android Derived Final E2E
[ ] npm run test:ci PASS
[ ] npm run verify PASS
[ ] APK build PASS
[ ] adb install -r PASS
[ ] 数据完整
[ ] credential 安全
[ ] 最终 HEAD 已 push
[ ] 最终 HEAD GitHub Actions 全绿
```

才允许：

```text
FINAL SEAL = GO
```

---

# 16. 禁止伪造发布证据

以下一律不算 GO：

```text
自动化测试替代指定 Android 实证
旧 SHA APK 截图替代当前最终 APK
手工 UPDATE DB 制造 completed
删除失败 task 后重新跑
重新建 Batch 替代 Resume
把 outcome_unknown 改成自动 retry
把 failed assertion 改 skip
隐藏 borrowedTokens 来绕开 Gate H
仅打印预期 hash，不查真实 persisted hash
用旧 GitHub Actions green run 替代最终 HEAD
```

---

# 17. 推荐执行顺序

```text
Step 1
修正 Gate H Preview/Debug board-level 只读可观察性

Step 2
targeted + full verify

Step 3
build APK + adb install -r

Step 4
完成 Gate H

Step 5
完成 Gate J

Step 6
完成 Gate K

Step 7
完成 Gate L

Step 8
完成 Gate M

Step 9
数据完整性、安全检查

Step 10
npm run test:ci + npm run verify + APK build

Step 11
提交并 push

Step 12
检查最终 HEAD GitHub Actions

Step 13
更新 Final Seal

Step 14
所有发布 Gate 全部闭环后才判 GO
```

---

# 18. Agent 最终汇报格式

Agent 完成后必须直接输出：

## 1. Final HEAD

```text
local HEAD:
origin/main:
working tree:
```

## 2. 修改文件

逐文件说明。

## 3. Gate H

```text
自动化：
Android：
关键数值：
证据目录：
结论：
```

## 4. Gate J

```text
Policy A hash:
Policy B hash:
Batch hash:
Child #1:
Child #2:
Child #3:
结论：
```

## 5. Gate K

```text
Resume 前 attempt counts:
Resume 后 attempt counts:
最终 task:
结论：
```

## 6. Gate L

```text
中断前：
恢复后：
child #1 attempt delta:
child #2 resume:
child #3:
parent:
结论：
```

## 7. Gate M

```text
Derived Final:
artifact:
revision:
validation:
chapter adoption:
结论：
```

## 8. Regression

```text
test:ci:
verify:
APK:
install:
DB integrity:
```

## 9. GitHub Actions

```text
Run ID:
JavaScript:
Migration:
Android:
```

## 10. Final Gate A–O

严格：

```text
GO
```

或：

```text
NO-GO
```

---

# 19. 最终说明

当前 Context Budget V3 已不处于“算法仍需优化”的阶段。

本轮真正需要完成的是：

> **把已经通过代码和自动化证明的行为，转换成可复核的 Android 发布级直接证据。**

特别是 Gate H：

> 不应继续隐藏 board-level allocation，而应以只读诊断方式提供足够的可观察性。

完成 H/J/K/L/M 后，如果最终 HEAD CI 仍全绿且没有新回归，即可进行 Context Budget V3 Final Seal 的最终 GO 判定。

本轮结束后，不应继续因为“证据形式不统一”重复开启算法改造。后续如有新问题，应作为独立 BUG / 新版本需求处理。
