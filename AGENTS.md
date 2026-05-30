# tavo-mini

基于 tavo-maker 小说家工作台的 **Android-only** React Native 应用。React Native CLI + TypeScript。

## 常用命令

- `npm install` — 安装依赖（自动触发 postinstall patch）
- `npm start` — 启动 Metro
- `npm run android` — 运行 Android 开发版
- `npm run apk:debug` — 构建 debug APK 并复制到统一产物目录
- `npm run apk:release` — 构建 release APK 并复制到统一产物目录
- `npm test` — 运行全部 Jest 测试
- `npx jest __tests__/llm.test.ts` — 运行单个测试文件
- `npm run lint` — ESLint 检查
- **无 typecheck 脚本**：项目没有独立 `tsc --noEmit`，不要瞎跑

### APK 产物目录

`dist/apk/{debug|release}/TavoMini-V<ver>-{debug|release}.apk` 是唯一交付路径。Gradle 原生 `android/app/build/outputs/apk/` 只是中间产物，不要手动复制 APK 到项目其他目录。

## 架构要点

### 入口
- `index.js` → `src/main/index.tsx`（ThemeProvider + NavigationContainer）
- `src/navigation/TabNavigator.tsx` — 底部 4 Tab（项目/写作/资料/设置）+ Stack 嵌套

### 状态管理
4 个 Zustand store：
- `projectStore` — 项目列表、当前项目、CRUD
- `settingsStore` — LLM 配置
- `themeStore` — 主题模式（亮色/暗色/护眼）
- `pipelineTaskStore` — 多阶段 AI 管线任务状态

### 数据层
SQLite 数据库 `tavo_mini.db`，16 张表（schema version 5）。服务层 `src/services/database.ts` 提供全部 CRUD。表：projects、chapters、fragments、plotlines、project_plotlines、characters、worldbook_collections、worldbook_entries、notes、presets、llm_config、settings、project_resources、llm_usage_logs、freeform_documents、pipeline_tasks。

### 主题配色
基准三色：`#439EA6`（主色）/ `#B0E0E3`（辅助）/ `#D7F1F4`（底色）。所有屏幕通过 `useThemeStore` 读取颜色，不硬编码。

### AI 管线
- `services/llm.ts` — OpenAI 兼容 API，流式 + 非流式，流式中断回退非流式
- `services/contextBuilder.ts` — 三种上下文策略（滑动窗口/完整/自定义）
- `services/macroReplace.ts` — `{{char}}`/`{{user}}`/`{{chapter}}`/`{{synopsis}}` 宏替换
- `services/pipelineRunner.ts` — 多阶段 AI 管线（草稿→审查→事实核查→校对），支持取消和分步回退
- `services/secureStorage.ts` — API Key 按 LLM 配置 id 走 Android Keystore（react-native-keychain），`llm_config` 表只存 name、base_url、model_name、is_active 等非密钥字段

## Native 与构建

### 纯 Android
- 没有 iOS 工程，不要添加 iOS 相关代码或 CocoaPods
- Android 配置：minSdk 24，compileSdk/targetSdk 36，Kotlin 2.1.20
- Node >= 22.11.0（`package.json` engines 要求）

### Gradle 与签名
- `android/build.gradle` 和 `settings.gradle` 使用阿里云 Maven 镜像，修改时不要删掉
- Release 签名 keystore 在 `android/keystores/tavo-mini-release.keystore`，密码可通过 `TAVO_MINI_RELEASE_STORE_PASSWORD` / `TAVO_MINI_RELEASE_KEY_ALIAS` / `TAVO_MINI_RELEASE_KEY_PASSWORD` 环境变量覆盖

### SQLite Patch
- `scripts/patch-sqlite-storage-gradle.js` 在 `npm install` 后自动执行：将 `react-native-sqlite-storage` 的 Android `build.gradle` 中的 `jcenter()` 替换为 `mavenCentral()`
- 如果该依赖升级后 patch 失效，手动检查并修复

### PNG 元数据原生模块
- `src/native/PngMetadataModule.ts` 桥接 Android 原生模块解析 PNG tEXt 块（角色卡导入）
- 相关 Kotlin 代码在 `android/app/src/main/java/com/tavomini/`

## 测试

- Jest + `@testing-library/react-native`，配置见 `jest.config.js`
- `jest.setup.js` 已 mock 所有原生模块：sqlite-storage、fs、document picker、keychain、toast、safe-area-context、lucide-react-native
- **添加新的原生依赖时，若测试报错缺少 mock，优先在 `jest.setup.js` 中补充 mock**
- **`transformIgnorePatterns` 陷阱**：新增 RN 原生模块依赖时，还需在 `jest.config.js` 的 `transformIgnorePatterns` 正则白名单中加入包名，否则 ESM 转换失败

## 代码风格

- Prettier：`arrowParens: 'avoid'`、`singleQuote: true`、`trailingComma: 'all'`
- 所有数据操作通过 `services/database.ts`，不在页面中直接写 SQL
- 自动保存：章节编辑 2 秒防抖（`utils/debounce.ts`）
- 错误信息用中文，通过 Toast 通知
- 导出格式：Markdown、纯文本（UTF-8 BOM）、`.tavo-novel.json`（兼容 tavo-maker）
- 导入格式：JSON 角色卡（CCv1/v2/v3）、世界书（lorebook_v3）、PNG 角色卡
