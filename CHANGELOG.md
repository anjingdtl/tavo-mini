# Changelog

All notable changes to ShineWriter are documented here. This file follows the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Version
numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.5.10] - 2026-07-20

### Fixed

- **极小 Token 预算不超限**：`selectCandidatesWithinTokenBudget()` 在截断前先扣除完整章节前缀 Token；预算连完整前缀都容纳不下时返回空结果，避免截断后由 `formatMemoryCandidateLine()` 重新加前缀导致超预算。
- **Story Memory 实体词单次计算**：`contextBuilder` 每条 Episodic 检索只 `collectStoryRetrievalTerms` / `findActiveStoryTerms` 一次，经可选 `precomputed` 参数传入 `scoreMemoryCandidates()`，评分结果与旧路径完全一致。

### Tests

- 新增极小预算（1/5/10）、前缀不足、前缀+短正文、首候选截断与 `estimateTokens(memoryText) <= budget` 边界用例。
- 新增预计算与旧调用评分一致性、`collectStoryRetrievalTerms` 单次构建只执行一次的断言。
- 30/100/300 章性能软阈值回归继续通过。

### Notes

- V2.5.9 已正式发布（`d856052` / 报告 `docs/V2.5.9-STORY-MEMORY-RETRIEVAL-FIX-REPORT.md`），故本边界修复升版为 **V2.5.10**。
- Schema / 备份格式 / Checkpoint / Pending Bridge / Seam / 默认 Token 预算 / API 调用次数均不变；无 Embedding 或第二模型。

## [2.5.9] - 2026-07-20

### Fixed

- **Checkpoint 主路径摘要密度**：默认 smart Checkpoint 的 `chapterSummaries` 提示词与字段契约强化「谁对谁做了什么」、承诺/欺骗/冲突/合作/救援/拒绝/背叛、物品流转、信息与未解决矛盾，并禁止模糊代词，使默认主路径与 `generateMemorySummary()` 对齐。
- **不可用 Story Memory 不参与实体加权**：Episodic 检索仅复用 `prepareStoryMemoryForGeneration()` 判定可用的 Checkpoint state；`dirty` / `empty` / `failed` / `rebuilding` / 异常一律 `storyState = null`，回退中文 n-gram TF-IDF。
- **Token 预算优先序**：混合 Top-K 后先按召回优先级做预算筛选（超长跳过并尝试后续更短候选；尚无入选时可截断最高优先），再按 `chapter.position` 升序展示，避免早期次要摘要挤掉关键互动。
- **共用别名歧义**：`aliasToCanonicalNames` 一对多；多人物共用「队长」等称呼记为歧义别名，不自动激活人物、不参与组合奖励；仅 canonical 名明确出现时激活。

### Tests

- 新增/扩展 Checkpoint 检索摘要、Dirty 状态、Token 预算、歧义别名与 30 章小预算回归测试。
- 门禁：`npm run verify` / `npm run test:coverage`。

### Notes

- API 调用次数不变（正文生成前仍 1 次远程请求）；Schema / 备份格式不变。

## [2.5.8] - 2026-07-20

### Added

- Episodic 历史摘要检索支持当前写作要求与上一章正文结尾进入查询。
- 中文章节记忆检索新增单字、双字、三字联合 Token，保留英文/数字完整 Token 与停用词。
- 基于现有 Story Memory 的人物姓名、别名、持有物、开放线索与伏笔做轻量实体加权；两名及以上当前相关人物共现时增加人物组合奖励。
- Top-K 改为相关度 + 当前人物历史 + 最近章节的混合选择，注入上下文时按章节位置升序展示。
- Story Memory 关系渲染改为「人物姓名[内部ID]」，并优先展示当前章节相关人物关系。
- 新增纯函数模块 `src/services/episodicMemoryRetriever.ts`（可回退 `EPISODIC_RETRIEVAL_V2_ENABLED`）。

### Improved

- `memory_summary` 默认目标长度约 300 字；提示词强化人物行为、互动、承诺/欺骗/冲突、物品流转与未解决矛盾。
- 长篇较早人物交互细节的回溯精度提升；普通章节正文生成前远程 API 调用次数保持 1 次。
- 不改变 Checkpoint 默认策略、Pending Bridge / Seam、Dirty rebuild 主逻辑、Token 预算与数据库 Schema。

### Tests

- 新增 `__tests__/memorySummaryPrompt.test.ts`、`episodicMemoryRetriever.test.ts`、`storyMemoryRendererRetrieval.test.ts`、`longStoryRecallRegression.test.ts`（含 30 章交互场景与 30/100/300 章性能软阈值）。
- 门禁：`npm run verify` 112 suites / 574 tests PASS；`npm run test:coverage` exit 0。

