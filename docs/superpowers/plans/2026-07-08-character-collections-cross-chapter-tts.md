# Character Collections and Cross-Chapter TTS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build cross-chapter voice reading and character-card collections, then verify and publish the finished `main` branch.

**Architecture:** Add a schema 11 migration with `character_collections` plus `characters.collection_id`, mirror worldbook collection database patterns for character cards, and keep TTS range assembly in database helpers consumed by `ChapterEditor`. Reuse existing TTS playback and character-card parsing so the feature adds orchestration, grouping, and UI state instead of new native playback code.

**Tech Stack:** React Native 0.85, TypeScript, Zustand, SQLite via `react-native-sqlite-storage`, Jest and `@testing-library/react-native`.

---

## File Structure

- Modify `src/services/migrations/index.ts` to bump schema version to 11 and register a new migration.
- Create `src/services/migrations/v10-to-v11.ts` for character collection schema upgrade and existing-character backfill.
- Modify `src/services/database.ts` for fresh schema, collection CRUD, character query joins, collection enablement, and cross-chapter reading text helpers.
- Modify `src/services/fileImport.ts` so character imports accept a collection and can import a batch into one collection.
- Modify `src/screens/ResourceLibrary.tsx` to show character collections and collection-scoped character cards.
- Modify `src/screens/ChapterEditor.tsx` to show a reading range picker and call the new text helper.
- Modify `__tests__/databaseMigration.test.ts`, `__tests__/fileImportBatch.test.ts`, `__tests__/resourceLibraryUi.test.tsx`, and `__tests__/chapterEditorToolbar.test.tsx` for regression coverage.

## Task 1: Schema 11 Character Collections

**Files:**
- Create: `src/services/migrations/v10-to-v11.ts`
- Modify: `src/services/migrations/index.ts`
- Modify: `src/services/database.ts`
- Test: `__tests__/databaseMigration.test.ts`

- [ ] **Step 1: Write the failing migration test**

Add a test that runs the v10-to-v11 migration against the existing SQLite mock and asserts:

```ts
expect(sqlStatements).toContainEqual(expect.stringContaining('CREATE TABLE IF NOT EXISTS character_collections'));
expect(sqlStatements).toContainEqual(expect.stringContaining('ALTER TABLE characters ADD COLUMN collection_id INTEGER NOT NULL DEFAULT 0'));
expect(sqlStatements).toContainEqual(expect.stringContaining('UPDATE characters SET collection_id'));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/databaseMigration.test.ts --runInBand`

Expected: FAIL because `migrateV10toV11` and schema 11 do not exist.

- [ ] **Step 3: Implement migration and fresh schema**

Create `migrateV10toV11`, bump `SCHEMA_VERSION` to `11`, register `{ from: 10, to: 11, breaking: false, migrate: migrateV10toV11 }`, add the fresh `character_collections` table, and add `collection_id` to fresh `characters`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/databaseMigration.test.ts --runInBand`

Expected: PASS.

## Task 2: Character Collection Database API

**Files:**
- Modify: `src/services/database.ts`
- Test: `__tests__/resourceLibraryUi.test.tsx` mocks and future UI tests

- [ ] **Step 1: Add failing API expectations through UI tests**

Update the ResourceLibrary database mock to include these functions and add assertions that collection enablement calls `setCharacterCollectionEnabledForProject`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/resourceLibraryUi.test.tsx --runInBand`

Expected: FAIL because ResourceLibrary does not call the new helpers.

- [ ] **Step 3: Implement database helpers**

Add:

```ts
getCharacterCollections(projectId?: number)
createCharacterCollection(projectId: number, name: string, extra?: Row)
updateCharacterCollection(id: number, fields: Row)
deleteCharacterCollection(id: number)
updateCharacterCollectionTokenEstimate(id: number)
getCharactersByCollection(collectionId: number, projectId?: number)
setCharacterCollectionEnabledForProject(projectId: number, collectionId: number, enabled: boolean)
setAllCharactersCollectionId(projectId: number, collectionId: number)
ensureDefaultCharacterCollection(projectId: number)
```

Update `getAllCharacters`, `getCharactersByProject`, `getCharacterById`, `createCharacter`, `updateCharacter`, `updateCharacterTokenBudget`, and `deleteCharacter` to preserve collection metadata and token estimates.

- [ ] **Step 4: Run targeted tests**

