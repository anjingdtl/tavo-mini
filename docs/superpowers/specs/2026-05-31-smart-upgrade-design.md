# 智能升级安装系统设计

> 日期: 2026-05-31
> 状态: 待实施

## 背景

当前项目每次构建 APK 时 `versionCode` 固定不变（始终为 15），数据库迁移采用"全量重跑"策略，App 无法区分首次安装与升级安装。导致覆盖安装时用户体验不可靠，存在数据丢失风险。

## 目标

1. **首次安装**：完整初始化，无需迁移
2. **升级安装**：增量迁移数据库，保留用户全部设定和内容
3. **不兼容升级**：仅在数据结构有重大破坏性变更时，先备份后重建
4. **版本管理自动化**：`versionCode` 和 `versionName` 无需手动维护

## 设计

### 一、构建时版本自动管理

#### Gradle 侧 (`android/app/build.gradle`)

```groovy
// versionCode = git commit 总数（自动递增）
def gitCommitCount = {
    try {
        return Integer.parseInt("git rev-list --count HEAD".execute().text.trim())
    } catch (Exception e) {
        // 回退：从 package.json 版本计算
        def pkg = new groovy.json.JsonSlurper().parse(file("../../package.json"))
        def parts = pkg.version.split("\\.")
        return Integer.parseInt(parts[0]) * 10000 + Integer.parseInt(parts[1]) * 100 + Integer.parseInt(parts[2])
    }
}()

// versionName 从 package.json 读取
def pkgVersion = new groovy.json.JsonSlurper().parse(file("../../package.json")).version

defaultConfig {
    versionCode gitCommitCount
    versionName "V${pkgVersion}"
}
```

#### JS 侧

Gradle 构建时生成 `src/constants/version.json`：

```json
{
  "versionName": "V1.3.2",
  "versionCode": 42,
  "buildTime": "2026-05-31T10:00:00Z"
}
```

JS 代码直接 `import` 此文件获取版本信息，无需 Native Module。

Gradle task 在 `preBuild` 阶段自动执行生成脚本。

---

### 二、安装类型检测

#### settings 表新增键

| key | 说明 | 示例值 |
|-----|------|--------|
| `app_version` | 当前运行的 App 版本 | `"1.3.2"` |
| `app_version_code` | 当前 versionCode | `"42"` |
| `previous_version` | 升级前的旧版本（仅升级时有值） | `"1.2.0"` |
| `first_install_version` | 首次安装时的版本 | `"1.0.0"` |
| `install_type` | 本次启动类型 | `fresh` / `upgrade` / `same` |

#### 检测逻辑

在 `openDatabase()` 的 `migrate()` 阶段执行：

```
读取 settings.app_version
├── 为空 → 首次安装 (fresh)
│   ├── 写入 app_version = 当前版本
│   ├── 写入 first_install_version = 当前版本
│   ├── 写入 install_type = 'fresh'
│   └── 跳过数据迁移
│
├── < 当前版本 → 升级安装 (upgrade)
│   ├── 写入 previous_version = 旧版本
│   ├── 写入 app_version = 当前版本
│   ├── 写入 install_type = 'upgrade'
│   └── 执行增量迁移（见第三部分）
│
└── = 当前版本 → 同版本启动 (same)
    ├── 写入 install_type = 'same'
    └── 不执行任何迁移
```

---

### 三、增量数据库迁移

#### 目录结构

```
src/services/migrations/
  index.ts          ← 迁移注册表 + 执行引擎
  v1-to-v2.ts       ← 每个迁移步骤一个文件
  v2-to-v3.ts
  v3-to-v4.ts
  v4-to-v5.ts
```

#### 迁移注册表

```ts
interface Migration {
  from: number;
  to: number;
  breaking: boolean;
  migrate: (db: SQLite.SQLiteDatabase) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  { from: 1, to: 2, breaking: false, migrate: migrateV1toV2 },
  { from: 2, to: 3, breaking: false, migrate: migrateV2toV3 },
  { from: 3, to: 4, breaking: true,  migrate: migrateV3toV4 },
  { from: 4, to: 5, breaking: false, migrate: migrateV4toV5 },
];
```

#### 执行引擎

```ts
async function runMigrations(db, fromVersion: number, toVersion: number) {
  const needed = MIGRATIONS.filter(m => m.from >= fromVersion && m.to <= toVersion);
  const hasBreaking = needed.some(m => m.breaking);

  if (hasBreaking) {
    await createBackup(db);
  }

  for (const migration of needed) {
    await db.transaction(async (tx) => {
      await migration.migrate(tx);
      await tx.executeSql(
        'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        ['schema_version', String(migration.to)]
      );
    });
  }
}
```

#### 常量

```ts
const SCHEMA_VERSION = '5';
const MIN_COMPATIBLE_SCHEMA_VERSION = '3';
```

- `MIN_COMPATIBLE_SCHEMA_VERSION`：如果用户的 schema_version 低于此值，视为不兼容，触发全量备份 + 重建流程

---

### 四、升级前自动备份

#### 触发条件

满足以下任一条件时触发：