## [2.5.7] - 2026-07-19

### Fixed

- **章节改删与故事记忆 dirty 同事务**：`updateChapter` / `deleteChapter` 将章节写入或删除、项目 `updated_at`、`project_story_memory` dirty 标记（CASE 保留最早起点）以及相关 `story_memory_batches` 失效放入同一 SQLite `executeTransaction`。任一语句失败整笔回滚，消除「正文已新、记忆仍 clean、同文重试不再标脏」窗口；删除后章节不存在也无法二次触发 dirty 的风险一并关闭。
- dirty 重建时作废 `through >= dirty_from` 的已 applied 检查点批次，并在 dirty 路径禁止复用旧批次链（自 V2.5.6 跟进修复 `a6b90e2` 一并纳入本版正式交付）。

### Changed

- `storyMemoryRepository` 抽出可组合的 SQL 语句构造器，供章节仓储与既有 facade 共用；对外 repository API 保持兼容，无新 Schema / 迁移。

### Tests

- 扩展 `__tests__/projectChapterStoryMemoryDirty.test.ts`（11 例）：单次事务组成、事务 reject 无独立章节写 fallback、pending 仅失效、无记忆行兼容、更早 dirty 起点、position min、非连续性字段、相同正文不 dirty。
- 配套 `databaseTransaction` rollback 与 `storyMemoryRepository` dirty 事务断言。
- 门禁：`npm run verify` 108 suites / 557 tests PASS；`npm run test:coverage` exit 0。
- 模拟器原子 dirty 终验（gitignore 证据：`test-logs/story-memory-atomic-dirty-final/`）：真实编辑器 autosave 修改已覆盖章、大纲删除已覆盖章 → dirty + 批次失效；重建可恢复 clean。

## [2.5.6] - 2026-07-19

### Added

- Schema 16：`project_story_memory_policy`、`story_memory_batches`，含迁移、fresh schema、manifest 与备份恢复。
- 故事记忆检查点架构：默认 `smart` 策略、目标间隔 3 章；到达条件时一次批量 LLM 请求处理整批章节，禁止积压后补跑 N 次逐章请求。
- 批量检查点 prompt/校验/合并、coverage 规划、策略引擎与 Context Preview `story_memory_bridge` 诊断。
- 故事记忆页：更新策略、待整理范围、人物名称映射、中文状态与本地化时间。

### Changed

- 章节定稿先本地成功；长期记忆失败不回滚正文、不覆盖旧检查点。
- 生成上下文改为 Checkpoint + Pending Bridge + Seam，移除生成前无条件 `ensureStoryMemoryReady` 追平。
- 检查点覆盖范围外的新章/修改为 pending，不再误标 dirty。
- 重建默认按 `intervalChapters`（通常 3）分批，避免过大批次导致 JSON 截断。
- 人物/线索/关系更新对缺失引用 soft-skip，避免单条坏引用拖垮整批检查点。

### Fixed

- 定稿遇到模型把 `evidenceQuote` 轻微改写时，自动从当前章节正文恢复为真实连续摘录；无法安全定位的条目会被忽略，避免整章因单条证据阻塞。
- 定稿前重新读取自动保存后的章节，避免使用旧的编辑器快照覆盖最新正文；同步阻止重复点击触发并行定稿。
- 强化多人物抽取 prompt 与名单顺序，降低长篇 cast 漏人与重建缩水。

### Tests

- 新增 policy/coverage/30 章请求数证明、Schema 15→16 迁移、检查点合并与预算测试。
- 新增证据恢复、无依据证据拒绝和定稿闭包竞态回归测试。
- DeepSeek `deepseek-v4-flash` 模拟器 30 章多人物多线验收：11/11 人物、25 关系、10 个 3 章批次、`through=29/clean`，主检查点请求 10（非 30 次逐章 patch）。

## [2.5.5] - 2026-07-18

### Fixed

