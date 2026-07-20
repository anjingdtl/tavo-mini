# Tavo Mini V2.5.13 故事记忆最终硬化 — 交接进度文档

> 交接时间：2026-07-20 23:51
> 当前 HEAD：基线 `4097ce1`（V2.5.12 docs commit）+ 未提交的 V2.5.13 工作区改动
> 目标版本：V2.5.13 / versionCode 2051300
> 唯一施工依据：`docs/superpowers/specs/Tavo-Mini-V2.5.13-Story-Memory-Final-Hardening-SPEC.md`
>
> **下一个 agent 必读：先看完这份文档，再看 SPEC，然后从「未完成事项」按顺序继续。不要重做已完成的部分。**

---

## 一、当前仓库状态

```
分支：main（与 origin/main 同步）
基线提交：4097ce1 docs: point README CI pin to V2.5.12 Verify run 29752469471
未提交改动：见下方「已修改文件」清单
```

- `git status` 应显示以下文件被修改/新增，**全部保留**：
  - 修改：`src/services/episodicMemoryRetriever.ts`
  - 修改：`src/services/storyMemory/characterMentionResolver.ts`
  - 修改：`src/services/contextBuilder.ts`
  - 修改：`scripts/check-version-consistency.js`
  - 修改：`.github/workflows/verify.yml`
  - 修改：`package.json`（2.5.12 → 2.5.13）
  - 修改：`package-lock.json`（2.5.12 → 2.5.13）
  - 修改：`src/constants/version.json`（V2.5.13 / 2051300）
  - 修改：`CHANGELOG.md`（新增 [2.5.13] 条目）
  - 修改：`README.md`（V2.5.13 badge / 当前版本 / V2.5.13 段落 / 正式产物 / 英文摘要）
  - 修改：`__tests__/episodicMemoryRetriever.test.ts`（两处 `scored()` 加 `matchedCharacterIds: []`）
  - 未跟踪：`docs/superpowers/specs/Tavo-Mini-V2.5.13-Story-Memory-Final-Hardening-SPEC.md`
  - 未跟踪：`docs/superpowers/specs/Tavo-Mini-V2.5.13-Handover-Progress.md`（本文档）

---

## 二、基线验证（交接前已跑过，全部通过）

| 命令 | 结果 |
| ---- | ---- |
| `npm run lint` | 0 errors / 5 warnings（全部为历史遗留：4 个 `no-bitwise` + 1 个 `no-void`，位置 `android/`、`storyMemoryBatchValidator.ts`，与本次无关） |
| `npm run typecheck` | ✅ 0 errors |
| `npm run verify:version` | ✅ `[verify:version] ok V2.5.13 versionCode=2051300` |
| 定向 Jest（7 个 suite） | ✅ 88/88 通过：`episodicMemoryRetriever` / `storyMemorySystemInvariants` / `longStoryRecallRegression` / `contextBuilderStoryMemory` / `storyMemoryPrepare` / `storyMemoryRenderer` / `storyMemoryRendererRetrieval` |

**还没有跑过**：`npm run test:ci`（全量）、`npm run test:coverage`（全量覆盖率）、`npm run verify`。下一个 agent 完成测试补齐后必须跑。

---

## 三、已完成事项（SPEC §1–§9 生产代码部分）

### 修复一：人物历史桶彻底改用 characterId（SPEC §5）✅

**根因**：`ScoredMemoryCandidate` 只存 `matchedCharacters: string[]`（canonical name），混合 Top-K 的人物桶排序时，`candidateMentionsActiveCharacter` / `activeCharacterCountInCandidate` 在没有 `terms` 参数时退回 `includesInsensitive(candidate.text, name)` 姓名字符串匹配——重名（李明/李明）、歧义正式姓名、跨别名场景会出错。

**修改**：

- `src/services/episodicMemoryRetriever.ts`
  - `ScoredMemoryCandidate` 新增 `matchedCharacterIds: string[]`，注释明确「bucket / pair priority 的唯一事实来源」
  - `scoreMemoryCandidates()` 用 `uniqueNonEmpty(candidateMentions.characterIds.filter(id => activeIdSet.has(id)))` 填充，去重且顺序稳定
  - `candidateMentionsActiveCharacter(candidate)` 改为单行：`return candidate.matchedCharacterIds.length > 0`
  - `activeCharacterCountInCandidate(candidate)` 改为单行：`return candidate.matchedCharacterIds.length`
  - 两个函数**删除了所有 `includesInsensitive(candidate.text, name)` 姓名回退**；签名也不再要 `active` / `terms` 参数
  - `selectMemoryCandidates` 人物桶 sort 中 pair 判定改为 `a.matchedCharacterIds.length >= 2 ? 1 : 0`，不再扫描候选文本
