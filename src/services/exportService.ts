import RNFS from 'react-native-fs';
import { saveDocuments } from '@react-native-documents/picker';
import * as db from './database';

function safeFileName(name: string): string {
  return (name || 'novel-project').replace(/[\\/:*?"<>|]/g, '_');
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
  return saveTextDocument(`${projectName}.txt`, `\ufeff${text}`, 'text/plain');
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
    spec: 'tavo-mini-project-v1',
    version: '1.0',
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

async function saveTextDocument(fileName: string, content: string, mimeType: string): Promise<string> {
  const cachePath = `${RNFS.CachesDirectoryPath}/${Date.now()}-${fileName}`;
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
}