- 淇闀跨瘒鏁呬簨璁板繂闅忕珷鑺傛帹杩涙椂锛屾ā鍨嬭緭鍑鸿揪鍒伴暱搴︿笂闄愬悗杩斿洖涓嶅畬鏁?JSON锛屼笖淇璇锋眰缁х画娌跨敤鍚屼竴杈撳嚭棰勭畻鑰岄噸澶嶅け璐ョ殑闂銆?- 缁撴瀯鍖栬蹇嗚姹備紭鍏堝惎鐢?OpenAI 鍏煎 JSON Object 妯″紡锛涗笉鏀寔璇ュ弬鏁扮殑鏈嶅姟浼氳嚜鍔ㄥ洖閫€鏅€氭ā寮忋€?- 璁板綍妯″瀷 `finish_reason`锛屾棤鏁?JSON 浼氫互 2 鍊嶉绠楄嚜鍔ㄤ慨澶嶏紝绗簩娆′粛澶辫触鏃朵涪寮冩埅鏂画鏂囥€佷粠鍘熷绔犺妭閲嶆柊鐢熸垚锛屾渶楂樻墿瀹瑰埌 16000 tokens銆?- 璇佹嵁鏍￠獙澶辫触浼氭寚鍑哄叿浣?`evidenceQuote` 骞惰姹傛寜姝ｆ枃鍘熻瑷€閫愬瓧淇锛岄伩鍏嶆ā鍨嬪弽澶嶆剰璇戝悓涓€璇佹嵁锛涗弗鏍艰瘉鎹棬绂佷繚鎸佷笉鍙樸€?- 鏁呬簨璁板繂璇锋眰鏀圭敤 180 绉掗暱浠诲姟瓒呮椂锛屽苟瀵硅秴鏃躲€佺綉缁滈敊璇€丠TTP 429/5xx 鑷姩閲嶈瘯涓€娆★紝瑙ｅ喅妯″瀷鍋跺彂鎱㈠搷搴斿鑷村畾绋垮け璐ョ殑闂銆?
### Tests

- 鏂板 JSON 妯″紡銆佸吋瀹瑰洖閫€銆侀暱搴︽埅鏂瘑鍒€佷笁绾ф墿瀹瑰拰鏈€缁堥敊璇瘖鏂祴璇曘€?- 鏂板杩炵画 20 绔犵敓鍛藉懆鏈熷洖褰掞紝娉ㄥ叆姣忛€㈢ 3 绔犺繛缁袱娆℃埅鏂紝楠岃瘉鍏ㄩ儴绔犺妭椤哄簭瀹氱銆佹憳瑕侀潪绌恒€佽ˉ涓佸師瀛愭彁浜や笖鏁呬簨璁板繂淇濇寔 clean銆?- 浣跨敤 DeepSeek銆?M 涓婁笅鏂囧拰姝ｅ紡绛惧悕 release 鍦?Android API 37 x86_64 妯℃嫙鍣ㄩ€愮珷鍐欏叆骞跺畾绋?20 绔狅紱鏈€缁堢姸鎬佹甯搞€丏irty 璧风偣涓虹┖锛屽寘鍚?20 鍚嶇櫥鍦轰汉鐗╁拰 35 鏉′汉鐗╁叧绯汇€?
## [2.5.4] - 2026-07-18

### Fixed

- 淇缁撴瀯鍖栨晠浜嬭蹇嗘垚鍔熸帹杩涚珷鑺傘€佷絾妯″瀷杩斿洖绌?`episodicSummary` 鏃朵粛鎻愮ず鈥滅珷鑺傚凡瀹氱鈥濅笖绔犺妭鎽樿涓虹┖鐨勯棶棰樸€?- 鎽樿涓虹┖鏃朵紭鍏堜娇鐢ㄧ珷鑺傛瑕佺敓鎴愮‘瀹氭€т簨浠惰蹇嗭紱姒傝涔熶负绌烘椂浣跨敤鍘婚櫎 Markdown 鏍囬鍚庣殑姝ｆ枃鐗囨锛岀‘淇濆悗缁珷鑺備簨浠舵绱㈠缁堟湁闈炵┖鎽樿銆?- 瀵瑰凡搴旂敤琛ヤ竵浣嗗巻鍙叉憳瑕佷负绌虹殑绔犺妭锛屽啀娆＄偣鍑诲畾绋夸細澶嶇敤琛ヤ竵骞惰嚜鍔ㄨˉ鍐欐憳瑕侊紝鏃犻渶閲嶆柊鐢熸垚鏁呬簨鐘舵€併€?
### Tests

- 鏂板妯″瀷绌烘憳瑕併€佹瑕佸厹搴曘€佹鏂囧厹搴曞強宸插簲鐢ㄨˉ涓佹憳瑕佷慨澶嶅洖褰掓祴璇曘€?- 浣跨敤 DeepSeek 鍦ㄧ嚎 API銆?M 涓婁笅鏂囧拰姝ｅ紡绛惧悕 release 鍦?Android API 37 x86_64 妯℃嫙鍣ㄩ獙璇佺浜岀珷鎽樿钀藉簱銆佹憳瑕佸脊绐楄鍙栧強绗笁绔犱簨浠朵笂涓嬫枃娉ㄥ叆銆?
## [2.5.3] - 2026-07-18

