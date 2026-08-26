import RNFS from 'react-native-fs';
import { keepLocalCopy, pick, types } from '@react-native-documents/picker';
import * as db from './database';
import type { ProjectMode } from '../types/novel';
import { localFileUriToPath } from '../utils/localFileUri';
import {
  isValidProjectMode,
} from './continuation/projectMode';

/**
 * Project-package spec versions accepted by the parser.
 *
 * v1/v2 — historical `tavo-mini-project`/`shinewriter-project` packages
 * (outline + freeform). Parsing behaviour for these is unchanged.
 * v3 — `shinewriter-project-v3`, introduced in Schema 19 for continuation
 * projects. v3 carries the active continuation source, text chunks, source
 * chapters, settings/boundary and continuation chapters; the v3 branch is
 * implemented alongside the continuation backup work (Spec §15).
 */
export type ProjectPackageSpecVersion = 1 | 2 | 3 | 4;

export interface ProjectImportPreview {
  specVersion: ProjectPackageSpecVersion;
  name: string;
  mode: string;
  chapterCount: number;
  resourceCount: number;
  /** 包内包含哪些能力（B0 §2.5 导入预览）。 */
  hasOutlines: boolean;
  hasCharacters: boolean;
  hasWorldbook: boolean;
  hasNotes: boolean;
  /** 作家风格 = 带 semantic_json 的 preset（writer-style v1）。 */
  hasWriterStyle: boolean;
  /** v3 续写包携带有 Continuation 数据。 */
  hasContinuation: boolean;
}

export interface ParsedProjectPackage {
  spec: string;
  specVersion: number;
  project: any;
  chapters: any[];
  fragments: any[];
  plotlines: any[];
  resources: {
    characters: any[];
    worldbookEntries: any[];
    notes: any[];
    presets: any[];
    /** v4+ outline project packages carry outlines (Schema 36+). */
    outlines?: any[];
  };
  contextConfig?: any;
  /**
   * v3-only continuation payload (Spec §15). Present when specVersion === 3.
   * Contains the active source, text chunks, source chapters and settings.
   */
  continuation?: {
    sources: any[];
    textChunks: any[];
    sourceChapters: any[];
    settings: any | null;
  };
}

export function parseProjectPackage(text: string): ParsedProjectPackage {
  // 去除 UTF-8 BOM，避免 Windows 编辑器生成的文件解析失败
  const stripped = text.replace(/^\uFEFF/, '');
  let data: any;
  try {
    data = JSON.parse(stripped);
  } catch {
    throw new Error('文件内容不是有效的 JSON。');
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('文件内容不是有效的 JSON 对象。');
  }

  const spec = String(data.spec || '');
  if (!spec.startsWith('tavo-mini-project') && !spec.startsWith('shinewriter-project')) {
    throw new Error(`不支持的项目包格式：${spec || '缺少 spec 字段'}`);
  }

  const specVersionMatch = spec.match(/(?:tavo-mini-project|shinewriter-project)-v(\d+)/);
  if (!specVersionMatch) {
    throw new Error(`无法识别的项目包版本：${spec}`);
  }
  const specVersion = parseInt(specVersionMatch[1], 10);
  // Spec §15: v1/v2 stay compatible; v3 is the continuation package introduced
  // in Schema 19. v4 extends v2 (outline/freeform) with the outlines resource
  // (Schema 36, 大纲创作模式升级). Older apps reject v4; this build accepts all.
  if (specVersion !== 1 && specVersion !== 2 && specVersion !== 3 && specVersion !== 4) {
    throw new Error(`不支持的项目包版本：v${specVersion}`);
  }

  return {
    spec,
    specVersion,
    project: data.project || {},
    chapters: Array.isArray(data.chapters) ? data.chapters : [],
    fragments: Array.isArray(data.fragments) ? data.fragments : [],
    plotlines: Array.isArray(data.plotlines) ? data.plotlines : [],
    resources: {
      characters: Array.isArray(data.resources?.characters) ? data.resources.characters : [],
      worldbookEntries: Array.isArray(data.resources?.worldbookEntries) ? data.resources.worldbookEntries : [],
      notes: Array.isArray(data.resources?.notes) ? data.resources.notes : [],
      presets: Array.isArray(data.resources?.presets) ? data.resources.presets : [],
      outlines: Array.isArray(data.resources?.outlines) ? data.resources.outlines : [],
    },
    contextConfig: data.contextConfig,
    // Spec §15: v3 packages carry the continuation payload.
    continuation:
      specVersion === 3 && data.continuation && typeof data.continuation === 'object'
        ? {
            sources: Array.isArray(data.continuation.sources) ? data.continuation.sources : [],
            textChunks: Array.isArray(data.continuation.textChunks) ? data.continuation.textChunks : [],
            sourceChapters: Array.isArray(data.continuation.sourceChapters) ? data.continuation.sourceChapters : [],
            settings: data.continuation.settings ?? null,
          }
        : undefined,
  };
}

