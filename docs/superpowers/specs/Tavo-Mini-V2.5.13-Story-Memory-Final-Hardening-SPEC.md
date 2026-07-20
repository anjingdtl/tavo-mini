# Tavo Mini V2.5.13 故事记忆最终硬化补丁 SPEC

> 仓库：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
> 当前基线：V2.5.12  
> 建议目标版本：V2.5.13  
> 发布基线提交：`a6820cf741473948332f92fc71dc80c62d4249b2`  
> 当前远端文档头部提交：`4097ce1acd85b57cad482ce8302ddbf48d48be18`  
> 施工目标：修复 V2.5.12 终检发现的剩余旁路、竞态和门禁缺口，不再扩展故事记忆功能

---

# 1. 背景

V2.5.12 已完成以下核心加固：

- 目标章节感知的 Checkpoint eligibility；
- 禁止未来或同位置 Checkpoint 注入和实体加权；
- 查询、候选摘要和 Story Memory 扫描共用人物解析器；
- 显式 `characterId → canonicalName` 映射；
- 跨别名人物召回；
- 多人物场景下关系 bundle 原子预算；
- 真正空查询路径；
- 系统不变量测试；
- 版本一致性脚本；
- 真实 GitHub Actions 验证。

最终反例审查发现，剩余问题主要集中在以下交界处：

1. 候选评分已经使用统一人物解析器，但混合 Top-K 的人物历史桶仍可能回退到姓名字符串匹配；
2. 歧义长词虽然不激活人物，但没有占用区间，内部短姓名仍可能误激活；
3. 同一次上下文构建中，prepare 与 Story Memory Renderer 读取了两次数据库，可能使用不同 Checkpoint 快照；
4. `verify:version` 只进入本地 `npm run verify`，没有进入 GitHub Actions；
5. 版本校验脚本未精确检查 README 英文摘要和正式 APK 信息；
6. 若干测试存在条件放行或只测纯函数、没有验证真实接线；
7. 模拟器没有执行 SPEC 要求的旧章节回写和未来 Checkpoint 隔离场景。

本轮必须将这些问题作为一个小型、封闭的 V2.5.13 hardening 补丁一次完成。

---

# 2. 本轮目标

一次性完成：

1. 人物历史桶、人物计数和组合优先级全部使用人物 ID；
2. 歧义词参与最长匹配和区间占用，但不激活人物；
3. 单次 `buildContext()` 全程使用同一份 prepared Checkpoint 快照；
4. 远端 CI 自动执行版本一致性检查；
5. README 中英文版本、正式 APK 信息与当前发布一致；
6. 补齐真实生产接线集成测试；
7. 去除关系预算测试的条件放行；
8. 增加重名、歧义和跨别名候选桶测试；
9. 完成模拟器旧章节回写验收；
10. 保持 Schema、备份格式、API 调用次数和默认预算不变。

---

# 3. 非目标与禁止事项

本轮不得引入：

- Embedding；
- 向量数据库；
- 第二模型；
- LLM reranker；
- 新远程 API；
- 新数据库 Schema；
- 多历史 Checkpoint 存储；
- 新 UI；
- 事件数据库；
- 无关重构；
- 大规模类型重写；
- 为测试方便改变生产语义；
- 新增全局可变缓存；
- 取消或降低现有测试与覆盖率门禁。

以下项目仍明确不属于本轮：

- Android 16KB page-size 原生库对齐；
- ARM64 真机专项；
- 本地 GGUF 长上下文专项；
- 进程强杀后的 `rebuilding` 恢复；
- 中文 IME 全链路录制；
- 多历史 Checkpoint 快照库。

---

# 4. 核心设计原则

## 4.1 人物身份只以 characterId 为准

人物身份判断、去重、人物历史桶、人物数量和人物组合奖励不得再使用姓名字符串推断。

姓名与别名只用于：

- 文本解析；
- 展示；
- 调试信息。

## 4.2 同一次上下文构建使用同一快照

`prepareStoryMemoryForGeneration()` 返回的：

```ts
prepared.checkpoint
prepared.coverage
```

