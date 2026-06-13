# Tavo Mini

A personal novel writing workbench for Android, built with React Native. Designed for long-form fiction authors who need data safety, AI controllability, and efficient writing workflows — all offline, all local.

## Features

### Writing & Editing
- Multi-project management with chapter-based and freeform document editing
- Auto-save with flushable async debounce — your last keystroke is never lost
- Content revision history with one-click restore and reversible snapshot chains
- Focus mode for distraction-free writing
- Chapter reordering with up/down controls

### AI-Powered Generation
- Multi-stage AI pipeline: Draft → Review → Fact-Check → Proofread
- Context preview before generation — see exactly what sources the AI uses
- Generation drafts — AI output goes to preview first, never overwrites directly
- Pipeline checkpoint resume — interrupted tasks continue from the last successful stage
- OpenAI-compatible API with streaming support and automatic fallback

### Data Safety
- Backup center with format v2 validation, checksums, and transactional restore
- Category-based retention: 3 automatic / 10 manual / 3 pre-restore backups
- Project package import/export (v2 format with v1 backward compatibility)
- All high-risk operations (clear, AI replace, restore) create recoverable snapshots

### Research & Organization
- Character cards (CCv1/v2/v3), world books (lorebook_v3), and PNG character import
- Story overview with chapter count, word count, and per-chapter statistics
- Project search across chapters, notes, world books, and characters
- LLM usage analytics by time range, model, and scenario

### Security
- API keys stored in Android Keystore via react-native-keychain
- Database never stores credentials in plaintext

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React Native 0.85 (Android-only) |
| Language | TypeScript 5.8 |
| State | Zustand 5 (4 stores) |
| Database | SQLite (react-native-sqlite-storage), 16 tables, schema v8 |
| Navigation | React Navigation 7 (Bottom Tabs + Native Stack) |
| AI | OpenAI-compatible API (streaming + non-streaming) |
| Security | Android Keystore (react-native-keychain) |
| Testing | Jest + React Native Testing Library |

## Requirements

- **Node.js** >= 22.11.0
- **Android SDK**: minSdk 24, compileSdk/targetSdk 36
- **Kotlin** 2.1.20
- **Java** 17+

## Getting Started

### Install Dependencies

```sh
npm install
```

The postinstall script automatically patches `react-native-sqlite-storage` Gradle config (replaces `jcenter()` with `mavenCentral()`).

### Start Metro

```sh
npm start
```

### Run on Android

```sh
npm run android
```

### Build APK

```sh
# Debug APK
npm run apk:debug

# Release APK
npm run apk:release
```

APK output path: `dist/apk/{debug|release}/TavoMini-V<version>-{debug|release}.apk`

> The Gradle output at `android/app/build/outputs/apk/` is an intermediate artifact. Only use APKs from `dist/apk/`.

### Release Signing

The release keystore is at `android/keystores/tavo-mini-release.keystore`. Override credentials via environment variables:

```
TAVO_MINI_RELEASE_STORE_PASSWORD
TAVO_MINI_RELEASE_KEY_ALIAS
TAVO_MINI_RELEASE_KEY_PASSWORD
```

## Testing & Linting

```sh
# Run all tests
npm test

# Run a single test file
npx jest __tests__/llm.test.ts

# ESLint
npm run lint
```

## Project Structure

```
tavo-mini/
  android/                           # Android native project
  scripts/                           # Build scripts (build-apk, generate-version-json, patch-sqlite)
  src/
    main/index.tsx                    # App entry (splash → upgrade detection → ThemeProvider + Navigation)
    navigation/TabNavigator.tsx       # Bottom tabs + Stack navigation
    screens/                          # 24 screen components
    components/                       # ChapterCard, AIStreamText, ThemeProvider, ui
    services/                         # database, llm, contextBuilder, macroReplace,
                                       summaryGenerator, chapterGeneration,
                                       batchChapterPipeline, fileImport,
                                       exportService, secureStorage,
                                       pipelineMessages, pipelineRunner,
                                       backupService, revisionService,
                                       draftService, projectImport,
                                       migrations/
    services/migrations/              # Incremental migration engine (v3→v4→v5→v6→v7→v8)
    store/                            # projectStore, settingsStore, themeStore,
                                       pipelineTaskStore
    constants/                        # defaults.ts, version.json (auto-generated)
    native/PngMetadataModule.ts       # PNG tEXt chunk parsing bridge
    types/                            # novel, character, worldbook, theme, pipeline,
                                       revision, draft, contextTrace
    utils/                            # debounce, jsonExtractor, tokenEstimator
  index.js                            # RN entry
```

## Database Schema

SQLite database `tavo_mini.db`, 16 tables at schema version 8:

| Table | Purpose |
|---|---|
| `projects` | Novel projects |
| `chapters` | Chapter content and metadata |
| `fragments` | Chapter text fragments |
| `plotlines` | Plot line definitions |
| `project_plotlines` | Plot line ↔ project associations |
| `characters` | Character cards |
| `worldbook_collections` | World book groups |
| `worldbook_entries` | World book entries |
| `notes` | Project notes |
| `presets` | AI presets |
| `llm_config` | LLM provider configurations (no API keys) |
| `settings` | App settings |
| `project_resources` | Project resource links |
| `llm_usage_logs` | LLM call logs with model and duration |
| `freeform_documents` | Freeform writing documents |
| `pipeline_tasks` | Multi-stage AI pipeline tasks |
| `content_revisions` | Content version history (v6+) |
| `generation_drafts` | AI generation drafts (v7+) |

## Theme

Base tri-color palette: `#439EA6` (primary) / `#B0E0E3` (secondary) / `#D7F1F4` (background)

Three themes via `useThemeStore`: Light / Dark / Eye-care. No hardcoded colors.

## Import & Export

| Direction | Format |
|---|---|
| Import | JSON character cards (CCv1/v2/v3), world books (lorebook_v3), PNG character cards |
| Export | Markdown, Plain text (UTF-8 BOM), `.tavo-novel.json` (tavo-maker compatible) |

## Data Safety Notes

- Editor auto-save uses flushable debounce with AppState monitoring — content is saved before backgrounding or navigation
- All destructive operations (clear, AI replace, restore) create revision snapshots
- Backups use format v2 with validation and checksums; restore is transactional
- Database migrations are non-breaking and incremental
- Pre-restore backups are created automatically before any restore operation

## License

Private project. All rights reserved.
