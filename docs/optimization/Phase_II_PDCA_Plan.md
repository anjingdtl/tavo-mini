# Phase II PDCA — Writing Kernel Reconstruction

## Plan

Phase I 已封存于 `b8d3f5b0b8c5703fd2998dfb1abbaf4767305ecb`，本阶段不修改 Phase I Source Contract。Phase II 将把写作执行收敛为 `runWritingKernel()` 单一生产入口，冻结统一的 `FrozenWritingContext`，并把 Outline/Continuation 的差异限制在 Freeze 前的 Driver/Adapter。

硬边界：Data Compatibility = YES；Execution Compatibility = NO。旧未完成执行态不迁移、不 Resume，重新创建新的 run/trace/frozen-context 身份。Canon、Boundary、Seam、Anchor 保留为资料约束；旧 Continuation Runner/Prompt/预算模块不再由产品层直接调用。

严格顺序：先建立 `REG-WRITING-SEMANTIC-APPLY-001` Red，再实现语义 Apply Gate；随后实现 Collect → Normalize → Plan → Allocate → Render → Freeze、统一 Kernel Trace/Replay、生产入口切换、Golden/稳定性 CI，最后执行全量静态检查、回归和真实设备验证。

## Do

1. Semantic Apply：Final Body 若声明 applied requirement 但与 Revision 前正文语义不变，必须阻断；只有每个要求都有非空 `VALID_NO_OP` 原因时才允许通过。
2. Context Layer：新增纯函数职责模块和 `FrozenWritingContext`，统一 source/candidate/allocation/render/fingerprint/trace。
3. Kernel：新增不感知场景的 `runWritingKernel()`，使用预冻结 Driver 执行 Draft → Review → Audit/FactCheck → Revision → Proof → Final Validate → Persist → Post Update。
4. Cutover：Outline/Continuation 产品入口通过 Kernel Facade；历史 API 仅保留测试/恢复兼容，不作为产品层入口。
5. Replay/Golden：Decision Replay 与 Golden Journey x10，固定输入下指纹、预算、选择、渲染、义务和 Final Validate 结果不得漂移。
6. Stability CI：新增独立 `generation-stability` Job，不允许 `allow-failure`。

## Check

必须运行：

```text
npm run lint
npm run typecheck
npm test -- --runInBand
Decision Replay x10
Golden Journey
Semantic Apply Regression
Generation Stability CI 静态审计
adb install -r Debug APK
Outline 真实 LLM >= 5 章
Continuation 真实 LLM >= 5 章
```

逐章记录：Source Bundle/Canon/Boundary/Seam/Anchor、Kernel Trace、上下文预算、Freeze、Draft、Review、Revision、Finalize、正文落库、Story Memory/状态更新、连续性和配置保留。指标必须为 Fatal=0、Silent Context Loss=0、Unexpected Live DB Re-read=0、Fingerprint Drift=0、False Applied Requirement=0。

执行结果（2026-08-16，提交前）：

- Semantic Apply Red→Green：先以“正文仅增加零宽字符”的夹具确认旧逻辑误报通过；加入 `checkSemanticRequirementApplication()` 后同一夹具阻断 `SEMANTIC_APPLY_FAILED`，显式且逐项有原因的 `VALID_NO_OP` 通过。专项测试 PASS，2 tests。
- `npm run lint`：PASS，0 errors；202 条既有 warnings。
- `npm run typecheck`：PASS。
- 受影响回归：PASS，5 suites / 48 tests；V5 strict contracts/workflow、batch restart、UI resume、Kernel Reconstruction 均通过。
- 全量 Jest：PASS，441 suites passed，3 skipped；3449 tests passed，8 skipped，0 failed。
- Golden/Replay：`writingKernelReconstruction.test.ts` PASS；固定请求的 Golden fixtures x10 决策指纹稳定，冻结 Trace 阶段顺序稳定，无 fingerprint diff。
- Generation Stability 独立套件：`.github/workflows/generation-stability.yml` 已建立为独立、非 allow-failure Job；本地按同一 7-suite 命令复跑 PASS，40 tests。
- 静态边界审计：PASS；`runWritingKernel()` 是产品唯一写作入口，Kernel/Context/Replay 无场景分支、无数据库读取；产品屏幕与批处理未直接调用旧执行函数；V5 Production gate 为 fail-closed（`CONTINUATION_V5_SOFT_GATES=false`），语义 Apply 永远为硬门禁。
- 失败闭环：全量回归首次暴露 3 个旧测试对三参数旧执行边界的断言；根因是 Kernel 为每次新执行冻结并传递 `generationTraceId`，代码行为符合新契约。已更新断言验证第四参数 Trace 身份，随后 3 suites 与全量 Jest 复跑通过。

## Act

所有发现按 Finding → Root Cause → Fix → Red→Green → Regression → Re-run 闭环。若 Phase I 契约需要修改，先停止本阶段并独立修复 Phase I；不得把 Phase I 根契约混入 Phase II Commit。

本阶段最终 Commit message：

```text
refactor(writing): rebuild unified production writing kernel
```

设备验收仍在独立 Commit 后执行：先构建最新 Debug APK，以 `adb install -r` 保留应用数据升级安装并核对 Provider/模型/Endpoint/推理参数，再执行 Outline 5 章 + Continuation 5 章真实 LLM 全链路穿测。设备结果不得用 Mock 或旧执行态兼容替代。
