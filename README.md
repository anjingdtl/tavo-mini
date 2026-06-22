# ShineWriter

> **Current version: V1.6.3** (versionCode 52) · Last updated 2026-06-14

A personal novel writing workbench for Android, built with React Native. Designed for long-form fiction authors who need data safety, AI controllability, and efficient writing workflows — all offline, all local.

## Latest Updates (V1.6.3)

- **Dismissible pipeline-result prompt.** The "流水线已完成 / 流水线失败" prompt that surfaces a finished AI task is now a controlled React Modal (`src/components/PipelineResultPrompt.tsx`) instead of a native `Alert.alert`. Tapping "查看结果" dismisses the modal *in lockstep* with the navigation, so it no longer lingers on top of the result page or feels like it is being re-fired on every screen change.
- **Strict once-per-task prompting.** The root subscription in `src/main/index.tsx` now ignores tasks whose `resolvedAt` is non-null, which is the critical guard for batch runs (`batchChapterPipeline` resolves every sub-task right after `completeTask`). A batch generation no longer pops one global prompt per chapter — the per-chapter summary in `OutlineEditor` remains the canonical feedback.
- **110/110 tests passing** across 25 suites (`npm test`); `npm run lint` clean.

## Features

### Writing & Editing
- Multi-project management with chapter-based and freeform document editing
- Auto-save with flushable async debounce — your last keystroke is never lost
- Content revision history with one-click restore and reversible snapshot chains
- Focus mode for distraction-free writing
- Chapter reordering with up/down controls

### AI-Powered Generation
- Multi-stage AI pipeline: Draft → Review → Fact-Check → Proofread
- Live progress UI (`PipelineProgress`) that surfaces the current stage, label, and elapsed time
- Generation drafts — AI output goes to preview first, never overwrites directly
- Pipeline checkpoint resume — interrupted tasks continue from the last successful stage
- Global completion prompt that fires no matter which screen the user is on when a pipeline finishes; double-dismissal and batch-replay are explicitly prevented
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
| Testing | Jest + React Native Testing Library (110 tests, 25 suites) |

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

APK output path: `dist/apk/{debug|release}/ShineWriter-V<version>-{debug|release}.apk`

> The Gradle output at `android/app/build/outputs/apk/` is an intermediate artifact. Only use APKs from `dist/apk/`.

The `prebuild` step also auto-generates `src/constants/version.json` from `package.json` and the current `git rev-list --count HEAD` (used as `versionCode`).

### Release Signing

The release keystore is at `android/keystores/shine-writer-release.keystore`. Override credentials via environment variables:

```
SHINE_WRITER_RELEASE_STORE_PASSWORD
SHINE_WRITER_RELEASE_KEY_ALIAS
SHINE_WRITER_RELEASE_KEY_PASSWORD
```

## Testing & Linting

```sh
# Run all tests (110 tests / 25 suites)
npm test

# Run a single test file
npx jest __tests__/llm.test.ts

# ESLint
npm run lint
```

## Project Structure

```
shinewriter/
  android/                           # Android native project
  scripts/                           # Build scripts (build-apk, generate-version-json, patch-sqlite)
  src/
    main/index.tsx                    # App entry (splash → upgrade detection → ThemeProvider + Navigation,
                                      #   root pipeline-task subscription, dismissible result prompt)
    navigation/
      TabNavigator.tsx                # Bottom tabs + Stack navigation
      navigationRef.ts                # Root navigation ref + helpers used by the
                                      #   global pipeline prompt (navigateToPipelineResult etc.)
    screens/                          # 24 screen components
    components/                       # ChapterCard, AIStreamText, ThemeProvider, ui,
                                      #   PipelineProgress, GenerationResultModal,
                                      #   PipelineResultPrompt
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

SQLite database `shine_writer.db`, 16 tables at schema version 8:

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
- AI generation never overwrites the chapter body in place: results land in `generation_drafts` and require an explicit adopt

## Changelog

### V1.6.3 — 2026-06-14
- Dismissible pipeline-result prompt (controlled React Modal) replacing native `Alert.alert`, so the prompt no longer lingers on top of the result screen after navigation
- Root subscription guards `resolvedAt === null` to ensure each task is prompted at most once and that batch sub-tasks do not trigger the global prompt
- Test coverage: `__tests__/pipelineResultPrompt.test.tsx`, additional case in `__tests__/pipelineAutoPrompt.test.tsx` (auto-resolved batch tasks stay silent)
- 110/110 tests passing, ESLint clean

### V1.6.2 — 2026-06-14
- `PipelineProgress` component surfacing the current stage, label, and elapsed time
- `GenerationResultModal` so the user can preview pipeline output without leaving the editor
- `BackupCenterScreen` create-row layout fix (z-order + elevation against the FlatList)

### V1.6.1 — 2026-06-14
- Stability fix for `DraftPreviewScreen` adopt / delete / clear crash caused by nested Alert + setState on unmounted component
- Chapter editor toolbar reflowed from a single wide row to a 4×4 grid with shorter labels
- 11 new tests, 93/93 passing

## License

Private project. All rights reserved.