### Fixed

- 淇鍚屼竴绔犺妭鍖呭惈澶氬悕鏂颁汉鐗╂椂 DeepSeek 澶嶇敤鍚屼竴涓?`tempRef` 瀵艰嚧瀹氱澶辫触鐨勯棶棰橈紱鐜板湪鎸変汉鐗╁悕纭畾鎬х敓鎴愬敮涓€寮曠敤锛屽苟鍚屾鏀瑰啓浠绘剰瑙勬ā浜虹墿鍏崇郴鍥俱€佸啿绐佸弬涓庤€呭拰绾跨储褰掑睘寮曠敤锛屾棤娉曞畨鍏ㄦ秷姝ф椂浠嶆嫆缁濆悎骞躲€?- 鍚屼竴浜虹墿琚ā鍨嬮噸澶嶆娊鍙栨椂鍚堝苟鍒悕銆佽韩浠姐€佺壒寰佸拰鍒濆鐘舵€侊紝閬垮厤鍒堕€犻噸澶嶄汉鐗╄褰曘€?- 琛ラ綈 OpenAI 鍏煎妯″瀷鐨勫畬鏁磋ˉ涓佸瓧娈靛绾︼紝骞跺吋瀹硅交寰敼鍐欑殑姝ｆ枃璇佹嵁銆佺己鐪佸彲閫夊瓧娈点€佸父瑙佷汉鐗╁瓧娈靛埆鍚嶄笌鍏崇郴绔偣鍚嶇О锛屼粛鎷掔粷鏃犱緷鎹簨瀹炪€佹偓绌哄叧绯诲拰鑷韩鍏崇郴銆?
### Tests

- 鏂板鍥涗汉鐗┿€佷笁鏉′氦鍙夊叧绯汇€佷袱鏉″苟琛屾晠浜嬬嚎锛屼互鍙婂叡浜?`tempRef`銆佸瓧娈电己鐪?鍒悕銆佽瘉鎹交寰敼鍐欏拰鏃犲叧璇佹嵁鎷掔粷鐨勫洖褰掓祴璇曘€?- 浣跨敤 DeepSeek 鍦ㄧ嚎 API銆?M 涓婁笅鏂囧拰姝ｅ紡绛惧悕 release 鍦?Android API 37 x86_64 妯℃嫙鍣ㄩ獙璇佺涓€绔犲弻浜虹墿/鍏崇郴钀藉簱涓庣浜岀珷鍏ㄥ眬鏁呬簨鐘舵€佹敞鍏ャ€?
## [2.5.2] - 2026-07-18

### Fixed

- 淇 DeepSeek 绛変腑鏂囨ā鍨嬩负鏂颁汉鐗╄繑鍥?`new_char_鐭崇拹` 杩欑被 Unicode 涓存椂寮曠敤鏃讹紝绔犺妭瀹氱琚鍒や负鈥滄柊浜虹墿涓存椂寮曠敤鏃犳晥鈥濈殑闂锛涙牎楠屼粛鎷掔粷绌烘牸銆佹爣鐐瑰拰鏃犳硶瀹夊叏娑堟鐨勫紩鐢ㄣ€?- 灏嗘柊浜虹墿涓存椂寮曠敤鐨勬牸寮忛敊璇笌閲嶅閿欒鎷嗗垎涓哄彲鎿嶄綔鐨?repair 鎻愮ず锛屽苟鍦ㄦ晠浜嬭蹇嗙郴缁熸彁绀鸿瘝涓槑纭敮涓€鎬т笌鍏佽瀛楃锛岄伩鍏嶇浜屾淇缁х画杩斿洖鍚岀被閿欒銆?- 绗竴绔犳晠浜嬭蹇嗗彲浠ユ甯告帹杩涘悗锛岀浜岀珷涓婁笅鏂囨仮澶嶆敞鍏ラ」鐩骇鍏ㄥ眬鏁呬簨鐘舵€併€?
### Tests

- 浣跨敤姝ｅ紡绛惧悕 V2.5.1 release銆丏eepSeek 鍦ㄧ嚎 API 鍜?1M 涓婁笅鏂囧湪 Android API 37 x86_64 妯℃嫙鍣ㄥ鐜板畾绋垮け璐ヤ笌鍏ㄥ眬鐘舵€佺己澶便€?- 鏂板 Unicode銆侀潪娉曟爣鐐瑰拰閲嶅 `tempRef` 瀹氬悜娴嬭瘯锛屽苟瀵逛慨澶嶅悗鐨勬寮忕鍚?release 鎵ц绗竴绔犲畾绋夸笌绗簩绔犱笂涓嬫枃娉ㄥ叆鍥炲綊銆?
## [2.5.1] - 2026-07-18

