import RNFS from 'react-native-fs';
import { saveDocuments } from '@react-native-documents/picker';
import * as db from './database';

function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (name || 'novel-project').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_');
  return cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned;
}

export async function exportToMarkdown(projectId: number): Promise<string> {
  const project = await db.getProjectById(projectId);
  const chapters = await db.getChaptersByProject(projectId);
  const projectName = safeFileName(project?.name || 'novel-project');

  let markdown = `# ${project?.name || projectName}\n\n`;
  for (const chapter of chapters) {
    markdown += `## ${chapter.title || `第 ${chapter.position + 1} 章`}\n\n`;
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
  const text = chapters
    .map((chapter) => `${chapter.title || `第 ${chapter.position + 1} 章`}\n\n${chapter.content || ''}`)
    .join('\n\n');
  return saveTextDocument(`${projectName}.txt`, `﻿${text}`, 'text/plain');
}

export async function exportTavoNovelJSON(projectId: number): Promise<string> {
  const project = await db.getProjectById(projectId);
  const [chapters, fragments, plotlines, characters, worldbookEntries, notes, presets] = await Promise.all([
    db.getChaptersByProject(projectId),
    db.getFragmentsByProject(projectId),
    db.getPlotlinesByProject(projectId),
    db.getCharactersByProject(projectId),
    db.getWorldbookEntriesByProject(projectId),
    db.getNotesByProject(projectId),
    db.getPresetsByProject(projectId),
  ]);

  const data = {
    spec: 'tavo-mini-project-v2',
    version: '2.0',
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
    },
    contextConfig: await db.getContextConfig(),
  };

  const projectName = safeFileName(project?.name || 'novel-project');
  return saveTextDocument(`${projectName}.tavo-mini.json`, JSON.stringify(data, null, 2), 'application/json');
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
    spec: 'tavo-preset-v1',
    name: preset.name,
    system_prompt: preset.system_prompt,
    writing_style: preset.writing_style,
    extra_instructions: preset.extra_instructions,
    temperature: preset.temperature,
    top_p: preset.top_p,
    max_tokens: preset.max_tokens,
  };
  return saveTextDocument(fileName, JSON.stringify(exportData, null, 2), 'application/json');
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