必须成为本次 `buildContext()` 的唯一 Story Memory 快照。

主生成链路不得在 prepare 后再次查询 Checkpoint。

## 4.3 歧义词阻挡但不激活

共享 alias、canonical/alias 冲突、大小写冲突等歧义词：

- 不激活任何人物；
- 仍参加最长词优先扫描；
- 命中后占用文本区间；
- 阻止内部或重叠的短词误激活。

## 4.4 CI 必须执行真实发布门禁

任何声称进入 `npm run verify` 的发布门禁，都必须在 GitHub Actions 中显式执行，不能只依赖本地报告。

---

# 5. 修复一：人物历史桶彻底改用人物 ID

## 5.1 当前问题

`scoreMemoryCandidates()` 已通过统一人物解析器获得候选摘要中的人物 ID，但 `ScoredMemoryCandidate` 只保存：

```ts
matchedCharacters: string[]
```

混合 Top-K 的人物历史桶随后调用：

```ts
candidateMentionsActiveCharacter()
activeCharacterCountInCandidate()
```

并可能退回到 canonical name / alias 的字符串包含判断。

这会造成：

- 重名候选被错误视为同时命中多个人；
- 歧义正式姓名错误进入人物桶；
- 查询与候选使用不同别名时，评分正确但人物桶排序仍不正确；
- pair priority 与实际人物 ID 解析不一致。

## 5.2 修改 ScoredMemoryCandidate

增加：

```ts
export interface ScoredMemoryCandidate {
  chapter: Chapter;
  text: string;
  cosineScore: number;
  entityBoost: number;
  pairBoost: number;
  finalScore: number;

  matchedCharacterIds: string[];
  matchedCharacters: string[];
  matchedObjects: string[];
  matchedThreads: string[];
}
```

要求：

- `matchedCharacterIds` 来自候选解析结果和 active ID 集合的交集；
- 必须去重；
- 顺序稳定；
- `matchedCharacters` 只做显示映射；
- legacy / empty query / empty IDF 分支统一填 `[]`。

## 5.3 修改人物桶逻辑

删除或停止使用生产路径中的：

```ts
candidateMentionsActiveCharacter(candidate, active)
activeCharacterCountInCandidate(candidate, active)
```

基于姓名 `includes` 的回退。

改为：

```ts
function candidateMentionsActiveCharacter(
  candidate: ScoredMemoryCandidate,
): boolean {
  return candidate.matchedCharacterIds.length > 0;
}

function activeCharacterCountInCandidate(
  candidate: ScoredMemoryCandidate,
): number {
  return candidate.matchedCharacterIds.length;
}
```

如果保留旧函数用于兼容测试，必须：

- 明确标为 legacy/test-only；
- 现代生产路径不得调用；
- 不得影响混合 Top-K。

## 5.4 人物组合优先级

人物历史桶排序中的 pair 判定必须改为：

```ts
candidate.matchedCharacterIds.length >= 2
```

不得重新扫描候选文本。

## 5.5 必测反例

### 重名歧义候选

```text
A canonical=李明 alias=记者
B canonical=李明 alias=医生

查询：记者和医生去现场
候选1：李明去了现场
候选2：记者与医生共同去了现场
```

预期：

- 候选1 `matchedCharacterIds=[]`；
- 候选1不得获得人物桶双人优先；
- 候选2命中 A、B 两个 ID；
- 候选2获得 pair priority。

### 跨别名候选

```text
林岚 aliases=小岚、岚姐

查询：林岚追问银钥匙
候选：岚姐交出银钥匙
```

预期：

- `matchedCharacterIds=['char_lan']`；
- 正常进入人物历史桶。

---

# 6. 修复二：歧义词参与区间占用

## 6.1 当前问题

解析器会识别 `ambiguousNormalizedTerms`，但歧义 owner 被过滤后不参与候选扫描。

因此：

```text
A alias=队长
B alias=队长
C canonical=长
查询：队长下令
```

可能错误激活人物 C。

## 6.2 统一扫描单元

建立统一扫描项：