### Fixed

- 淇缁撴瀯鍖栨晠浜嬭蹇嗗湪妯″瀷璇锋眰宸茬粡鍙戝嚭鍚庡彇娑堟椂琚敊璇寔涔呭寲涓?`failed` 鐨勯棶棰橈紱鐜板湪鍙栨秷浼氫繚鐣欏凡瀹屾垚 checkpoint銆佹仮澶嶄负 `dirty`锛屽苟鍏佽缁х画閲嶅缓銆?
### Changed

- 灏嗛暱绡囩粨鏋勫寲鏁呬簨璁板繂鐨勬寮忓彂甯冪増鏈粺涓€鎺ㄨ繘鑷?V2.5.1锛孲chema 淇濇寔 15锛屼笉鏂板杩佺Щ銆?- 鍙戝竷鏂囨。鏄庣‘鍖哄垎纭畾鎬?OpenAI 鍏煎鏈嶅姟鐨勫崗璁?杩愯鏃堕獙璇佷笌鐪熷疄澶栭儴妯″瀷璇箟楠屾敹銆?
### Tests

- Android API 37 x86_64 妯℃嫙鍣ㄥ畬鎴?29 涓潪绌虹珷鑺傚畬鏁撮噸寤恒€佹甯歌緭鍑恒€乺epair銆佷簩娆￠潪娉曞け璐ャ€佸湪閫斿彇娑堜笌缁х画銆乻napshot 鍥炴斁鍜?clean 涓婁笅鏂囨敞鍏ャ€?- 闈炵┖澶囦唤鍦ㄦ竻闄ゅ簲鐢ㄦ暟鎹悗鎭㈠ Story Memory 涓夎〃 1/29/2 琛屽畬鍏ㄤ竴鑷达紝涓?API Key 鏈繘鍏ュ浠姐€?- 鏈€缁堟湰鍦伴棬绂佷负 98 suites / 489 tests锛涜鐩栫巼 statements 78.77%銆乥ranches 61.38%銆乫unctions 85.56%銆乴ines 80.33%銆?
### Known limitations

- 鐪熷疄澶栭儴妯″瀷鐨勮涔夎川閲忋€侀檺娴佷笌缃戠粶娉㈠姩锛屼互鍙?arm64 鐪熸満 llama.cpp 闀夸笂涓嬫枃鎬ц兘浠嶉渶涓撻」楠屾敹銆?- Android 16 KB page-size 瀵硅瘽妗嗘姤鍛婄殑绗笁鏂瑰師鐢熷簱瀵归綈椋庨櫓浠嶆湭鍏抽棴銆?
## [2.5.0] - 2026-07-18

### Added

- 鏂板闀跨瘒灏忚缁撴瀯鍖栨晠浜嬭蹇嗭細椤圭洰绾у浐瀹氫繚瀛樼櫥鍦轰汉鐗┿€佷汉鐗╁叧绯诲拰鏁呬簨涓荤嚎锛屾瘡娆＄珷鑺傜敓鎴愪綔涓鸿繛缁€х害鏉熷己鍒舵敞鍏ャ€?- 姣忕珷瀹氱鐢辨ā鍨嬪彧鐢熸垚甯︽鏂囪瘉鎹殑澧為噺琛ヤ竵锛岀▼搴忚礋璐ｄ弗鏍兼牎楠屻€佺ǔ瀹?ID 鍒嗛厤銆佺‘瀹氭€у悎骞跺拰绔犺妭浜嬩欢鏂囨湰娓叉煋銆?- 鏂板 Schema 15 鐨?`project_story_memory`銆乣chapter_memory_patches`銆乣story_memory_snapshots`锛屾敮鎸佸師瀛愪繚瀛樸€佸浠芥仮澶嶃€佺骇鑱斿垹闄や笌鎸変綅缃揩鐓с€?- 鏂板 dirty 澶辨晥銆乥ase fingerprint 鏍￠獙銆佽ˉ涓佸鐢ㄣ€佸彇娑?澶辫触 checkpoint銆佸畬鏁撮噸寤哄拰鏃ф憳瑕佸揩閫熷垵濮嬪寲銆?- 鏁呬簨姒傝鏂板鈥滄晠浜嬭蹇嗏€濋〉闈紝鍙煡鐪嬬姸鎬併€佷笁绫昏蹇嗐€佹瀯寤鸿繘搴﹀拰鏈€杩戦敊璇紝骞舵墽琛屽揩閫熷垵濮嬪寲銆佺户缁€佸畬鏁淬€佸彇娑堟垨娓呯┖閲嶅缓銆?- 鏂板 `structured_story_memory_enabled` 鍥炴粴寮€鍏筹紱鍏抽棴鍚庝繚鐣欐柊琛ㄥ苟鍥為€€鏃х珷鑺備簨浠舵憳瑕佸畾绋胯矾寰勩€?
### Changed

