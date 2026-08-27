/**
 * TXT 小说导入为项目（项目页「导入 TXT 小说」入口）。
 *
 * 流程：选 .txt 文件 → 原生编码识别 → 共享 Streaming 管线（decode →
 * normalize → 行级切分，与续写 TXT 同一套能力）→ 按标题切章（标准 →
 * 宽松 → 整篇回退）→ 预览确认 → 创建 outline 模式项目并批量写入章节，
 * 失败整体回滚。
 *
 * 选 outline 模式：导入的正文作为普通章节完全可编辑、可跑管线、可一键
 * N 章；continuation 模式会把项目章节当「续写章」走 Canon 边界编号，
 * 不适用于导入既有作品的完整正文。
 *
 * 流式解析（parseTxtProjectStreaming）与一次性 splitTxtChapters 语义等价，
 * 但标准/宽松模式只保留当前章窗口，整篇文本仅在无标题回退时才保留
 * （供 LLM 智能分章），避免大 TXT 整篇读入 OOM。
 */
import RNFS from 'react-native-fs';
import { types } from '@react-native-documents/picker';
import * as db from './database';
import { pickSourceFile } from './fileImport';
import { requireContinuationTextImport } from '../native/ContinuationTextImportModule';
import { normalizeSourceText } from './continuation/continuationNormalizer';
import {
  parseSourceChapters,
  createStreamingChapterParser,
  matchHeading,
  type ParsedChapter,
  type ParsedSource,
} from './continuation/continuationParser';
import { streamDecodedText } from './txtStreaming';
import { callLLM, type ChatMessage } from './llm';
import { extractJSON } from '../utils/jsonExtractor';

/** 整篇读入 JS 字符串的体积上限；更大的文件建议先拆分（原著导入走流式，无此限制）。 */
export const MAX_TXT_IMPORT_BYTES = 20 * 1024 * 1024;

export type TxtSplitMode = 'standard' | 'loose' | 'fallback' | 'llm';

export interface TxtChapter {
  title: string;
  content: string;
}

export interface TxtImportPackage {
  name: string;
  encoding: string;
  splitMode: TxtSplitMode;
  chapters: TxtChapter[];
  warnings: string[];
  /** 归一化总字数（含空白），用于预览「总字数」。 */
  charCount: number;
}

export interface TxtImportPreview {
  name: string;
  encoding: string;
  chapterCount: number;
  splitMode: TxtSplitMode;
  /** 分章模式的人类可读描述（标准标题识别/宽松标题识别/整篇单章/LLM 智能分章）。 */
  splitModeLabel: string;
  /** 总字数。 */
  charCount: number;
  /** true 时预览弹窗提供「智能分章（LLM）」按钮。 */
  needsSmartSplit: boolean;
  sampleTitles: string[];
  warnings: string[];
}

export interface TxtStreamProjectParseResult {
  chapters: TxtChapter[];
  splitMode: TxtSplitMode;
  warnings: string[];
  normalizedCharCount: number;
  nonWhitespaceCharCount: number;
  /**
   * fallback 模式保留整篇归一化文本供 LLM 智能分章；standard/loose 为
   * null（流式解析不常驻整篇正文）。
   */
  normalizedText: string | null;
  /** 智能分章候选短行（行首 UTF-16 偏移 + 行文本）。 */
  smartSplitCandidates: Array<{ offset: number; text: string }>;
}

// 序章/楔子/番外等无编号标题。仅整行匹配（可带【】或（）包装），行长受限
// 以避免把正文中恰好出现这些词的句子误判为标题。
const LOOSE_HEADING_RE =
  /^[（(【\[]?\s*(?:序章?|楔子|引子|序言|前言|尾声|终章|后记|番外[^\n]{0,20}|附录[^\n]{0,20}|书名[^\n]{0,20})\s*[）)】\]]?\s*$/;
// 「一、」「二、」式的短编号行。
const LOOSE_NUMBERED_RE =
  /^(?:[0-9]{1,4}|[一二三四五六七八九十百]{1,6})[、.．:：]\s*\S{0,28}$/;

const PREAMBLE_TITLE = '开篇';

