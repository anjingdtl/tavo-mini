/* eslint-env jest */

import {
  countProjectBodyChars,
  formatProjectWritingStats,
} from '../src/services/projectWritingStats';

describe('project writing stats contract', () => {
  test('counts non-whitespace Unicode code points, not UTF-16 units', () => {
    expect(countProjectBodyChars('  第一章\n😀\tA  第二章  ')).toBe(8);
  });

  test('uses the single card display format for exact materialized stats', () => {
    expect(
      formatProjectWritingStats({ chapterCount: 63, bodyCharCount: 248000 }),
    ).toBe('63 章 · 24.8 万字');
    expect(
      formatProjectWritingStats({ chapterCount: 0, bodyCharCount: 0 }),
    ).toBe('0 章 · 0 字');
  });
});