- `src/services/contextBuilder.ts` 三处空 candidate 字面量（legacy 路径、`empty_query_recent`/`empty_idf_recent` 路径、`assembleRecentSummariesWithinBudget`）补上 `matchedCharacterIds: []`
- `__tests__/episodicMemoryRetriever.test.ts` 两处 `scored()` helper 同样补 `matchedCharacterIds: []`

### 修复二：歧义词参与最长匹配和区间占用（SPEC §6）✅

**根因**：`resolveCharacterMentionsInText` 在 `uniqueTermCandidates` 构建时 `if (ambiguousNormalized.has(owner.normalizedTerm)) continue;`——歧义词**完全不进入扫描**，所以"队长"歧义词不会占用 `[start, end)` 区间，内部"长"被后续唯一词扫描误激活。

**修改** `src/services/storyMemory/characterMentionResolver.ts`：

- 新增导出接口 `CharacterTermScanEntry { normalizedTerm, displayTerm, owners, ambiguous, length }`
- 重写扫描核心：按 `normalizedTerm` 建 bucket，唯一词与歧义词都进同一 `scanEntries` 列表；歧义 bucket 保留最长 displayTerm
- 排序：`length` 降序 → 唯一词 canonical 优先于 alias → `normalizedTerm` → `displayTerm`
- 循环处理：歧义项把所有未被占用的命中区间加入 `claimedSpans` 并记入 `ambiguousTermsEncountered`，**不创建 mention、不激活任何 characterId**；唯一项照旧激活
- 结果："队长下令" 中"队长"歧义 → 占区间、不激活，"长"无法命中区间内部；但同一文本其他不重叠位置（如"队长下令，长随后离开"后半句的"长"）仍可被唯一人物激活

### 修复三：单次 buildContext 使用同一 prepared Checkpoint 快照（SPEC §7）✅

**根因**：`buildContext()` 调 `prepareStoryMemoryForGeneration()` 拿到 `prepared.checkpoint`/`prepared.coverage` 后，又调 `buildStoryMemoryContext()`，后者**再次 `db.getProjectStoryMemory(projectId)`**。两次读取之间 Checkpoint 状态可能改变（例如另一进程把它标 dirty），导致 coverage 用旧 clean、Renderer 又因第二次读到 dirty 不注入。

**修改** `src/services/contextBuilder.ts`：

- 新增导出 `renderPreparedStoryMemoryContext(projectId, currentChapter, checkpoint, budgetTokens, options?)`：纯函数，**不访问 DB**，只在传入 snapshot 上做防御性 `resolveUsableCheckpointForTarget`，然后走 `renderStoryMemoryForContext` + trace
- `buildStoryMemoryContext()` 改为薄包装：`db.getProjectStoryMemory` → `renderPreparedStoryMemoryContext`，保留给**没有跑过 prepare** 的外部调用方使用
- 主链路 `buildContext()` 内 `storyMemory` 改为 `renderPreparedStoryMemoryContext(projectId, currentChapter, prepared?.checkpoint ?? null, config.storyStateBudgetTokens ?? 8000, { retrievalUserPrompt })`，不再二次读 DB

SPEC §7.5 快照一致性不变量现在成立：`coverage.checkpointThroughPosition` / `storyStateForRetrieval`（来自 `resolveStoryStateForRetrieval(prepared)`，读 `prepared.checkpoint.state`）/ Story Memory Renderer / trace 中 Checkpoint through 全部来自同一个 `prepared.checkpoint`。

### 修复四：GitHub Actions 执行版本一致性门禁（SPEC §8）✅

`.github/workflows/verify.yml` `javascript` Job 在 `Install dependencies` 之后、`Lint` 之前增加：

```yaml
- name: Version consistency
  run: npm run verify:version
```

**还没有**：真实推送 + 看到 GitHub Actions Run 的 `Version consistency — success` 步骤。这是下一个 agent 的活。

### 修复五：版本一致性脚本精确检查 README（SPEC §9）✅

`scripts/check-version-consistency.js` 在原有 5/6 号检查之上新增：