export function previewProjectPackage(pkg: ParsedProjectPackage): ProjectImportPreview {
  const resourceCount =
    pkg.resources.characters.length +
    pkg.resources.worldbookEntries.length +
    pkg.resources.notes.length +
    pkg.resources.presets.length +
    (pkg.resources.outlines?.length ?? 0);

  return {
    specVersion: pkg.specVersion as ProjectPackageSpecVersion,
    name: String(pkg.project.name || '未命名项目'),
    // Spec §8.1: empty/missing mode falls back to outline (legacy v1 packages);
    // genuinely unknown values are preserved here only so the import step can
    // surface a precise error — they are rejected before any DB write.
    mode: String(pkg.project.mode || 'outline'),
    chapterCount: pkg.chapters.length,
    resourceCount,
    hasOutlines: (pkg.resources.outlines?.length ?? 0) > 0,
    hasCharacters: pkg.resources.characters.length > 0,
    hasWorldbook: pkg.resources.worldbookEntries.length > 0,
    hasNotes: pkg.resources.notes.length > 0,
    // writer-style v1 presets carry semantic_json; ordinary presets do not.
    hasWriterStyle: pkg.resources.presets.some(
      p => Boolean(p && (p.semantic_json || p.semantic)),
    ),
    hasContinuation: pkg.continuation != null,
  };
}

