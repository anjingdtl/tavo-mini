# tavo-mini

基于 tavo-maker 小说家工作台的安卓手机应用。React Native 纯安卓实现。

## 常用命令

- `npm install` — 安装依赖
- `npx react-native run-android` — 运行 Android 开发版
- `cd android && ./gradlew assembleDebug` — 构建 debug APK
- `cd android && ./gradlew assembleRelease` — 构建 release APK

无自动化测试框架，手动测试验证。

## 架构

React Native CLI + TypeScript。Zustand 状态管理，SQLite 本地持久化。底部 4 Tab 导航（项目/编辑/资料/设置），三色主题系统。

### 文件结构

```
tavo-mini/
  android/                           -- Android 原生工程
  src/
    main/index.tsx                    -- App 入口（ThemeProvider + NavigationContainer）
    navigation/TabNavigator.tsx       -- 底部 Tab + Stack 导航
    screens/                          -- 16 个页面组件
    components/                       -- ChapterCard, AIStreamText, ThemeProvider
    services/                         -- database, llm, contextBuilder, macroReplace,
                                        summaryGenerator, fileImport, exportService
    store/                            -- projectStore, settingsStore, themeStore
    native/PngMetadataModule.ts       -- PNG tEXt 块解析桥接
    types/                            -- novel, character, worldbook, theme
    utils/                            -- debounce, jsonExtractor
  index.js                            -- RN 入口
```

### 数据层

SQLite 数据库 `tavo_mini.db`，11 张表：projects、chapters、fragments、plotlines、project_plotlines、characters、worldbook_entries、notes、presets、llm_config、settings。

服务层 `src/services/database.ts` 提供全部 CRUD 操作。

### 状态管理

三个 Zustand store：
- `projectStore` — 项目列表、当前项目、CRUD
- `settingsStore` — LLM 配置
- `themeStore` — 主题模式（亮色/暗色/护眼）

### 主题配色

基准三色：`#439EA6`（主色）/ `#B0E0E3`（辅助）/ `#D7F1F4`（底色）

三个主题通过 `ThemeProvider` 全局注入，所有屏幕通过 `useThemeStore` 读取颜色。

### AI 集成

- `services/llm.ts` — OpenAI 兼容 API，流式 + 非流式调用，流式中断回退非流式
- `services/contextBuilder.ts` — 三种上下文策略（滑动窗口/完整/自定义），角色+世界书注入
- `services/macroReplace.ts` — `{{char}}`/`{{user}}`/`{{chapter}}`/`{{synopsis}}` 宏替换
- `services/summaryGenerator.ts` — LLM 生成结构化章节摘要

### 文件导入导出

- 导入：JSON 角色卡（CCv1/v2/v3） + 世界书（lorebook_v3）；PNG 角色卡通过原生模块解析 tEXt 块
- 导出：Markdown、纯文本（UTF-8 BOM）、`.tavo-novel.json`（兼容 tavo-maker）

### 关键模式

- 所有数据操作通过 `services/database.ts` 的导出函数，不在页面中直接操作 SQL
- 自动保存：章节编辑 2 秒防抖（`utils/debounce.ts`）
- 主题颜色统一从 `useThemeStore` 获取，不硬编码颜色值
- 错误信息中文显示，使用 Toast 通知

## 安全

- API Key 以明文存储在 SQLite 数据库 `llm_config` 表中（Android 私有目录，其他应用不可访问）
- 无 WebView、无远程代码执行
