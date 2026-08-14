import RNFS from 'react-native-fs';
import { saveDocuments } from '@react-native-documents/picker';
import * as db from './database';
import { exportSillyTavernOpenAIPreset } from './writerStyle/tavernAdapter';
import { freezeWriterStyle } from './writerStyle/compiler';
import {
  getContinuationChapterNumbering,
  makeContinuationChapterNumbering,
} from './continuation/chapterNumbering/continuationChapterNumbering';

function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (name || 'novel-project').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_');
  return cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned;
}

/**
 * Resolve the display title for a chapter. Continuation projects continue the
 * visible number from the source boundary (Spec §11.2); user-custom titles are
 * preserved. Outline projects keep the legacy position+1 fallback.
 */
function resolveChapterTitle(
  project: { mode?: string } | null,
  chapter: { title: string; position: number },
  numbering: Awaited<ReturnType<typeof getContinuationChapterNumbering>> | null,
): string {
  if (project?.mode === 'continuation' && numbering) {
    const resolved = numbering.getDisplayTitle(chapter);
    if (resolved) return resolved;
  }
  return chapter.title || makeContinuationChapterNumbering(null).getDefaultTitle(chapter.position as any);
}

async function loadExportNumbering(
  project: { mode?: string } | null,
  projectId: number,
): Promise<Awaited<ReturnType<typeof getContinuationChapterNumbering>> | null> {
  if (project?.mode !== 'continuation') return null;
  try {
    return await getContinuationChapterNumbering(projectId);
  } catch {
    return null;
  }
}

export async function exportToMarkdown(projectId: number): Promise<string> {
  const project = await db.getProjectById(projectId);
  const chapters = await db.getChaptersByProject(projectId);
  const projectName = safeFileName(project?.name || 'novel-project');
  // Load numbering once per export (Spec §11.3) — avoid N snapshot reads.
  const numbering = await loadExportNumbering(project, projectId);

  let markdown = `# ${project?.name || projectName}\n\n`;
  for (const chapter of chapters) {
    const title = resolveChapterTitle(project, chapter, numbering);
    markdown += `## ${title}\n\n`;
    if (chapter.synopsis) markdown += `> ${chapter.synopsis}\n\n`;
    if (chapter.summary_json?.brief) markdown += `> 摘要：${chapter.summary_json.brief}\n\n`;
    markdown += `${chapter.content || ''}\n\n---\n\n`;
  }

  return saveTextDocument(`${projectName}.md`, markdown, 'text/markdown');
}

export async function exportToText(projectId: number): Promise<string> {
  const project = await db.getProjectById(projectId);
  const chapters = await db.getChaptersByProject(projectId);
  const projectName = safeFileName(project?.name || 'novel-project');
  const numbering = await loadExportNumbering(project, projectId);
  const text = chapters
    .map(chapter => {
      const title = resolveChapterTitle(project, chapter, numbering);
      return `${title}\n\n${chapter.content || ''}`;
    })
    .join('\n\n');
  return saveTextDocument(`${projectName}.txt`, `﻿${text}`, 'text/plain');
}

