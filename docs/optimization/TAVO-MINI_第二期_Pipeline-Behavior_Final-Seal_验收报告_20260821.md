# TAVO-MINI 第二期 Pipeline Behavior Final Seal 验收报告

项目：TAVO-MINI / ShineWriter  
唯一施工基线：F:\ClaudeWorkSpace\projects\TAVO-MINI  
验收依据：docs/optimization/TAVO-MINI_第二期_Pipeline-Behavior_测试与修复收口方案_V1.0.md  
版本：V2.11.54  
最终脱敏证据：docs/optimization/evidence/PHASE2_PIPELINE_BEHAVIOR_EVIDENCE_FINAL.md  
本地采集包（不入库）：test-logs/emulator-qa-final-20260822-9FFBE1/PIPELINE_BEHAVIOR_EVIDENCE.md

## 1. SHA 绑定

Git SHA 与 APK SHA 不得混用。生产源码 SHA ≠ 仓库 docs/CI 子提交 SHA。

| 字段 | 值 | 含义 |
|---|---|---|
| finalProductionCodeHead | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` | 最终生产 Git SHA（`fix(writing): close pipeline behavior persistence loop`） |
| ciValidatedHead | `0a5640699ac4ab235fcaa9f634ea683863faf492` | 本轮显式接入 Pipeline Behavior suites 的 Git SHA（`ci(writing): lock pipeline behavior final seal gates`）。其祖先 `6d389f8d` 已由远端 Verify + Generation Stability 于 2026-08-22 验证通过 |
| androidValidatedHead | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` | Android 实际验证的生产源码 Git SHA |
| realLlmValidatedHead | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` | 真实 LLM 实际验证的生产源码 Git SHA |
| finalRepositoryHead | `0a564069` 的 docs 子提交（本报告所在提交） | 最终远端 HEAD，是 CI/docs-only 后代，不是新的生产源码 SHA。精确值以 push 后 `git rev-parse origin/main` 为准 |
| apkSha256 | `9FFBE113B9DAFF5A914618741F5177396067E0BDCD702D57E627D211D21EC8AC` | live 2+2+1+1 矩阵 APK SHA-256 |
| appVersion | V2.11.54 / versionCode 2115400 | 构建元数据 |

### 1.1 Ancestry

```text
0148c4a25145e1876d9387bd936d5f3d8e5910b0
  docs(writing): seal phase 2 after remote verification
    └── 5284c1a3e75eef5c368c6e0d35083ccd55ffd792
          docs: add pipeline behavior next-step execution plan
            └── 6d389f8da48cf7a61d810246ef9e4a71d7e3fc18
                  fix(writing): close pipeline behavior persistence loop
                  ← finalProductionCodeHead
                  ← androidValidatedHead
                  ← realLlmValidatedHead
                    └── 0a5640699ac4ab235fcaa9f634ea683863faf492
                          ci(writing): lock pipeline behavior final seal gates
                          ← ciValidatedHead
                            └── docs(optimization): publish phase-two final evidence and seal report
                                  ← finalRepositoryHead
                                  不修改 src/，因此不是新的生产源码 SHA