1. 迁移路径中存在 `breaking: true` 的迁移
2. 用户 `schema_version < MIN_COMPATIBLE_SCHEMA_VERSION`

#### 备份存储

- 路径：使用 `react-native-fs` 的 `ExternalDirectoryPath`（即 `/sdcard/Android/data/com.tavomini/files/`），无需额外权限
- 子目录：`backups/`
- 文件名：`backup_v{旧版本}_{时间戳}.json`
- 保留策略：最多保留 3 个备份，自动清理最旧的
- 注意：此路径在 App 卸载时会被系统清理，但升级安装（同签名覆盖）不会清除。备份仅作为迁移失败的安全网，不是长期存储

#### 备份文件格式

```json
{
  "meta": {
    "app_version": "1.2.0",
    "schema_version": "3",
    "backup_date": "2026-05-31T10:00:00Z",
    "table_count": 16
  },
  "tables": {
    "projects": [{ "id": 1, "name": "...", ... }],
    "chapters": [...],
    "fragments": [...],
    "plotlines": [...],
    "project_plotlines": [...],
    "characters": [...],
    "worldbook_collections": [...],
    "worldbook_entries": [...],
    "notes": [...],
    "presets": [...],
    "llm_config": [...],
    "settings": [...],
    "project_resources": [...],
    "llm_usage_logs": [...],
    "pipeline_tasks": [...],
    "freeform_documents": [...]
  }
}
```

#### 恢复机制

- 迁移过程中每个步骤在事务中执行
- 如果某步迁移抛异常 → 事务回滚 → 从备份文件恢复全部数据
- 恢复失败 → Toast 提示用户备份文件路径，让用户知道数据还在

---

### 五、升级提示 UI

#### 首次安装

正常进入 App，无额外提示。

#### 普通升级（无 breaking 变更）

静默迁移，用户无感知。迁移完成后 Toast 提示"已升级到 V{x.x.x}"（1 秒消失）。

#### 不兼容升级（有 breaking 变更）

启动时弹出全屏对话框：

- **标题**："版本升级"
- **内容**："本次升级涉及数据结构重大变更，将自动迁移您的数据。迁移前已自动备份到 Documents/TavoMini/backups/ 目录。"
- **按钮**："开始升级"

迁移过程中显示进度指示器。

- 成功 → Toast "升级完成" → 进入 App
- 失败 → "升级遇到问题，正在恢复备份..." → 恢复成功/失败提示

#### 降级

不处理降级场景。

#### App 启动集成

`src/main/index.tsx` 的 App 组件启动流程改为：

```
SplashScreen (1200ms)
  → openDatabase()（含安装类型检测 + 迁移）
  → 读取 install_type
  → install_type === 'upgrade' 且有 breaking 变更？
    ├── 是 → 渲染 UpgradeScreen（全屏对话框 + 进度）
    │       → 升级完成 → 切换到 TabNavigator
    └── 否 → 直接渲染 TabNavigator
              → Toast "已升级到 V{x.x.x}"（仅 upgrade 时）
```

---

### 六、现有迁移拆分说明

当前 `database.ts` 中的 `migrate()` 包含两个数据迁移函数，需拆分到对应的版本迁移文件中：

| 迁移文件 | 内容 | 来源 |
|----------|------|------|
| `v1-to-v2.ts` | 早期 schema 变更（列添加等，已由 `ensureSchemaCompatibility` 覆盖，此处为空操作） | 推断 |
| `v2-to-v3.ts` | 同上 | 推断 |
| `v3-to-v4.ts` | `migrateLegacyProjectResources()` — 从 characters/worldbook/notes/presets 填充 project_resources 关联表 | `database.ts:428-445` |
| `v4-to-v5.ts` | `migrateLegacyWorldbookCollections()` — 为孤立 worldbook_entries 创建默认 collection | `database.ts:447-459` |

`ensureSchemaCompatibility()` 保持不变，作为列级别的兜底检查，在 `createTables()` 之后、迁移之前执行。

---

## 涉及文件变更

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `android/app/build.gradle` | 修改 | versionCode/versionName 自动化 |
| `scripts/generate-version-json.gradle` | 新增 | Gradle task 生成 version.json |
| `src/constants/version.json` | 新增（构建生成） | 版本信息常量 |
| `src/services/database.ts` | 修改 | 重构 migrate()，集成安装类型检测 |
| `src/services/migrations/index.ts` | 新增 | 迁移注册表 + 执行引擎 |
| `src/services/migrations/v1-to-v2.ts` | 新增 | 迁移步骤 |
| `src/services/migrations/v2-to-v3.ts` | 新增 | 迁移步骤 |
| `src/services/migrations/v3-to-v4.ts` | 新增 | 迁移步骤 |
| `src/services/migrations/v4-to-v5.ts` | 新增 | 迁移步骤 |
| `src/services/backupService.ts` | 新增 | 备份/恢复服务 |
| `src/screens/UpgradeScreen.tsx` | 新增 | 升级提示 UI |
| `src/main/index.tsx` | 修改 | 启动时检测安装类型，必要时显示升级界面 |

## 不包含

- 降级处理
- 设置页面手动恢复备份入口
- 应用商店发布相关配置
- iOS 支持