```ts
interface CharacterTermScanEntry {
  normalizedTerm: string;
  displayTerm: string;
  owners: CharacterTermOwner[];
  ambiguous: boolean;
  length: number;
}
```

所有唯一词与歧义词均进入同一列表。

## 6.3 扫描顺序

按以下顺序排序：

1. `displayTerm.length` 降序；
2. canonical 优先于 alias，仅对唯一词稳定排序；
3. `normalizedTerm`；
4. `displayTerm`。

## 6.4 命中规则

对每个扫描项：

### 歧义项

- 查找所有未被占用的命中区间；
- 将这些区间加入 `claimedSpans`；
- 加入 `ambiguousTermsEncountered`；
- 不创建 `CharacterMention`；
- 不激活任何人物。

### 唯一项

- 只处理未与 `claimedSpans` 重叠的区间；
- 创建 mention；
- 激活唯一 characterId；
- 占用区间。

## 6.5 重要边界

必须覆盖：

```text
队长 / 长
老林 / 林
Captain / captain / Captain队长
林岚 / 林
```

预期：

- 歧义长词阻挡内部短词；
- 唯一长词阻挡内部短词；
- 同一文本其他不重叠位置的短词仍可正常激活。

示例：

```text
队长下令，长随后离开
```

如果“队长”歧义，“长”是唯一人物：

- “队长”内部的“长”不激活；
- 后半句独立出现的“长”可以激活。

---

# 7. 修复三：单次 buildContext 使用同一 prepared 快照

## 7.1 当前问题

主链路当前为：

```text
prepareStoryMemoryForGeneration()
→ 获得 prepared.checkpoint / prepared.coverage
→ buildStoryMemoryContext()
→ 再次从数据库读取 Checkpoint
```

两次读取之间如果 Checkpoint 状态发生变化，可能出现：

- coverage 以旧 clean Checkpoint 计算；
- Renderer 却因第二次读取 dirty 而不注入；
- 早期章节长期状态形成缺口；
- 或新 Checkpoint 与 Pending Bridge 重复覆盖。

## 7.2 新增纯渲染入口

新增：

```ts
export function renderPreparedStoryMemoryContext(
  projectId: number,
  currentChapter: Chapter,
  checkpoint: ProjectStoryMemoryRecord | null,
  budgetTokens: number,
  options?: { retrievalUserPrompt?: string },
): { text: string; traceItems: ContextTraceItem[] }
```

该函数：

- 不访问数据库；
- 只使用传入 checkpoint；
- 可内部再次做 eligibility 防御，但不得替换为 DB 新值；
- 负责 Renderer 和 trace。

## 7.3 主链路修改

`buildContext()` 必须使用：

```ts
renderPreparedStoryMemoryContext(
  projectId,
  currentChapter,
  prepared?.checkpoint ?? null,
  budget,
  ...
)
```

不得再次调用数据库读取型 `buildStoryMemoryContext()`。

## 7.4 保留外部包装函数

如其他独立调用方仍需要：

```ts
buildStoryMemoryContext(projectId, ...)
```

可以保留包装：

```text
DB read
→ eligibility
→ renderPreparedStoryMemoryContext()
```

但主生成链路不能使用该包装。

## 7.5 快照一致性不变量

同一次 `buildContext()`：

```text
coverage.checkpointThroughPosition
storyStateForRetrieval
Story Memory Renderer
trace 中 Checkpoint through
```

必须来自同一份 `prepared.checkpoint`。

## 7.6 集成测试

使用数据库 mock 模拟：

### 场景 A：prepare 后 DB 被标记 dirty

- prepare 返回 clean through=10；
- 第二次 DB mock 若被调用则返回 dirty；
- 主链路必须不进行第二次 Checkpoint 读取；
- Renderer 使用 prepared clean 快照；
- coverage 与 Renderer through 一致。

### 场景 B：prepare 返回 null

- 后续 DB 变为 clean；
- 主链路不得突然注入新 Checkpoint；
- 本轮使用 raw/episodic coverage。

### 场景 C：未来 Checkpoint

- prepare 返回 checkpoint=null；
- coverage 起点=-1；
- Renderer 不注入；
- entity state=null；
- preview 不调用 LLM。

