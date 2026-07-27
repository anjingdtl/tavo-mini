# 原著续写 Phase 1 施工报告

> 分支：`feat/continuation-phase-1`（从 `main` @ 91eec42 切出）
> 版本：V2.6.6 → **V2.7.0**；Schema：18 → **19**
> 施工日期：2026-07-27
> 对应 Spec：`docs/superpowers/specs/next/continuation-phase-1-project-foundation.spec.md`

## 1. 基线审计结论（Spec §7）

施工前已核验 Spec §7 列出的全部「已核验基线」在 `main` 分支仍成立（详见审计记录）。关键事实：

- `ProjectMode = 'outline' | 'freeform'`，`projects.mode` 默认 `'outline'`，无需新增列。
- 写作路由仅 `TabNavigator.tsx:75` 单点 dispatch；底部 5 Tab；`ResourceLibrary` 单屏 SegmentedControl。
- 构建模块 TXT 解析走整文件 base64（`RNFS.readFile(path,'base64')`），不复用。
- 备份 format v3，`SCHEMA_MANIFEST` 驱动；项目包 `shinewriter-project-v2`，导入接受 `1|2`。
- Schema 18，最低兼容 3，15 个迁移文件齐全；项目删除靠 `ON DELETE CASCADE` + `PRAGMA foreign_keys=ON`。
- 基线测试：145/146 套件通过、1107 测试通过、typecheck clean。

## 2. 改动文件清单

### 新增源码（25 个）

**类型与兼容层**
- `src/types/novel.ts`（修改）— `ProjectMode` 扩为 `'outline'|'continuation'|'freeform'`；新增 branded `SourceChapterPosition`/`ContinuationChapterPosition`/`Utf16Offset`。
- `src/services/continuation/projectMode.ts` — `normalizeProjectMode` / `isValidProjectMode` / `PROJECT_MODE_LABELS` / `NEW_PROJECT_MODE_OPTIONS`。
- `src/services/continuation/types.ts` — 跨阶段公共契约（snapshot / bounded chapter / reader interface / 错误类）。

**Schema 19 与数据层**
- `src/services/migrations/v18-to-v19.ts` — 5 张表 + 3 个 partial unique index + CHECK 约束。
- `src/services/migrations/index.ts`（修改）— 注册 v18→v19，`SCHEMA_VERSION=19`。
- `src/data/schema/createCurrentSchema.ts`（修改）— fresh schema 镜像同款 CREATE TABLE。
- `src/services/database/schemaManifest.ts`（修改）— 5 张表入 manifest，import_jobs `backup:false`。
- `src/services/database/schemaValidator.ts`（修改）— 跳过 `backup:false` 表的 MISSING_TABLE 检查。
- `src/services/continuation/continuationSourceRepository.ts` — sources/chunks/chapters/settings CRUD + branded 边界转换 + 原子激活 + chunk 连续性校验。
- `src/services/continuation/hashUtils.ts` — 同步 SHA-256 + UTF-8 字节计数（surrogate-aware）。

**原生与解析**
- `android/app/src/main/java/com/shinewriter/ContinuationTextImportModule.kt` — 分块解码（UTF-8/BOM/GBK/GB18030/UTF-16 LE/BE），多字节边界处理。
- `android/app/src/main/java/com/shinewriter/ContinuationTextImportPackage.kt` — ReactPackage。
- `android/app/src/main/java/com/shinewriter/MainApplication.kt`（修改）— 注册包。
- `src/native/ContinuationTextImportModule.ts` — TS 绑定 + `requireContinuationTextImport` 守卫。
- `src/services/continuation/continuationNormalizer.ts` — BOM/NUL/控制字符清理 + 换行统一（`NORMALIZATION_VERSION=v1`）。
- `src/services/continuation/continuationParser.ts` — 中英文章节/卷标题检测 + 无标题回退（`PARSER_VERSION=v1`）。
- `src/services/continuation/continuationEditLog.ts` — 预览编辑（rename/merge/split/exclude/reset）。

**服务与 Reader**
- `src/services/continuation/continuationProjectService.ts` — `createContinuationProject`。
- `src/services/continuation/continuationImportService.ts` — 导入编排 + interrupted 恢复 + 原子激活 + 错误分类。
- `src/services/continuation/continuationSettingsService.ts` — 边界解析 + §5.9 失效 hook。
- `src/services/continuation/continuationSourceReader.ts` — **bounded SourceReader**（Phase 2 唯一入口）。
- `src/services/continuation/continuationSourceBrowserService.ts` — UI-only 未来原文浏览（`purpose` 强制）。
- `src/services/uuidBridge.ts` — v4 风格 id 生成。