Run: `npx jest __tests__/resourceLibraryUi.test.tsx __tests__/databaseMigration.test.ts --runInBand`

Expected: tests that do not depend on UI implementation still pass or fail only for missing UI wiring.

## Task 3: Collection-Aware Character Imports

**Files:**
- Modify: `src/services/fileImport.ts`
- Test: `__tests__/fileImportBatch.test.ts`

- [ ] **Step 1: Write failing import tests**

Add tests that call:

```ts
await importCharacters(1, files, { collectionId: 7 });
await importCharactersAsCollection(1, 'Folder A', files);
```

Assert each created character receives collection id 7 in the first case, and the second case creates one collection then imports all successful cards into it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/fileImportBatch.test.ts --runInBand`

Expected: FAIL because the new option and helper do not exist.

- [ ] **Step 3: Implement collection-aware imports**

Change `importOneCharacterFromFile` and `importCharacters` to accept `collectionId`. Add `importCharactersAsCollection(projectId, collectionName, files)` that creates one character collection and returns `{ collectionId, importedCount }` for successes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/fileImportBatch.test.ts --runInBand`

Expected: PASS.

## Task 4: Resource Library Character Collection UX

**Files:**
- Modify: `src/screens/ResourceLibrary.tsx`
- Test: `__tests__/resourceLibraryUi.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Assert:

```ts
expect(await findByText('新建角色合集')).toBeTruthy();
expect(await findByText('整理已导入')).toBeTruthy();
fireEvent.press(await findByText('打开'));
expect(await findByText('返回合集')).toBeTruthy();
```

Also assert the character collection switch calls `setCharacterCollectionEnabledForProject`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/resourceLibraryUi.test.tsx --runInBand`

Expected: FAIL because character collections are not rendered.

- [ ] **Step 3: Implement UI**

Add `characterCollections`, `selectedCharacterCollectionId`, collection-level actions, collection cards, selected-collection filtering, and collection-aware create/import/delete/edit flows. Keep toolbar actions in one horizontal scroll strip.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/resourceLibraryUi.test.tsx --runInBand`

Expected: PASS.

## Task 5: Cross-Chapter TTS Range Picker

**Files:**
- Modify: `src/services/database.ts`
- Modify: `src/screens/ChapterEditor.tsx`
- Test: `__tests__/chapterEditorToolbar.test.tsx`

- [ ] **Step 1: Write failing chapter editor tests**

Mock `Alert.alert`, `db.buildChapterReadingText`, and `useVoiceStore`. Assert the reading button opens `本章`, `从本章到结尾`, and `全书`; pressing `全书` calls `buildChapterReadingText(projectId, chapterId, 'all')` and then `playChapter`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/chapterEditorToolbar.test.tsx --runInBand`

Expected: FAIL because no range picker exists.

- [ ] **Step 3: Implement reading text helper and UI**

Add `buildChapterReadingText(projectId, chapterId, range)` with range values `current`, `fromCurrent`, and `all`. Update `toggleTts` so playback stops immediately when active, otherwise opens the range picker.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/chapterEditorToolbar.test.tsx --runInBand`

Expected: PASS.

## Task 6: Regression, Fixes, and Publish

**Files:**
- All modified files

- [ ] **Step 1: Run targeted regression**

Run:

```powershell
npx jest __tests__/chapterEditorToolbar.test.tsx __tests__/fileImportBatch.test.ts __tests__/resourceLibraryUi.test.tsx __tests__/databaseMigration.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 2: Run full Jest suite**

Run: `npm test -- --runInBand`

Expected: PASS. If full suite times out or exposes unrelated pre-existing issues, capture the exact output and run the smallest credible affected subset before publishing.

- [ ] **Step 3: Run lint**

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 4: Build Android release**

Run: `npm run apk:release`

Expected: release APK is copied to `dist/apk/release/ShineWriter-V<ver>-release.apk`.

- [ ] **Step 5: Commit and push main**

Run:

```powershell
git status --short
git add -f docs/superpowers/plans/2026-07-08-character-collections-cross-chapter-tts.md
git add src __tests__
git commit -m "feat: add character collections and cross-chapter tts"
git fetch origin --prune
git merge --ff-only origin/main
git push origin main
git rev-parse HEAD
git rev-parse origin/main
```

Expected: local and remote `main` point to the same SHA.
