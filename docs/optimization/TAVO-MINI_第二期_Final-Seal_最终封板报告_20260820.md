# TAVO-MINI 第二期 Final-Seal 最终封板报告

日期：2026-08-20（Asia/Shanghai）

结论：`PHASE 2 FINAL SEALED / GO`

## 1. Final HEAD 身份

| 字段 | 值 |
|---|---|
| `remoteMainBeforeWork` | `31e86b3e206ff508255e1e16d1ca8e09e252f5f1` |
| `finalRepositoryHead` | `d9b603df81006e417a24890a3665911fe196d135` |
| `finalProductionCodeHead` | `d9b603df81006e417a24890a3665911fe196d135` |
| `ciValidatedHead` | `d9b603df81006e417a24890a3665911fe196d135`（本地 `generation-stability.yml` workflow-equivalent） |
| `realLlmValidatedHead` | `d9b603df81006e417a24890a3665911fe196d135` |

开工前已执行 `git fetch origin main`；远端 `main` 未新增提交，未发现需要追加审计的远端变更。最终代码提交仅为：

```text
d9b603d ci(writing): wire phase-two gates into generation stability workflow
```

本轮没有修改主流水线架构、Writer/QA/Context/Memory 数量或 Stage 集合。工作树中保留用户提供的封板方案文档；本报告为 docs-only 证据产物，不改变上述生产 HEAD。

## 2. 本轮施工

已修改：

- `.github/workflows/generation-stability.yml`
- `__tests__/phaseTwoGenerationStabilityGate.test.ts`

Workflow 现在显式以 `--runInBand --runTestsByPath` 运行全部 12 个二期 suite；Gate 同时校验每个 suite 的显式路径，并拒绝 focused/skipped test、`allow-failure`、`continue-on-error`、`|| true` 与 `SKIP_PHASE2`。本地 `git diff --check` 通过。

12 个显式 suite：

```text
writingPhase2Baseline.test.ts
writingFinalCandidateContract.test.ts
outlineWorkflowVersion.test.ts
writingProofRemovalContract.test.ts
writingQaConsolidationContract.test.ts
outlineStageRuntimeRunQaDispatch.test.ts
writingQaDurablePreloadContract.test.ts
writingCompactSemanticApplyContract.test.ts
writingOneShotCompactQaSkip.test.ts
writingRevisionTriggerContract.test.ts
continuationCompactLedgerContract.test.ts
phaseTwoGenerationStabilityGate.test.ts
```

## 3. Android Debug / Install / 配置保留

最终 HEAD 的 `npm run apk:debug`：`BUILD SUCCESSFUL`。

```text
APK: dist/apk/debug/ShineWriter-V2.11.54-debug.apk
bytes: 52541500
SHA256: FBF7336BC445F8CFDEFF2CA43BEBC6866DA816F61F63B08729F020D9FF408223
versionName: V2.11.54
versionCode: 2115400
targetSdk: 36
```

在 `emulator-5554` 上执行 `adb install -r`，结果为 `Success`。`firstInstallTime` 保持为 2026-08-08，未执行 `pm clear`、`uninstall` 或任何 App 数据清除。安装后四个最终批次仍全部存在且为 completed。

保留的活动 LLM 配置（密钥未进入报告）：

```text
provider: openai_compatible
base_url: https://api.deepseek.com
model: deepseek-v4-flash
context_window: 1000000
max_output_tokens: 200000
```

One-Shot 运行仅通过现有 UI 配置切换为 `pipeline_execution_profile=one_shot`、`pipeline_reasoning_effort=low`；没有新增固定 Token cap。

## 4. Production DAG 与架构门禁

```text
ONE Production Entry = 1
ONE Kernel = 1
ONE Writer Core = 1
ONE Prompt Compiler = 1
ONE QA = 1
ONE Context = 1
ONE Memory = 1
```

标准 compact DAG：

```text
Draft → QA → Conditional Revision → FinalValidate → Persist
```

One-Shot 冻结策略：一次 Draft paid LLM；QA/Revision/旧审查 Stage 均策略跳过；随后仍执行 FinalValidate、Persist 与既有 PostWriting/状态同步闭环。

## 5. Final HEAD 真实 LLM 证据

所有下表均来自最终 HEAD 安装后的 App 数据库快照，未使用旧 HEAD live 证据。计数格式为 `logical / formatter / physical / fallback`；Token 为 `input / output`。

### 5.1 Outline Standard 2/2

批次：`batch_mt1a27p2_9vnrrz`，`status=completed`，`topology=compact_standard (2)`，`workflow=4`，`context_budget=7`，批次总调用 6（规划调用 2；章节 kernel 调用按 trace 计）。