---

# 8. 修复四：GitHub Actions 执行版本一致性门禁

## 8.1 修改 workflow

在 `.github/workflows/verify.yml` 的 JavaScript Job 中增加：

```yaml
- name: Version consistency
  run: npm run verify:version
```

建议顺序：

```text
Install dependencies
→ Version consistency
→ Lint
→ TypeScript
→ Jest with coverage
```

也可直接执行 `npm run verify`，但不能因此重复运行大量测试。

推荐保留独立步骤，便于失败时明确定位。

## 8.2 CI 验收

新的 Run 必须明确包含步骤：

```text
Version consistency — success
```

施工报告必须记录该步骤，而不是只记录本地命令。

---

# 9. 修复五：加强版本一致性脚本

## 9.1 精确检查 README 英文摘要

必须使用明确正则或固定模板检查：

```text
The current version is **V2.5.13**
```

不能只统计 README 中版本字符串出现次数。

## 9.2 精确检查正式 APK 文本

README 如继续保留“当前正式产物”，必须检查：

```text
ShineWriter-V2.5.13-release.apk
versionName=V2.5.13
versionCode=2051300
```

APK 大小与 SHA-256 不建议纳入自动版本脚本，因为构建前无法确定。

## 9.3 推荐简化 README

建议将：

```text
当前正式产物：文件名 + 大小 + Hash + 签名
```

改为：

```text
当前正式产物及 SHA-256、签名、zipalign、aapt 结果见：
docs/V2.5.13-STORY-MEMORY-FINAL-HARDENING-REPORT.md
```

这样 README 只维护：

- 当前版本；
- 当前 APK 文件名；
- 报告链接。

避免每次版本升级同步多组构建信息。

## 9.4 versionCode

目标：

```text
V2.5.13
versionCode 2051300
```

继续使用现有版本规则。

---

# 10. 修复六：补齐真实生产接线测试

## 10.1 Checkpoint 集成测试

新增测试文件建议：

```text
__tests__/storyMemoryPreparedSnapshotIntegration.test.ts
```

必须覆盖：

- `prepareStoryMemoryForGeneration()`；
- `buildContext()`；
- `renderPreparedStoryMemoryContext()`；
- `resolveStoryStateForRetrieval()`；
- preview；
- generation。

不能只测试 eligibility 纯函数。

## 10.2 断言要求

未来或同位置 Checkpoint 场景必须断言：

```text
prepared.checkpoint === null
coverage.checkpointThroughPosition === -1
resolveStoryStateForRetrieval(prepared) === null
Story Memory text === ''
preview 未调用 LLM
```

coverage 不足时：

```text
generation 被阻止
不得使用未来状态兜底
```

## 10.3 单快照测试

通过 mock 统计：

```text
getProjectStoryMemory / ensureProjectStoryMemoryRow
```

主链路 prepare 后不得为 Renderer 再读取一次 Checkpoint。

---

# 11. 修复七：关系预算测试取消条件放行

## 11.1 当前问题

现有测试使用：

```ts
if (result.includedCharacterIds.length >= 2) {
  expect(...)
}
```

这会允许关键关系完全未进入时测试仍通过。

## 11.2 修改要求

使用固定、可计算的测试数据和确定预算。

无条件断言：

```ts
expect(result.includedCharacterIds).toContain('char_lan');
expect(result.includedCharacterIds).toContain('char_zhou');
expect(result.includedRelationshipIds).toContain('rel_lan_zhou');
expect(result.estimatedTokens).toBeLessThanOrEqual(budget);
```

测试预算必须：

- 足够容纳 prefix + 林岚 + 周恪 + rel_lan_zhou；
- 不足以容纳全部 8 名人物；
- 通过程序计算边界，不使用不稳定的 35% 推断。

可以先独立渲染最小 state 计算必要预算，再在大 state 中使用该预算加少量余量。

---

# 12. 修复八：人物历史桶专项测试

新增测试覆盖：

## 12.1 重名正式姓名

```text
查询：记者和医生去现场
候选：李明去了现场
```

断言：

