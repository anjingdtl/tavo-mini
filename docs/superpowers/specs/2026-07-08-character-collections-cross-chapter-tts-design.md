# Character Collections and Cross-Chapter TTS Design

## Goal

Add two production features to ShineWriter:

1. Let users start voice reading from the chapter editor with a range choice: current chapter, current chapter through the final chapter, or the whole book.
2. Give character cards a collection workflow similar to worldbook collections, including folder-style batch import, grouping existing cards, and one-tap enable or disable for all cards in a collection.

## Current Context

The app is Android-only React Native with SQLite storage. Chapter reading currently happens in `src/screens/ChapterEditor.tsx` by calling `useVoiceStore().playChapter(chapter.content)`. The voice store already supports system TTS, cloud TTS, stop behavior, session events, progress, and cloud text-length limiting.

Worldbook collections already provide the closest local pattern:

- `worldbook_collections` stores collection metadata.
- `worldbook_entries.collection_id` links entries to a collection.
- `ResourceLibrary` first shows collection cards, then shows entries after opening one collection.
- `setWorldbookCollectionEnabledForProject()` updates collection state and project resource usage.

Character cards currently live as standalone rows in `characters`. Project enablement is tracked through `project_resources` with resource type `character`.

## Feature 1: Cross-Chapter Voice Reading

### User Experience

The chapter editor keeps a compact toolbar. Pressing the voice button opens a native alert with these actions:

- `本章`: read only the current chapter body.
- `从本章到结尾`: read the current chapter and every later chapter in the same project.
- `全书`: read every chapter in the project.
- `取消`: dismiss the range picker.

When playback is already synthesizing or playing, pressing the same toolbar control stops playback immediately, matching the current behavior.

### Reading Text Assembly

The app will build a single reading text before calling `playChapter()`:

- Current chapter: current `chapter.content`.
- Current-to-end: chapters with the same `project_id` and `position >= current.position`, ordered by `position ASC, id ASC`.
- Whole book: all chapters with the same `project_id`, ordered by `position ASC, id ASC`.

Each included chapter contributes:

```text
第 N 章 标题

正文
```

Empty chapter bodies are skipped. If the final assembled text is empty, show `没有可朗读的正文内容`.

### TTS Behavior

No native TTS API change is required. The assembled text is passed to `voiceStore.playChapter(text)`:

- System TTS keeps using native text chunking and session events.
- Cloud TTS keeps the existing 10000-character warning and truncation behavior.
- Built-in TTS keeps the existing placeholder message.

This avoids new playback queue complexity while still enabling real cross-chapter reading.

### Error Handling

Chapter range loading failures show a Toast with `朗读失败`. Stop failures continue to be swallowed or surfaced by existing store behavior.

## Feature 2: Character Card Collections

### Data Model

Add a new table:

```sql
CREATE TABLE IF NOT EXISTS character_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  max_tokens INTEGER NOT NULL DEFAULT 50000,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
)
```

Add a nullable-style integer column to `characters`:

```sql
collection_id INTEGER NOT NULL DEFAULT 0
```

Fresh installs create both structures directly. Existing installs migrate from schema version 10 to 11.

Collection token estimates are the sum of each member character's `estimated_tokens`. Character token budgets remain per card; collection `max_tokens` is used for display and future budget controls, not for filtering character context in this first release.

### Database API

Add database helpers that mirror worldbook patterns:

- `getCharacterCollections(projectId?: number)`
- `createCharacterCollection(projectId: number, name: string, extra?: Row)`
- `updateCharacterCollection(id: number, fields: Row)`
- `deleteCharacterCollection(id: number)`
- `updateCharacterCollectionTokenEstimate(id: number)`
- `getCharactersByCollection(collectionId: number, projectId?: number)`
- `setCharacterCollectionEnabledForProject(projectId: number, collectionId: number, enabled: boolean)`
- `setAllCharactersCollectionId(projectId: number, collectionId: number)`

Existing character helpers gain collection awareness:

- `getAllCharacters(projectId?)` returns `collection_id`, `collection_name`, `collection_enabled`, and `enabled_for_project`.
- `getCharactersByProject(projectId)` only returns characters enabled for the project and whose collection is enabled.
- `createCharacter()` accepts an optional `collectionId` and updates collection token estimates.
- `updateCharacter()`, `updateCharacterTokenBudget()`, and `deleteCharacter()` refresh affected collection token estimates.

### Resource Library UX

The `角色` tab switches to the same two-level pattern as `世界书`:

- Top level shows character collection cards.
- Opening a collection shows cards in that collection.
- A `返回合集` action returns to the collection list.

Top-level character actions:

