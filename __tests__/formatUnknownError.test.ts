import { formatUnknownError } from '../src/services/continuation/canon/canonAnalysisService';

describe('formatUnknownError', () => {
  it('reads Error.message', () => {
    expect(formatUnknownError(new Error('boom'))).toBe('boom');
  });

  it('reads plain object message from sqlite-style rejects', () => {
    expect(formatUnknownError({ message: 'UNIQUE constraint failed', code: 6 })).toBe(
      'UNIQUE constraint failed (code=6)',
    );
  });

  it('does not return [object Object]', () => {
    const msg = formatUnknownError({ foo: 1, bar: 'x' });
    expect(msg).not.toContain('[object Object]');
    expect(msg).toContain('foo');
  });

  it('passes through strings', () => {
    expect(formatUnknownError('plain')).toBe('plain');
  });
});