export function splitModeLabel(mode: TxtSplitMode): string {
  switch (mode) {
    case 'standard':
      return '标准标题识别';
    case 'loose':
      return '宽松标题识别';
    case 'llm':
      return 'LLM 智能分章';
    default:
      return '整篇单章（可智能分章）';
  }
}

function splitByOffsets(
  normalizedText: string,
  boundaries: { title: string; start: number; contentStart: number }[],
): TxtChapter[] {
  const chapters: TxtChapter[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const end = i + 1 < boundaries.length ? boundaries[i + 1].start : normalizedText.length;
    chapters.push({
      title: boundaries[i].title,
      content: normalizedText
        .slice(boundaries[i].contentStart, end)
        .trim(),
    });
  }
  return chapters;
}

/** 标准标题切章；正文开头若有未归属内容收进「开篇」。 */
function standardSplit(normalizedText: string, parsed: ParsedSource): TxtChapter[] {
  const chapters: TxtChapter[] = [];
  const first = parsed.chapters[0];
  if (first && first.sourceStartOffset > 0) {
    const preamble = normalizedText.slice(0, first.sourceStartOffset).trim();
    if (preamble.length > 0) {
      chapters.push({ title: PREAMBLE_TITLE, content: preamble });
    }
  }
  for (const ch of parsed.chapters) {
    if (ch.isExcluded) continue;
    chapters.push({
      title: ch.title.trim(),
      content: normalizedText.slice(ch.contentStartOffset, ch.sourceEndOffset).trim(),
    });
  }
  return chapters;
}

export function splitTxtChapters(rawText: string): {
  chapters: TxtChapter[];
  splitMode: TxtSplitMode;
  warnings: string[];
} {
  const normalized = normalizeSourceText(rawText).text;
  if (normalized.trim().length === 0) {
    throw new Error('TXT 文件内容为空。');
  }
  const parsed = parseSourceChapters(normalized);
  if (!parsed.fallbackUsed) {
    return {
      chapters: standardSplit(normalized, parsed),
      splitMode: 'standard',
      warnings: parsed.warnings.slice(),
    };
  }
  const loose = looseSplit(normalized);
  if (loose.used) {
    return {
      chapters: loose.chapters,
      splitMode: 'loose',
      warnings: ['未识别到“第X章”式标题，已按序章/番外等特殊标题切分，请核对章节划分。'],
    };
  }
  return {
    chapters: [{ title: '整篇导入', content: normalized.trim() }],
    splitMode: 'fallback',
    warnings: ['未识别到章节标题，整篇作为单一章节导入。可在预览中选择「智能分章」。'],
  };
}

/** 标准解析（第X章/节/回、Chapter N）失败后的宽松标题扫描。 */
function looseSplit(normalizedText: string): { chapters: TxtChapter[]; used: boolean } {
  const lines = normalizedText.split('\n');
  const boundaries: { title: string; start: number; contentStart: number }[] = [];
  let offset = 0;
  let matched = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && (LOOSE_HEADING_RE.test(trimmed) || LOOSE_NUMBERED_RE.test(trimmed))) {
      boundaries.push({ title: trimmed, start: offset, contentStart: offset + line.length + 1 });
      matched = true;
    }
    offset += line.length + 1;
  }
  if (!matched || boundaries.length < 2) return { chapters: [], used: false };

  // 首个标题前的正文（书籍简介等）不丢弃，收进「开篇」。
  const firstStart = boundaries[0].start;
  const chapters: TxtChapter[] = [];
  if (normalizedText.slice(0, firstStart).trim().length > 0) {
    chapters.push({
      title: PREAMBLE_TITLE,
      content: normalizedText.slice(0, firstStart).trim(),
    });
  }
  chapters.push(...splitByOffsets(normalizedText, boundaries));
  return { chapters, used: true };
}

export const SMART_SPLIT_MAX_CANDIDATES = 1200;
const SMART_SPLIT_LINE_MAX_CHARS = 30;

/**
 * 单行是否可作智能分章候选（一次性与流式共用同一过滤规则）。
 */
function isSmartSplitCandidateLine(trimmed: string): boolean {
  return (
    trimmed.length > 0 &&
    trimmed.length <= SMART_SPLIT_LINE_MAX_CHARS &&
    !/[。！？；…”」』]$/u.test(trimmed)
  );
}

