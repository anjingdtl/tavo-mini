/* eslint-env jest */

import {
  isAutoResultJumpSuppressed,
  suppressAutoResultJumpForChapter,
} from '../src/navigation/chapterResultJumpSuppression';

describe('chapterResultJumpSuppression', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns false for unsuppressed chapters', () => {
    expect(isAutoResultJumpSuppressed(9224)).toBe(false);
  });

  test('suppresses within the TTL window', () => {
    suppressAutoResultJumpForChapter(9224, 60_000);
    expect(isAutoResultJumpSuppressed(9224)).toBe(true);
  });

  test('expires after the TTL window', () => {
    suppressAutoResultJumpForChapter(9224, 60_000);
    jest.advanceTimersByTime(60_001);
    expect(isAutoResultJumpSuppressed(9224)).toBe(false);
  });

  test('uses the default TTL when omitted', () => {
    suppressAutoResultJumpForChapter(7);
    jest.advanceTimersByTime(59_999);
    expect(isAutoResultJumpSuppressed(7)).toBe(true);
    jest.advanceTimersByTime(1);
    expect(isAutoResultJumpSuppressed(7)).toBe(false);
  });

  test('extending TTL keeps the chapter suppressed', () => {
    suppressAutoResultJumpForChapter(3, 10_000);
    jest.advanceTimersByTime(5_000);
    suppressAutoResultJumpForChapter(3, 10_000);
    jest.advanceTimersByTime(9_000);
    expect(isAutoResultJumpSuppressed(3)).toBe(true);
    jest.advanceTimersByTime(1_000);
    expect(isAutoResultJumpSuppressed(3)).toBe(false);
  });
});