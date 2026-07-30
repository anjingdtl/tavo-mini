/**
 * The legacy two-argument activation API has no style profile to validate.
 * It must fail closed instead of activating Canon without original style.
 */
import { activateSnapshot } from '../src/services/continuation/canon/canonAnalysisService';

describe('activateSnapshot legacy API', () => {
  it('rejects activation without the required original-style profile', async () => {
    await expect(activateSnapshot(1, 'snap-1')).rejects.toThrow('原著风格画像');
  });
});