| chapter | generationTraceId | freezeFingerprint | profile | Draft | QA | Revision | FinalValidate / Persist | logical/formatter/physical/fallback | tokens |
|---:|---|---|---|---|---|---|---|---|---:|
| 248 | `gt-mt1a5fon-0fzpr3py` | `616fbad4fb14cfc81846fe84949ebb0f64e53c1c9556d7a56ed146ba6364fb0d` | standard | 1/0/1/0 | 1/0/1/0 | 0/0/0/0 | PASS / PASS | 2/0/2/0 | 18,903 / 7,637 |
| 249 | `gt-mt1a7ai9-yj7e77ih` | `1fd958f80a50dd7a5ad5b8e627e43f8b60f2140025793fc7069f47ee53f201e2` | standard | 1/0/1/0 | 1/0/1/0 | 0/0/0/0 | PASS / PASS | 2/0/2/0 | 19,715 / 6,134 |

两章均为 `FinalValidate=completed`、`Persist=completed`，采用 revision 已持久化（revision 177、178）。第 249 章 QA 文本包含非结构化的泛化叙述，但没有 blocking/warning 的可定位可执行 finding；按正式 Revision Trigger Contract 正确保持 Revision=0，未人为篡改 QA。

### 5.2 Continuation Standard 2/2

批次：`batch_mt1apqop_qj7coa`，`status=completed`，`topology=compact_standard (2)`，`workflow=4`，`context_budget=7`，批次总 LLM=4。

| chapter | generationTraceId | freezeFingerprint | profile | Draft | QA | Revision | FinalValidate / Persist | logical/formatter/physical/fallback | tokens |
|---:|---|---|---|---|---|---|---|---|---:|
| 250 | `gt_b6271d9b0f289f278af5066dc652f8ac` | `af1635fd69dca5a849c308c3e5af8ca331db78316dc7863987e0beec475f653a` | standard | 1/0/1/0 | 1/0/1/0 | 0/0/0/0 | PASS / PASS | 2/0/2/0 | 51,002 / 2,510 |
| 251 | `gt_f15c7eb19c9e32308fd1ed3a32a057c4` | `879032c99f9ac26c6a45e6b15f5f3fefc0d6ac580b447aa87b890b750811ffa9` | standard | 1/0/1/0 | 1/0/1/0 | 0/0/0/0 | PASS / PASS | 2/0/2/0 | 51,555 / 9,120 |

Continuation ledger 仅出现以下现代 stage：

```text
draft_writer      success / request_count=1
unified_qa        success / request_count=1
revision_writer   skipped / request_count=0
final_validate    success / request_count=0
```

每章的 final artifact 已 finalized/adopted，`completion_reason=adopted`；对应 exact `extract_state` 与 `rebuild_story_memory:auto` 均 completed。批次期间第 251 章曾出现状态同步等待/重试，但 LLM 调用始终为 4，未产生重复付费调用。

非计入样本：早先一次 Outline Standard 尝试的第 2 章收到网络 `outcome_unknown` 后按 fail-closed 规则停止，未 resume、未 retry、未冒充 Final HEAD 证据；最终封板只采用本节列出的新批次 `batch_mt1a27p2_9vnrrz`。

### 5.3 Outline One-Shot 1/1

批次：`batch_mt1blsye_8up1vx`，`status=completed`，`topology=compact_standard (2)`，`workflow=4`，`context_budget=7`，`profile=one_shot`，批次总 LLM=1。

| chapter | generationTraceId | freezeFingerprint | Draft | QA / Revision / Review / Audit / FactCheck / Proof | FinalValidate / Persist | logical/formatter/physical/fallback | tokens |
|---:|---|---|---|---|---|---|---:|
| 252 | `gt-mt1bmp7k-rseow9xb` | `7a4e06a64e19e33c278358d6cd7bf66fdb476afe1cfaac58da9aff33b48c8892` | 1/0/1/0 | 0 / 0 / 0 / 0 / 0 / 0 | PASS / PASS | 1/0/1/0 | 11,991 / 4,223 |

QA/旧审查/Revision/Proof 的 trace/stage row 均为策略 skip 或不存在的 paid call；`chapterWritingPaidCallCount=1`。

### 5.4 Continuation One-Shot 1/1

批次：`batch_mt1btnp5_x0jcmb`，`status=completed`，`topology=compact_standard (2)`，`workflow=4`，`context_budget=7`，`profile=one_shot`，批次总 LLM=1。

| chapter | generationTraceId | freezeFingerprint | Draft | QA | Revision | FinalValidate / Persist | logical/formatter/physical/fallback | tokens |
|---:|---|---|---|---|---|---|---|---:|
| 253 | `gt_ce47ad8fd80c1bb87284cefc5b360439` | `8ee30f80aea7cb5a4117cfd58eecdeb7e179de019a85f55f75eb4f245e73b698` | 1/0/1/0 | 0/0/0/0 | 0/0/0/0 | PASS / PASS | 1/0/1/0 | 31,869 / 1,547 |

