# ShineWriter 第二期 Final Seal / NG-05 收尾证据

> 文档日期：2026-08-14
> 项目：`anjingdtl/tavo-mini` / ShineWriter
> 本轮范围：第二期最后一轮 PDCA；不扩期
> 代码提交：`4e4055f`（`fix: preserve frozen notes semantics in V7`）
> 应用版本：`V2.11.51` / versionCode `2115100`
> 数据库 Schema：**51（未升 52）**
> 任务契约：Context Budget **7** / Resource Context **2** / Pipeline Snapshot **4**

本文件记录 NG-05 修复、全量门禁、真实 Android Freeze/Resume 和发版候选物证据。文档提交后还会对最终 HEAD 做独立第二视角审查；在该审查完成前，不提前宣告剩余 NO-GO 清零。

---

## 1. NG-05：V7 Frozen Note Compiler 语义封板

| 要求 | 实现与证据 | 结论 |
|---|---|---|
| Snapshot 后不重新查 DB | `resourceSourceSnapshot.ts` 在返回前完成 Notes style profile / retrieval hydration；`noteDetailCompiler.ts` 只接收 frozen input，不持有 DB、project 或 live source 依赖。回归测试对 snapshot 后 DB read counter 断言为 0。 | GO |
| 抽出旧 Notes 纯算法层 | `src/services/noteSemantics.ts` 提供纯算法：Style Profile JSON 解析、文本构建、权重归一化、profile merge，以及 legacy retrieval 的 token/context window、prefilter、fallback、literal validation、prompt builder、query/fingerprint。无 DB、LLM、React 依赖。 | GO |
| styleWeights 必须真实生效 | V7 编译使用 frozen `styleWeights` 参与 profile merge；权重为 0 的维度不会进入结果。测试验证改变权重会改变风格画像，而不是只冻结不消费。 | GO |
| retrieval 不能被简单字符串匹配替代 | V7 snapshot hydrate 复用旧 Retriever 的预筛选、上下文片段、候选 fallback、字面校验和 prompt 语义；compiler 只消费已冻结的 legacy-selected fragments，不在冻结后另造字符串匹配。V6 live 与 V7 frozen 对外 fragment 语义逐字段相等。 | GO |
| V6 legacy / V7 frozen 回归与零读取 | `noteSemanticsV7Regression.test.ts` 覆盖 V6 live/V7 frozen retrieval equality、styleWeights、原文 Note、snapshot 后零读取；`noteRetriever.test.ts` 覆盖 legacy cache-hit 不额外 reload。 | GO |
| 原模式与阶段语义 | Original Note literal body、Warning、`NOT_SELECTED`、save / balanced / rich、Freeze / Resume 均保留并由定向/全量测试及 Android evidence 覆盖。 | GO |

关键代码边界：

- V6 `getOrAnalyzeNoteStyle` / `retrieveRelevantNotes` 继续保留 live DB、cache、LLM 和旧返回形状。
- V7 `captureResourceSourceSnapshot` 只在捕获阶段读源；`compileNoteDetailFromFrozen` 只编译 `FrozenNote` / `FrozenNoteConfig`。
- `retrievalScore` 仅作为冻结算法内部排序证据，V6 公共 fragment 输出会剥离该内部字段，避免改变既有 API 形状。

---

## 2. 本地自动化 Gate

| Gate | 命令 / 证据 | 结果 |
|---|---|---|
| 定向 V6/V7 Notes 回归 | `npm test -- --runInBand noteRetriever noteSemanticsV7Regression styleAnalyzer` | **PASS：3 suites / 20 tests** |
| 完整 CI 测试 | `npm run test:ci` | **PASS：408 suites passed，2 skipped；3230 tests passed，7 skipped；3237 total** |
| Migration | `npm test -- migration --runInBand` | **PASS：42 suites / 204 tests** |
| Verify | `npm run verify` | **PASS**（含 lint、typecheck、version、完整 test:ci） |
| TypeScript | `npm run typecheck` | **PASS** |
| 版本一致性 | `npm run verify:version` | **PASS** |
| changed-file lint | 变更文件 ESLint | **PASS**；仅 `noteSemantics.ts` hash 位运算的 2 个既有规则 warning，无 error |
| 覆盖率参考 | `npm run test:coverage` | **PASS**：statements 73.83%、branches 63.19%、functions 78.57%、lines 75.59% |
| 数据库兼容 | Schema 51 device migration check | **PASS**：projects 8、chapters 78、characters 4、worldbook 5、presets 2、project_resources 66、outlines 24；integrity ok |

