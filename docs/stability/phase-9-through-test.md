# Stability Phase 9 Report — 模拟器穿测（真实 LLM）

**日期：** 2026-08-15
**构建：** ShineWriter-V2.11.52-debug.apk（含 Phase 1-8 全部治理代码）
**设备：** emulator-5554（Medium_Phone / android-37.1 / x86_64）
**LLM：** 真实配置（"默认配置"，context_window=1,000,000，openai_compatible）

## 穿测矩阵与结果

### T1 完整单章生成（大纲模式，owv=4 / cbv=7）

- 项目：P2_AWARENESS（id=14，大纲创作，6 章）
- 章节：第 1 章（计划状态）
- 结果：五阶段全部成功（Draft 1638 字 → Review → FactCheck → Brief → Proof），耗时 1m19s / 13,486 tokens
- **生产证据（DB 取证，exec-out run-as 免 CRLF 损坏）：**

```
task=pt_msudczgv_157 status=completed owv=4 cbv=7
  generationTraceId=gt-msudczhz-j9a742yb          ← Phase 1 生产生效
  generationFingerprint=f9c9a8d85c48...d6c92fa     ← Phase 2 生产生效
  stabilityDiagnostics=None                        ← 零降级（干净运行）
  attempts: brief/draft/factCheck/proof/review 全部 succeeded
```

对照旧任务（治理前生成）无 trace / 指纹 → 历史兼容（缺省容忍）验证通过。

### T2 Kill → Cold Start → Resume（指纹不漂移）

1. 触发第二次生成 → 6s 后 `am force-stop`（draft 进行中）
2. kill 时取证：`pt_msudg775_158 status=drafting`，冻结信封完整保留
   （`traceId=gt-msudg79c-fws2xyeh`，`fingerprint=4fa439d5b37d...a8c0948f`）
3. 冷启动：弹"流水线失败/运行被中断且没有成功的初稿"（classifyInterruptedTask
   正确分类不可恢复类），对话框提供"从失败节点重试"
4. 确认重试 → **复用 kill 前冻结信封**（指纹原样，未从 live DB 重冻结）
5. 完整跑完：五阶段 succeeded（draft attempt#1=started被杀 / #2=succeeded）

```
最终：status=completed
      traceId=gt-msudg79c-fws2xyeh（不变）
      fingerprint=4fa439d5b37d...（与 kill 时逐字节一致）
```

**Gate P1-9 关键断言：Resume → generationFingerprint 不变 ✓**

### T3 稳定性错误码扫描（logcat）

`grep -iE 'FATAL EXCEPTION|SNAPSHOT_PARSE_FAILED|SNAPSHOT_FINGERPRINT_MISMATCH|PIPELINE_DRAFT_SAVE_FAILED|GENERATION_CONTEXT_FUTURE_SOURCE_LEAK'` → **零命中**（两次完整运行无 fatal、无静默降级、无指纹失配、无未来章节泄漏）。

## Gate P1-9 判定

| 要求 | 结果 |
|---|---|
| 无 fatal | ✓ |
| 无 silent context loss | ✓（stabilityDiagnostics 为空） |
| 无 fingerprint drift | ✓（kill→resume→complete 全程不变） |
| 无 next-stage re-read drift | ✓（重试消费冻结信封，attempt 台账干净） |

**GO**
