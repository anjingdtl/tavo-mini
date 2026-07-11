export interface NoteChapter {
  title: string;
  offset: number;
}

/**
 * 识别 TXT 中常见的小说章节标题，供导入切分和编辑器目录共用，避免两处规则不一致。
 */
export function getNoteChapters(text: string): NoteChapter[] {
  const lines = text.match(/[^\n]*(?:\n|$)/g) || [];
  const chapters: NoteChapter[] = [];
  let offset = 0;

  for (const line of lines) {
    const title = line.trim();
    if (isChapterHeading(title)) chapters.push({ title, offset });
    offset += line.length;
  }
  return chapters;
}

function isChapterHeading(heading: string): boolean {
  if (!heading || heading.length > 100) return false;
  return /^(?:#{1,6}\s+.+|第[\d零〇一二三四五六七八九十百千万两]+(?:卷|部|篇)?(?:章|节|回|集|部).*|(?:序章|楔子|引子|前言|后记|尾声|终章|番外)(?:\s|：|:|$).*|(?:chapter|prologue|epilogue)\s+(?:\d+|[ivxlcdm]+)\b.*)$/i.test(
    heading,
  );
}