- `chapters.memory_summary` 缁х画淇濈暀锛屼絾鏀逛负鐢卞凡楠岃瘉 episodic patch 纭畾鎬ф覆鏌擄紱鍘?TF-IDF Top-K 妫€绱㈣兘鍔涗繚鐣欍€?- 涓婁笅鏂囬『搴忚皟鏁翠负绯荤粺棰勮 鈫?椤圭洰鏁呬簨鐘舵€?鈫?璧勬枡 鈫?鐩稿叧鍘嗗彶绔犺妭浜嬩欢 鈫?鏈€杩戞鏂?鈫?褰撳墠绔犺妭鎸囦护銆?- 鑷姩涓婁笅鏂囪緭鍏ラ绠楄皟鏁翠负姝ｆ枃 45% / 璧勬枡 20% / Story State 25% / Episodic Memory 10%锛屽苟鏂板姣忕珷琛ヤ竵杈撳嚭涓婇檺銆?- 鏁版嵁搴?Schema 浠?14 鍗囩骇涓?15锛涜縼绉诲彧寤鸿〃鍜岀储寮曪紝涓嶄細鍦ㄥ惎鍔ㄦ垨杩佺Щ鏃惰皟鐢ㄦā鍨嬨€?
### Fixed

- IDF 缂撳瓨绛惧悕鏀逛负绔犺妭 ID銆乼oken 鏁板拰鍐呭鎸囩汗缁勫悎锛屽彲璇嗗埆绛夐暱鎽樿鍐呭鍙樺寲銆?- 淇敼銆佸垹闄ゆ垨閲嶆帓宸插畾绋跨珷鑺備細鎶?dirty 璧风偣鍚堝苟鍒版渶鏃╁彈褰卞搷浣嶇疆锛屼笉鍐嶉潤榛樻敞鍏ュ凡鐭ヨ繃鏈熺殑鍏ㄥ眬鐘舵€併€?- 绔犺妭姝ｆ枃淇濆瓨涓庤蹇嗙敓鎴愬け璐ヨВ鑰︼紱妯″瀷鎴栦簨鍔″け璐ヤ笉浼氬洖婊氥€佹竻绌烘鏂囨垨浼€犳柊鐨勫畾绋挎椂闂淬€?
### Tests

- 鏂板棰嗗煙鍚堝苟銆佽繍琛屾椂鏍￠獙銆丼chema 14鈫?5銆乺epository銆丩LM repair銆佸畾绋裤€侀噸寤恒€佹覆鏌撱€佷笂涓嬫枃銆侀绠楀拰 UI 瀹氬悜娴嬭瘯銆?- 鑷姩鍖栫粨鏋滀笌瑕嗙洊鐜囪 [`docs/V2.5.0-STORY-MEMORY-TEST-REPORT.md`](docs/V2.5.0-STORY-MEMORY-TEST-REPORT.md)銆?
### Known limitations

- Android 鐪熸満 30 绔犲満鏅€佸湪绾挎ā鍨嬨€佹湰鍦?GGUF銆佸己鏉€鎭㈠涓庡浠芥竻绌烘仮澶嶄粛闇€鍙戝竷鍊欓€夊寘琛ラ獙銆?- 鏃ф憳瑕佸揩閫熷垵濮嬪寲渚濊禆鍘熸憳瑕佽川閲忥紱鍑嗙‘鎬ц姹傞珮鐨勯」鐩簲涓诲姩鎵ц瀹屾暣姝ｆ枃閲嶅缓銆?
## [2.4.6] - 2026-07-18

### Added

