# ShineWriter 流水线修订 — 进度交接

> 最后更新：2026-07-21
> 交接原因：模拟器 DNS 不通阻塞真机 LLM 4 模式测试，需要换 Agent / 换设备继续。

---

## 一、已完成且已验证的工作

### Phase 0–4：流水线修订（全部完成，914 个单元测试通过）

| Phase | 内容 | 状态 |
|---|---|---|
| Phase 0 | 基线确认（125 suites / 857 tests 全通过） | ✅ |
| Phase 1 | 修正阶段依赖：twoStage/conditional 串行，full 仅 review∥factCheck 并行 | ✅ |
| Phase 2 | 共享上下文快照 PipelineContextSnapshot + buildContext 返回快照 + 分区裁剪 + 删除 slice(0,3000) | ✅ |
| Phase 3 | 初稿后二次本地召回 buildPostDraftAuditContext | ✅ |
| Phase 4 | 自动化测试 + 类型检查 + 构建 + 模拟器冒烟 | ✅ |

### 变更文件

**修改（5 个）**：
- `src/services/pipelineRunner.ts` — 重写：抽取 runReviewStage/runFactCheckStage/runProofStage 共享 helper；twoStage 串行 draft→review→proof；conditional 串行 draft→factCheck→proof；full 并行 review∥factCheck 后 proof 等待；full 接入初稿后二次召回；删除 buildContextPreview()；删除旧并行文案；resume 同步修正
- `src/services/pipelineMessages.ts` — 重写：buildReviewMessages/buildFactCheckMessages/buildProofMessages 改为接收 ReviewContext/FactCheckContext/ProofConstraints；分区 token 预算裁剪；删除 slice(0,3000)
- `src/services/contextBuilder.ts` — BuildContextResult 增加 pipelineContext；buildResourceContext 返回分区字段
- `__tests__/pipelineRunner.test.ts` — 重写：17 个新断言
- `CHANGELOG.md` — [Unreleased] 记录

**新增（7 个）**：
- `src/types/pipelineContext.ts` — PipelineContextSnapshot / ReviewContext / FactCheckContext / ProofConstraints + 快照→分区转换器
- `src/services/postDraftRetrieval.ts` — 初稿驱动 Episodic/世界书/人物召回 + 合并去重 + 失败回退
- `__tests__/pipelineContextIntegration.test.ts` — 5 tests（全链路）
- `__tests__/pipelineContextSnapshot.test.ts` — 5 tests
- `__tests__/pipelineMessages.test.ts` — 13 tests
- `__tests__/postDraftContinuityScenarios.test.ts` — 11 tests（SPEC §20.5 连续性矩阵）
- `__tests__/postDraftRetrieval.test.ts` — 16 tests

### 测试结果

- `npm run verify`（lint + typecheck + test:ci）：**130 suites / 914 tests 全通过**
- `npm run typecheck`：0 errors
- `npm run lint`：0 errors（10 个预存在 warning）
- `npm run apk:debug`：BUILD SUCCESSFUL

### DeepSeek API 提示词实测（已完成）

直接用 DeepSeek API 实测了 buildReviewMessages / buildFactCheckMessages 提示词：
- 评估返回 `{strengths:3, issues:4, suggestions:5}`，正确指出钥匙归属冲突与关系冲突
- 核查返回 `{errors:3, warnings:3}`，正确捕捉「第一次踏入人民公园」（被 Story Memory 证伪）、「李雪从未见过张明」（被证伪）、钥匙位置错误，尊重世界书规则

---

## 二、未完成的工作

### 模拟器 4 模式真机 E2E 测试（被 DNS 阻塞）

