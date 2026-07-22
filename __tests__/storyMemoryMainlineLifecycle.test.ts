import {
  createEmptyChapterMemoryPatch,
  createEmptyStoryMemory,
} from '../src/services/storyMemory/storyMemoryDefaults';
import { applyStoryMemoryPatch } from '../src/services/storyMemory/storyMemoryMerger';

const baseContext = {
  projectId: 7,
  sourceFingerprint: 'mainline-source',
  now: '2026-07-22T00:00:00.000Z',
};

describe('story memory mainline lifecycle', () => {
  it('replaces an arc, clears an objective, and resolves an active conflict', () => {
    const opening = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '暗门开启',
    });
    opening.mainlinePatch.currentArcUpdate = {
      action: 'start',
      arcRef: '',
      name: '钟楼调查',
      summary: '林岚开始调查钟楼暗门。',
      evidenceQuote: '林岚决定查清钟楼暗门的来历',
    };
    opening.mainlinePatch.currentObjective = {
      value: '找到进入地下档案室的钥匙',
      evidenceQuote: '林岚要先找到进入地下档案室的钥匙',
    };
    opening.mainlinePatch.conflictUpserts.push({
      ref: 'new_conflict_guard',
      title: '守卫阻拦进入档案室',
      description: '守卫封锁钟楼地下入口',
      state: '僵持',
      stakes: '无法取得失踪档案',
      parties: [],
      evidenceQuote: '守卫挡在地下入口前',
    });
    opening.mainlinePatch.foreshadowingUpserts.push({
      ref: 'new_foreshadow_key',
      title: '',
      setup: '银钥匙刻着陌生家徽',
      expectedPayoff: '揭示家徽主人',
      status: 'open',
      evidenceQuote: '银钥匙上刻着陌生的家徽',
    });

    const first = applyStoryMemoryPatch(createEmptyStoryMemory(7), opening, {
      ...baseContext,
      chapterId: 1,
      chapterPosition: 0,
    });
    const oldArcId = first.state.mainline.currentArc!.id;
    const conflictId = Object.keys(first.state.mainline.activeConflicts)[0];
    const foreshadowId = Object.keys(first.state.mainline.foreshadowing)[0];

    const transition = createEmptyChapterMemoryPatch({
      chapterId: 2,
      chapterPosition: 1,
      title: '档案室入口',
    });
    transition.mainlinePatch.currentArcUpdate = {
      action: 'replace',
      arcRef: oldArcId,
      name: '档案室真相',
      summary: '林岚进入档案室追查失踪档案。',
      evidenceQuote: '林岚推开入口进入地下档案室',
    };
    transition.mainlinePatch.currentObjective = {
      value: '',
      evidenceQuote: '钥匙已经打开地下档案室的门',
    };
    transition.mainlinePatch.conflictResolutions.push({
      conflictRef: conflictId,
      resolution: '守卫确认密令后放行。',
      evidenceQuote: '守卫确认密令后让开了道路',
    });
    transition.mainlinePatch.foreshadowingUpserts.push({
      ref: foreshadowId,
      title: '',
      setup: '银钥匙刻着陌生家徽',
      expectedPayoff: '揭示家徽主人',
      status: 'paid',
      evidenceQuote: '档案证明家徽属于林岚的父亲',
    });

    const result = applyStoryMemoryPatch(first.state, transition, {
      ...baseContext,
      chapterId: 2,
      chapterPosition: 1,
      sourceFingerprint: 'mainline-source-2',
    });

    expect(result.state.mainline.currentArc).toEqual(
      expect.objectContaining({ name: '档案室真相' }),
    );
    expect(result.state.mainline.currentArc?.id).not.toBe(oldArcId);
    expect(result.state.mainline.currentObjective).toBe('');
    expect(result.state.mainline.activeConflicts[conflictId]).toBeUndefined();
    expect(result.state.mainline.recentCompletedBeats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: oldArcId }),
        expect.objectContaining({
          summary: expect.stringContaining('守卫阻拦'),
        }),
      ]),
    );
    expect(result.state.mainline.foreshadowing[foreshadowId].status).toBe(
      'paid',
    );
  });
});
