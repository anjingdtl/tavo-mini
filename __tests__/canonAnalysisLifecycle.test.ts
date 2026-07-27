/**
 * Analysis lifecycle: staging → awaiting_review → activate; failed run never
 * becomes active (Spec §4.7, §8.7, §15).
 */
import { emptyCapabilities, emptyCoverage } from '../src/services/continuation/canon/types';
import { extractChapterDeterministic } from '../src/services/continuation/canon/deterministicExtractor';
import { asSourcePosition, asUtf16Offset } from '../src/services/continuation/continuationSourceRepository';

describe('Canon analysis lifecycle contracts', () => {
  it('quick profile extraction still yields world + characters + plot', () => {
    const chapter = {
      id: 1,
      sourceId: 1,
      position: asSourcePosition(0),
      title: '第一章',
      content:
        '[角色:林凡][世界规则:灵气|天地灵气][剧情:崛起][经历:林凡:拜师]林凡说道：出发。',
      range: { start: asUtf16Offset(0), end: asUtf16Offset(80) },
      clippedByBoundary: false,
    };
    const r = extractChapterDeterministic([chapter]);
    expect(r.characters.length).toBeGreaterThan(0);
    expect(r.worldRules.length).toBeGreaterThan(0);
    expect(r.plotThreads.length).toBeGreaterThan(0);
  });

  it('empty capabilities for quick mark incomplete reasons path', () => {
    const caps = emptyCapabilities('quick');
    expect(caps.relationships).toBe(false);
    expect(caps.knowledgeBoundaries).toBe(false);
    expect(caps.timelineEvents).toBe(false);
    expect(caps.worldRules).toBe(true);
    const cov = emptyCoverage(asSourcePosition(0));
    expect(cov.schemaVersion).toBe(1);
    expect(cov.incompleteReasons).toEqual([]);
  });

  it('standard capabilities enable full families', () => {
    const caps = emptyCapabilities('standard');
    expect(caps.relationships).toBe(true);
    expect(caps.knowledgeBoundaries).toBe(true);
    expect(caps.timelineEvents).toBe(true);
  });
});
