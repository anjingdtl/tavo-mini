# TAVO-MINI Phase IV 优化建设与最终封板方案
## 写作通过率恢复、Writer Style 遵循验收与文学质量闭环

> 方案版本：Phase IV v2.0
> 编制日期：2026-08-31
> 当前施工仓：`E:\AiWorkSpace\tavo-mini`
> 远端仓：`anjingdtl/tavo-mini`
> 编制时远端 `main`：`24b65486337cf0c45a2a5aa9d82661d0f1644f23`
> 当前提交：`fix(phase4): restore DeepSeek thinking and add IV-11 evidence`
> Agent 开工时必须重新 `git fetch`，以实际 `origin/main` 为准。

---

# 0. 本方案定位

Phase IV 前半程已经完成主要工程减法：

- Gate 简化；
- JSON Contract 瘦身；
- Governor 旁路化；
- Context 阻滞治理；
- Persistence Boundary 收拢；
- DeepSeek Thinking Always On 恢复；
- reasoning / final content 通道分离；
- Draft Completion Boundary；
- pathological plan 结构等价回归；
- 真实 Android 5/10 章稳定性验证。

下一阶段不再继续扩展流水线架构。

本方案的核心任务是：

> **证明 Phase IV 在恢复一次生成成功率、降低阻滞与延迟的同时，没有牺牲项目已配置 Writer Style 的遵循度和小说叙事质量。**

文学质量不使用脱离项目设定的“泛化审美评分”作为主判断。

正式定义：

```text
文学质量
=
Writer Style Adherence
+
Narrative Completion Quality
```

其中第一优先级是：

# Writer Style Adherence

即：

> **正文是否真正按照当前项目已经配置的“作家风格”写作。**

---

# 1. 当前 Phase IV 状态

当前远端已完成的关键能力：

```text
Gate 减法                       DONE
JSON 协议瘦身                  DONE
Governor Current Request Bypass DONE
Mandatory + Elastic Context    DONE
Persistence Boundary           DONE
Thinking Always On             DONE
Reasoning / Final 分离          DONE
Draft Completion Boundary      DONE
结构等价 Pathological Plan      3/3 PASS
真实 5 章 Fast/One-Shot         5/5 PASS
修复后真实 10 章 Fast/One-Shot  10/10 PASS
```

当前仍未封板的核心原因：

```text
Writer Style 遵循率没有形成正式验收分母
Standard / Quality 没有完成同题文学质量 A/B
Completion Boundary 的文学副作用尚未排除
现有“文学质量”主要是文本形态代理指标
```

因此 Phase IV Final Seal 继续：

```text
HOLD
```

直到 Writer Style 与叙事质量证据闭环。

---

# 2. 核心原则

## 2.1 Writer Style 是文学质量 SSOT

文学风格验收必须以项目当前实际配置并进入 Frozen Context 的 Writer Style 为唯一基准。

不得以：

- “评测模型个人偏好”；
- “网文平均风格”；
- “更华丽就是更好”；
- “句子更长就是更文学”；

替代 Writer Style。

如果 Writer Style 要求：

```text
短句
冷静克制
少心理直述
对白简短
第三人称限知
避免比喻堆砌
章节末尾留余味
```

则正文按这些规则执行才是“质量高”。

即使另一种写法更华丽，只要偏离已配置 Style，就属于 Style Drift。

## 2.2 文学质量评估不能进入生产写作主链

本轮新增的文学质量评测只能存在于：

```text
Test
Evidence
Acceptance
Offline Evaluator
```

不得进入：

```text
正常 Draft
正常 QA
正常 Revision
正常 Persist
```

禁止新增：

- Literary Judge LLM Stage；
- 自动文学打分 Gate；
- 因文学评分自动 retry；
- 因 Style 分数自动 re-plan；
- 第二 Writer；
- 第二 Context Builder；
- 第二 Prompt Compiler。

文学质量是 **Final Seal 的测试 Gate**，不是运行时 Gate。