**UI**
- `src/screens/continuation/ResourceHomeScreen.tsx` — 资料 5 入口首页。
- `src/screens/continuation/ContinuationHomeScreen.tsx` — 未导入/已导入状态 + 模式门控。
- `src/screens/continuation/ContinuationSourceChaptersScreen.tsx` — 只读章节列表 + 导入入口。
- `src/screens/continuation/ContinuationBoundaryScreen.tsx` — 续写起点设置。
- `src/navigation/TabNavigator.tsx`（修改）— ResourceStack + 5 路由。
- `src/screens/ResourceLibrary.tsx`（修改）— 接受 `initialTab` route param。
- `src/screens/ProjectListScreen.tsx`（修改）— 新建选择器用 `NEW_PROJECT_MODE_OPTIONS`，标签用 `PROJECT_MODE_LABELS`。
- `src/data/repositories/projectRepository.ts`（修改）— `createProject` 经 `normalizeProjectMode` 规范化。

**备份与项目包**
- `src/services/exportService.ts`（修改）— continuation 项目导出 `shinewriter-project-v3`。
- `src/services/projectImport.ts`（修改）— 接受 v3 + `importContinuationPayload`（chunk 连续性/hash/外键校验 + ID 重映射）。

### 测试（11 新增 + 4 修改）
- `__tests__/continuationProjectMode.test.ts`（10）
- `__tests__/migrations-v18-v19.test.ts`（3）
- `__tests__/continuationSourceReader.test.ts`（9 — snapshot 过期/末章裁剪/未来原文排除/范围裁剪）
- `__tests__/continuationBrandedTypes.test.ts`（14 — brand 校验 + UTF-16 surrogate/emoji + chunk 连续性）
- `__tests__/continuationTextImportNative.test.ts`（9 — 编码探测契约 + 多字节边界）
- `__tests__/continuationNormalizer.test.ts`（9）
- `__tests__/continuationParser.test.ts`（11 — 含 30 章夹具 + 正文 prefix + 误识别防护）
- `__tests__/continuationEditLog.test.ts`（8）
- `__tests__/continuationImportService.test.ts`（13 — 错误分类 + 脱敏 + 文件名）
- `__tests__/continuationSettingsService.test.ts`（9 — 三种边界模式 + 排除章节 + §5.9 失效）
- `__tests__/continuationProjectPackageV3.test.ts`（9 — v3 解析 + v1/v2 兼容 + v4 拒绝）
- `__tests__/continuationResourceHome.test.tsx`（7 — 5 入口渲染 + 导航 + 模式门控）
- `__tests__/migrationMatrix.test.ts`（修改 — 覆盖 3..18→19 + v19 表/索引断言）
- `__tests__/migrationTestUtils.ts`（修改 — 支持 `CREATE UNIQUE INDEX`）
- `__tests__/migrations-v16-v17.test.ts` / `migrations-v17-v18.test.ts`（修改 — `SCHEMA_VERSION` 断言改为 `>=`）

### E2E
- `e2e/maestro/07-continuation-import.yaml`（新增）
- `e2e/maestro/03-resource-library.yaml`（修改 — 资料→角色 路径适配 ResourceStack）

### 文档与版本
- `README.md` / `CHANGELOG.md` / `AGENTS.md` / `package.json` / `package-lock.json` / `src/constants/version.json`

## 3. 迁移版本

| 项 | 施工前 | 施工后 |
| --- | --- | --- |
| `SCHEMA_VERSION` | 18 | **19** |
| `MIN_COMPATIBLE_SCHEMA_VERSION` | 3 | 3（不变） |
| 迁移文件 | v3→...→v17→v18 | + `v18-to-v19.ts` |
| 迁移矩阵测试覆盖 | 3..14 | **3..18 → 19** |
| 备份 format_version | 3 | 3（不变，仅扩 manifest） |
| 项目包 spec | v1/v2 | **v1/v2/v3** |

新增表（5 张，全部 `ON DELETE CASCADE` 到 projects）：
- `continuation_sources`（含 `idx_continuation_sources_one_ready` partial unique index）
- `continuation_source_text_chunks`（含 `idx_continuation_text_chunks_range`）
- `continuation_source_chapters`
- `continuation_settings`（含 7 条 CHECK + 2 个 composite FK）
- `continuation_import_jobs`（含 `idx_continuation_import_one_active` partial unique index，`backup:false`）

## 4. 测试结果

全部门禁（Spec §21 质量验收）：

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| lint | `npm run lint` | ✅ 0 error（14 warning 均为预存 `no-bitwise`/`no-void`，非本次引入） |
| typecheck | `npm run typecheck` | ✅ clean |
| version | `npm run verify:version` | ✅ ok V2.7.0 versionCode=2070000 |
| Jest 全量 | `npm run test:ci` | ✅ **1222 passed**（基线 1107，新增 115；1 套件预存 skip） |
| coverage | `npm run test:coverage` | ✅ Statements 76.06% / Branches 61.9% / Functions 81% / Lines 77.86%（均高于基线） |
| 迁移矩阵 | `migrationMatrix.test.ts` | ✅ Schema 3..18 全部 → 19 |
| Android Debug | `npm run apk:debug` | ✅ BUILD SUCCESSFUL |

新增测试套件 11 个、用例 **+115**，无回归。

## 5. APK 路径

```
dist/apk/debug/ShineWriter-V2.7.0-debug.apk   (53.93 MB)
```