---

## 3. Android E2E / Freeze-Resume

### 3.1 普通 UI E2E

- 设备：`emulator-5554`，包：`com.shinewriter`
- 安装：`adb install -r`，未 uninstall，未 `pm clear`
- 最终 Debug APK：`dist/apk/debug/ShineWriter-V2.11.51-debug.apk`
- Maestro：`e2e/maestro/13-phase2-resource-context.yaml`
- 结果：**PASS**，112.5 秒；证据：`test-logs/android-qa/phase2-final-20260814/maestro-phase2-final-rerun.log`
- 覆盖安装后版本：`V2.11.51` / `2115100`

### 3.2 真实 V7 冻结与冷启动 Resume

最终真实任务：`pt_msru931i_149`，目标章节 `73`，`context_budget_version=7`。

| 快照 | 状态 | context 长度 | frozen hash | live marker |
|---|---|---:|---|---|
| `v7-final-before-force-stop.db` | proofing | 188237 | `a51a05d40cb3cf664ee6b153701c4ea8` | absent |
| `v7-final-after-cold-start.db` | interrupted | 188237 | same | absent |
| `v7-final-live-mutated.db` | interrupted | 188237 | same | raw source changed, frozen context absent |
| `v7-final-after-resume.db` | completed | 188237 | same | absent |

完成后的 checkpoint：

```text
brief    succeeded  attempt 1
draft    succeeded  attempt 1
factCheck succeeded attempt 1
review   succeeded  attempt 1
proof    succeeded  attempt 3
```

验证点：冷启动后 UI 明确显示「从上次失败阶段继续」和「从失败节点重试」；加入 `LIVE_CHANGED_AFTER_FREEZE_FINAL_20260814` 到 characters / notes / worldbook / preset 后，Resume 仍只重跑未完成 Proof，冻结 context hash、长度和正文均未漂移。一次证据抓取曾误用会 force-stop 的默认脚本，导致 Resume attempt 2 被中断；已按同一 frozen snapshot 再次 Resume，最终 attempt 3 成功，故最终证据以 `after-resume` 为准并完整保留中间快照。

主 QA 设备随后恢复到原始基线：

```text
baselineHash = 0227178FD6722550ECCCBE075E8EDC1791E28031FB63DCA0CE530374E59732F7
deviceHash   = 0227178FD6722550ECCCBE075E8EDC1791E28031FB63DCA0CE530374E59732F7
integrity_check = ok
```

证据目录：`test-logs/android-qa/phase2-final-20260814/`。

---

## 4. Release candidate

- Release APK：`dist/apk/release/ShineWriter-V2.11.51-release.apk`
- SHA-256：`DAF076868CF4D409183E5B741D161ABF7E16134F6C1931ABBA16E32BA1E3BACF`
- package：`com.shinewriter`
- versionName：`V2.11.51`
- versionCode：`2115100`
- signer certificate SHA-256：`017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`
- signers：1；APK v2：true；zipalign：successful
- 独立 release AVD：`emulator-5558`，覆盖安装后可启动并进入作品库；无 `AndroidRuntime:E` 应用 fatal
- 仅记录非阻断平台提示：Android 16 KB page-size compatibility warning、Gradle/第三方依赖既有 warning；构建与安装均成功

---

## 5. GitHub Actions

代码提交 `4e4055f` 的 Verify run：

- URL：<https://github.com/anjingdtl/tavo-mini/actions/runs/31731201601>
- JavaScript validation：**success**
- Android Debug build：**success**
- Migration matrix：**success**

Final Seal 文档提交后将再次检查最新 Verify run；只有该 run 也通过，发布门禁才算完成。

---

## 6. 封板状态

当前实现与版本候选物已通过本地门禁、Android 证据和代码提交后的 GitHub Actions。Final Seal 文档提交后的最终 HEAD 仍需完成独立第二视角审查；审查无新发现且最终 GitHub Actions 通过后，才更新为最终 GO 声明。
