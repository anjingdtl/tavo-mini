import * as db from './database';

export interface MacroContext {
  projectId: number;
  chapterTitle?: string;
  chapterSynopsis?: string;
  userName?: string;
}

export async function processMacros(text: string, context: MacroContext): Promise<string> {
  let output = text;
  const characters = await db.getCharactersByProject(context.projectId);
  const firstCharacter = characters[0];

  output = output.replace(/\{\{char\}\}/gi, firstCharacter?.name || '角色');
  output = output.replace(/\{\{user\}\}/gi, context.userName || '读者');
  output = output.replace(/\{\{chapter\}\}/gi, context.chapterTitle || '');
  output = output.replace(/\{\{synopsis\}\}/gi, context.chapterSynopsis || '');

  return output;
}
