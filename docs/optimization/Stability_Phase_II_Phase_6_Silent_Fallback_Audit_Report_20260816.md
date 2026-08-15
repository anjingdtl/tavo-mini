# Stability Phase II — Phase 6 Silent Fallback Audit

日期：2026-08-16  
治理依据：`docs/optimization/ShineWriter_tavo-mini_稳定性治理第二期方案_20260815.md`  
执行仓：`F:\ClaudeWorkSpace\projects\TAVO-MINI`

## 1. 结论

Phase 6 的治理范围是 Generation Semantic Path，未做全项目 warning cleanup。

```text
Second Phase Silent Fallback Audit
Unclassified semantic fallback = 0
Phase 6 Gate P1-5 = GO
Overall stability governance = NO-GO
```

Overall 仍为 NO-GO，因为 Phase 7 Golden Journey V2、Phase 8 真机矩阵、Phase 9 独立 Generation Stability CI、Phase 10 最终独立审计尚未按顺序完成。当前没有提前 Seal。

## 2. 复现与最小改造

### 2.1 红测

先以真实 `buildContext()` 入口复现静默语义丢失：

```text
npm test -- --runInBand __tests__/silentFallbackAuditV2.test.ts
```

初始结果：资源读取、笔记正文/检索失败时 `stabilityDiagnostics` 为 `[]`，测试失败；V7 冻结检索与风格分析失败时 `snapshot.warnings` 为 `undefined`，对应红测也失败。

### 2.2 最小改造

- `collectGenerationMaterials` 为 source capture rejection、成功但格式错误的 source、note body、style profile、note retrieval、model capacity、Story Memory render 增加结构化诊断；保留既有降级行为。
- V6 `resourceContextCandidates` 接入同一 diagnostic sink，覆盖 note config、character JSON、style profile、retrieval、bulk note body 等空候选 fallback。
- V7 frozen source path 将 style analyzer failure、invalid retrieval result、retrieval fallback 写入 `ResourceContextWarning`，并在 Generation collect boundary 映射为 `GenerationDiagnostic`。
- 新六阶段 renderer 对 allocation 中缺失的 Candidate fail-closed；Legacy renderer 的合成 `protocol` allocation 项保持 `LEGACY_ONLY` 兼容并留有明确注释。
- 新增机器可检审计登记表：`src/services/context/generation/silentFallbackAudit.ts`。

未重写 Budget 数学、Story Memory 核心或 Continuation V5 核心。

## 3. 分类登记

完整登记与可机检 Gate 位于：

- `src/services/context/generation/silentFallbackAudit.ts`
- `__tests__/silentFallbackAuditV2.test.ts`
- `__tests__/silentFallbackV7Audit.test.ts`

登记总数：33。

| 分类 | 数量 | 处置原则 |
| --- | ---: | --- |
| `SAFE_NON_SEMANTIC` | 6 | 明确的性能、预算零 grant、显式资源关闭或可选排序降级，并有 trace/策略事实 |
| `DIAGNOSTIC_REQUIRED` | 20 | 保留既有降级结果，但必须进入 GenerationDiagnostic 或冻结资源 warning |
| `BLOCKING_REQUIRED` | 2 | awareness source read failure、六阶段 Candidate 合同破坏时阻断 |
| `LEGACY_ONLY` | 5 | 仅历史适配、旧调用 seam 或旧 payload 兼容，不得成为新主链旁路 |

机器断言：

```text
getUnclassifiedSemanticFallbacks() === []
every entry has classification and observability evidence
```

## 4. 重要审计项与证据

| 路径 | 原始 fallback | 分类 | 当前证据 |
| --- | --- | --- | --- |
| `collectGenerationMaterials.resourceSources.*` | `Promise.allSettled` rejection → 空 source | `DIAGNOSTIC_REQUIRED` | `RESOURCE_RETRIEVAL_FAILED` / `NOTE_RETRIEVAL_FAILED` |
| `resourceContextCandidates.noteConfig` | config failure → `mode=none` | `DIAGNOSTIC_REQUIRED` | `NOTE_RETRIEVAL_FAILED` |
| `resourceContextCandidates.noteRetrieval` | retrieval failure → 空 candidates | `DIAGNOSTIC_REQUIRED` | `NOTE_RETRIEVAL_FAILED` |
| `resourceContextCandidates.noteContents` | body failure → `{}` | `DIAGNOSTIC_REQUIRED` | `NOTE_RETRIEVAL_FAILED` |
| `resources.hydrateFrozenRetrieval` | invalid/failed selection → frozen candidates | `DIAGNOSTIC_REQUIRED` | frozen `NOTE_RETRIEVAL_FAILED` warning + Generation diagnostic |
| `resources.hydrateFrozenStyleProfiles` | analyzer failure → no style profile | `DIAGNOSTIC_REQUIRED` | frozen `NOTE_STYLE_ANALYSIS_FAILED` warning + Generation diagnostic |
| `contextBuilder.idfCache` | cache/build failure → original O(N²) path | `SAFE_NON_SEMANTIC` | correctness-preserving comment and unchanged output semantics |
| `resources.readSourcePayloads.characters/worldbook` | enabled source read failure | `BLOCKING_REQUIRED` | `ResourceContextError` fail-closed |
| `generation.renderGenerationContext` | allocation item has no Candidate | `BLOCKING_REQUIRED` | `GENERATION_CONTRACT_INVALID:render.missing_candidate` |
| Legacy synthetic `protocol` allocation | no material Candidate by design | `LEGACY_ONLY` | legacy adapter comment; existing V2 integration remains green |

## 5. Verification

Targeted tests：

```text
silentFallbackAuditV2.test.ts          PASS — 6 tests
silentFallbackV7Audit.test.ts         PASS — 2 tests
contextBuilderV3.integration.test.ts  PASS — 14 tests
contextBuilderV7.integration.test.ts  PASS — 3 tests
generationPhase2StageContracts.test.ts PASS — 6 tests
generationDiagnostics.test.ts         PASS — 5 tests
secondPhaseResourceClosure.test.ts    PASS — 11 tests
```

仓库门禁：

```text
npm run lint       PASS — 0 errors, 202 warnings (existing baseline count)
npm run typecheck  PASS
npm run test:ci    PASS — 436 suites passed, 3 skipped
                   3433 tests passed, 8 skipped
git diff --check   PASS
```

## 6. 风险与 Gate 状态

```text
New P0 = 0
New P1 = 0
New P2 = 0
Phase 6 blocking NO-GO = 0
Unclassified semantic fallback = 0
```

本阶段未发现需要扩大范围的 P0/P1/P2 问题。Lint 中的 202 个 warning 是既有基线，未在本阶段清理或弱化断言。

Phase 6 可以提交并进入下一阶段；这不等同于最终 Stability Architecture GO / SEALED。