/**
 * 收集可能是标题的短行候选。LLM 载荷契约（{i: 行首偏移, t: 行文本}）与
 * 历史版本一致，避免 LLM 侧行为漂移。
 */
export function collectSmartSplitCandidates(normalizedText: string): {
  candidates: Array<{ i: number; t: string }>;
  lineOffsets: number[];
} {
  const lines = normalizedText.split('\n');
  const candidates: Array<{ i: number; t: string }> = [];
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    const trimmed = line.trim();
    if (isSmartSplitCandidateLine(trimmed) && candidates.length < SMART_SPLIT_MAX_CANDIDATES) {
      candidates.push({ i: offset, t: trimmed });
    }
    offset += line.length + 1;
  }
  return { candidates, lineOffsets };
}

/**
 * 候选行 + LLM 判定 → 章节组装。一次性与流式共用同一实现。
 */
async function assembleSmartSplit(
  normalizedText: string,
  candidates: Array<{ i: number; t: string }>,
  lineOffsets: number[],
): Promise<TxtChapter[]> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是小说文本结构分析器。用户给出一个 JSON 数组，每项 {i: 行首偏移, t: 行文本}。' +
        '请判断哪些行是章节标题（例如“第X章”“Chapter N”“序章”“楔子”“番外”“一、”等独立短行）。' +
        '只输出严格 JSON：{"starts":[行首偏移数组]}，按升序排列，至少包含第一个章节标题的偏移；' +
        '没有把握的行不要输出，正文叙述行绝对不要输出。',
    },
    { role: 'user', content: JSON.stringify(candidates) },
  ];
  // Let the shared provider capability resolver derive the request output
  // from the active model context. Import must not carry its own fixed cap.
  const result = await callLLM(messages);
  if (!result) {
    throw new Error('LLM 未返回结果，请检查 LLM 配置后重试。');
  }
  const jsonText = extractJSON(result);
  if (!jsonText) {
    throw new Error('LLM 返回内容无法解析为 JSON，请重试。');
  }
  let starts: unknown;
  try {
    starts = JSON.parse(jsonText).starts;
  } catch {
    throw new Error('LLM 返回的 JSON 不合法，请重试。');
  }
  if (!Array.isArray(starts) || starts.length === 0) {
    throw new Error('LLM 未识别出章节标题，请手动整理标题后重试。');
  }
  const validOffsets = new Set(lineOffsets);
  const boundaries = starts
    .map(v => Number(v))
    .filter(v => Number.isInteger(v) && validOffsets.has(v))
    .sort((a, b) => a - b);
  if (boundaries.length === 0) {
    throw new Error('LLM 识别的章节起点无效，请重试。');
  }
  const titleByOffset = new Map(candidates.map(c => [c.i, c.t]));
  const chapters: TxtChapter[] = [];
  const firstStart = boundaries[0];
  const preamble = normalizedText.slice(0, firstStart).trim();
  if (preamble.length > 0) {
    chapters.push({ title: PREAMBLE_TITLE, content: preamble });
  }
  chapters.push(
    ...splitByOffsets(
      normalizedText,
      boundaries.map((start, index) => {
        const nlIdx = normalizedText.indexOf('\n', start);
        return {
          title: titleByOffset.get(start) || `第 ${index + 1} 章`,
          start,
          contentStart: nlIdx >= 0 ? nlIdx + 1 : normalizedText.length,
        };
      }),
    ),
  );
  return chapters;
}

/**
 * LLM 智能分章：作用于已归一化文本（流式 fallback 保留的整篇文本）。
 */
export async function smartSplitTxtChaptersFromNormalized(
  normalizedText: string,
): Promise<TxtChapter[]> {
  const { candidates, lineOffsets } = collectSmartSplitCandidates(normalizedText);
  if (candidates.length < 2) {
    throw new Error('没有可用于智能分章的候选行，请手动整理标题后重试。');
  }
  return assembleSmartSplit(normalizedText, candidates, lineOffsets);
}

/**
 * LLM 智能分章（一次性语义，测试/兼容入口）：先归一化再走同一实现。
 */
export async function smartSplitTxtChaptersWithLLM(
  rawText: string,
): Promise<TxtChapter[]> {
  return smartSplitTxtChaptersFromNormalized(normalizeSourceText(rawText).text);
}

