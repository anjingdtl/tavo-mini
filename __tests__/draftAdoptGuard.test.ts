import { canStartAdopt } from '../src/utils/draftAdoptGuard';

describe('canStartAdopt', () => {
  it('returns true when no adopt in flight', () => {
    expect(canStartAdopt(null, 1)).toBe(true);
  });

  it('returns false when same draft is being adopted', () => {
    expect(canStartAdopt(1, 1)).toBe(false);
  });

  it('returns false when another draft is being adopted', () => {
    expect(canStartAdopt(1, 2)).toBe(false);
  });

  it('treats 0 as no adopt in flight', () => {
    expect(canStartAdopt(0, 1)).toBe(true);
  });
});
