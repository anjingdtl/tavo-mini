import {
  buildTextSourceSnapshot,
  decodeTextSourceBase64,
  parseConstructionTextSource,
} from '../src/services/construction/textSourceParser';

declare const Buffer: any;

describe('construction text source parser', () => {
  test('decodes UTF-8 BOM and preserves heading sections', () => {
    const base64 = Buffer.from('\uFEFF# 人物\n沈砚是机关师。\n\n第1章 雾港\n港口常年有雾。', 'utf8').toString('base64');
    const decoded = decodeTextSourceBase64(base64);
    const source = parseConstructionTextSource(decoded.text, '素材.txt', decoded.encoding);
    expect(decoded.encoding).toBe('utf-8');
    expect(source.sections).toHaveLength(2);
    expect(source.sections[0].title).toBe('人物');
    expect(source.sections[1].title).toContain('第1章');
  });

  test('decodes UTF-16LE and keeps user-selected source order stable', () => {
    const value = '# A\n第一段\n\n# B\n第二段';
    const base64 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')]).toString('base64');
    const decoded = decodeTextSourceBase64(base64);
    const source = parseConstructionTextSource(decoded.text, 'a.txt', decoded.encoding);
    const snapshot = buildTextSourceSnapshot(source, [source.sections[1].id]);
    expect(decoded.encoding).toBe('utf-16le');
    expect(snapshot).toContain('第二段');
    expect(snapshot).not.toContain('第一段');
  });

  test('splits untitled paragraphs and rejects an empty selection', () => {
    const source = parseConstructionTextSource('第一段。\n\n第二段。', '无标题.txt');
    expect(source.sections.length).toBeGreaterThan(0);
    expect(() => buildTextSourceSnapshot(source, [])).toThrow('至少选择一个');
  });
});