/**
 * 流式解析项目 TXT：decode → normalize → 行级切分（共享管道），标准 →
 * 宽松 → 整篇回退三档与一次性 splitTxtChapters 语义等价。
 *
 * 内存策略：一旦出现章节标题，正文窗口只保留「当前章 + 最近标题行」；
 * 无任何章节标题时（宽松/整篇回退），整篇归一化文本才会常驻（供宽松
 * 切分与 LLM 智能分章），此时与一次性解析的内存模型一致。
 */
export async function parseTxtProjectStreaming(input: {
  localPath: string;
  encoding: string;
  fileSizeBytes: number;
  originalFileName?: string;
}): Promise<TxtStreamProjectParseResult> {
  const parser = createStreamingChapterParser();

  // 归一化文本保留窗：windowStart 是 window[0] 在归一化文本中的偏移。
  let windowText = '';
  let windowStart = 0;

  let sawFirstChapterHeading = false;
  // 当前打开章节的标题行起始偏移（仅用于窗口裁剪）。
  let openHeadingStart: number | null = null;
  // 首个章节标题前的正文（标准模式作为「开篇」）。
  let preambleText = '';

  const chapters: TxtChapter[] = [];
  let nonWhitespaceCharCount = 0;
  let globalParagraphCount = 0;
  const smartSplitCandidates: TxtStreamProjectParseResult['smartSplitCandidates'] = [];

  const emitClosed = (closed: ParsedChapter[]) => {
    for (const ch of closed) {
      const start = ch.contentStartOffset - windowStart;
      const end = ch.sourceEndOffset - windowStart;
      if (start >= 0 && end >= start) {
        chapters.push({
          title: ch.title.trim(),
          content: windowText.slice(start, end).trim(),
        });
      }
    }
  };

  // 窗口裁剪：丢弃当前打开章标题行之前的所有内容。
  const dropBefore = (offset: number) => {
    if (offset <= windowStart) return;
    windowText = windowText.slice(offset - windowStart);
    windowStart = offset;
  };

  const normMeta = await streamDecodedText({
    files: [
      {
        localPath: input.localPath,
        encoding: input.encoding,
        fileSizeBytes: input.fileSizeBytes,
        originalFileName: input.originalFileName,
      },
    ],
    callbacks: {
      onNormalizedChunk: async ({ block }) => {
        windowText += block;
        const matches = block.match(/\S/g);
        if (matches) nonWhitespaceCharCount += matches.length;
      },
      onLine: async ({ line, lineStartOffset, lineLength }) => {
        const closed = parser.pushLine(line, lineStartOffset);
        emitClosed(closed);

        const heading = matchHeading(line);
        if (heading && heading.kind === 'chapter') {
          if (!sawFirstChapterHeading) {
            sawFirstChapterHeading = true;
            const preamble = windowText.slice(0, lineStartOffset - windowStart).trim();
            if (preamble.length > 0) {
              preambleText = preamble;
            }
            dropBefore(lineStartOffset);
          } else if (openHeadingStart !== null) {
            dropBefore(openHeadingStart);
          }
          openHeadingStart = lineStartOffset;
        }

        const trimmed = line.trim();
        if (trimmed.length > 0) globalParagraphCount += 1;
        if (
          isSmartSplitCandidateLine(trimmed) &&
          smartSplitCandidates.length < SMART_SPLIT_MAX_CANDIDATES
        ) {
          smartSplitCandidates.push({ offset: lineStartOffset, text: trimmed });
        }
        void lineLength;
      },
      onLongLineParts: async ({ parts }) => {
        if (parts.some(p => p.trim().length > 0)) globalParagraphCount += 1;
      },
    },
  });

  if (nonWhitespaceCharCount === 0) {
    throw new Error('TXT 文件内容为空。');
  }

  if (!sawFirstChapterHeading) {
    // 无任何章节标题：整篇文本完整保留在 windowText 中。
    const normalizedText = windowText;
    const loose = looseSplit(normalizedText);
    if (loose.used) {
      return {
        chapters: loose.chapters,
        splitMode: 'loose',
        warnings: ['未识别到“第X章”式标题，已按序章/番外等特殊标题切分，请核对章节划分。'],
        normalizedCharCount: normMeta.normalizedCharCount,
        nonWhitespaceCharCount,
        normalizedText: null,
        smartSplitCandidates,
      };
    }
    return {
      chapters: [{ title: '整篇导入', content: normalizedText.trim() }],
      splitMode: 'fallback',
      warnings: ['未识别到章节标题，整篇作为单一章节导入。可在预览中选择「智能分章」。'],
      normalizedCharCount: normMeta.normalizedCharCount,
      nonWhitespaceCharCount,
      normalizedText,
      smartSplitCandidates,
    };
  }

  // 标准模式：关闭最后一个章节。
  const parsedFinal = parser.finalize({
    fallbackSha256: normMeta.normalizedSha256,
    fallbackParagraphCount: globalParagraphCount,
    totalCharCount: normMeta.normalizedCharCount,
  });
  const finalClosed = parsedFinal.chapters;
  emitClosed(finalClosed);

  const result: TxtChapter[] = [];
  if (preambleText.length > 0) {
    result.push({ title: PREAMBLE_TITLE, content: preambleText });
  }
  result.push(...chapters);

  return {
    chapters: result,
    splitMode: 'standard',
    warnings: parsedFinal.warnings.slice(),
    normalizedCharCount: normMeta.normalizedCharCount,
    nonWhitespaceCharCount,
    normalizedText: null,
    smartSplitCandidates,
  };
}