**阻塞原因**：模拟器 DNS 解析失败。
- `adb shell ping api.deepseek.com` → `unknown host`
- `adb shell ping 8.8.8.8` → **能通**（IP 连通正常）
- 模拟器 DNS 配置为 `10.0.2.3`（模拟器内置 DNS 代理），该代理已失效
- `adb root` 不可用（production build），无法改 `/system/etc/hosts`
- 尝试过的修复：`ndc resolver setnetdns`、`settings put global dns1/dns2`、飞行模式重连 → 均无效
- 宿主机 curl `https://api.deepseek.com` 完全正常（HTTP 200，IP 171.108.215.12）

**已尝试但未跑通的步骤**：
1. 在应用 LLM 设置配置 DeepSeek（base_url / api_key / model）→ 保存（keychain 持久化有疑问）
2. 创建项目 PipelineVerify + 第 2 章（带 synopsis "ZhangMingGoesToSaltLake"）
3. 流水线模式切到 noReview
4. 第 2 章编辑器点击「AI 重新生成」→ 流水线启动但 0 字输出（DNS 不通导致 LLM 调用失败）

**下一个 Agent 需要做的事**：

#### 方案 A：修复模拟器 DNS（推荐）
重启模拟器时加 DNS 参数：
```bash
# 先停掉当前模拟器
adb -s emulator-5554 emu kill
# 用 -dns-server 重启（保留 userdata，不丢配置）
emulator -avd Pixel_10_Pro_XL -dns-server 8.8.8.8,8.8.4.4 -no-snapshot-load
# 验证
adb -s emulator-5554 shell ping -c 2 api.deepseek.com
```

如果 `-dns-server` 参数不生效，换用：
```bash
emulator -avd Pixel_10_Pro_XL -netdelay none -netspeed full -dns-server 8.8.8.8
```

#### 方案 B：换一个 Google APIs（非 Play Store）AVD
创建一个无 Play Store 的 AVD（支持 `adb root`），然后可以直接改 `/system/etc/hosts`。

#### 方案 C：用真机
USB 连接真机，安装 debug APK，在真机上配置 DeepSeek 并跑 4 模式。

#### DNS 修复后的 4 模式测试步骤
1. **确认 DeepSeek 配置**：设置 → LLM 设置 → 确认 DeepSeek 配置存在且已激活 → 点「保存并测试」确认网络通
2. **确认 keychain**：如果「保存并测试」报 401，说明 api_key 未持久化到 keychain（logcat 搜 `RNKeychainManager`）。此时需要重新输入 api_key 并保存（可能需要用「新增」按钮创建新配置而非编辑现有配置）
3. **noReview 测试**：流水线配置 → 无审核 → 写一章 → 结果页应只有 draft success，review/factCheck/proof 全 skipped
4. **twoStage 测试**：切「仅评估」→ 写新章 → draft/review/proof 三阶段 success，factCheck skipped
5. **conditional 测试**：切「仅核查」→ 写新章 → draft/factCheck/proof success，review skipped
6. **full 测试**：切「完整」→ 写新章 → draft/review/factCheck/proof 全 success
7. **每步检查**：通知栏文案、结果页阶段状态/tokens/耗时、终稿文本

---

## 三、当前模拟器状态

- 模拟器 `emulator-5554`（Pixel_10_Pro_XL）已停止（为重启修 DNS 准备）
- 应用 `com.shinewriter` debug APK（V2.5.16）已安装（重启后仍在，除非 wipe-data）
- 项目 `PipelineVerify` 已创建（2 章，第 2 章有 synopsis）
- DeepSeek 配置可能在也可能不在（取决于 keychain 是否在重启后保留——通常保留）
- 流水线模式当前为 `noReview`

---

## 四、DeepSeek 凭据

- **端点**：`https://api.deepseek.com`
- **模型**：`deepseek-v4-flash`（推理模型，会输出 reasoning_content）
- **API Key**：由用户提供，已通过 UI 输入模拟器（不写入本文件）

---

## 五、git 状态

- 分支：`main`
- 4 个文件已修改 + 7 个文件新增（均未提交）
- 本次 commit 包含 progress.md + 全部代码变更
- **未推送远程**（等待本次 commit + push）