设备验证（`emulator-5556`，fresh install）：
- Schema 19 迁移在全新数据库上顺利执行，无崩溃。
- 原生 `ContinuationTextImportModule` 注册成功。
- 5 底部 Tab（项目/写作/构建/资料/设置）完整渲染。
- 新建「原著续写」项目成功，卡片显示「原著续写」标签（`PROJECT_MODE_LABELS`）。
- 资料 > 续写 显示「导入 TXT 原著」未导入卡片 + 隐私提示。

## 6. Phase 2 交接契约验证（Spec §23）

Phase 1 向 Phase 2 公开的契约在 `src/services/continuation/types.ts` 与 `continuationSourceReader.ts` 中固定：

```ts
interface ContinuationSourceSnapshot {
  projectId: number;
  sourceId: number;
  sourceVersion: number;
  normalizedSha256: string;
  parserVersion: string;
  normalizationVersion: string;
  boundary: { chapterId; chapterPosition: SourceChapterPosition; charOffsetExclusive: Utf16Offset };
}
interface ContinuationSourceReader {
  getSnapshot(projectId): Promise<ContinuationSourceSnapshot>;
  listBoundedSourceChapters(snapshot): Promise<BoundedSourceChapter[]>;
  readBoundedEvidenceRange({ snapshot, start, end }): Promise<string>;
}
```

**验证结果（`continuationSourceReader.test.ts` 9/9 通过）：**

| 契约要求 | 测试用例 | 状态 |
| --- | --- | --- |
| snapshot sourceId/version/hash/parser/normalizer 任一漂移即抛 `continuation_source_snapshot_outdated` | `throws snapshot-outdated when the live source hash changed` / `... boundary moved` / `... source was superseded` | ✅ |
| 结果始终按 `boundary.charOffsetExclusive` 裁剪 | `clips readBoundedEvidenceRange to the boundary` / `returns empty when ... entirely past the boundary` | ✅ |
| 自定义边界位于章节中间时末章 `content` 被物理截断 | `truncates the boundary chapter when the boundary falls mid-chapter` | ✅ |
| future source（边界后）默认不可被领域查询返回 | `never returns future source past the boundary chapter` | ✅ |
| Phase 2 不得导入 `ContinuationSourceBrowserService` | 文件级文档 + `purpose` 强制参数（运行时校验） | ✅（约定 + 运行时断言） |

**Phase 2 只能通过 `continuationSourceReader` 获取 boundary 内原著章节；无业务代码直接跨层读取 future source。**

## 7. 已知风险与限制

1. **导入 UI 已收尾**：V2.9.1 已实测 Android 文件选择 → 本地复制 → 解析预览 → 确认激活 → 只读章节列表，且返回首页即时刷新。文本编码确认、章节编辑（合并/拆分/排除）仍可作为后续体验增强。
2. **`custom_offset` UI**：服务层完整支持章节内偏移续写点（`continuationSettingsService` 测试覆盖），但 `ContinuationBoundaryScreen` 当前只暴露 `end_of_source` / `end_of_chapter`；章节内滑块 UI 为后续 polish。
3. **原生解码器实机性能**：本次使用小型 TXT 完成真实导入；5 MB TXT 的耗时、内存与 chunk 大小调优仍需专项压测——`chunk target` 当前为 192 KiB UTF-8 band 的启发值。
4. **v3 项目包导入的端到端实机验证**：parser + 校验 + ID 重映射有单元测试覆盖，但 export→import 的真实 round-trip（含大块文本）建议在真机备份恢复流程中再压测一次。

## 8. Definition of Done 自检（Spec §22）

| 条目 | 状态 |
| --- | --- |
| 1. Phase 1 功能验收全部通过 | ✅ 导入、原子激活、只读浏览、边界设置与 AI 配置门控均已接入并实测 |
| 2. 新增数据契约已写入项目文档 | ✅ CHANGELOG / README / AGENTS.md |
| 3. Phase 2 可只通过公开 service 获取 boundary 内原著章节 | ✅ `continuationSourceReader` + 9 测试 |
| 4. 无业务代码直接跨层读取 future source | ✅（browser service 仅 UI，`purpose` 强制） |
| 5. 新增表纳入 manifest 与项目删除；业务表进备份，import job `backup:false` | ✅ |
| 6. 至少一份中文测试原著完成端到端导入 | ✅ 模拟器已完成真实 TXT 文件选择、解析、确认和持久化；30 章夹具解析测试继续覆盖 |
| 7. 导入任务失败、取消、App 重启均有可验证结果 | ✅ `recoverInterruptedJobs` + cancel/resume 服务层测试 |
| 8. 施工报告列出实际文件、迁移版本、测试命令、APK、剩余风险 | ✅ 本报告 |

**结论（V2.9.1 更新）**：Phase 1 的数据底座、领域服务、bounded 契约、Schema 19、备份/项目包 v3、真实导入 UI 与测试矩阵均已完成；遗留项仅为大文件性能和章节内偏移等体验增强。