export async function importProjectPackage(pkg: ParsedProjectPackage): Promise<number> {
  const projectName = String(pkg.project.name || '导入的项目');
  // Spec §8.1: unknown modes must not be written to `projects.mode`. Validate
  // at the boundary; `normalizeProjectMode('')` would silently fall back, so
  // we use the strict guard and throw a localized error for anything outside
  // the whitelist.
  const rawMode = pkg.project.mode;
  if (!isValidProjectMode(rawMode)) {
    throw new Error(
      `不支持的项目模式：${String(rawMode ?? '')}（仅支持 outline / continuation / freeform）`,
    );
  }
  const projectMode: ProjectMode = rawMode;

  // a. Create project
  const projectId = await db.createProject(projectName, projectMode);

  try {
    // b. Map old chapter IDs to new IDs
    const chapterIdMap = new Map<number, number>();

    // c. Create chapters
    for (const chapter of pkg.chapters) {
      const oldId = Number(chapter.id);
      const position = Number(chapter.position ?? 0);
      const newId = await db.createChapter(projectId, position, chapter.title || undefined);
      const updateFields: Record<string, any> = {};
      if (chapter.synopsis) updateFields.synopsis = chapter.synopsis;
      if (chapter.content) updateFields.content = chapter.content;
      if (chapter.status) updateFields.status = chapter.status;
      if (chapter.summary_json) {
        updateFields.summary_json = typeof chapter.summary_json === 'string'
          ? chapter.summary_json
          : JSON.stringify(chapter.summary_json);
      }
      if (chapter.memory_summary) updateFields.memory_summary = chapter.memory_summary;
      if (Object.keys(updateFields).length > 0) {
        await db.updateChapter(newId, updateFields);
      }
      if (oldId) chapterIdMap.set(oldId, newId);
    }

    // d. Create fragments
    for (const fragment of pkg.fragments) {
      const position = Number(fragment.position ?? 0);
      await db.createFragment(projectId, fragment.type || 'note', fragment.content || '', position);
    }

    // e. Create plotlines, map old IDs to new
    const plotlineIdMap = new Map<number, number>();
    for (const plotline of pkg.plotlines) {
      const oldId = Number(plotline.id);
      const newId = await db.createPlotline(
        projectId,
        plotline.name || '未命名线索',
        plotline.description || '',
        plotline.color || '#439EA6',
      );
      if (oldId) plotlineIdMap.set(oldId, newId);
    }

    // f. Set chapter-plotline associations
    for (const chapter of pkg.chapters) {
      const oldChapterId = Number(chapter.id);
      const newChapterId = chapterIdMap.get(oldChapterId);
      if (!newChapterId) continue;

      const oldPlotlineIds: number[] = Array.isArray(chapter.plotline_ids)
        ? chapter.plotline_ids.map(Number)
        : [];
      const newPlotlineIds = oldPlotlineIds
        .map((oldPid) => plotlineIdMap.get(oldPid))
        .filter((id): id is number => id !== undefined);

      if (newPlotlineIds.length > 0) {
        await db.setChapterPlotlines(newChapterId, newPlotlineIds);
      }
    }

    // g. Create characters
    for (const character of pkg.resources.characters) {
      const name = String(character.name || '未命名角色');
      const sourceType = String(character.source_type || 'json');
      const dataJson = typeof character.data_json === 'string'
        ? character.data_json
        : JSON.stringify(character.data_json || character.data || {});
      const charId = await db.createCharacter(projectId, name, sourceType, dataJson);
      // Set enabled state if explicitly disabled
      if (character.enabled_for_project === 0) {
        await db.setProjectResourceEnabled(projectId, 'character', charId, false);
      }
    }

    // h. Create worldbook collections and entries
    const collectionIdMap = new Map<number, number>();
    for (const entry of pkg.resources.worldbookEntries) {
      const oldCollectionId = Number(entry.collection_id || 0);
      let newCollectionId = collectionIdMap.get(oldCollectionId);

      // Create collection if not yet mapped
      if (oldCollectionId && !newCollectionId) {
        newCollectionId = await db.createWorldbookCollection(
          projectId,
          entry.collection_name || `世界书合集 ${oldCollectionId}`,
          { enabled: entry.collection_enabled !== 0 ? 1 : 0 },
        );
        collectionIdMap.set(oldCollectionId, newCollectionId);
      }

      const keywordPrimary = String(entry.keyword_primary || '');
      const content = String(entry.content || '');
      const enabled = Number(entry.enabled ?? 1);
      const extra: Record<string, any> = {};
      if (newCollectionId) extra.collection_id = newCollectionId;
      if (entry.keyword_secondary) extra.keyword_secondary = entry.keyword_secondary;
      if (entry.comment) extra.comment = entry.comment;
      if (entry.constant != null) extra.constant = Number(entry.constant);
      if (entry.position != null) extra.position = Number(entry.position);

      const wbEntryId = await db.createWorldbookEntry(projectId, keywordPrimary, content, enabled, extra);
      if (entry.enabled_for_project === 0) {
        await db.setProjectResourceEnabled(projectId, 'worldbook', wbEntryId, false);
      }
    }

    // i. Create notes
    for (const note of pkg.resources.notes) {
      const title = String(note.title || '未命名笔记');
      const noteId = await db.createNote(projectId, title, note.content || '');
      if (note.enabled_for_project === 0) {
        await db.setProjectResourceEnabled(projectId, 'note', noteId, false);
      }
    }

    // j. Create presets
    const writerStyleIdMap = new Map<number, number>();
    for (const preset of pkg.resources.presets) {
      const name = String(preset.name || '未命名作家风格');
      const isDefault = preset.is_default === 1 || preset.is_default === true;
      const presetId = await db.createPreset(projectId, name, isDefault);

      // Update preset fields if any extra data exists
      const updateFields: Record<string, any> = {};
      if (preset.system_prompt) updateFields.system_prompt = preset.system_prompt;
      if (preset.writing_style) updateFields.writing_style = preset.writing_style;
      if (preset.temperature != null) updateFields.temperature = Number(preset.temperature);
      if (preset.top_p != null) updateFields.top_p = Number(preset.top_p);
      if (preset.max_tokens != null) updateFields.max_tokens = Number(preset.max_tokens);
      if (preset.extra_instructions) updateFields.extra_instructions = preset.extra_instructions;
      for (const field of [
        'semantic_json',
        'compatibility_json',
        'source_format',
        'source_fingerprint',
        'compatibility_fingerprint',
        'asset_contract_version',
      ]) {
        if (preset[field] !== undefined) updateFields[field] = preset[field];
      }
      if (Object.keys(updateFields).length > 0) {
        await db.updatePreset(presetId, updateFields);
      }
      if (Number(preset.id) > 0) writerStyleIdMap.set(Number(preset.id), presetId);

      if (preset.enabled_for_project === 0) {
        await db.setProjectResourceEnabled(projectId, 'preset', presetId, false);
      }
    }

    const oldActiveWriterStyleId = Number(
      pkg.project.active_writer_style_id ?? pkg.project.activeWriterStyleId ?? 0,
    );
    const newActiveWriterStyleId = writerStyleIdMap.get(oldActiveWriterStyleId);
    if (newActiveWriterStyleId) {
      await db.setProjectActiveWriterStyle(projectId, newActiveWriterStyleId);
    }

    // j2. v4+ outline packages: restore outlines (title/content/source/enable/
    //     order). Older v2/v3 packages have no outlines array and skip this.
    //     Each outline is created disabled-by-default then re-enabled/reordered
    //     to match the exported state, preserving the user's intent.
    const outlines = pkg.resources.outlines;
    if (outlines && outlines.length > 0) {
      // Validate the entire outlines array before any write so illegal data
      // never partially lands in the new project.
      for (let i = 0; i < outlines.length; i += 1) {
        const outline = outlines[i];
        if (!outline || typeof outline !== 'object') {
          throw new Error(`项目包 outlines[${i}] 不是有效对象`);
        }
        if (outline.title != null && typeof outline.title !== 'string') {
          throw new Error(`项目包 outlines[${i}].title 必须是字符串`);
        }
        if (outline.content != null && typeof outline.content !== 'string') {
          throw new Error(`项目包 outlines[${i}].content 必须是字符串`);
        }
        if (
          outline.enabled != null &&
          typeof outline.enabled !== 'boolean' &&
          outline.enabled !== 0 &&
          outline.enabled !== 1 &&
          outline.enabled !== '0' &&
          outline.enabled !== '1'
        ) {
          throw new Error(`项目包 outlines[${i}].enabled 非法`);
        }
        if (outline.position != null) {
          const pos = Number(outline.position);
          if (!Number.isInteger(pos) || pos < 0) {
            throw new Error(
              `项目包 outlines[${i}].position 必须是非负整数，收到 ${String(outline.position)}`,
            );
          }
        }
        const willEnable =
          outline.enabled === true ||
          Number(outline.enabled) === 1 ||
          outline.enabled === '1';
        const contentStr =
          outline.content == null ? '' : String(outline.content);
        if (willEnable && !contentStr.trim()) {
          throw new Error(
            `项目包 outlines[${i}] 启用但正文为空，已拒绝导入`,
          );
        }
        const sourceTypeRaw =
          outline.source_type ?? outline.sourceType ?? 'manual';
        if (sourceTypeRaw !== 'txt' && sourceTypeRaw !== 'manual') {
          throw new Error(
            `项目包 outlines[${i}].source_type 必须是 manual 或 txt`,
          );
        }
      }

      // Sort by exported position (stable for ties) so createOutline order is
      // deterministic. Invalid positions already rejected above.
      const sorted = [...outlines]
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const pa = Number(a.item.position ?? 0);
          const pb = Number(b.item.position ?? 0);
          if (pa !== pb) return pa - pb;
          return a.index - b.index;
        })
        .map(entry => entry.item);
      const newIds: number[] = [];
      for (const outline of sorted) {
        const title = String(outline.title ?? '');
        const content = String(outline.content ?? '');
        const sourceType =
          outline.source_type === 'txt' || outline.sourceType === 'txt'
            ? 'txt'
            : 'manual';
        const sourceFileName =
          outline.source_file_name ?? outline.sourceFileName ?? undefined;
        const newId = await db.createOutline(projectId, {
          title,
          content,
          sourceType,
          sourceFileName,
        });
        newIds.push(newId);
        // Restore the exported enabled state (default is off).
        const enabled =
          outline.enabled === true ||
          Number(outline.enabled) === 1 ||
          outline.enabled === '1';
        if (enabled) {
          await db.setOutlineEnabled(projectId, newId, true);
        }
      }
      // Restore exact order via reorderOutlines (positions are now 0..n-1
      // matching the sorted export order, but reorder makes it deterministic).
      if (newIds.length > 1) {
        await db.reorderOutlines(projectId, newIds);
      }
    }

    // k. Spec §15: continuation v3 payload — import source/chunks/chapters/
    //    settings with full ID remapping, in a project-level transaction so a
    //    failure rolls back the whole import (no half project).
    if (pkg.specVersion === 3 && pkg.continuation) {
      await importContinuationPayload(projectId, pkg.continuation);
    }
  } catch (error) {
    // Best-effort cleanup on failure
    await db.deleteProject(projectId).catch(() => {});
    throw error;
  }

  return projectId;
}

