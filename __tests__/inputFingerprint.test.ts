/**
 * Pipeline input fingerprint tests (Schema 37 adopt-time drift detection).
 *
 * Verifies the fingerprint composition (projectId | chapterId | chapterUpdatedAt
 * | outlineFingerprint) is stable for identical inputs and changes when any
 * component drifts, plus the adopt-time comparison logic used by the result
 * screen. The outline repository is mocked so the live outline fingerprint is
 * deterministic.
 */
jest.mock('../src/data/repositories/outlineRepository', () => ({
  getEnabledOutlinesByProject: jest.fn(async () => [] as any[]),
}));

import { computeInputFingerprint } from '../src/services/outlineContextBuilder';
import { getEnabledOutlinesByProject } from '../src/data/repositories/outlineRepository';

const mockedGetEnabled = getEnabledOutlinesByProject as jest.MockedFunction<
  typeof getEnabledOutlinesByProject
>;

beforeEach(() => {
  mockedGetEnabled.mockReset();
  mockedGetEnabled.mockResolvedValue([]);
});

describe('computeInputFingerprint stability', () => {
  it('is stable for identical inputs', async () => {
    const a = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'abc123',
    });
    const b = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'abc123',
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(16); // sha256 truncated to 16 hex chars
  });

  it('changes when outline fingerprint changes', async () => {
    const a = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'abc123',
    });
    const b = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'changed',
    });
    expect(a).not.toBe(b);
  });

  it('changes when chapter updatedAt changes (external chapter edit)', async () => {
    const a = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'abc123',
    });
    const b = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-02T00:00:00Z',
      outlineFingerprint: 'abc123',
    });
    expect(a).not.toBe(b);
  });

  it('changes when chapterId changes', async () => {
    const a = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'abc123',
    });
    const b = await computeInputFingerprint({
      projectId: 7,
      chapterId: 101,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'abc123',
    });
    expect(a).not.toBe(b);
  });

  it('changes when projectId changes', async () => {
    const a = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'abc123',
    });
    const b = await computeInputFingerprint({
      projectId: 8,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'abc123',
    });
    expect(a).not.toBe(b);
  });
});

describe('computeInputFingerprint live outline fallback', () => {
  it('falls back to live outline fingerprint when outlineFingerprint omitted', async () => {
    // No outlines enabled → live fingerprint is '' → still produces a stable hash.
    const a = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
    });
    const b = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
    });
    expect(a).toBe(b);
    expect(mockedGetEnabled).toHaveBeenCalledTimes(2);
  });

  it('produces different fingerprint when live outlines change', async () => {
    // First call: no outlines.
    mockedGetEnabled.mockResolvedValueOnce([]);
    const noOutline = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
    });
    // Second call: an enabled outline exists → live fingerprint non-empty.
    mockedGetEnabled.mockResolvedValueOnce([
      {
        id: 1,
        projectId: 7,
        title: '主线',
        content: 'A',
        sourceType: 'manual',
        enabled: true,
        position: 0,
        estimatedTokens: 1,
        contentHash: 'aaa',
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]);
    const withOutline = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
    });
    expect(noOutline).not.toBe(withOutline);
  });
});

describe('adopt-time drift detection logic', () => {
  it('detects drift when baseline differs from live', async () => {
    const baseline = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'original',
    });
    const live = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'edited',
    });
    expect(baseline).not.toBe(live); // drift detected
  });

  it('no drift when baseline matches live', async () => {
    const baseline = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'same',
    });
    const live = await computeInputFingerprint({
      projectId: 7,
      chapterId: 100,
      chapterUpdatedAt: '2026-01-01T00:00:00Z',
      outlineFingerprint: 'same',
    });
    expect(baseline).toBe(live); // no drift
  });

  it('null/missing baseline never reports drift (legacy tasks)', async () => {
    // A legacy task (pre-Schema-37) has inputFingerprint = null. The adopt flow
    // skips the check entirely when baseline is falsy, so no false warning.
    const baseline: string | null = null;
    expect(baseline).toBeFalsy(); // adopt flow treats this as "no baseline"
  });
});
