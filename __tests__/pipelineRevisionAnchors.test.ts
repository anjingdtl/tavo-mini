/**
 * Pipeline revision anchors — canonical draft / hash / anchors / tagged
 * rendering (V5-Lite Phase 1). Determinism + edge cases (§18.3).
 */
import {
  buildRevisionAnchors,
  buildTaggedDraft,
  canonicalizeDraft,
  computeDraftHash,
  findAnchorById,
  serializeAnchors,
  MAX_ANCHOR_TEXT_LENGTH,
} from '../src/services/pipeline/revisionAnchors';

describe('canonicalizeDraft', () => {
  test('CRLF → LF', () => {
    expect(canonicalizeDraft('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  test('lone CR → LF', () => {
    expect(canonicalizeDraft('a\rb\rc')).toBe('a\nb\nc');
  });

  test('mixed CRLF and CR both normalize', () => {
    expect(canonicalizeDraft('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  test('no Unicode normalization and no body mutation', () => {
    const input = '中文「引号」\n\n😀 表情 😀';
    expect(canonicalizeDraft(input)).toBe(input);
  });
});

describe('computeDraftHash', () => {
  test('same canonical text → same hash', () => {
    expect(computeDraftHash('hello')).toBe(computeDraftHash('hello'));
  });

  test('CRLF vs LF normalize to the same hash', () => {
    expect(computeDraftHash(canonicalizeDraft('a\r\nb'))).toBe(
      computeDraftHash('a\nb'),
    );
  });

  test('different text → different hash', () => {
    expect(computeDraftHash('a')).not.toBe(computeDraftHash('b'));
  });
});

describe('buildRevisionAnchors', () => {
  test('splits paragraphs on blank lines with stable ids', () => {
    const anchors = buildRevisionAnchors('第一段。\n\n第二段！');
    expect(anchors).toHaveLength(2);
    expect(anchors[0].id).toBe('draft-p-001');
    expect(anchors[1].id).toBe('draft-p-002');
    expect(anchors[0].text).toBe('第一段。');
    expect(anchors[1].text).toBe('第二段！');
  });

  test('offsets cover the paragraph only (separators excluded)', () => {
    const draft = 'AAA\n\nBBB';
    const anchors = buildRevisionAnchors(draft);
    expect(anchors[0]).toMatchObject({ start: 0, end: 3, text: 'AAA' });
    expect(anchors[1]).toMatchObject({ start: 5, end: 8, text: 'BBB' });
    expect(anchors[1].text).toBe(draft.substring(5, 8));
  });

  test('duplicated paragraphs get distinct ids', () => {
    const anchors = buildRevisionAnchors('相同\n\n相同');
    expect(anchors[0].id).toBe('draft-p-001');
    expect(anchors[1].id).toBe('draft-p-002');
  });

  test('blank / whitespace-only paragraphs are skipped, offsets preserved', () => {
    const anchors = buildRevisionAnchors('AAA\n\n   \n\nBBB');
    expect(anchors).toHaveLength(2);
    expect(anchors[0].text).toBe('AAA');
    expect(anchors[1].text).toBe('BBB');
    // "AAA\n\n   \n\n" = 3+1+1+3+1+1 = 10 chars → BBB starts at 10
    expect(anchors[1].start).toBe(10);
  });

  test('single newline stays INSIDE the natural paragraph (A\\nB)', () => {
    const draft = 'A\nB\n\nC';
    const anchors = buildRevisionAnchors(draft);
    expect(anchors).toHaveLength(2);
    // "A\nB" is ONE natural paragraph (single newline is not a separator).
    expect(anchors[0].id).toBe('draft-p-001');
    expect(anchors[0].text).toBe('A\nB');
    expect(anchors[0].start).toBe(0);
    expect(anchors[0].end).toBe(3);
    expect(anchors[1].id).toBe('draft-p-002');
    expect(anchors[1].text).toBe('C');
    expect(anchors[1].start).toBe(5);
    expect(anchors[1].end).toBe(6);
    // Offsets always reconstruct the original characters.
    for (const a of anchors) {
      expect(draft.substring(a.start, a.end)).toBe(a.text);
    }
  });

  test('multiple blank lines still split exactly one paragraph boundary', () => {
    const draft = '第一段\n第二行\n\n\n\n第三段';
    const anchors = buildRevisionAnchors(draft);
    expect(anchors).toHaveLength(2);
    expect(anchors[0].text).toBe('第一段\n第二行');
    expect(anchors[1].text).toBe('第三段');
  });

  test('tagged draft keeps single-newline paragraphs intact', () => {
    const { taggedText, anchors } = buildTaggedDraft('A\nB\n\nC');
    expect(anchors).toHaveLength(2);
    expect(taggedText).toContain('[draft-p-001]\nA\nB');
    expect(taggedText).toContain('[draft-p-002]\nC');
    // canonical body chars are never mutated by tagging.
    const bodyOnly = taggedText
      .replace(/\[draft-p-\d{3}(?:-s-\d{3})?\]/g, '')
      .split('\n')
      .filter(l => l.trim().length > 0)
      .join('\n');
    expect(bodyOnly).toBe('A\nB\nC');
  });

  test('identical canonical drafts produce identical anchors', () => {
    const draft = '甲\n\n乙。\n\n丙！';
    const a = buildRevisionAnchors(draft);
    const b = buildRevisionAnchors(draft);
    expect(a).toEqual(b);
    expect(serializeAnchors(a)).toBe(serializeAnchors(b));
  });

  test('empty draft → no anchors', () => {
    expect(buildRevisionAnchors('')).toEqual([]);
  });

  test('lone-surrogate content does not break offsets', () => {
    const draft = 'a\ud83d\ude00\n\nb';
    const anchors = buildRevisionAnchors(draft);
    expect(anchors).toHaveLength(2);
    expect(anchors[0].end - anchors[0].start).toBe(anchors[0].text.length);
  });
});

describe('over-length paragraphs', () => {
  test('long paragraph splits into segments at sentence boundaries', () => {
    const sentence = '这是很长的一句话。'.repeat(200); // 800 chars
    const anchors = buildRevisionAnchors(sentence, 300);
    expect(anchors.length).toBeGreaterThan(1);
    for (const a of anchors) {
      expect(a.text.length).toBeLessThanOrEqual(300 + 1);
      expect(a.id).toMatch(/^draft-p-001-s-\d{3}$/);
    }
    // Concatenated segments rebuild the original paragraph (no loss).
    const rebuilt = anchors.map(a => a.text).join('');
    expect(rebuilt).toBe(sentence);
  });

  test('segment ids increment deterministically', () => {
    const anchors = buildRevisionAnchors('字'.repeat(MAX_ANCHOR_TEXT_LENGTH * 3 + 10));
    expect(anchors[0].id).toBe('draft-p-001-s-001');
    expect(anchors[1].id).toBe('draft-p-001-s-002');
    expect(anchors[2].id).toBe('draft-p-001-s-003');
  });

  test('ordinary paragraph after a split keeps a plain id', () => {
    const draft = `${'啊'.repeat(2000)}\n\n第二段`;
    const anchors = buildRevisionAnchors(draft);
    const last = anchors[anchors.length - 1];
    expect(last.id).toBe('draft-p-002');
    expect(last.text).toBe('第二段');
  });

  test('single anchor when text is at the limit', () => {
    const text = 'x'.repeat(MAX_ANCHOR_TEXT_LENGTH);
    const anchors = buildRevisionAnchors(text);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].text.length).toBe(MAX_ANCHOR_TEXT_LENGTH);
  });
});

describe('buildTaggedDraft', () => {
  test('renders each paragraph exactly once with its marker', () => {
    const draft = '第一段\n\n第二段';
    const { taggedText, anchors } = buildTaggedDraft(draft);
    expect(anchors).toHaveLength(2);
    expect(taggedText).toContain('[draft-p-001]\n第一段');
    expect(taggedText).toContain('[draft-p-002]\n第二段');
    // Body text appears exactly once.
    expect(taggedText.split('第一段')).toHaveLength(2);
  });

  test('blank paragraphs omitted from tagged rendering', () => {
    const { taggedText } = buildTaggedDraft('A\n\n\n\nB');
    expect(taggedText).not.toContain('[]');
  });

  test('tagged text equals anchor marker + text lines', () => {
    const { taggedText } = buildTaggedDraft('你好。\n\n世界！');
    expect(taggedText).toBe('[draft-p-001]\n你好。\n\n[draft-p-002]\n世界！');
  });
});

describe('findAnchorById', () => {
  const anchors = buildRevisionAnchors('a\n\nb');

  test('found by id', () => {
    expect(findAnchorById(anchors, 'draft-p-001')?.text).toBe('a');
  });

  test('unknown id → undefined', () => {
    expect(findAnchorById(anchors, 'draft-p-999')).toBeUndefined();
  });

  test('null / empty → undefined', () => {
    expect(findAnchorById(anchors, undefined)).toBeUndefined();
    expect(findAnchorById(anchors, '')).toBeUndefined();
  });
});