- `导入角色卡`: single import. If no collection is selected, import into an `未分组角色` collection created on demand.
- `批量导入角色卡`: multi-select import into one new collection. Default collection name uses a stable label such as `批量角色卡 YYYY-MM-DD HH:mm`.
- `导入文件夹`: uses the available document picker directory API when practical on Android. The implementation should fall back to multi-select if direct recursive folder enumeration is not supported by the picker/native stack.
- `新建角色合集`: creates an empty collection.
- `整理已导入`: creates `全部人物卡` and moves all ungrouped character cards into it.

Inside a collection:

- `导入角色卡` and `批量导入角色卡` import into the selected collection.
- `新建角色卡` creates a card in the selected collection.
- `返回合集` goes back to the collection list.
- Each card keeps edit, export, delete, and current-project enable switches.

Collection card actions:

- `打开`
- `编辑`
- `删除`
- A `合集启用` switch

### Collection Enablement

Toggling `合集启用` updates:

1. `character_collections.enabled`
2. every card inside the collection in `project_resources` for the current project

When enabled, all member cards become enabled for the current project. When disabled, all member cards become disabled for the current project. Individual character switches remain available inside the collection after it is enabled.

### Import Behavior

Single and batch character imports reuse the existing JSON and PNG parsing:

- JSON SillyTavern character card support remains unchanged.
- PNG metadata import and image persistence remain unchanged.
- Batch results still report successes and failures.

New import helpers should accept an optional `collectionId`. Batch import into a new collection should clean up the collection if every file fails. If some files succeed, keep the collection and report partial failures.

Direct folder import is best-effort because Android Storage Access Framework directory enumeration may require extra native access beyond the current picker API. The first implementation should expose a user-facing folder import entry only if it can reliably enumerate supported files. Otherwise, the UI should use multi-select wording and avoid promising recursive folder traversal.

### Existing Data Migration

Migration to schema 11:

1. Create `character_collections`.
2. Add `characters.collection_id` if missing.
3. Create one default collection named `全部人物卡`.
4. Move existing characters with `collection_id = 0` into that collection.
5. Set the default collection token estimate from existing character estimates.

This keeps old data visible immediately after upgrade.

## Architecture

### Files To Modify

- `src/services/database.ts`: schema, character collection CRUD, character query joins, collection enablement.
- `src/services/migrations/index.ts`: schema version 11 registration.
- `src/services/migrations/v10-to-v11.ts`: migration for character collections.
- `src/services/fileImport.ts`: collection-aware character import helpers and optional folder import support.
- `src/screens/ChapterEditor.tsx`: TTS range picker and range text assembly call.
- `src/screens/ResourceLibrary.tsx`: character collection list, selected collection state, collection actions, and collection-aware imports.
- Tests under `__tests__/`: database migration, file import batch behavior, resource library UI, voice/chapter toolbar behavior.

### New Helper Boundaries

Keep cross-chapter text assembly in a small database-facing helper rather than embedding SQL and formatting deeply in the component. Keep character collection creation and token-estimate maintenance inside `database.ts` so UI and import services do not duplicate bookkeeping.

## Testing Plan

Use targeted Jest tests first:

- `__tests__/chapterEditorToolbar.test.tsx`
  - Pressing `朗读` opens range choices.
  - Choosing `本章` calls `playChapter` with the current body.
  - Choosing `从本章到结尾` reads ordered chapter bodies from current position onward.
  - Choosing `全书` reads all project chapters.

- `__tests__/fileImportBatch.test.ts`
  - Batch character import can create/use one collection.
  - Partial failures keep successful cards in the collection.
  - Empty selection still returns an empty result.

- `__tests__/resourceLibraryUi.test.tsx`
  - Character tab renders collection-level actions.
  - Opening a character collection shows card-level actions.
  - Collection enable switch calls the collection enablement database helper.

- `__tests__/databaseMigration.test.ts`
  - Schema 11 migration creates `character_collections`.
  - Existing characters receive a nonzero `collection_id`.

Final verification:

- `npx jest __tests__/chapterEditorToolbar.test.tsx __tests__/fileImportBatch.test.ts __tests__/resourceLibraryUi.test.tsx __tests__/databaseMigration.test.ts --runInBand`
- `npm run lint`

No separate `tsc --noEmit` command is required because this project has no typecheck script.

## Out Of Scope

- Native playback queue controls such as next chapter, previous chapter, resume position, or chapter-level progress.
- Cloud TTS multi-file queueing beyond the existing 10000-character guardrail.
- Recursive folder import if Android directory enumeration is not reliable with the current picker stack.
- Character collection export format.
- Changing character context budget allocation logic beyond respecting collection enabled state.

## Approval Notes

The accepted product choice is to show a range picker for cross-chapter reading instead of defaulting to one implicit range. The recommended implementation is a real `character_collections` table, not metadata inside `data_json`, because collection filtering, migration, and batch enablement need stable relational queries.