## 2.3 Thinking Always On

所有真实生产写作测试：

```text
Thinking = ON
```

Fast / Standard / Quality 只能调整：

```text
reasoning effort
pipeline depth
existing QA / Revision depth
```

不得关闭 Thinking。

## 2.4 同题 A/B

比较不同档位时，必须尽量保持：

```text
同 Writer Style
同 Plan
同 Frozen Context
同目标字数
同 Provider
同 Model
同章节位置
```

只改变：

```text
Fast / Standard / Quality
```

否则结果不能用于判断质量档价值。

---

# 3. Writer Style Adherence Contract

## 3.1 风格要求结构化

测试时，从真实 Writer Style 配置中提取“可验收风格要求”。

建议归一为：

```text
Style Requirement
├─ id
├─ category
├─ rule
├─ strength
├─ applicability
└─ evidenceExpectation
```

例如：

```text
S01 POV
第三人称限知
mandatory

S02 Dialogue
对白短促，少解释性台词
preferred

S03 Psychology
避免大段直接心理解释
mandatory

S04 Rhythm
冲突场景使用较短句
preferred

S05 Ending
章节收束留余味，不直接总结主题
preferred
```

这里只做测试侧 projection。

不得新建第二套生产 Writer Style 系统。

## 3.2 Rule 强度

统一：

```text
MANDATORY
PREFERRED
AVOID
```

### MANDATORY

违反即：

```text
Hard Style Violation
```

### PREFERRED

统计遵循情况，但单条偏离不直接使章节失败。

### AVOID

出现时统计 Style Drift。

---

# 4. 核心文学质量指标

## 4.1 Writer Style Mandatory Pass

```text
Mandatory Style Pass Rate
=
满足的适用 Mandatory Rule
/
全部适用 Mandatory Rule
```

Final Seal 要求：

```text
Hard Style Violation = 0
```

## 4.2 Writer Style Adherence Rate

对本章适用 Style Rule 计算：

```text
Writer Style Adherence Rate
=
Σ satisfied applicable rule weights
/
Σ applicable rule weights
```

不适用于该章的 Style Rule 不进入分母。

## 4.3 Style Drift Count

重点记录：

- POV Drift；
- Voice Drift；
- Dialogue Drift；
- Description Density Drift；
- Psychology Drift；
- Rhythm Drift；
- Ending Drift；
- Explicit Forbidden Pattern。

## 4.4 Narrative Completion Quality

文学质量不能只看 Style。

同时检查：

```text
Scene Completion
Beat Realization
Causal Continuity
Character Consistency
Emotional / Dramatic Effectiveness
Ending Effectiveness
```

重点问题：

> 是否真的把这一章“演出来”，而不是摘要式完成任务。

---

# 5. 原有文本形态指标重新定位

现有：

- 正文长度；
- 句长；
- 段长；
- 对白比例；
- 重复率；
- 结尾标点；
- 转场次数；
- 协议泄漏；

继续保留。

但统一更名/定位为：

# Literary Shape Telemetry

它们只能用于：

```text
辅助解释 Style Drift
辅助发现机械重复
辅助发现 Completion Boundary 副作用
```

不得单独作为：

```text
文学质量 PASS / FAIL
```

---

# 6. Completion Boundary 文学副作用专项

Phase IV 新增的 Draft Completion Boundary 已解决 runaway 风险，但必须排除以下副作用：

## 6.1 调查/悬疑

检查是否：

```text
为了避免清单无限展开
→ 把关键调查过程写成摘要
```

## 6.2 情绪戏

检查是否：

```text
因果完成后立即停止
→ 情绪没有充分沉淀
```

## 6.3 动作戏

检查是否：

```text
为了快速收束
→ 跳过关键动作—反应—后果链
```

## 6.4 慢节奏章节

检查是否：

```text
Completion Boundary
→ 把氛围章写成任务清单
```

## 6.5 章节结尾

检查是否大量形成：