```

过时写法（已作废，不得再引用）：

- `finalRepositoryHead = 0148c4a…`（那是 6d389f8 之前的 docs 提交，不是最终生产源码）
- `origin/main = 0148c4a…`（fetch 后 origin/main 已是 6d389f8，随后为本轮 CI/docs 子提交）
- `realLlmValidatedHead = APK SHA`（Git SHA 与 APK SHA 混用）

### 1.2 本轮是否重跑真实 LLM

本轮只增加 workflow、test gate、脱敏证据和文档，没有修改 `src/`、配置语义或运行时依赖。因此：

- 不重跑 Outline/Continuation 2+2+1+1；
- 真实样本继续绑定生产源码 SHA `6d389f8d`；
- live APK SHA-256 保持 `9FFBE113…`；
- `dist/` 中后来出现的 debug 重建 `69C20D1C…` 只是同一生产树的后续构建 / C3 smoke，不是第二份 live LLM 矩阵。

## 2. Gate 判定

| Gate | 判定 |
|---|---|
| C0 Exact Baseline | PASS（fetch 后生产 HEAD = `6d389f8d`） |
| C1 Deterministic DAG | PASS |
| C2 Resume / Crash | PASS |
| C3 Android Full Flow | PASS（`adb install -r`，未 uninstall / pm clear） |
| C4 Real LLM 2+2+1+1 | PASS（6 个有效样本，见最终证据） |
| C5 Full Regression | PASS（Verify / Generation Stability / Migration / Android Debug） |

## 3. 真实样本

有效样本为 Outline Standard×2、Continuation Standard×2、Outline One-Shot×1、Continuation One-Shot×1，共 6 个。每个样本的 Expected DAG、Actual DAG、Logical/Formatter/Physical/Fallback/Retry、Token、ledger、Final Candidate、Persist、PostWriting、Memory 见：

`docs/optimization/evidence/PHASE2_PIPELINE_BEHAVIOR_EVIDENCE_FINAL.md`

概要：

- Outline 310：Standard，QA clean，Revision skip，Final Candidate=Draft。
- Outline 311：Standard，QA executable finding，Revision×1，Final Candidate=Revision。
- Continuation 313/314：Standard，QA/Conditional Revision 均各 1 次，Final Candidate=adopted Revision，PostWriting/Memory outbox 最终 settled。
- Outline 312：One-Shot，Draft×1，QA/Revision formal skip，Final Candidate=Draft。
- Continuation 316：One-Shot，Draft×1，QA/Revision formal skip，state extraction 与 Story Memory outbox 最终 completed。

覆盖核对：至少 1 个 Standard Clean（310）与 1 个 Standard Needs Revision（311；313/314 同样是 Needs Revision）。

## 4. 产品收口

- Outline 与 Continuation 当前 Compact 任务共用同一 Writing Kernel、ONE Context、Freeze、Draft、ONE QA、Conditional Revision、FinalValidate、Persist、PostWriting/ONE Memory 语义。
- 不新增第二套 Pipeline、Writer、QA、Context 或 Memory。
- 不新增 Proof/Judge；有效真实矩阵没有旧 Review/Audit/FactCheck/Proof 调用。
- 当前结果页统一为 compact stage strips；采纳、放弃、失败/过期路径的重试/继续操作恢复。
- One-Shot 只改变冻结 profile 下 QA/Revision 的正式状态，不创建另一条 Pipeline。
- 旧 workflow/schema 与旧历史任务仅作为读取兼容，不作为当前 Compact 生产执行入口。

## 5. Generation Stability 显式接入

本轮把 Pipeline Behavior 关键 Red Tests 从「仅靠 `npm run test:ci` 间接覆盖」改为 Generation Stability 显式 `--runTestsByPath`：

- `__tests__/continuationPipelineDagContract.test.ts`
- `__tests__/continuationPipelinePostWritingClosure.test.ts`
- `__tests__/outlineFinalizePostWritingIntegration.test.ts`
- `__tests__/outlinePostWritingOutbox.test.ts`
- `__tests__/writingPipelinePostWritingClosure.test.ts`
- `__tests__/writingCompactFormatterPolicy.test.ts`
- `__tests__/writingStageBudgetBinding.test.ts`
- `__tests__/writingTokenLedger.test.ts`

`__tests__/phaseTwoGenerationStabilityGate.test.ts` 反向检查：文件存在、workflow 明确运行、无 `.skip/.only/xdescribe/xit/fit/fdescribe`、workflow 无 `continue-on-error` / `allow-failure` / `|| true` / `SKIP_PHASE2`。

先证明未接入时 Red，再修改 workflow 转 Green。

## 6. 旧 NO-GO 文档

`docs/optimization/TAVO-MINI_第二期_Pipeline-Behavior_未完成项_下一步执行计划_V1.0.md` 已标记 **SUPERSEDED / HISTORICAL**。它记录 2026-08-22 收口复审过程，不再代表当前项目结论。当前结论以本 Final Seal 报告与 `6d389f8d` 生产 SHA 为准。

## 7. Final decision

本次验收同时满足：

- Pipeline Divergence = 0
- Unexpected LLM Stage = 0
- Duplicate Paid Call = 0
- Hidden Physical Call = 0
- Freeze Drift = 0
- Final Candidate Drift = 0
- PostWriting Break = 0
- Memory Drift = 0
- Generation Stability 新 Gate 全部显式接入
- 真实 2+2+1+1 与 Production SHA 可追溯
- Final Seal 报告 SHA 字段区分 Git / APK / 生产 / docs-CI 子提交

因此宣布：

```text
PHASE 2 FINAL SEALED / GO
```
