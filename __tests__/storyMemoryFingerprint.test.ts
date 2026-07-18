import {
  canonicalStringify,
  fingerprintChapterSource,
  fingerprintStoryMemoryState,
  stableTextFingerprint,
} from '../src/services/storyMemory/storyMemoryFingerprint';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';

describe('story memory fingerprints', () => {
  it('is stable and detects equal-length content changes', () => {
    expect(stableTextFingerprint('甲乙丙丁')).toBe(
      stableTextFingerprint('甲乙丙丁'),
    );
    expect(stableTextFingerprint('甲乙丙丁')).not.toBe(
      stableTextFingerprint('甲乙丙戊'),
    );
    expect(
      fingerprintChapterSource({ title: '章', synopsis: '', content: '甲' }),
    ).not.toBe(
      fingerprintChapterSource({ title: '章', synopsis: '', content: '乙' }),
    );
  });

  it('canonicalizes object keys and set-like arrays', () => {
    expect(canonicalStringify({ b: 1, aliases: ['乙', '甲', '甲'], a: 2 })).toBe(
      canonicalStringify({ a: 2, aliases: ['甲', '乙'], b: 1 }),
    );
  });

  it('excludes volatile metadata from state fingerprints', () => {
    const first = createEmptyStoryMemory(7);
    const second = {
      ...first,
      metadata: { ...first.metadata, updatedAt: '2099-01-01', lastError: 'x' },
    };
    expect(fingerprintStoryMemoryState(first)).toBe(
      fingerprintStoryMemoryState(second),
    );
  });
});