- 英文摘要精确行匹配：正则 `The current version is \*\*V2\.5\.13\*\*`（不是模糊计数）
- 当前正式 APK 文件名：`ShineWriter-V2.5.13-release.apk` 必须出现
- `versionName=V2.5.13` 必须出现
- `versionCode=2051300` 必须出现
- 反向守卫：扫描 `ShineWriter-V<x>.<y>.<z>-release.apk` 所有出现，任何非当前版本即 fail
- 反向守卫：扫描 `The current version is **V<x>.<y>.<z>**` 所有出现，任何非当前版本即 fail

同时把 README 第 102-103 行旧的 V2.5.8 正式产物描述替换为 SPEC §9.3 推荐的简化模式：

```
当前正式产物：`dist/apk/release/ShineWriter-V2.5.13-release.apk`，`versionName=V2.5.13`，`versionCode=2051300`。
该 APK 的 SHA-256、正式证书 SHA-256、APK Signature Scheme、signer 数量、zipalign 和 AAPT 验收结果见
`docs/V2.5.13-STORY-MEMORY-FINAL-HARDENING-REPORT.md`。
```

这样以后版本升级只需要改一处版本号 + 一处 APK 文件名，构建信息集中在报告里。

---

## 四、版本状态（已升）

- `package.json.version = "2.5.13"`
- `package-lock.json` 顶部 + `packages[""].version = "2.5.13"`
- `src/constants/version.json` = `{ versionName: "V2.5.13", versionCode: 2051300, releaseTitle: "ShineWriter V2.5.13" }`（由 `npm run prebuild` 重新生成）
- `CHANGELOG.md` 顶部新增 `[2.5.13] - 2026-07-20` 条目（Fixed + Tests + Notes 三段；Tests 段标注"后续 agent 继续"）
- `README.md`：
  - badge `Version-V2.5.13-blue.svg`
  - 第 16 行 `当前版本：**V2.5.13**`
  - V2.5.12 段后插入 V2.5.13 简介段
  - 正式产物替换为 V2.5.13 + 报告链接（SPEC §9.3 推荐格式）
  - 英文摘要 `The current version is **V2.5.13**`，正文加入 V2.5.13 hardening 要点

---

## 五、未完成事项（下一个 agent 按顺序继续）

> 顺序基本是 SPEC 章节顺序。每项做完跑相应测试。

### 5.1 SPEC §10 修复六：补真实生产接线集成测试

**新建** `__tests__/storyMemoryPreparedSnapshotIntegration.test.ts`，必须覆盖：

- `prepareStoryMemoryForGeneration()`
- `buildContext()`
- `renderPreparedStoryMemoryContext()`
- `resolveStoryStateForRetrieval()`
- preview 路径
- generation 路径

**断言要求**：

未来或同位置 Checkpoint 场景：
- `prepared.checkpoint === null`
- `coverage.checkpointThroughPosition === -1`
- `resolveStoryStateForRetrieval(prepared) === null`
- Story Memory text === `''`
- preview 未调用 LLM（用 jest mock 计数）

coverage 不足时：
- `buildContext` 抛出 `故事记忆覆盖不足`
- 不得使用未来状态兜底

**单快照测试**（SPEC §10.3）：
- 通过 jest mock 统计 `getProjectStoryMemory` / `ensureProjectStoryMemoryRow` 调用次数
- 主链路 `buildContext` 一次调用内，prepare 之后不得为 Renderer 再读一次 Checkpoint
- 三个场景：A) prepare 后 DB 被标 dirty → Renderer 仍用 prepared 的 clean 快照；B) prepare 返回 null → 后续 DB 变 clean 也不注入；C) 未来 Checkpoint → 不注入 + entity state null + preview 不调 LLM

参考：`__tests__/storyMemoryPrepare.test.ts` 的 mock 模式（`jest.mock('../src/services/database', ...)`），可以复用 `mockGetChapters` / `mockGetMemory` / `mockEnsure` 计数。

### 5.2 SPEC §11 修复七：关系预算测试取消条件放行

**位置** `__tests__/storyMemorySystemInvariants.test.ts` 第 362-420 行 `describe('system invariants: relationship budget guarantee')`。

当前问题代码：

```ts
if (result.includedCharacterIds.length >= 2) {
  expect(result.includedCharacterIds).toEqual(...);
  expect(result.includedRelationshipIds).toContain('rel_lan_zhou');
}
```

**改为无条件断言**：

