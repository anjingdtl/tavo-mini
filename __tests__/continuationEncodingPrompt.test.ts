import { shouldConfirmEncoding } from '../src/screens/continuation/ContinuationSourceChaptersScreen';

describe('continuation import encoding confirmation', () => {
  it('keeps manual encoding recovery for a single TXT', () => {
    expect(shouldConfirmEncoding(1)).toBe(true);
  });

  it('never asks users to choose encodings for a multi-TXT import', () => {
    expect(shouldConfirmEncoding(2)).toBe(false);
    expect(shouldConfirmEncoding(10)).toBe(false);
  });
});
