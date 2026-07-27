/**
 * Future leakage is a Phase 2 release blocker (Spec §17.3).
 *
 * Fixture: chapters 1–20 in-boundary; 21–30 contain identity reveal.
 * Custom mid-chapter boundary also tested.
 */
import { extractChapterDeterministic } from '../src/services/continuation/canon/deterministicExtractor';
import { validateEvidenceRange } from '../src/services/continuation/canon/canonEvidenceService';
import { asSourcePosition, asUtf16Offset } from '../src/services/continuation/continuationSourceRepository';
import type { BoundedSourceChapter } from '../src/services/continuation/types';

function chapter(
  position: number,
  title: string,
  content: string,
  start: number,
): BoundedSourceChapter {
  return {
    id: position + 1,
    sourceId: 1,
    position: asSourcePosition(position),
    title,
    content,
    range: {
      start: asUtf16Offset(start),
      end: asUtf16Offset(start + content.length),
    },
    clippedByBoundary: false,
  };
}

describe('Canon future leakage zero-tolerance (Spec §17.3)', () => {
  const inBoundary: BoundedSourceChapter[] = [];
  let offset = 0;
  for (let i = 0; i < 20; i++) {
    const content =
      i === 0
        ? '第一章 [角色:林凡][世界规则:灵气复苏|天地灵气回归][剧情:少年崛起]林凡说道：我要变强。'
        : i === 10
          ? `第${i + 1}章 [角色:苏晴][关系:林凡->苏晴:同门][经历:林凡:初入宗门] 日常修炼。`
          : `第${i + 1}章 日常修炼与试炼，无重大秘密。`;
    inBoundary.push(chapter(i, `第${i + 1}章`, content, offset));
    offset += content.length + 1;
  }

  const futureSecret =
    '[角色:真正身份是魔帝转世][世界规则:禁术真相|只有魔帝知道]林凡其实是魔帝转世！';
  const futureChapters: BoundedSourceChapter[] = [];
  for (let i = 20; i < 30; i++) {
    const content = `第${i + 1}章 ${futureSecret}`;
    futureChapters.push(chapter(i, `第${i + 1}章`, content, offset));
    offset += content.length + 1;
  }

  const boundaryExclusive = inBoundary[inBoundary.length - 1].range.end;

  it('deterministic extraction on bounded chapters never sees future secrets', () => {
    const result = extractChapterDeterministic(inBoundary);
    const blob = JSON.stringify(result);
    expect(blob).not.toContain('魔帝转世');
    expect(blob).not.toContain('禁术真相');
    expect(result.characters.some(c => c.canonicalName === '林凡')).toBe(true);
    expect(result.worldRules.some(r => r.title === '灵气复苏')).toBe(true);
  });

  it('evidence from future chapters is rejected by boundary validator', () => {
    const future = futureChapters[0];
    const r = validateEvidenceRange(
      {
        chapterId: future.id,
        chapterPosition: future.position,
        charStart: future.range.start,
        charEnd: future.range.end,
        quotePreview: futureSecret.slice(0, 40),
      },
      boundaryExclusive,
    );
    expect(r.ok).toBe(false);
  });

  it('mid-chapter boundary: second-half secret is not extractable from clipped content', () => {
    const full =
      '前半段日常修炼。[角色:林凡]||||后半段秘密：[角色:真正身份是魔帝转世]魔帝苏醒。';
    const cut = full.indexOf('||||');
    const clipped = full.slice(0, cut);
    const midChapter = chapter(19, '第二十章', clipped, 5000);
    midChapter.clippedByBoundary = true;

    const result = extractChapterDeterministic([midChapter]);
    const blob = JSON.stringify(result);
    expect(blob).not.toContain('魔帝转世');
    expect(blob).not.toContain('魔帝苏醒');
    expect(result.characters.some(c => c.canonicalName === '林凡')).toBe(true);

    // Even if a malicious extractor produced future offsets, validator blocks them.
    const secretStart = 5000 + full.indexOf('魔帝转世');
    const rejected = validateEvidenceRange(
      {
        chapterId: 20,
        chapterPosition: 19,
        charStart: secretStart,
        charEnd: secretStart + 4,
        quotePreview: '魔帝转世',
      },
      5000 + cut,
    );
    expect(rejected.ok).toBe(false);
  });

  it('extractor that only receives future chapters can find secrets — proving isolation is at boundary, not model', () => {
    // Documents that the safety boundary is SourceReader clipping, not the extractor.
    const leak = extractChapterDeterministic(futureChapters);
    expect(JSON.stringify(leak)).toContain('魔帝');
  });
});