/**
 * Import the v3 continuation payload (Spec §15).
 *
 * Validates chunk contiguity, normalized hash and chapter ranges before any
 * write. All source/chapter IDs are remapped to fresh rows in the new project.
 */
async function importContinuationPayload(
  projectId: number,
  payload: NonNullable<ParsedProjectPackage['continuation']>,
): Promise<void> {
  const { openDatabase } = await import('../data/connection/openDatabase');
  const transactionModule = await import('../data/connection/transaction');
  const executeTransaction = transactionModule.executeTransaction;
  type SqlStatement = import('../data/connection/transaction').SqlStatement;
  const { ensureSettingsRow } = await import('./continuation/continuationSourceRepository');
  const { sha256Hex } = await import('./continuation/hashUtils');
  const dbHandle = await openDatabase();
  await ensureSettingsRow(dbHandle, projectId);

  // Validate the payload before writing anything.
  if (payload.sources.length === 0) {
    throw new Error('续写项目包缺少原著源数据。');
  }
  // Remap source ids.
  const sourceIdMap = new Map<number, number>();
  for (const src of payload.sources) {
    // Insert with a fresh auto-increment id; reuse the imported version.
    const [insRes] = await dbHandle.executeSql(
      `INSERT INTO continuation_sources (
        project_id, version, status, display_name, original_file_name, mime_type,
        detected_encoding, file_size_bytes, raw_sha256, normalized_sha256,
        normalized_char_count, normalized_byte_count, chapter_count,
        parser_version, normalization_version, error_code, error_message,
        created_at, updated_at, activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        Number(src.version) || 1,
        String(src.status || 'ready'),
        String(src.display_name || '原著'),
        String(src.original_file_name || 'source.txt'),
        String(src.mime_type || 'text/plain'),
        String(src.detected_encoding || 'utf-8'),
        Number(src.file_size_bytes) || 0,
        String(src.raw_sha256 || ''),
        String(src.normalized_sha256 || ''),
        Number(src.normalized_char_count) || 0,
        Number(src.normalized_byte_count) || 0,
        Number(src.chapter_count) || 0,
        String(src.parser_version || 'v1'),
        String(src.normalization_version || 'v1'),
        src.error_code ?? null,
        src.error_message ?? null,
        String(src.created_at || new Date().toISOString()),
        String(src.updated_at || new Date().toISOString()),
        src.activated_at ?? null,
      ],
    );
    sourceIdMap.set(Number(src.id), insRes.insertId);
  }

  // Validate + insert chunks per source.
  for (const src of payload.sources) {
    const oldSrcId = Number(src.id);
    const newSrcId = sourceIdMap.get(oldSrcId)!;
    const chunks = payload.textChunks
      .filter(c => Number(c.source_id) === oldSrcId)
      .sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index));
    // Pre-flight contiguity/hash check on the payload BEFORE any chunk INSERT
    // (Spec §15: verify before import, fail without leaving half a project).
    if (chunks.length > 0) {
      let cursor = 0;
      for (const c of chunks) {
        const start = Number(c.char_start_offset);
        const end = Number(c.char_end_offset);
        if (start !== cursor || end <= start) {
          throw new Error(`原著分块不连续：源 ${oldSrcId} 第 ${c.chunk_index} 块`);
        }
        // Verify per-chunk hash matches content (Spec §15).
        if (sha256Hex(String(c.content || '')) !== String(c.content_sha256 || '')) {
          throw new Error(`原著分块哈希校验失败：源 ${oldSrcId} 第 ${c.chunk_index} 块`);
        }
        cursor = end;
      }
      if (cursor !== Number(src.normalized_char_count)) {
        throw new Error(
          `原著总字符数不匹配：期望 ${src.normalized_char_count}，实际 ${cursor}`,
        );
      }
    }
    // Insert chunks.
    const statements: SqlStatement[] = chunks.map(c => ({
      sql: `INSERT INTO continuation_source_text_chunks (
        source_id, chunk_index, char_start_offset, char_end_offset, content, content_sha256
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      params: [
        newSrcId,
        Number(c.chunk_index),
        Number(c.char_start_offset),
        Number(c.char_end_offset),
        String(c.content || ''),
        String(c.content_sha256 || ''),
      ],
    }));
    if (statements.length > 0) await executeTransaction(dbHandle, statements);
  }

  // Insert source chapters with id remapping.
  const chapterIdMap = new Map<number, number>();
  for (const src of payload.sources) {
    const oldSrcId = Number(src.id);
    const newSrcId = sourceIdMap.get(oldSrcId)!;
    const chapters = payload.sourceChapters
      .filter(c => Number(c.source_id) === oldSrcId)
      .sort((a, b) => Number(a.position) - Number(b.position));
    const statements: SqlStatement[] = chapters.map(c => ({
      sql: `INSERT INTO continuation_source_chapters (
        source_id, position, volume_title, detected_title, title, content_sha256,
        char_count, paragraph_count, source_start_offset, content_start_offset,
        source_end_offset, is_excluded, exclusion_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        newSrcId,
        Number(c.position),
        c.volume_title ?? null,
        String(c.detected_title || ''),
        String(c.title || ''),
        String(c.content_sha256 || ''),
        Number(c.char_count) || 0,
        Number(c.paragraph_count) || 0,
        Number(c.source_start_offset),
        Number(c.content_start_offset),
        Number(c.source_end_offset),
        Number(c.is_excluded) === 1 ? 1 : 0,
        c.exclusion_reason ?? null,
        String(c.created_at || new Date().toISOString()),
        String(c.updated_at || new Date().toISOString()),
      ],
    }));
    if (statements.length > 0) {
      await executeTransaction(dbHandle, statements);
      // Read back the inserted ids to build the chapterIdMap.
      const [selRes] = await dbHandle.executeSql(
        'SELECT id, position FROM continuation_source_chapters WHERE source_id = ? ORDER BY position ASC',
        [newSrcId],
      );
      for (let i = 0; i < selRes.rows.length; i++) {
        const row = selRes.rows.item(i);
        const oldChapter = chapters[row.position];
        if (oldChapter) chapterIdMap.set(Number(oldChapter.id), row.id);
      }
    }
  }

  // Import settings (boundary) with remapped source/chapter ids.
  if (payload.settings) {
    const s = payload.settings;
    const newActiveSourceId = s.active_source_id ? sourceIdMap.get(Number(s.active_source_id)) : null;
    const newBoundarySourceId = s.boundary_source_id ? sourceIdMap.get(Number(s.boundary_source_id)) : null;
    const newBoundaryChapterId = s.boundary_chapter_id ? chapterIdMap.get(Number(s.boundary_chapter_id)) : null;
    await dbHandle.executeSql(
      `UPDATE continuation_settings SET
        active_source_id = ?, boundary_source_id = ?, boundary_chapter_id = ?,
        boundary_char_offset_global = ?, boundary_mode = ?, import_completed = ?,
        analysis_status = 'outdated', updated_at = ?
        WHERE project_id = ?`,
      [
        newActiveSourceId,
        newBoundarySourceId,
        newBoundaryChapterId,
        s.boundary_char_offset_global != null ? Number(s.boundary_char_offset_global) : null,
        String(s.boundary_mode || 'end_of_source'),
        Number(s.import_completed) === 1 ? 1 : 0,
        new Date().toISOString(),
        projectId,
      ],
    );
  }
}

export async function pickAndPreviewProjectPackage(): Promise<{
  preview: ProjectImportPreview;
  pkg: ParsedProjectPackage;
} | null> {
  let selected: any;
  try {
    const results = await pick({ type: [types.json, types.allFiles], allowMultiSelection: false, mode: 'import' });
    if (!results || results.length === 0) return null;
    selected = results[0];
  } catch (e: any) {
    // User cancelled the picker
    if (e?.message?.includes('cancel') || e?.code === 'DOCUMENT_PICKER_CANCELED') return null;
    throw new Error('选择文件失败。');
  }
  if (!selected) return null;

  let localPath: string;
  try {
    const [copy] = await keepLocalCopy({
      files: [{ uri: selected.uri, fileName: selected.name || 'shinewriter-import' }],
      destination: 'cachesDirectory',
    });
    if (copy.status === 'error') {
      throw new Error(copy.copyError || '复制导入文件失败。');
    }
    localPath = localFileUriToPath(copy.localUri);
  } catch (e: any) {
    if (e.message?.includes('cancel')) return null;
    throw new Error('复制导入文件失败。');
  }

  const text = await RNFS.readFile(localPath, 'utf8');
  const pkg = parseProjectPackage(text);
  const preview = previewProjectPackage(pkg);
  return { preview, pkg };
}