```text
任务完成
→ 留一个钩子
→ 结束
```

导致 Ending Pattern 模板化。

---

# 7. 文学质量评测方法

采用：

```text
Deterministic Rule Check
+
Blind Human / Independent Evaluator
```

## 7.1 Deterministic

负责：

- 明确 Writer Style Mandatory；
- 禁止项；
- POV；
- 协议泄漏；
- 明显重复；
- 可机械验证的格式/表达要求。

## 7.2 Blind Evaluation

评审输入只包含：

- 必要任务目标；
- Writer Style 要求；
- 最终正文。

评审不知道：

- Fast / Standard / Quality；
- 修改前 / 修改后；
- 哪个版本；
- 哪次是目标候选。

评估：

```text
Writer Style Adherence
Scene Completion
Beat Realization
Character Consistency
Causal Continuity
Ending Effectiveness
```

允许人工评审，也允许使用独立评测模型作为辅助。

评测模型不得进入生产流水线。

---

# 8. Fast / Standard / Quality 同题矩阵

## 8.1 第一轮最小矩阵

选择至少 4 类代表性任务：

```text
A 人物对白冲突
B 情绪/关系推进
C 悬疑调查/清单型
D 动作/强因果推进
```

每个任务：

```text
Fast
Standard
Quality
```

总计至少：

```text
4 × 3 = 12 篇真实正文
```

## 8.2 第二轮风险补充

若第一轮发现 Style Drift 或档位差异不清晰，再增加：

```text
E 世界观信息密集
F 慢节奏氛围
G pathological structural-equivalent
```

---

# 9. 档位价值验收

## Fast

```text
高 First-Pass
基本 Writer Style 不跑偏
适合快速生产
```

## Standard

```text
Writer Style 遵循稳定
Canon / Continuity 更稳
QA 有实际价值
```

## Quality

```text
在不改变 Writer Style 的情况下
进一步提升叙事完成度、人物稳定性和细节质量
```

如果出现：

```text
Quality 比 Fast 更华丽
但更偏离 Writer Style
```

则：

```text
Quality = FAIL
```

---

# 10. Style Non-Regression Gate

每个档位都必须：

```text
Hard Style Violation = 0
```

同时：

```text
Standard 不得出现系统性 Writer Style 退化
Quality 不得出现系统性 Writer Style 退化
```

若 Quality：

```text
Token ↑
Latency ↑
但 Writer Style / Narrative Completion 无改善
```

则记录：

```text
Quality Value Questionable
```

不得伪称“更高质量”。

---

# 11. IV-12 PDCA 阶段

## IV-12A — Writer Style Evaluation Contract

目标：

> 建立以真实 Writer Style 为 SSOT 的测试合同。

任务：

- 找到当前 Writer Style 的真实 Freeze / Projection 路径；
- 生成测试侧 Style Requirement Projection；
- 不改生产写作链；
- 建立 Style Adherence evidence schema。

GO：

```text
Style Rule 可追溯
Mandatory / Preferred / Avoid 可区分
不新增生产 LLM Stage
```

## IV-12B — Same-Task Literary A/B

执行：

```text
4 个计划
×
Fast / Standard / Quality
```

每个样本同时采集：

```text
Writer Style Adherence
Hard Style Violation
Style Drift
Narrative Completion
Pipeline Stability
Token
Latency
Physical Calls
```

GO：

```text
12 个样本完整
无 P0 Style Violation
数据可配对比较
```

## IV-12C — Completion Boundary Literary Regression

重点使用：

```text
调查
情绪
动作
慢节奏
清单型
```

判断新 Completion Boundary 是否导致：

- 场景缩水；
- 摘要化；
- 情绪过快；
- 结尾模板化；
- 有意义重复被误抑制。

如果存在：

```text
NO-GO
→ Root Cause
→ 最小 Prompt 修正
→ 重新 A/B
```

## IV-12D — Quality Tier Value

比较三档：

```text
Style
Narrative
Cost
Latency
Calls
First-Pass
```