- 先独立渲染最小 state（只 prefix + 林岚 + 周恪 + rel_lan_zhou），用 `estimateTokens` 精确算出最小必要预算
- 在大 state（8 人物 + stale rels）中用这个预算加少量余量（建议 +50）
- 断言：
  ```ts
  expect(result.includedCharacterIds).toContain('char_lan');
  expect(result.includedCharacterIds).toContain('char_zhou');
  expect(result.includedRelationshipIds).toContain('rel_lan_zhou');
  expect(result.estimatedTokens).toBeLessThanOrEqual(budget);
  ```
- 预算必须**程序计算**，不能用 `Math.floor(full.estimatedTokens * 0.35)` 这种不稳定推断

### 5.3 SPEC §12 修复八：人物历史桶专项测试

在 `__tests__/episodicMemoryRetriever.test.ts` 增加 describe 块（或新建 `__tests__/characterHistoryBucket.test.ts`）：

**重名正式姓名**：
```
state.characters: char_reporter canonical=李明 alias=记者; char_doctor canonical=李明 alias=医生
query: '记者和医生去现场'
candidate1 text: '李明去了现场' → matchedCharacterIds=[]，pairBoost=0，不进双人物桶
candidate2 text: '记者与医生共同去了现场' → matchedCharacterIds=['char_reporter','char_doctor']（顺序不限），pairBoost=CHARACTER_PAIR_BOOST，人物桶优先
```

**跨别名**：
```
state.characters: char_lan canonical=林岚 aliases=[小岚, 岚姐]
query: '林岚'
candidate text: '岚姐' → matchedCharacterIds=['char_lan']
```

**歧义长词阻挡短词**（`resolveCharacterMentionsInText` 层）：
```
state.characters: char_captain_a alias=队长; char_captain_b alias=队长; char_chang canonical=长
text: '队长下令，长随后离开'
→ 歧义"队长"占区间；前半段"长"不激活 char_chang；后半段独立"长"激活 char_chang
→ characterIds = ['char_chang']（仅 1 个）
```

同埋 'Captain/captain/Captain队长'、'林岚/林'、'老林/林' 等价场景。

### 5.4 SPEC §13 修复十三：更新系统不变量测试

在 `__tests__/storyMemorySystemInvariants.test.ts` 追加 4 个 describe：

1. **人物桶不变量**：mock 一个候选 `matchedCharacters=['李明']` 但 `matchedCharacterIds=[]`，混合 Top-K 不得把它当双人物候选
2. **歧义占位不变量**：歧义词命中后 `ambiguousTermsEncountered` 包含该词，且对应区间内短词不激活
3. **单快照不变量**：通过 jest mock 计数，一次 `buildContext` 内 `getProjectStoryMemory` 调用次数 ≤ 1
4. **远端版本门禁不变量**：用 Node `fs.readFileSync` 读 `.github/workflows/verify.yml`，断言包含字符串 `npm run verify:version`

### 5.5 SPEC §14 代码反模式扫描

修复六七八完成后，跑以下搜索并确认现代路径干净：

```bash
# 应只剩测试或 SPEC 文档里的引用；生产路径不得调用带 active/terms 参数的版本
grep -rn "candidateMentionsActiveCharacter\|activeCharacterCountInCandidate" src/
# 生产路径不得为 Renderer 二次读 Checkpoint
grep -rn "getProjectStoryMemory\|ensureProjectStoryMemoryRow" src/services/contextBuilder.ts
# README 不得残留旧版
grep -nE "V2\.5\.(8|9|10|11|12)" README.md
```

### 5.6 全量测试 + 覆盖率

```bash
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
npm run test:coverage
npm run verify
```

**不得**用 `--forceExit`；**不得**降低 `jest.config.js` 覆盖率门禁（全局 branches 55 / functions 65 / lines 65 / statements 65；`database.ts`/`database/**`/`schema/**`/`migrations/**`/`backupService.ts` 是 branches 70 / lines 80）。

新增测试文件如果被覆盖率门禁卡住，先补测试，**不要**调阈值。

### 5.7 SPEC §15 性能测试

`__tests__/longStoryRecallRegression.test.ts` 已有 30/100/300 章性能测试（第 246-327 行，`episodic retrieval performance scale` describe）。**重跑一次**确认本次改动没引入明显回退：

```bash
npx jest __tests__/longStoryRecallRegression.test.ts --runInBand
```