export function buildTxtPreview(pkg: TxtImportPackage): TxtImportPreview {
  return {
    name: pkg.name,
    encoding: pkg.encoding,
    chapterCount: pkg.chapters.length,
    splitMode: pkg.splitMode,
    splitModeLabel: splitModeLabel(pkg.splitMode),
    charCount: pkg.charCount,
    needsSmartSplit: pkg.splitMode === 'fallback',
    sampleTitles: pkg.chapters.slice(0, 5).map(c => c.title),
    warnings: pkg.warnings.slice(),
  };
}

/**
 * 选择一个 .txt 文件并解析为待导入项目。用户取消选择时返回 null。
 *
 * 读取走共享 Streaming 管线（vs 旧整篇读入）；normalizedText 仅在
 * fallback（需要智能分章）时返回。
 */
export async function pickAndPreviewTxtProject(): Promise<{
  preview: TxtImportPreview;
  pkg: TxtImportPackage;
  normalizedText: string | null;
} | null> {
  const file = await pickSourceFile([types.plainText, types.allFiles]);
  if (!file) return null;
  if (!/\.txt$/i.test(file.name)) {
    throw new Error('请选择 .txt 文本文件。');
  }
  const stat = await RNFS.stat(file.localPath);
  if (stat.size > MAX_TXT_IMPORT_BYTES) {
    throw new Error(
      `TXT 文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 20MB 上限，请先拆分文件后再导入。`,
    );
  }
  const decoder = requireContinuationTextImport();
  const detected = await decoder.detectEncoding(file.localPath);
  const parsed = await parseTxtProjectStreaming({
    localPath: file.localPath,
    encoding: detected.encoding,
    fileSizeBytes: Number(detected.fileSizeBytes) > 0
      ? Number(detected.fileSizeBytes)
      : stat.size,
    originalFileName: file.name,
  });
  const pkg: TxtImportPackage = {
    name: file.name.replace(/\.txt$/i, '').trim() || '导入的TXT小说',
    encoding: detected.encoding,
    splitMode: parsed.splitMode,
    chapters: parsed.chapters,
    warnings: parsed.warnings,
    charCount: parsed.normalizedCharCount,
  };
  return {
    preview: buildTxtPreview(pkg),
    pkg,
    normalizedText: parsed.normalizedText,
  };
}

/**
 * 把解析好的 TXT 章节写入新项目（outline 模式）。任一步失败时删除
 * 半成品项目，不留空壳。
 */
export async function importTxtProject(pkg: TxtImportPackage): Promise<number> {
  const projectId = await db.createProject(pkg.name, 'outline');
  try {
    await db.createChaptersBulk(
      projectId,
      pkg.chapters.map((chapter, index) => ({
        position: index,
        title: chapter.title,
        content: chapter.content,
        status: 'draft',
      })),
    );
    return projectId;
  } catch (error) {
    await db.deleteProject(projectId);
    throw error;
  }
}
