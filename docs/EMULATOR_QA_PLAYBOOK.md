# TAVO-MINI 模拟器 QA 实操手册（踩坑记录）

> 来源：2026-08-10 Story Memory No-Stall P1/P2 V3 真机穿测
> 设备：emulator-5554（pixel_6 / API 37）/ 包名 com.shinewriter / V2.11.40
> 全局工具卡：`~/.claude/CLAUDE.md` 的 Maestro + ADB 卡 + `~/.claude/memory/maestro-adb.md`

## 1. 一轮 QA 的标准流程

```powershell
# 0) 证据目录（产物一律进 test-logs/，不许污染仓库根）
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Path "test-logs/emulator-qa-$stamp" -Force | Out-Null

# 1) 构建 + 安装（保留数据用 install -r，不要 pm clear）
npm run apk:debug
adb -s emulator-5554 install -r "dist/apk/debug/ShineWriter-V2.11.40-debug.apk"

# 2) 启动 + UI 探测
adb -s emulator-5554 shell am force-stop com.shinewriter
adb -s emulator-5554 shell am start -n "com.shinewriter/.MainActivity"
Start-Sleep -Seconds 5
adb -s emulator-5554 shell uiautomator dump /sdcard/qa.xml | Out-Null
adb -s emulator-5554 exec-out cat /sdcard/qa.xml > test-logs/ui-1.xml
node scripts/qa/ui-list-texts.mjs emulator-5554 test-logs/ui-1.xml

# 3) LLM / 项目前置检查
adb -s emulator-5554 exec-out run-as com.shinewriter cat databases/shine_writer.db > test-logs/db.sqlite
# 用 python 脚本查（不要内联 -c，见踩坑 8）

# 4) 语义驱动：ui-find → ui-tap
node scripts/qa/ui-find.mjs emulator-5554 '关键字'
node scripts/qa/ui-tap.mjs --serial emulator-5554 --match '关键字' --partial --dump test-logs/ui-x.xml
```

## 2. 本轮踩坑记录（血泪）

### 2.1 项目列表页：点卡片不会导航！
`ProjectListScreen` 的项目卡片 `onPress` 只调 `setCurrentProject(item)`，**不导航**。
正确流程：点卡片（选中当前项目）→ 再点底部 **"3 写作"** tab 才进章节列表。
表现：点卡片后 UI 树完全不变（只有"当前工作项目"badge），容易误判为点击无效。

### 2.2 Maestro 中文匹配必挂（GBK 编码）
`maestro test` 对中文文本断言/匹配是乱码（日志 `Assert that "?????" is visible FAILED`），
flow YAML 里的 `tapOn: "R2-测试项目"` / `assertVisible: "作品集"` 全部失效。
**结论：本项目 UI 驱动不要用 maestro 中文匹配，一律 `adb shell input tap` + `ui-find.mjs` 坐标。**
（maestro hierarchy/list-devices 仍可用；它显示的 `pixel_6 / android-33` 与 adb 的 API 37 是两套信息源，以 adb 为准。）

### 2.3 按钮坐标：用 ui-list-nodes.mjs 拿准确 bounds
```powershell
node scripts/qa/ui-list-nodes.mjs test-logs/ui-x.xml | Select-String 'CLICK|关键字'
```
注意：`ui-list-nodes.mjs` **不带 serial 参数**（直接传 xml 路径）；`ui-list-texts.mjs` / `ui-find.mjs` **带 serial**。搞混就 ENOENT。

### 2.4 章节编辑器工具栏是横向 ScrollView
"AI 重新生成/定稿/版本"在左侧；**"历史/朗读/上下文/草稿"在右侧，必须横向滑动**才可见：
```powershell
adb -s emulator-5554 shell input swipe 900 880 300 880 300
```
上下文预览入口就是工具栏里的"上下文"按钮（icon Eye），不在顶部 tab。

### 2.5 直接改模拟器 DB（构造测试数据的路径）
```powershell
# app 必须 force-stop，否则 SQLite 锁冲突 + 覆盖丢失
adb -s emulator-5554 shell am force-stop com.shinewriter
adb -s emulator-5554 exec-out run-as com.shinewriter cat databases/shine_writer.db > test-logs/db-live.sqlite
# python 改完：
adb -s emulator-5554 push test-logs/db-live.sqlite /data/local/tmp/qa-db.sqlite
adb -s emulator-5554 shell run-as com.shinewriter cp /data/local/tmp/qa-db.sqlite databases/shine_writer.db
adb -s emulator-5554 shell am start -n "com.shinewriter/.MainActivity"
```
坑：
- chapters 表 SELECT 结果 dict 的 key 是 **id 不是 position**（`SELECT id, position, title`），按 position 索引会 KeyError
- 修改前先 `PRAGMA table_info(chapters)` 拿全列，INSERT 要带全 NOT NULL 列（created_at/updated_at 等）

### 2.6 PowerShell 里内联 python 必炸
`python -c "..."` 里的双引号/中文/`\` 在 pwsh 下会被转义吃掉（`length(content)` 被解析成 cmdlet）。
**一律写成 `test-logs/*.py` 文件再 `python test-logs/x.py`。**

### 2.7 force-stop 会杀死运行中的 pipeline
前台服务（PipelineForeground）也保不住 `am force-stop`。第 12 章 pipeline 跑到
proofing 被我 force-stop 中断成 `interrupted`（"任务被中断，可重新开始或恢复"）。
证据采集完再 force-stop；要验证完整 pipeline 必须等它跑完。

### 2.8 RN Alert 对话框：点击后可能有"残留"假象
降级确认框（"长期记忆暂不可用"）点击"继续生成"后，uiautomator dump 可能仍显示
对话框（旧视图缓存）。**判断是否生效看 logcat ReactNativeJS 的 pipeline 日志或 DB**，
别只信 UI dump。BACK 键 = 取消对话框。

### 2.9 zai-mcp 图片分析有配额（429）
`zai-mcp-server_analyze_image` 当月配额耗尽会 429（`Weekly/Monthly Limit Exhausted`）。
截图排障不可用时，**纯靠 UI 树驱动**：dump → ui-list-texts → ui-find → tap。

### 2.10 uiautomator dump 会输出旧视图
页面切换后等 2-5 秒再 dump；dump 失败（无输出）时重跑一次，别拿上一次的 xml 瞎找节点。

## 3. Story Memory P1 V3 真实链路边界

- Safe Coverage：本地覆盖可证明时，写作入口立即继续；后台维护排队，前台不等待 Story Memory LLM。
- Hard Gap：本地发现历史硬缺口时，立即显示“暂不能安全生成”；不通过降级确认绕过，也不先发 LLM 请求。
- 定稿：章节正文与 `final` 状态先在本地事务落库；摘要/检查点维护属于后续后台工作，Partial Success 保留已应用状态。
- 请求：每个 Story Memory 逻辑子任务使用 `thinking: { type: "disabled" }`，真实物理 HTTP 预算最多 3 次；`sent` 后进程中断在冷启动被标记为 `outcome_unknown`，禁止静默重发。
- 调试升级：必须使用 `adb install -r`。若设备现有包由正式 TAVO MINI 证书签名，需要用同一既有证书签名的 debug 变体；禁止卸载、`pm clear` 或删除数据库。
- 验证工具：将临时 SQLite 快照脚本放入 `test-logs/`（仅记录配置元数据，不记录 API Key），并结合 `uiautomator dump`、过滤后的 logcat 与 ledger 行做证据闭环。