软阈值：30 章 < 500ms / 100 章 < 1500ms / 300 章 < 4000ms。300 章 scoreMs / 30 章 scoreMs < 50。

同时补一个 10/50/100 人固定种子测试（SPEC §15 提到），可以在 `storyMemorySystemInvariants.test.ts` 的 `fixed-seed anti-regression` describe 基础上扩展，或新建 `__tests__/storyMemoryPersonScale.test.ts`。记录每次的候选 mention resolve / mixed Top-K / render 耗时 / DB 读取次数到施工报告。

### 5.8 SPEC §16 模拟器验收

需要 12+ 章真实测试项目，形成 clean Checkpoint，然后回到早期章节（如第 4 章）做预览/生成。具体步骤：

1. 启动 Android 模拟器（项目里有 `npm run android`、既有 e2e 脚本可参考 `e2e/maestro/`）
2. 创建测试项目 + 12 个有正文的章节
3. 触发 story memory 批次整理，形成 `through > 4` 的 clean Checkpoint
4. 返回第 4 章：打开上下文预览 → 断言 Story Memory 不注入未来 Checkpoint，trace 显示「不注入目标章节之后或同位置的检查点」；raw/episodic fallback 按 coverage 工作
5. 在第 4 章触发一次 AI 生成（或构建 generation 上下文）→ 断言不注入未来人物秘密/关系；coverage 不足时明确阻止；无 `AndroidRuntime FATAL`
6. 多人物关系场景：写作要求同时提及 8 人，预览包含关键关系双方 + 关系 + 不超预算
7. 抓 logcat + UI tree + 截图存到 `test-logs/v2.5.13-emulator/`（gitignored）

详细记录：模拟器编号、Android 版本、章节数、Checkpoint through、目标章节 position、trace 结果、logcat 关键行、截图/UI tree 路径。

### 5.9 SPEC §18 GitHub Actions

```bash
git add -A
git commit -m "release(v2.5.13): final story-memory hardening patch"
git push origin main
```

然后用 `gh run list --workflow=verify.yml --limit 5` 等 CI，必须确认：

- `Version consistency` 步骤：success
- `JavaScript validation` Job：success
- `Android Debug build` Job：success
- `Migration matrix` Job：success
- workflow `head_sha` === V2.5.13 release commit sha

把 Run ID 和 head_sha 回填到 README 和施工报告。

### 5.10 SPEC §19 Release APK

参考 `docs/RELEASE_APK_BUILD.md`。

```powershell
# 在 PowerShell（不是 bash）加载用户级签名变量到 Process 级（见 RELEASE_APK_BUILD.md 中的片段）
# 然后：
npm run apk:release
```

产物：`dist/apk/release/ShineWriter-V2.5.13-release.apk`。

验收：
- 文件大小（bytes）
- SHA-256（`certutil -hashfile <apk> SHA256`）
- 正式证书 SHA-256 必须是 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`（`apksigner verify --print-certs`）
- APK Signature Scheme v2+、单 signer
- zipalign（`zipalign -c -v 16 <apk>`）
- aapt `versionName=V2.5.13` / `versionCode=2051300`
- 模拟器安装成功

**不得**新建 keystore；**不得**用 Debug 签名；**不得**把密码写进任何文件或日志。

### 5.11 最终施工报告

新建 `docs/V2.5.13-STORY-MEMORY-FINAL-HARDENING-REPORT.md`，按 SPEC §22 列 19 项：

1. 基线提交（`4097ce1`）和最终 release commit（待填）
2. 修改文件清单（可参考本文档「当前仓库状态」）
3. 三项生产缺陷的根因和修复
4. 删除或停用的旁路逻辑
5. `matchedCharacterIds` 使用范围
6. 歧义词区间占用规则
7. prepared snapshot 一致性
8. DB 读取次数测试
9. 集成测试与反例测试
10. 无条件关系预算测试
11. 30/100/300 章性能
12. 版本一致性脚本与 GitHub Actions 步骤
13. README 中英文及 APK 信息
14. Schema、备份、API 次数
15. 模拟器旧章节回写实测
16. GitHub Actions Run ID 与 head_sha
17. APK 路径、大小、SHA-256、签名、zipalign、aapt
18. 仍存在但不属于本轮的项目级风险
19. 是否仍有任何已知的人物桶误判、歧义子串、Checkpoint 快照竞态或版本门禁缺陷

**禁用措辞**：「理论上」「应该」「预计」——只写实测结果。

报告写完后再更新 README 把 CI Run 链接和 APK SHA-256 回填（如果 README 还保留的话）。

---

## 六、施工纪律（SPEC §21 复诵）

- 不覆盖用户未提交内容
- 不做无关格式化
- 每项生产修改必须有测试
- 必须替换旧旁路，不是新增另一套逻辑
- 修复后进行仓库级搜索
- 必须完成代码、测试、CI、模拟器、版本和 APK
- 不得用施工报告替代实际执行
- 不得把纯函数测试写成模拟器验收
- 不得使用条件断言让核心测试假通过

---

## 七、禁止扩大范围（SPEC §3 复诵）

**不得引入**：Embedding / 向量数据库 / 第二模型 / LLM reranker / 新远程 API / 新数据库 Schema / 多历史 Checkpoint 存储 / 新 UI / 事件数据库 / 无关重构 / 大规模类型重写 / 为测试方便改变生产语义 / 新增全局可变缓存 / 取消或降低现有测试与覆盖率门禁。

**不属于本轮**：Android 16KB page-size / ARM64 真机 / 本地 GGUF 长上下文 / 进程强杀 rebuilding 恢复 / 中文 IME 全链路 / 多历史 Checkpoint。

---

## 八、快速恢复上下文提示词（给下一个 agent）

```
请在 F:\ClaudeWorkSpace\projects\TAVO-MINI 继续完成 ShineWriter V2.5.13 故事记忆最终硬化补丁。

