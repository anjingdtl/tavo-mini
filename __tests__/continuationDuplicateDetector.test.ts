import {
  evaluateContinuationDuplicate,
  detectWholeArtifactDuplication,
} from '../src/services/continuation/generation/continuationDuplicateDetector';

const HAN_PARAGRAPH_A =
  '他推开门走进房间，窗外下着细雨，远处的灯光模糊不清。她坐在桌前翻阅一本旧书，听见脚步声抬起头来。';

const HAN_PARAGRAPH_B =
  '夜色渐深，两人相对无言，只有雨声敲打着屋檐。他开口想说什么，终究只是叹了口气。';

const HAN_PARAGRAPH_C =
  '第二天清晨阳光透过窗帘洒进房间，鸟鸣声取代了昨夜的雨声。她已不在，桌上留下一张字条。';

function repeat(text: string, times: number): string {
  let out = '';
  for (let i = 0; i < times; i += 1) out += text;
  return out;
}

describe('continuationDuplicateDetector', () => {
  describe('detectWholeArtifactDuplication', () => {
    it('blocks the exact real-world failure: candidate === writer + writer', () => {
      const writer = HAN_PARAGRAPH_A + HAN_PARAGRAPH_B;
      const candidate = writer + writer;
      expect(detectWholeArtifactDuplication(writer, candidate)).toBe(true);
    });

    it('blocks candidate doubled with whitespace glue between halves', () => {
      const writer = HAN_PARAGRAPH_A + HAN_PARAGRAPH_B;
      const candidate = `${writer}\n\n${writer}`;
      expect(detectWholeArtifactDuplication(writer, candidate)).toBe(true);
    });

    it('blocks candidate doubled with punctuation glue between halves', () => {
      const writer = HAN_PARAGRAPH_A + HAN_PARAGRAPH_B;
      const candidate = `${writer}——${writer}`;
      expect(detectWholeArtifactDuplication(writer, candidate)).toBe(true);
    });

    it('does not block a single coherent paragraph', () => {
      expect(
        detectWholeArtifactDuplication('', HAN_PARAGRAPH_A + HAN_PARAGRAPH_B),
      ).toBe(false);
    });

    it('does not block two distinct paragraphs concatenated', () => {
      const candidate = HAN_PARAGRAPH_A + HAN_PARAGRAPH_B;
      expect(detectWholeArtifactDuplication('', candidate)).toBe(false);
    });
  });

  describe('evaluateContinuationDuplicate', () => {
    it('blocks whole-artifact duplication (writer + writer)', () => {
      const writer = HAN_PARAGRAPH_A + HAN_PARAGRAPH_B;
      const candidate = writer + writer;
      const result = evaluateContinuationDuplicate({
        candidate,
        parent: writer,
      });
      expect(result.status).toBe('blocking');
      expect(result.wholeArtifactDuplication).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('blocks a long paragraph repeated three times in a row', () => {
      const candidate = repeat(HAN_PARAGRAPH_A + HAN_PARAGRAPH_B, 3);
      const result = evaluateContinuationDuplicate({ candidate });
      expect(result.status).toBe('blocking');
    });

    it('blocks two copies of the same paragraph separated only by punctuation', () => {
      const candidate = `${HAN_PARAGRAPH_A}${HAN_PARAGRAPH_B}\n。\n${HAN_PARAGRAPH_A}${HAN_PARAGRAPH_B}`;
      const result = evaluateContinuationDuplicate({ candidate });
      expect(result.status).toBe('blocking');
    });

    it('does not block normal rhetorical repetition of a short phrase', () => {
      // 短句复沓: a short phrase repeated for rhetorical effect inside an
      // otherwise advancing narrative. This must NOT be flagged.
      const candidate =
        '他走了，他走了，他终于走了。她望着空荡的房间，心中五味杂陈。窗外的雨还在下，仿佛永远不会停歇。夜深了，城市的灯火一盏接一盏熄灭，只剩下路灯孤零零地照着湿漉漉的街道。她翻开那本旧书，书页泛黄，字迹模糊，却依然能感受到当年的温度。那是他们共同读过的书，如今只剩她一个人翻阅。';
      const result = evaluateContinuationDuplicate({ candidate });
      expect(result.status).not.toBe('blocking');
    });

    it('blocks a revision that is an abnormal copy of the parent writer text', () => {
      const writer =
        HAN_PARAGRAPH_A +
        HAN_PARAGRAPH_B +
        HAN_PARAGRAPH_C +
        '他拿起字条，上面只有简单的几个字，却让他久久无法释怀。';
      // A "revision" that copies ≥80% of the parent verbatim with trivial edits.
      const candidate =
        writer.slice(0, Math.floor(writer.length * 0.9)) +
        '。';
      const result = evaluateContinuationDuplicate({
        candidate,
        parent: writer,
      });
      expect(result.highOverlapWithParent).toBe(true);
      expect(result.status).toBe('blocking');
    });

    it('does not block a substantive rewrite of the parent', () => {
      const writer =
        HAN_PARAGRAPH_A + HAN_PARAGRAPH_B + HAN_PARAGRAPH_C;
      // A genuinely different revision: same beats, rewritten prose.
      const candidate =
        '门被轻轻推开，他走进来的时候带着一身雨水。屋里很安静，她正低头看书，听到声响才抬起脸。两人对视片刻，谁都没有说话。窗外雨势未减，街灯的光被水雾晕开。他张了张嘴，最后只化作一声叹息。次日天晴，阳光照进屋子，她已不见踪影，桌上留着一张纸条。';
      const result = evaluateContinuationDuplicate({
        candidate,
        parent: writer,
      });
      expect(result.status).not.toBe('blocking');
    });

    it('returns within for a normal multi-paragraph chapter', () => {
      const candidate =
        HAN_PARAGRAPH_A +
        '\n\n' +
        HAN_PARAGRAPH_B +
        '\n\n' +
        HAN_PARAGRAPH_C +
        '\n\n他拿起那张字条，上面只写着简单的几个字，却让他久久无法释怀。';
      const result = evaluateContinuationDuplicate({ candidate });
      expect(result.status).toBe('within');
    });

    it('handles empty candidate without throwing', () => {
      const result = evaluateContinuationDuplicate({ candidate: '' });
      expect(result.status).toBe('within');
      expect(result.repeatedNgramRatio).toBe(0);
    });

    it('exposes numeric metrics for telemetry', () => {
      const writer = HAN_PARAGRAPH_A + HAN_PARAGRAPH_B;
      const candidate = writer + writer;
      const result = evaluateContinuationDuplicate({
        candidate,
        parent: writer,
      });
      expect(typeof result.repeatedNgramRatio).toBe('number');
      expect(typeof result.repeatedParagraphRatio).toBe('number');
      expect(typeof result.longestRepeatedHanSpan).toBe('number');
      expect(result.repeatedNgramRatio).toBeGreaterThan(0);
    });
  });
});
