/**
 * Deterministic chapter extractor for CI / offline fixtures (Spec §9.1, §17.6).
 *
 * Does not invent future plot: only scans the provided bounded chapter text.
 * Recognises explicit markers used by the Phase 2 future-leakage fixture:
 *   [角色:名字]  [别名:称号]  [世界规则:标题|描述]
 *   [关系:甲->乙:类型]  [剧情:标题]  [经历:角色:标题]
 *   [知识:角色:factKey:摘要]  [状态:角色:地点:摘要]
 *   [时间线:key:标题]
 * Also falls back to simple 「某某说」pattern for character discovery.
 */
import type { BoundedSourceChapter } from '../types';
import {
  EXTRACTION_RESULT_SCHEMA_VERSION,
  type ChapterExtractionResult,
  type ExtractionEvidenceCandidate,
} from './canonJsonValidators';

function evidenceFor(
  chapter: BoundedSourceChapter,
  localStart: number,
  localEnd: number,
): ExtractionEvidenceCandidate {
  const start = chapter.range.start + localStart;
  const end = chapter.range.start + localEnd;
  const preview = chapter.content.slice(localStart, Math.min(localEnd, localStart + 160));
  return {
    chapterId: chapter.id,
    chapterPosition: chapter.position,
    charStart: start,
    charEnd: Math.max(start + 1, end),
    quotePreview: preview,
  };
}

function matchAll(
  text: string,
  re: RegExp,
): Array<{ match: RegExpExecArray; index: number }> {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  const out: Array<{ match: RegExpExecArray; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = global.exec(text)) !== null) {
    out.push({ match: m, index: m.index });
    if (m[0].length === 0) global.lastIndex += 1;
  }
  return out;
}

export function extractChapterDeterministic(
  chapters: BoundedSourceChapter[],
): ChapterExtractionResult {
  const result: ChapterExtractionResult = {
    schemaVersion: EXTRACTION_RESULT_SCHEMA_VERSION,
    worldRules: [],
    characters: [],
    relationships: [],
    plotThreads: [],
    experiences: [],
    knowledge: [],
    states: [],
    timelineEvents: [],
  };

  const seenChars = new Set<string>();

  for (const chapter of chapters) {
    const text = chapter.content;

    for (const { match, index } of matchAll(text, /\[角色:([^\]]+)\]/g)) {
      const name = match[1].trim();
      if (!name || seenChars.has(name)) continue;
      seenChars.add(name);
      result.characters.push({
        canonicalName: name,
        aliases: [],
        description: `在「${chapter.title}」中出现`,
        importance: result.characters.length < 3 ? 'primary' : 'supporting',
        confidence: 0.85,
        evidence: [evidenceFor(chapter, index, index + match[0].length)],
      });
    }

    for (const { match, index } of matchAll(text, /\[别名:([^\]]+)\]/g)) {
      const alias = match[1].trim();
      if (!alias || result.characters.length === 0) continue;
      const owner = result.characters[result.characters.length - 1];
      if (!owner.aliases.includes(alias)) owner.aliases.push(alias);
      owner.evidence.push(evidenceFor(chapter, index, index + match[0].length));
    }

    for (const { match, index } of matchAll(
      text,
      /\[世界规则:([^|\]]+)\|([^\]]+)\]/g,
    )) {
      result.worldRules.push({
        category: 'fundamental',
        title: match[1].trim(),
        description: match[2].trim(),
        constraintLevel: 'hard',
        confidence: 0.9,
        evidence: [evidenceFor(chapter, index, index + match[0].length)],
      });
    }

    for (const { match, index } of matchAll(
      text,
      /\[关系:([^>\]]+)->([^:\]\]]+):([^\]]+)\]/g,
    )) {
      result.relationships.push({
        sourceName: match[1].trim(),
        targetName: match[2].trim(),
        relationType: match[3].trim() || 'related',
        attitude: '',
        publicStatus: 'public',
        description: '',
        confidence: 0.8,
        evidence: [evidenceFor(chapter, index, index + match[0].length)],
      });
    }

    for (const { match, index } of matchAll(text, /\[剧情:([^\]]+)\]/g)) {
      result.plotThreads.push({
        title: match[1].trim(),
        description: `见于「${chapter.title}」`,
        timeDescription: '',
        location: '',
        level: result.plotThreads.length === 0 ? 'main' : 'subplot',
        status: 'active',
        characterNames: [],
        confidence: 0.75,
        evidence: [evidenceFor(chapter, index, index + match[0].length)],
      });
    }

    for (const { match, index } of matchAll(
      text,
      /\[经历:([^:\]\]]+):([^\]]+)\]/g,
    )) {
      result.experiences.push({
        characterName: match[1].trim(),
        eventType: 'other',
        title: match[2].trim(),
        description: '',
        importance: 1,
        confidence: 0.75,
        evidence: [evidenceFor(chapter, index, index + match[0].length)],
      });
    }

    for (const { match, index } of matchAll(
      text,
      /\[知识:([^:\]\]]+):([^:\]\]]+):([^\]]+)\]/g,
    )) {
      result.knowledge.push({
        characterName: match[1].trim(),
        factKey: match[2].trim(),
        factSummary: match[3].trim(),
        knowledgeState: 'known',
        confidence: 0.7,
        evidence: [evidenceFor(chapter, index, index + match[0].length)],
      });
    }

    for (const { match, index } of matchAll(
      text,
      /\[状态:([^:\]\]]+):([^:\]\]]+):([^\]]+)\]/g,
    )) {
      result.states.push({
        characterName: match[1].trim(),
        location: match[2].trim(),
        physicalState: null,
        emotionalState: null,
        aliveState: 'alive',
        summary: match[3].trim(),
        confidence: 0.7,
        evidence: [evidenceFor(chapter, index, index + match[0].length)],
      });
    }

    for (const { match, index } of matchAll(
      text,
      /\[时间线:([^:\]\]]+):([^\]]+)\]/g,
    )) {
      result.timelineEvents.push({
        eventKey: match[1].trim(),
        title: match[2].trim(),
        summary: '',
        eventType: 'event',
        timeDescription: '',
        location: '',
        characterNames: [],
        importance: 1,
        confidence: 0.7,
        evidence: [evidenceFor(chapter, index, index + match[0].length)],
      });
    }

    // Fallback: 「张三说」 style — never invents names past chapter text.
    for (const { match, index } of matchAll(
      text,
      /([\u4e00-\u9fff]{2,4})(?:说道|说|道)[：:]/g,
    )) {
      const name = match[1];
      if (seenChars.has(name)) continue;
      // Skip common false positives.
      if (/^(但是|于是|然后|因此|如果|虽然|因为|所以)$/.test(name)) continue;
      seenChars.add(name);
      result.characters.push({
        canonicalName: name,
        aliases: [],
        description: `在「${chapter.title}」中发言`,
        importance: 'supporting',
        confidence: 0.55,
        evidence: [evidenceFor(chapter, index, index + name.length)],
      });
    }
  }

  return result;
}
