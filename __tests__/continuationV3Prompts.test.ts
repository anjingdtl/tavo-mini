import {
  compileV3WriterMessages,
  compileV3CheckerMessages,
  compileIntegratedReviserMessages,
} from '../src/services/continuation/generation/continuationPromptCompiler';
import {
  resolveContinuationLengthContract,
} from '../src/services/continuation/generation/continuationLengthContract';

function snapshot(targetChapterChars: number): any {
  return {
    schemaVersion: 2,
    workflowVersion: 3,
    projectId: 1,
    targetChapterId: 10,
    targetPosition: 0,
    source: {
      sourceId: 1,
      sourceVersion: 1,
      boundary: { chapterId: 1, chapterPosition: 0, charOffsetExclusive: 100 },
    },
    canon: { snapshotId: 'snap', revision: 1, boundaryGlobalCharOffset: 100, capabilities: {} },
    storyMemory: { stateFingerprint: 'fp', throughPosition: -1, status: 'clean' },
    inputRevisionHash: 'h',
    settingsSnapshot: {
      schemaVersion: 1,
      workflowVersion: 3,
      values: {
        targetChapterChars,
        strictnessProfile: 'balanced',
        worldRuleLevel: 'strict',
        characterLevel: 'strict',
        relationshipLevel: 'strict',
        plotLevel: 'balanced',
        experienceLevel: 'strict',
        knowledgeLevel: 'strict',
        styleLevel: 'strict',
        allowNewCharacters: false,
        allowNewLocations: false,
        allowNewOrganizations: false,
        majorRelationshipChangePolicy: 'require_confirmation',
        majorPowerChangePolicy: 'require_confirmation',
        characterDeathPolicy: 'require_confirmation',
        resurrectionPolicy: 'forbid',
        plannerLlmConfigId: null,
        writerLlmConfigId: null,
        checkerLlmConfigId: null,
        repairLlmConfigId: null,
        stateExtractionLlmConfigId: null,
        plannerConfirmationPolicy: 'risk_only',
        checkerEnabled: true,
        maxRepairRounds: 1,
        customRulesJson: '[]',
        createdAt: '',
        updatedAt: '',
      },
      resolvedModelConfigIds: {
        planner: 1,
        writer: 1,
        checker: 1,
        repair: 1,
        stateExtraction: 1,
      },
      frozenModelConfigs: {
        planner: null,
        writer: null,
        checker: null,
        repair: null,
        stateExtraction: null,
      },
    },
    bundles: {
      lockedRules: [],
      canon: { evidenceRefs: [], worldRules: [], characters: [], characterStates: [], relationships: [], experiences: [], knowledge: [], plotThreads: [], timelineEvents: [] },
      effectiveState: { characterStates: [], relationships: [], plotThreads: [], knowledge: [], experiences: [], freshness: { canonReady: true, storyMemoryStatus: 'clean', pendingStateExtractionCount: 0, pendingMajorProposalCount: 0, dirtyFromPosition: null }, appliedEventIds: [], omittedReasons: [] },
      seam: { summary: '', excerpt: '' },
      recentChapters: [],
      storyMemory: { summary: '', estimatedTokens: 0 },
      episodic: [],
      style: null,
      userInstruction: '写一场紧张的对峙',
    },
    primaryAnchor: null,
    createdAt: '',
  };
}

describe('V3 prompts use frozen dynamic target (plan §8, §2.3)', () => {
  const targets = [200, 1000, 3000, 8000, 30000];

  for (const target of targets) {
    it(`V3 Writer prompt echoes target ${target} and its ±500 band`, () => {
      const contract = resolveContinuationLengthContract(target);
      const messages = compileV3WriterMessages(snapshot(target));
      const all = messages.map(m => m.content).join('\n');
      expect(all).toContain(`目标为 ${target} 个汉字`);
      expect(all).toContain(`${contract.minHanCharacters}–${contract.maxHanCharacters}`);
      expect(all).toContain(`等于 ${target}`);
      // No hardcoded 3000 leaking through when target differs
      if (target !== 3000) {
        expect(all).not.toMatch(/目标为 3000 个汉字/);
      }
    });

    it(`V3 Integrated Reviser prompt uses target ${target} band`, () => {
      const contract = resolveContinuationLengthContract(target);
      const snap = snapshot(target);
      const messages = compileIntegratedReviserMessages(
        snap,
        '短正文',
        [],
        {
          lengthStatus: 'under',
          actualHanCharacters: 100,
          duplicateStatus: 'within',
          hardBlockingSubtypes: [],
        },
      );
      const all = messages.map(m => m.content).join('\n');
      expect(all).toContain(`${contract.minHanCharacters}–${contract.maxHanCharacters}`);
      expect(all).toContain(`${target}`);
    });
  }

  it('V3 Checker prompt is phase-aware (initial vs final)', () => {
    const snap = snapshot(3000);
    const initial = compileV3CheckerMessages(snap, '正文', 'initial');
    const final = compileV3CheckerMessages(snap, '正文', 'final');
    const initialText = initial.map(m => m.content).join('\n');
    const finalText = final.map(m => m.content).join('\n');
    expect(initialText).toContain('初检');
    expect(initialText).toContain('Integrated Reviser');
    expect(finalText).toContain('终检');
    expect(finalText).toContain('修订后的最终候选');
  });

  it('V3 prompts instruct schemaVersion=2 for Writer and schemaVersion=1 for Reviser', () => {
    const snap = snapshot(3000);
    const writer = compileV3WriterMessages(snap).map(m => m.content).join('\n');
    expect(writer).toMatch(/schemaVersion.*2/);
    const reviser = compileIntegratedReviserMessages(
      snap,
      '正文',
      [],
      { lengthStatus: 'within', actualHanCharacters: 3000, duplicateStatus: 'within', hardBlockingSubtypes: [] },
    ).map(m => m.content).join('\n');
    expect(reviser).toContain('"schemaVersion":1');
    expect(reviser).toContain('完整修订章节正文');
  });
});
