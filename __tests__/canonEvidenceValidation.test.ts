import { validateEvidenceRange } from '../src/services/continuation/canon/canonEvidenceService';

describe('Canon evidence validation (Spec §8.6, §17.3)', () => {
  const boundary = 1000;

  it('accepts ranges fully before boundary', () => {
    expect(
      validateEvidenceRange(
        {
          chapterId: 1,
          chapterPosition: 0,
          charStart: 10,
          charEnd: 20,
          quotePreview: 'quote',
        },
        boundary,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects future leakage past exclusive boundary', () => {
    const r = validateEvidenceRange(
      {
        chapterId: 21,
        chapterPosition: 20,
        charStart: 990,
        charEnd: 1001,
        quotePreview: 'secret',
      },
      boundary,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/未来|边界/);
  });

  it('rejects start at or past boundary', () => {
    const r = validateEvidenceRange(
      {
        chapterId: 21,
        chapterPosition: 20,
        charStart: 1000,
        charEnd: 1010,
        quotePreview: 'x',
      },
      boundary,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects inverted ranges', () => {
    const r = validateEvidenceRange(
      {
        chapterId: 1,
        chapterPosition: 0,
        charStart: 50,
        charEnd: 40,
        quotePreview: 'x',
      },
      boundary,
    );
    expect(r.ok).toBe(false);
  });
});