export async function exportShineWriterNovelJSON(projectId: number): Promise<string> {
  const project = await db.getProjectById(projectId);
  const [chapters, fragments, plotlines, characters, worldbookEntries, notes, presets, outlines] = await Promise.all([
    db.getChaptersByProject(projectId),
    db.getFragmentsByProject(projectId),
    db.getPlotlinesByProject(projectId),
    db.getCharactersByProject(projectId),
    db.getWorldbookEntriesByProject(projectId),
    db.getNotesByProject(projectId),
    db.getPresetsByProject(projectId),
    db.getOutlinesByProject(projectId),
  ]);

  // Spec §15: continuation projects export as shinewriter-project-v3, which
  // carries the active source, text chunks, source chapters and settings/
  // boundary. Outline/freeform projects export as v4 when they carry outlines
  // (Schema 36, 大纲创作模式升级); otherwise keep v2 for compatibility.
  const isContinuation = project?.mode === 'continuation';
  const hasOutlines = outlines && outlines.length > 0;
  const continuationPayload = isContinuation
    ? await buildContinuationExportPayload(projectId)
    : undefined;
  // v4 = outline/freeform projects WITH outlines; v2 = outline/freeform without;
  // v3 = continuation (unchanged).
  const specVersion = isContinuation ? 3 : hasOutlines ? 4 : 2;

  const data: any = {
    spec: `shinewriter-project-v${specVersion}`,
    version: `${specVersion}.0`,
    exportedAt: new Date().toISOString(),
    project,
    chapters,
    fragments,
    plotlines,
    resources: {
      characters: characters.map((character: any) => ({
        ...character,
        data_json: safeJson(character.data_json),
      })),
      worldbookEntries,
      notes,
      presets,
      // v4+: outlines (title/content/source/enable/order). Omitted for v2
      // projects without outlines so older apps still read the file.
      ...(hasOutlines
        ? {
            outlines: outlines.map((outline: any) => ({
              title: outline.title,
              content: outline.content,
              source_type: outline.sourceType,
              source_file_name: outline.sourceFileName ?? null,
              enabled: outline.enabled ? 1 : 0,
              position: outline.position,
            })),
          }
        : {}),
    },
    contextConfig: await db.getContextConfig(),
  };
  if (continuationPayload) {
    data.continuation = continuationPayload;
  }

  const projectName = safeFileName(project?.name || 'novel-project');
  return saveTextDocument(`${projectName}.shinewriter.json`, JSON.stringify(data, null, 2), 'application/json');
}

/**
 * Build the v3 continuation payload: active source + text chunks + source
 * chapters + settings/boundary. Import jobs are NOT included (Spec §15).
 */