```text
matchedCharacterIds=[]
人物桶不选择为双人物候选
pairBoost=0
```

## 12.2 明确两个 alias

```text
候选：记者与医生共同去了现场
```

断言：

```text
matchedCharacterIds=['char_reporter','char_doctor']
pairBoost > 0
人物桶优先
```

## 12.3 跨别名

```text
查询：林岚
候选：岚姐
```

断言：

```text
matchedCharacterIds=['char_lan']
```

## 12.4 歧义长词阻挡短词

```text
队长 / 长
老林 / 林
```

断言：

- 内部短词不激活；
- 不重叠独立短词正常激活。

---

# 13. 系统不变量更新

更新：

```text
__tests__/storyMemorySystemInvariants.test.ts
```

增加以下不变量。

## 13.1 人物桶不变量

```text
混合 Top-K 的人物桶只依赖 matchedCharacterIds。
```

不得通过姓名重新推断人物身份。

## 13.2 歧义占位不变量

```text
歧义词不激活人物，但必须阻挡重叠短词。
```

## 13.3 单快照不变量

```text
一次 buildContext 中 coverage、entity boosts、Renderer 和 trace
必须来自同一个 prepared Checkpoint。
```

## 13.4 远端版本门禁不变量

GitHub Actions workflow 文件必须包含：

```text
npm run verify:version
```

可以通过 Node 脚本测试或文本契约测试验证。

---

# 14. 代码反模式扫描

施工结束后必须搜索仓库：

```text
candidateMentionsActiveCharacter
activeCharacterCountInCandidate
includesInsensitive(candidate.text
getProjectStoryMemory(projectId)
buildStoryMemoryContext(
The current version is **V2.5.8**
ShineWriter-V2.5.8-release.apk
```

检查原则：

- 人物桶不得保留现代路径的姓名猜测；
- 主 `buildContext` 不得再次读取 Checkpoint；
- README 不得残留当前版错误信息；
- 历史 changelog 和旧报告中的旧版本字符串不需要修改。

---

# 15. Token 与性能要求

本轮不改变 Token 预算算法。

重新执行：

```text
30 章
100 章
300 章
10 人
50 人
100 人
```

重点记录：

- 候选 mention resolve；
- mixed Top-K；
- Story Memory render；
- 单次 buildContext DB 读取次数；
- 总召回耗时。

要求：

- 不重复解析同一候选以决定人物桶；
- `matchedCharacterIds` 直接复用评分阶段结果；
- 性能不得明显倒退；
- 300 章仍低于现有软阈值。

---

# 16. Android 模拟器验收

必须实际执行旧章节回写场景，不能只用单元测试代替。

## 16.1 场景准备

1. 创建测试项目；
2. 创建至少 12 个有正文的章节；
3. 形成覆盖后期章节的 clean Checkpoint；
4. 确认 Checkpoint through 大于某个早期目标章节位置。

## 16.2 旧章节预览

返回早期章节，例如第 4 章：

- 打开上下文预览；
- Story Memory 不得注入未来 Checkpoint；
- trace 显示检查点不可用于目标章节；
- raw/episodic fallback 按覆盖规划工作；
- 无崩溃。

## 16.3 旧章节生成

执行一次 AI 生成或在无真实 API 条件下完成可验证的生成前上下文构建：

- 不注入未来人物秘密和关系；
- coverage 不足时明确阻止；
- 不调用额外远程 API；
- 无 AndroidRuntime FATAL。

## 16.4 多人物关系

在当前写作要求中同时提及 8 人：

- 上下文预览包含关键关系双方；
- 包含关键关系；
- 不超预算。

## 16.5 证据

施工报告记录：

- 模拟器编号；
- Android 版本；
- 测试项目/章节数量；
- Checkpoint through；
- 目标旧章节 position；
- trace 结果；
- logcat 结果；
- 截图或 UI tree 路径。

---

# 17. 测试与门禁

必须执行：

```bash
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
npm run test:coverage
npm run verify
```

要求：

- 不使用 `--forceExit`；
- 不降低覆盖率；
- 不删除既有测试；
- 不通过条件断言放行核心要求；
- 新增测试必须验证具体 ID、具体路径和具体 DB 调用次数。

