import RNFS from 'react-native-fs';
import { keepLocalCopy, pick, types } from '@react-native-documents/picker';
import * as db from './database';

export interface ProjectImportPreview {
  specVersion: 1 | 2;
  name: string;
  mode: string;
  chapterCount: number;
  resourceCount: number;
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
  };
  contextConfig?: any;
}

export function parseProjectPackage(text: string): ParsedProjectPackage {
  let data: any;
  try {
    data = JSON.parse(text);
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
  if (specVersion !== 1 && specVersion !== 2) {
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
    },
    contextConfig: data.contextConfig,
  };
}

export function previewProjectPackage(pkg: ParsedProjectPackage): ProjectImportPreview {
  const resourceCount =
    pkg.resources.characters.length +
    pkg.resources.worldbookEntries.length +
    pkg.resources.notes.length +
    pkg.resources.presets.length;

  return {
    specVersion: pkg.specVersion as 1 | 2,
    name: String(pkg.project.name || '未命名项目'),
    mode: String(pkg.project.mode || 'outline'),
    chapterCount: pkg.chapters.length,
    resourceCount,
  };
}

export async function importProjectPackage(pkg: ParsedProjectPackage): Promise<number> {
  const projectName = String(pkg.project.name || '导入的项目');
  const projectMode = String(pkg.project.mode || 'outline');

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
    for (const preset of pkg.resources.presets) {
      const name = String(preset.name || '未命名预设');
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
      if (Object.keys(updateFields).length > 0) {
        await db.updatePreset(presetId, updateFields);
      }

      if (preset.enabled_for_project === 0) {
        await db.setProjectResourceEnabled(projectId, 'preset', presetId, false);
      }
    }
  } catch (error) {
    // Best-effort cleanup on failure
    await db.deleteProject(projectId).catch(() => {});
    throw error;
  }

  return projectId;
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
    localPath = copy.localUri.replace(/^file:\/\//, '');
  } catch (e: any) {
    if (e.message?.includes('cancel')) return null;
    throw new Error('复制导入文件失败。');
  }

  const text = await RNFS.readFile(localPath, 'utf8');
  const pkg = parseProjectPackage(text);
  const preview = previewProjectPackage(pkg);
  return { preview, pkg };
}