唯一施工依据：
- docs/superpowers/specs/Tavo-Mini-V2.5.13-Story-Memory-Final-Hardening-SPEC.md （完整 SPEC）
- docs/superpowers/specs/Tavo-Mini-V2.5.13-Handover-Progress.md （交接进度文档，必读）

当前状态：
- 分支 main，基线提交 4097ce1（V2.5.12 docs commit）
- 生产代码修复一（人物桶 ID 化）+ 修复二（歧义词区间占用）+ 修复三（单快照 buildContext）+ 修复四（CI verify:version）+ 修复五（README 精确校验）已完成
- 版本已升到 2.5.13 / versionCode 2051300
- 工作区有未提交改动（src/ + scripts/ + .github/ + package.json + package-lock.json + version.json + CHANGELOG.md + README.md + __tests__/episodicMemoryRetriever.test.ts），必须保留，不要回滚
- 已验证：lint 0 errors / typecheck ✅ / verify:version ✅ / 7 个相关测试 suite 88/88 通过
- 还没跑：npm run test:ci 全量 / test:coverage / verify

你的任务（严格按交接文档第五节顺序）：
1. 先读交接进度文档（最重要，告诉你哪些已做哪些没做）
2. 再读 SPEC 第 10-22 节
3. 补 __tests__/storyMemoryPreparedSnapshotIntegration.test.ts 集成测试（SPEC §10）
4. 改 storyMemorySystemInvariants.test.ts 关系预算测试，去除条件放行（SPEC §11）
5. 补人物桶专项测试（SPEC §12，重名/跨别名/歧义长词）
6. 补系统不变量 4 个新 describe（SPEC §13）
7. 跑代码反模式扫描（SPEC §14）
8. 跑 npm run lint / typecheck / verify:version / test:ci / test:coverage / verify 全部通过
9. 跑 30/100/300 章 + 10/50/100 人性能测试（SPEC §15）
10. 模拟器 12 章旧章节回写验收（SPEC §16）
11. git commit + push，等 GitHub Actions 4 个 Job 全 success（SPEC §18）
12. npm run apk:release 构建 Release APK，验收 SHA-256 / 证书 / 签名方案 / zipalign / aapt（SPEC §19）
13. 写 docs/V2.5.13-STORY-MEMORY-FINAL-HARDENING-REPORT.md 最终施工报告（SPEC §22，19 项内容）

施工纪律（SPEC §21）：
- 不覆盖用户未提交内容；不做无关格式化
- 每项生产修改必须有测试；必须替换旧旁路
- 不得用条件断言让测试假通过；不得用施工报告替代实际执行
- 不得扩大到 Embedding / 向量数据库 / 第二模型 / 新 Schema / 多历史 Checkpoint / UI 重构

完成后给我一份不超过 50 行的简报，列出：最终 commit sha、GitHub Actions Run ID、APK 路径 + SHA-256、所有测试结果、仍残留的项目级风险。
```