---

# 18. GitHub Actions

推送 V2.5.13 发布提交后，运行真实 Verify。

必须确认：

- Version consistency：success；
- JavaScript validation：success；
- Android Debug build：success；
- Migration matrix：success；
- workflow head_sha 等于 V2.5.13 release commit。

README 和施工报告回填真实 Run。

---

# 19. 版本与发布

目标版本：

```text
V2.5.13
versionCode 2051300
```

更新：

```text
package.json
package-lock.json
src/constants/version.json
CHANGELOG.md
README.md
docs/optimization/progress.md
docs/V2.5.13-STORY-MEMORY-FINAL-HARDENING-REPORT.md
```

正式 APK：

```text
dist/apk/release/ShineWriter-V2.5.13-release.apk
```

校验：

- 文件大小；
- SHA-256；
- 正式证书；
- APK Signature Scheme；
- signer 数量；
- zipalign；
- aapt versionName/versionCode；
- 模拟器安装。

不得新建 keystore，不得使用 Debug 签名。

---

# 20. 完成定义

只有全部满足才可交付：

- [ ] `ScoredMemoryCandidate` 包含 `matchedCharacterIds`；
- [ ] 人物历史桶只使用 `matchedCharacterIds`；
- [ ] 重名歧义候选不进入双人物桶；
- [ ] 跨别名候选正常进入人物桶；
- [ ] 歧义长词占用区间；
- [ ] “队长/长”“老林/林”测试通过；
- [ ] 主 `buildContext()` 复用 prepared checkpoint；
- [ ] prepare 后不为 Renderer 二次读取 Checkpoint；
- [ ] coverage、entity state、Renderer、trace 同快照；
- [ ] GitHub Actions 执行 `verify:version`；
- [ ] README 英文摘要为 V2.5.13；
- [ ] README 正式 APK 信息不再停留旧版本；
- [ ] 未来 Checkpoint 真实接线集成测试通过；
- [ ] 关系预算测试无条件断言关键关系；
- [ ] 系统不变量更新；
- [ ] 30/100/300 章性能不退化；
- [ ] 模拟器旧章节回写场景通过；
- [ ] Schema、备份、API 次数、默认预算不变；
- [ ] CI 对应 release commit 全绿；
- [ ] Release APK 校验通过；
- [ ] 报告明确列出仍未解决的项目级风险。

---

# 21. Agent 施工纪律

开始前执行：

```bash
git status
git branch --show-current
git log -5 --oneline
git diff
git fetch origin
```

要求：

- 基于最新远端 `main`；
- 不覆盖用户未提交内容；
- 不做无关格式化；
- 每项生产修改必须有测试；
- 必须替换旧旁路，而不是只新增另一套逻辑；
- 修复后进行仓库级搜索；
- 必须完成代码、测试、CI、模拟器、版本和 APK；
- 不得用施工报告替代实际执行；
- 不得把纯函数测试写成模拟器验收；
- 不得使用条件断言让核心测试假通过。

---

# 22. 最终施工报告

报告必须包含：

1. 基线提交和最终 release commit；
2. 修改文件；
3. 三项生产缺陷的根因和修复；
4. 删除或停用的旁路逻辑；
5. `matchedCharacterIds` 的使用范围；
6. 歧义词区间占用规则；
7. prepared snapshot 一致性；
8. DB 读取次数测试；
9. 集成测试与反例测试；
10. 无条件关系预算测试；
11. 30/100/300 章性能；
12. 版本一致性脚本与 GitHub Actions 步骤；
13. README 中英文及 APK 信息；
14. Schema、备份、API 次数；
15. 模拟器旧章节回写实测；
16. GitHub Actions Run ID 与 head_sha；
17. APK 路径、大小、SHA-256、签名、zipalign、aapt；
18. 仍存在但不属于本轮的项目级风险；
19. 是否仍有任何已知的人物桶误判、歧义子串、Checkpoint 快照竞态或版本门禁缺陷。

不得使用“理论上”“应该”“预计”等措辞替代实际结果。