Continuation ledger：`draft_writer=success/request_count=1`、`unified_qa=skipped/request_count=0`、`revision_writer=skipped/request_count=0`、`final_validate=success/request_count=0`。final artifact hash 为 `4be43d3ef59f59a8796fc10c94b085d47dced2a6a83d6eb20158d6c16116c9cc`，exact state extraction 与 Story Memory rebuild 均 completed。

## 6. 硬门禁结果

| Gate | Result | Evidence |
|---|---|---|
| Clean Standard ≤2 logical LLM | PASS | 四个 Standard 章节均为 2 |
| Needs Revision ≤3 logical LLM | PASS | `writingRevisionTriggerContract.test.ts`：blocking executable finding → Revision executes；12/12 PASS；未人为修改 live QA |
| One-Shot =1 | PASS | chapter 252、253 均为 logical=1 / paid=1 |
| Review/Audit/FactCheck/Proof=0 | PASS | compact trace 与 One-Shot policy ledger 均无 paid/physical call |
| Compact ledger 无 `narrative_architect` / `adversarial_auditor` / `final_reviser` 假行 | PASS | continuation ledger 只有 `draft_writer/unified_qa/revision_writer/final_validate` |
| Resume Duplicate Paid Call | 0 | 所有最终 live run 的 request_count 没有重复 paid call；状态重试未增加 LLM count |
| Freeze Drift | 0 | 每个 trace freeze 完成；`unexpectedLiveReadCount=0`，无 post-freeze live read |
| False Applied | 0 | 四组 trace `falseAppliedRequirementCount=0` |
| FinalValidate / Persist | PASS | 四组全部完成；continuation final artifact finalized/adopted |
| PostWriting / Story Memory | PASS | exact outbox extract/rebuild completed；安装后 `project_story_memory.status=clean`，through chapter 253 / position 61，`last_error=''` |

安装后 settled 快照中曾有一条旧的 chapter 251 事件派生 rebuild row 因旧 fingerprint/并发状态变化而失败；该 row 已被当前版本精确 `rebuild_story_memory:auto:16:60:<revisionHash>` 成功覆盖，Story Memory truth 为 clean，且批次状态门禁为 completed。该历史诊断行不属于当前 final artifact 的依赖，也未产生 LLM 调用。

## 7. F4 验证

```text
npm run verify                         PASS
  lint                                 0 errors / 209 existing warnings
  typecheck                            PASS
  verify:version                       PASS (V2.11.54 / 2115400)
  full Jest                            487 passed suites, 3773 passed tests

Generation Stability workflow-equivalent PASS
  12 suites / 89 tests                 PASS
  focused/skipped/allow-failure gate   PASS

Migration PASS
  43 migration suites / 205 tests      PASS

Android Debug PASS
  BUILD SUCCESSFUL
  adb install -r                       Success
```

Full Jest 的 3 个 skipped suites / 8 个 skipped tests 属于既有非二期套件；二期 12 个显式 suite 全部实际运行且无 skip/only。迁移目标文件中包含的 `migrationTestUtils.ts` 是 helper，不是测试 suite；其余 43 个 migration suite 全部通过。

本地 workflow-equivalent 已验证 `generation-stability.yml`。本轮未 push，也未将未运行的远端 GitHub Workflow 写成 SUCCESS；`ciValidatedHead` 仅表示上述同一 SHA 的本地等价验证。

## 8. 证据索引

主要原始证据均位于：

```text
test-logs/emulator-qa-20260820-162621/
```

关键文件：

```text
db-final-seal-post-install-settled.sqlite
db-outline-standard-retry-final.sqlite
db-continuation-standard-final.sqlite
db-outline-one-shot-final.sqlite
db-continuation-one-shot-final.sqlite
generation-stability-final.log
revision-trigger-red-test-final.log
migration-final.log
verify-final.log
android-debug-final.log
adb-install-r-final.log
final-seal-gate-assertions.log
```

密钥、完整 prompt、完整 response 正文均不进入本报告；数据库快照仅作为本地原始证据保存。

## 9. Final Seal

```text
Verify PASS
Generation Stability PASS
Migration PASS
Android Debug PASS
adb install -r PASS
Outline Standard 2/2 PASS
Continuation Standard 2/2 PASS
Outline One-Shot 1/1 PASS
Continuation One-Shot 1/1 PASS
Final HEAD 真实 2+2+1+1 PASS

PHASE 2 FINAL SEALED / GO
```
