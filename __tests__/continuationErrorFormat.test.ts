import {
  formatUnknownError,
  formatUnknownErrorCode,
} from '../src/services/continuation/generation/errorFormat';
import { withDistinctArtifactBody } from '../src/services/continuation/generation/generationRepository';

describe('continuation error formatting', () => {
  test('plain native objects do not become [object Object]', () => {
    expect(formatUnknownError({ message: 'database is locked', code: 5 })).toBe(
      'database is locked (code=5)',
    );
    expect(formatUnknownError({ code: 0 })).not.toBe('[object Object]');
    expect(formatUnknownError(new Error('boom'))).toBe('boom');
    expect(formatUnknownErrorCode({ code: 0 }, 'stage_failed')).toBe(
      'stage_failed',
    );
    expect(formatUnknownErrorCode({ code: 'final_x' }, 'stage_failed')).toBe(
      'final_x',
    );
  });

  test('distinct artifact body changes hash without altering readable han', () => {
    const body = '完整章节正文若干汉字。';
    const a = withDistinctArtifactBody(body, '1');
    const b = withDistinctArtifactBody(body, '2');
    expect(a).not.toBe(body);
    expect(b).not.toBe(a);
    expect(a.startsWith(body)).toBe(true);
  });
});