- 璁剧疆鏉垮潡鏂板"涓婁笅鏂囪嚜鍔ㄥ寲閰嶇疆"妯″潡锛氱敤鎴峰～鍏ユā鍨嬫敮鎸佺殑鏈€澶т笂涓嬫枃锛堝 200000锛夛紝绯荤粺鎸夊唴缃瘮渚嬶紙杈撳叆 80% / 杈撳嚭 20%锛夎嚜鍔ㄥ垎閰嶅埌 ContextConfig锛堟粦鍔ㄧ獥鍙?65% / 璧勬枡棰勭畻 20% / 鎽樿棰勭畻 15%锛夈€丳ipelineConfig锛堣崏绋?50% / 瀹￠槄 15% / 浜嬪疄鏍告煡 15% / 鏍″ 20%锛夈€乴lm_config銆乸resets 鍜岃祫婧愮骇 max_tokens 鍏?5 澶勯厤缃偣銆?- 鏀寔 128K / 200K / 512K / 1M 蹇嵎鎸夐挳涓庤嚜鐢辫緭鍏ワ紝瀹炴椂鍒嗛厤棰勮锛屼竴閿簲鐢ㄤ笌"鎭㈠榛樿"銆?- 璧勬簮绾?max_tokens 鎸夊悇琛ㄥ疄闄呮暟閲忓姩鎬佸垎鎽婏紙R1 绠楁硶锛夛紝鍗曢」鏈夋渶灏忎笅闄愬厹搴曘€?- 鏈湴 GGUF 妯″瀷鐨?`context_window` 涓嶈瑕嗗啓锛岀敱妯″瀷鏂囦欢鍏冩暟鎹繚鐣欍€?- 搴旂敤杩囩▼璧板崟涓€ `executeTransaction` 鍘熷瓙浜嬪姟锛屽啓鍏ュけ璐ユ暣浣撳洖婊氾紱璁板綍"涓婃搴旂敤"鍗＄墖渚涘洖鏄俱€?
### Changed

- 涓嶄慨鏀规暟鎹簱 Schema 鐗堟湰锛堜繚鎸?14锛夛紱涓嶅紩鍏ユ柊鐨?npm 渚濊禆銆?- 璁剧疆椤?AI 鏉垮潡椤堕儴鏂板鐙珛鍏ュ彛銆?
### Tests

- 鏂板 `contextAutoAllocator`锛?9 涓級涓?`contextAutoRepository`锛?2 涓級娴嬭瘯锛岃鐩栧垎閰嶇畻娉曞吀鍨?鏋佸ぇ/鏋佸皬/闆惰祫婧?姣斾緥甯搁噺涓?repository 璇诲啓 round-trip銆佸簲鐢ㄥ嚱鏁颁簨鍔″師瀛愭€т笌瀛楁淇濈暀璇箟銆?- 鍏ㄩ噺 Jest 鍩虹嚎锛?4 濂椾欢 / 432 娴嬭瘯閫氳繃銆?- emulator-5554锛圓ndroid 17 / x86_64锛夌鍒扮绌挎祴 8 妯″潡 0 宕╂簝锛屽畬鏁存姤鍛婅 [`docs/V2.4.6-TEST-REPORT.md`](docs/V2.4.6-TEST-REPORT.md)锛堝惈 6 寮犲叧閿埅鍥撅級銆?
### Known limitations