async function buildContinuationExportPayload(projectId: number): Promise<{
  sources: any[];
  textChunks: any[];
  sourceChapters: any[];
  settings: any | null;
}> {
  const { all } = await import('../data/connection/query');
  // all() opens the shared DB internally; no handle needed here.
  const sources = await all<any>(
    `SELECT * FROM continuation_sources WHERE project_id = ? ORDER BY version ASC`,
    [projectId],
  );
  const sourceIds = sources.map(s => s.id);
  let textChunks: any[] = [];
  let sourceChapters: any[] = [];
  if (sourceIds.length > 0) {
    const placeholders = sourceIds.map(() => '?').join(',');
    textChunks = await all<any>(
      `SELECT * FROM continuation_source_text_chunks WHERE source_id IN (${placeholders}) ORDER BY source_id, chunk_index ASC`,
      sourceIds,
    );
    sourceChapters = await all<any>(
      `SELECT * FROM continuation_source_chapters WHERE source_id IN (${placeholders}) ORDER BY source_id, position ASC`,
      sourceIds,
    );
  }
  const settingsRows = await all<any>(
    `SELECT * FROM continuation_settings WHERE project_id = ?`,
    [projectId],
  );
  return {
    sources,
    textChunks,
    sourceChapters,
    settings: settingsRows[0] ?? null,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function normalizeKeys(raw: string): string[] {
  if (!raw) return [];
  return raw.split(/[,，\n]/).map((k: string) => k.trim()).filter(Boolean);
}

export async function exportCharacterJSON(characterId: number): Promise<string> {
  const character = await db.getCharacterById(characterId);
  if (!character) throw new Error('未找到角色卡。');
  const data = safeJson(character.data_json) as Record<string, unknown>;
  const exportData = 'spec' in data ? data : { spec: 'chara_card_v3', spec_version: '3.0', data };
  const fileName = safeFileName(character.name || 'character') + '.json';
  return saveTextDocument(fileName, JSON.stringify(exportData, null, 2), 'application/json');
}

export async function exportWorldbookCollectionJSON(collectionId: number): Promise<string> {
  const collections = await db.getWorldbookCollections();
  const collection = collections.find((c: any) => c.id === collectionId);
  if (!collection) throw new Error('未找到世界书合集。');
  const entries = await db.getWorldbookEntriesByCollection(collectionId);
  const fileName = safeFileName(collection.name || 'worldbook') + '.json';
  const exportData = {
    spec: 'lorebook_v3',
    spec_version: '1.0',
    data: {
      name: collection.name,
      entries: entries.map((entry: any) => ({
        keys: normalizeKeys(entry.keyword_primary),
        secondary_keys: normalizeKeys(entry.keyword_secondary),
        content: entry.content || '',
        comment: entry.comment || '',
        enabled: entry.enabled === 1,
        constant: entry.constant === 1,
        insertion_order: entry.position || 0,
      })),
    },
  };
  return saveTextDocument(fileName, JSON.stringify(exportData, null, 2), 'application/json');
}

export async function exportNoteMarkdown(noteId: number): Promise<string> {
  const notes = await db.getAllNotes();
  const note = notes.find((n: any) => n.id === noteId);
  if (!note) throw new Error('未找到笔记。');
  const fileName = safeFileName(note.title || 'note') + '.md';
  const noteContent = await db.getNoteContentById(noteId);
  const content = `# ${note.title || '无标题'}\n\n${noteContent}`;
  return saveTextDocument(fileName, content, 'text/markdown');
}

export async function exportPresetJSON(presetId: number): Promise<string> {
  const presets = await db.getAllPresets();
  const preset = presets.find((p: any) => p.id === presetId);
  if (!preset) throw new Error('未找到预设。');
  const fileName = safeFileName(preset.name || 'preset') + '.json';
  const exportData = {
    spec: preset.semantic_json ? 'shinewriter-writer-style-v1' : 'shinewriter-preset-v1',
    name: preset.name,
    system_prompt: preset.system_prompt,
    writing_style: preset.writing_style,
    extra_instructions: preset.extra_instructions,
    temperature: preset.temperature,
    top_p: preset.top_p,
    max_tokens: preset.max_tokens,
    ...(preset.semantic_json
      ? { semantic: JSON.parse(preset.semantic_json) }
      : {}),
    ...(preset.source_format ? { source_format: preset.source_format } : {}),
    ...(preset.compatibility_json
      ? { compatibility: JSON.parse(preset.compatibility_json) }
      : {}),
  };
  return saveTextDocument(fileName, JSON.stringify(exportData, null, 2), 'application/json');
}

export async function exportWriterStyleAsTavern(
  styleId: number,
): Promise<string> {
  const styles = await db.getAllPresets();
  const style = styles.find(item => Number(item.id) === Number(styleId));
  if (!style) throw new Error('未找到作家风格。');
  const semantic = style.semantic_json
    ? JSON.parse(style.semantic_json)
    : null;
  const compatibility = style.compatibility_json
    ? JSON.parse(style.compatibility_json)
    : null;
  const raw = compatibility
    ? exportSillyTavernOpenAIPreset(compatibility, semantic || undefined)
    : freezeWriterStyle(style as any).semantic
      ? (await import('./writerStyle/tavernAdapter')).exportNewWriterStyleAsTavern(
          freezeWriterStyle(style as any).semantic!,
        )
      : null;
  if (!raw) throw new Error('该旧版作家风格没有可导出的 Semantic。');
  const fileName = safeFileName(style.name || 'writer-style') + '-SillyTavern.json';
  return saveTextDocument(fileName, JSON.stringify(raw, null, 2), 'application/json');
}

async function saveTextDocument(fileName: string, content: string, mimeType: string): Promise<string> {
  const cachePath = `${RNFS.CachesDirectoryPath}/${Date.now()}-${fileName}`;
  try {
    await RNFS.writeFile(cachePath, content, 'utf8');
    const [saved] = await saveDocuments({
      sourceUris: [`file://${cachePath}`],
      fileName,
      mimeType,
    });
    if (saved.error) {
      throw new Error(saved.error);
    }
    return saved.uri;
  } finally {
    RNFS.unlink(cachePath).catch(() => { /* ignore cleanup errors */ });
  }
}