输出：

```text
Fast Value
Standard Value
Quality Value
```

不得仅凭档位名字推断 Quality 一定更好。

## IV-12E — Final Production Revalidation

文学质量修正若引起生产 Prompt 改动，则重新：

```text
pathological equivalent 3/3
5章
10章
```

若未修改生产 Prompt，可只做 targeted 5章 + representative style checks。

任何 P0 / completion behavior 变化都必须重新跑完整 10 章。

---

# 12. Final Seal 指标

最终必须同时满足：

## Safety

```text
Thinking Always On
Mandatory Truth intact
length 不落 Final
outcome_unknown 不自动 retry
Governor physical call=0
Governor 不阻断 current request
无 hidden retry
Resume / Idempotency 正常
DB / accounting 正常
Canon / Story Memory 不污染
```

## Throughput

```text
First-Pass 稳定
无稳定 runaway
无异常 Context Block
无新增 Physical Calls
```

## Literary Quality

```text
Hard Style Violation = 0
Writer Style Adherence 稳定
Standard / Quality 不发生系统性 Style Drift
场景完整
关键 Beat 真正发生
人物稳定
因果完整
Completion Boundary 不造成文学性缩水
```

## Engineering

```text
targeted tests PASS
typecheck PASS
lint -- --quiet PASS
verify:elastic PASS
full verify PASS
APK PASS
adb install -r PASS
crash/ANR = 0
```

---

# 13. 不允许的“文学质量修复”

禁止：

```text
为了文学评分增加一个生产 Judge LLM
为了 Style 分数自动 retry
失败后自动 re-plan
增加第二 Writer
增加第二 Context
增加第二 Prompt Compiler
恢复复杂 JSON
恢复冗余 Gate
关闭 Thinking
固定业务 maxTokens
```

如果文学质量有问题，应优先定位：

```text
Writer Style Projection
Prompt wording
Stage-specific Style Requirement
QA / Revision instruction
Completion Boundary wording
```

然后最小修正。

---

# 14. Evidence 要求

仓库提交只保存脱敏证据。

允许：

```text
Rule IDs
Adherence Rate
Violation Count
Style Drift Category
Narrative Dimension Score
Tokens
Latency
FinishReason
Physical Calls
Quality Profile
Reasoning Effort
Correlation Key
```

不得保存：

- API Key；
- reasoning 原文；
- 完整小说正文；
- 完整敏感 Prompt。

---

# 15. Final Report 必须回答

最终报告必须明确回答：

1. Fast / Standard / Quality 是否都真正遵守 Writer Style？
2. 哪个档位 Style Adherence 最稳定？
3. Standard 的 QA 是否带来实际文学/一致性收益？
4. Quality 的额外成本是否换来实际收益？
5. Completion Boundary 是否导致场景缩水？
6. 是否出现模板化结尾？
7. 是否出现人物声音漂移？
8. 是否出现 POV / Psychology / Dialogue 等 Style Drift？
9. First-Pass 提升是否以文学质量下降为代价？
10. Phase IV 是否真正做到：

```text
高通过率
+
高效率
+
Writer Style 不丢
+
小说质量不降
```

---

# 16. Final Seal

只有：

```text
Safety PASS
AND
Throughput PASS
AND
Writer Style PASS
AND
Narrative Quality PASS
AND
Engineering PASS
```

才允许：

# `PHASE IV FINAL SEALED / GO`

否则：

```text
NO-GO
→ Root Cause
→ 最小修正
→ PDCA
→ 重测
```

---

# 17. 最终执行原则

```text
文学质量不是“模型觉得好看”。

文学质量首先是：
有没有按照用户已经配置好的作家风格去写。

Style 是基准，
正文是证据，
场景完整性是底线，
通过率与速度不能以风格漂移为代价。

后台可以复杂，
正常写作链保持简单。

文学评测属于验收系统，
永远不回灌成新的生产阻滞 Gate。
```