- `V2.4.6` 鏄伐绋嬮獙鏀?Tag锛屼笉鍚鍚?Release/Minified Release APK锛坄SHINE_WRITER_RELEASE_*` 鐜鍙橀噺鏈厤缃級銆俈2.4.4/V2.4.3/V2.4.2 鐨?release APK 鍦?`dist/apk/release/ShineWriter-V<ver>-release.apk` 宸插巻鍙蹭骇鐗┿€?- 16KB 椤靛ぇ灏?/ RELRO 瀵归綈璀﹀憡浠嶇劧瀛樺湪锛歚lib/{x86_64,arm64-v8a}/libllamacpp_jni.so`銆乣libreactnative.so`銆乣libhermesvm.so`銆乣libllama.so`銆乣libggml*.so`銆乣libsqliteJni.so` 绛夌涓夋柟 .so 鏈榻愶紝Android 15+ 鐪熸満鏃犳硶鍚姩锛涢渶 RN 0.85.x 鐨?16KB 鍏煎 patch + llama.cpp 閲嶇紪鍚庢墠鑳界敤浜?Play Store 鍙戝竷銆?
## [2.4.4] - 2026-07-16

### Added

- Added test-only migration/restore statement injection and real device flows for autosave kill, network interruption, and TTS background transitions.
- Added final per-flow Maestro/JUnit, logcat, UI-tree, screenshot, APK hash, and GitHub Actions evidence.

### Changed

- Node.js support is now `>=24.3.0`; CI uses Node 24.14.1.
- Jest CI and coverage run naturally without `--forceExit`, and GitHub Actions runs coverage once instead of executing the full suite twice.
- Backup publication now writes a staging file and atomically moves it into place after a successful write.
- The verification baseline is 82 Jest suites / 401 tests with 78.33% statements, 60.37% branches, 86.05% functions, and 79.95% lines.

### Fixed

- Autosave database failures propagate to exit guards and retain retryable pending state.
- Clearing chapter content now serializes with pending autosave and cannot be overwritten by a stale debounced write.
- Maestro selectors and navigation match the current Android UI, including API 37 compatibility prompts and deterministic pipeline cancellation.

### Known limitations

- `V2.4.4` is a Tag-only engineering release; no signed Release or Minified Release APK is attached because signing environment variables were unavailable.
- Migration-kill, restore-kill, GGUF-import-kill, and native OOM execution remain blocked by missing pause injectors/model assets; TTS background verification is partial because the API 37 emulator engine returned native error `-7` after playback began.
- API 37 reports a 16KB page-size/RELRO compatibility warning for native libraries; an ARM64 physical-device matrix remains required before distributing an RC APK.

### Security

- Fault-injection switches are test-only, cannot be enabled by remote input, and are disabled in Release builds.
- Release signing still requires process environment variables; no signing password, API key, or user database is committed.

### Removed

- No production capability was removed in V2.4.4.

## [2.4.3] - 2026-07-12

### Added

- Added Android llama.cpp local GGUF generation, import validation, progress reporting, cancellation, and local-model settings.
- Added Schema 14 runtime validation, note-mode compatibility repair, manifest-driven v3 backups, SHA-256 checksums, atomic restore, and external local-model references.
- Added TTS foreground keep-alive, unified notification permission handling, and background pipeline service timing fixes.

### Changed

- Release metadata is generated from `package.json`; Release signing requires explicit external environment variables.
- The database initialization path repairs known legacy defects before final schema validation.

### Fixed

- Fixed the legacy `project_note_config` upgrade path that could omit retrieval columns and make note-mode saving fail.
- Fixed world-book field preservation, background pipeline startup timing, and TTS foreground-service cleanup.

### Security

- Backup payloads do not contain LLM credentials; restoring a configuration clears any stale matching Keychain credential.

### Compatibility and upgrade risk

- Existing Schema 13 databases migrate to Schema 14. The startup repair path also handles databases that reached the current tables without all expected columns.
- Existing local GGUF files remain external assets and must be present or re-imported after restore; API keys must be entered again.

### Local model and API compatibility

- The supported local engine is Android llama.cpp with GGUF models. Online configuration remains OpenAI-compatible.

## [2.4.2] - 2026-07-11

### Added

- Added chapter-aware note navigation and chunking for the resource library.

### Changed

- Kept the database Schema unchanged from 2.4.1 while improving note retrieval context.

### Fixed

- Improved chapter selection and resource-library behavior for long notes.

### Security

- No new credential or network behavior was introduced in this release.

### Compatibility and upgrade risk

- No database migration is required from 2.4.1. Existing notes remain readable; chapter-aware indexing changes how long note content is presented to retrieval.

### Local model and API compatibility

- Local llama.cpp/GGUF and OpenAI-compatible API contracts remain unchanged.

## [2.4.1] - 2026-07-10

### Added

- Added stronger local-generation progress, startup, and failure feedback.

### Changed

- Hardened local-model generation controls, JNI concurrency/cancellation behavior, Qwen reasoning handling, and APK version-bundle validation.
- Kept the database Schema unchanged from 2.4.0.

### Fixed

- Fixed stale JavaScript bundles, cold-start pipeline results, inactive local configuration selection, and several local import/generation hangs.

### Security

- No new credential storage behavior was introduced in this release.

### Compatibility and upgrade risk

- No database migration is required from 2.4.0. Existing GGUF model records are retained; devices should re-test model loading after upgrading because native generation control changed.

### Local model and API compatibility

- GGUF models continue to use Android llama.cpp. OpenAI-compatible online endpoints remain supported.

## [2.4.0] - 2026-07-10

### Added

- Added the Android llama.cpp engine, JNI bridge, GGUF local-model manager, streaming generation, cancellation, and model lifecycle controls.
- Added TurboModule compatibility and regression coverage for the React Native 0.85 Android architecture.

### Changed

- Database Schema advanced from 12 to 13 for local-model metadata.
- The supported local-model path changed to GGUF + llama.cpp; the previous experimental local runtime was removed from the product path.

### Fixed

- Fixed native model-load/generation serialization, request cancellation races, model import state handling, and core TurboModule registration.

### Security

- Local GGUF inference runs on-device and does not require network access.

### Compatibility and upgrade risk

- Upgrading from 2.3.x runs the Schema 12鈫?3 migration. Legacy local-model records may require re-import when their source file or runtime is no longer available.

### Local model and API compatibility

- Android supports `.gguf` models through llama.cpp. Online APIs remain OpenAI-compatible and are independent of the local engine.
