import {
  PERSISTED_PROJECT_MODES,
  PROJECT_MODE_LABELS,
  NEW_PROJECT_MODE_OPTIONS,
  normalizeProjectMode,
  isValidProjectMode,
} from '../src/services/continuation/projectMode';
import type { ProjectMode } from '../src/types/novel';

describe('continuation project-mode compatibility layer', () => {
  describe('PERSISTED_PROJECT_MODES', () => {
    it('keeps freeform for backward compatibility and adds continuation', () => {
      expect(PERSISTED_PROJECT_MODES).toEqual([
        'outline',
        'continuation',
        'freeform',
      ]);
    });
  });

  describe('PROJECT_MODE_LABELS (exhaustive map)', () => {
    it('labels every persisted mode — no UI may branch on mode === ...', () => {
      for (const mode of PERSISTED_PROJECT_MODES) {
        expect(typeof PROJECT_MODE_LABELS[mode]).toBe('string');
        expect(PROJECT_MODE_LABELS[mode].length).toBeGreaterThan(0);
      }
    });

    it('uses the agreed Chinese copy', () => {
      expect(PROJECT_MODE_LABELS.outline).toBe('大纲创作');
      expect(PROJECT_MODE_LABELS.continuation).toBe('原著续写');
      expect(PROJECT_MODE_LABELS.freeform).toBe('自由写作');
    });
  });

  describe('NEW_PROJECT_MODE_OPTIONS', () => {
    it('offers outline + continuation but NOT freeform', () => {
      const values = NEW_PROJECT_MODE_OPTIONS.map(o => o.value);
      expect(values).toEqual(['outline', 'continuation']);
      expect(values).not.toContain('freeform');
    });
  });

  describe('normalizeProjectMode', () => {
    it('returns the three whitelisted literals as-is', () => {
      expect(normalizeProjectMode('outline')).toBe('outline');
      expect(normalizeProjectMode('continuation')).toBe('continuation');
      expect(normalizeProjectMode('freeform')).toBe('freeform');
    });

    it('falls back to outline for legacy blank values (v1 packages)', () => {
      expect(normalizeProjectMode(undefined)).toBe('outline');
      expect(normalizeProjectMode(null)).toBe('outline');
      expect(normalizeProjectMode('')).toBe('outline');
    });

    it('honours an explicit defaultValue for blanks', () => {
      expect(normalizeProjectMode(undefined, 'freeform')).toBe('freeform');
      expect(normalizeProjectMode('', 'continuation')).toBe('continuation');
    });

    it('throws on unknown strings — never silently coerces', () => {
      expect(() => normalizeProjectMode('free_legacy')).toThrow(
        /不支持的项目模式/,
      );
      expect(() => normalizeProjectMode('unknown')).toThrow();
      expect(() => normalizeProjectMode(123 as unknown)).toThrow();
      expect(() => normalizeProjectMode({ x: 1 } as unknown)).toThrow();
    });

    it('result type-satisfies ProjectMode', () => {
      const mode: ProjectMode = normalizeProjectMode('continuation');
      expect(mode).toBe('continuation');
    });
  });

  describe('isValidProjectMode', () => {
    it('narrows only the three whitelisted literals', () => {
      expect(isValidProjectMode('outline')).toBe(true);
      expect(isValidProjectMode('continuation')).toBe(true);
      expect(isValidProjectMode('freeform')).toBe(true);
      expect(isValidProjectMode('free_legacy')).toBe(false);
      expect(isValidProjectMode('')).toBe(false);
      expect(isValidProjectMode(undefined)).toBe(false);
      expect(isValidProjectMode(null)).toBe(false);
      expect(isValidProjectMode(42)).toBe(false);
    });
  });
});
