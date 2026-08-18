/**
 * Phase 1 ONE Memory hard gates.
 *
 * Production still has one Story Memory. Continuation Structured State is
 * runtime state with conflict-only confirmation. Canon stays fact authority.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  applyContinuityEventWithAuthority,
  classifyContinuityProposalCommit,
  CONTINUITY_AUTO_COMMIT_RULE_ID,
  CONTINUITY_CANON_CONFLICT_RULE_ID,
  evaluatePostWritingMemoryReady,
  FORBIDDEN_SECOND_LONG_TERM_MEMORY_FILES,
  MEMORY_AUTHORITY_ORDER,
  ONE_NARRATIVE_LONG_TERM_MEMORY_SYSTEM,
  resolveNarrativeFactConflict,
} from '../src/services/writing/memory';
import { autoCommitRoutineContinuityProposals } from '../src/services/writing/memory/continuityStateAutoCommit';
import { measureStructuralChapterObservability } from '../src/services/writing';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { outlineRequest } from './helpers/oneShotFixtures';

const ROOT = path.resolve(__dirname, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(ROOT, rel));
}

describe('ONE Memory authority', () => {
  test('rank is Canon > Boundary > Continuity State > Story Memory > Recent Prose', () => {
    expect(MEMORY_AUTHORITY_ORDER).toEqual([
      'canon',
      'frozen_source_boundary',
      'structured_continuity_state',
      'story_memory',
      'recent_prose',
    ]);
  });

  test('Story Memory vs Canon → Canon wins, no user confirmation', () => {
    const resolved = resolveNarrativeFactConflict({
      field: 'aliveState',
      left: { layer: 'story_memory', value: 'alive' },
      right: { layer: 'canon', value: 'dead' },
    });
    expect(resolved.winner).toBe('canon');
    expect(resolved.kind).toBe('story_memory_vs_canon');
    expect(resolved.requiresUserConfirmation).toBe(false);
    expect(resolved.winnerValue).toBe('dead');
  });

  test('Story Memory vs Continuity State → State wins, no user confirmation', () => {
    const resolved = resolveNarrativeFactConflict({
      field: 'location',
      left: { layer: 'story_memory', value: '旧城' },
      right: { layer: 'structured_continuity_state', value: '码头' },
    });
    expect(resolved.winner).toBe('structured_continuity_state');
    expect(resolved.kind).toBe('story_memory_vs_continuity_state');
    expect(resolved.requiresUserConfirmation).toBe(false);
  });

  test('Continuity State vs Canon hard fact → Conflict Gate', () => {
    const resolved = resolveNarrativeFactConflict({
      field: 'aliveState',
      left: { layer: 'structured_continuity_state', value: 'alive' },
      right: { layer: 'canon', value: 'dead' },
    });
    expect(resolved.winner).toBe('canon');
    expect(resolved.kind).toBe('continuity_state_vs_canon');
    expect(resolved.requiresUserConfirmation).toBe(true);
  });

  test('soft location overlay is not a Canon conflict gate', () => {
    const applied = applyContinuityEventWithAuthority({
      eventType: 'character_state',
      payload: { fields: { location: '夜雨码头', aliveState: 'alive' } },
      canonAliveState: 'alive',
    });
    expect(applied.requiresUserConfirmation).toBe(false);
    expect(applied.appliedFields.location).toBe('夜雨码头');
    expect(applied.appliedFields.aliveState).toBe('alive');
  });

  test('hard aliveState conflict is omitted from applied fields', () => {
    const applied = applyContinuityEventWithAuthority({
      eventType: 'character_state',
      payload: { fields: { location: '码头', aliveState: 'alive' } },
      canonAliveState: 'dead',
    });
    expect(applied.requiresUserConfirmation).toBe(true);
    expect(applied.omittedHardFields).toEqual(['aliveState']);
    expect(applied.appliedFields.aliveState).toBeUndefined();
    expect(applied.appliedFields.location).toBe('码头');
  });
});

describe('ONE Memory confirmation policy', () => {
  test('routine character_state auto-commits', () => {
    const decision = classifyContinuityProposalCommit({
      proposalType: 'character_state',
      payloadJson: JSON.stringify({
        summary: '林逸负伤',
        fields: { location: '码头', physicalState: '轻伤' },
      }),
    });
    expect(decision.action).toBe('auto_commit');
    expect(decision.reason).toBeNull();
    expect(decision.policyRuleId).toBe(CONTINUITY_AUTO_COMMIT_RULE_ID);
  });

  test('new_character without conflict auto-commits', () => {
    const decision = classifyContinuityProposalCommit({
      proposalType: 'new_character',
      payloadJson: JSON.stringify({ name: '阿九', summary: '新人物 阿九' }),
    });
    expect(decision.action).toBe('auto_commit');
  });

  test('Canon aliveState conflict requires confirmation', () => {
    const decision = classifyContinuityProposalCommit({
      proposalType: 'character_state',
      subjectRefType: 'canon_character',
      subjectRefId: '7',
      payloadJson: JSON.stringify({ fields: { aliveState: 'alive' } }),
      canonFacts: [{ characterId: 7, aliveState: 'dead' }],
    });
    expect(decision.action).toBe('require_user_confirmation');
    expect(decision.reason).toBe('canon_conflict');
    expect(decision.policyRuleId).toBe(CONTINUITY_CANON_CONFLICT_RULE_ID);
  });

  test('unmergeable and low-confidence later-plot stay behind the gate', () => {
    expect(
      classifyContinuityProposalCommit({
        proposalType: 'plot_advance',
        payloadJson: JSON.stringify({ summary: '主线分叉', unmergeable: true }),
      }),
    ).toMatchObject({
      action: 'require_user_confirmation',
      reason: 'unmergeable',
    });
    expect(
      classifyContinuityProposalCommit({
        proposalType: 'relationship_change',
        payloadJson: JSON.stringify({ summary: '反目', confidence: 0.2 }),
      }),
    ).toMatchObject({
      action: 'require_user_confirmation',
      reason: 'low_confidence_affects_later',
    });
  });

  test('low-confidence routine location still auto-commits', () => {
    const decision = classifyContinuityProposalCommit({
      proposalType: 'character_state',
      payloadJson: JSON.stringify({
        summary: '走到巷口',
        confidence: 0.2,
        fields: { location: '巷口' },
      }),
    });
    expect(decision.action).toBe('auto_commit');
  });

  test('auto-commit commits routine and leaves Canon conflict pending', async () => {
    const confirmProposal = jest.fn(async () => ({ eventId: 'ce_auto' }));
    const result = await autoCommitRoutineContinuityProposals({
      projectId: 1,
      confirmProposal,
      canonFacts: [{ characterId: 7, aliveState: 'dead' }],
      proposals: [
        {
          id: 'cp_ok',
          projectId: 1,
          chapterId: 10,
          sourceRunId: null,
          extractionContentHash: 'h',
          chapterRevisionHash: 'h',
          proposalType: 'character_state',
          subjectRefType: null,
          subjectRefId: null,
          payloadJson: JSON.stringify({ summary: '走到码头' }),
          proposalFingerprint: 'fp1',
          evidenceStart: 0,
          evidenceEnd: 4,
          status: 'pending',
          decisionNote: null,
          decidedAt: null,
          createdAt: 't',
          updatedAt: 't',
        },
        {
          id: 'cp_conflict',
          projectId: 1,
          chapterId: 10,
          sourceRunId: null,
          extractionContentHash: 'h',
          chapterRevisionHash: 'h',
          proposalType: 'character_state',
          subjectRefType: 'canon_character',
          subjectRefId: '7',
          payloadJson: JSON.stringify({ fields: { aliveState: 'alive' } }),
          proposalFingerprint: 'fp2',
          evidenceStart: 5,
          evidenceEnd: 9,
          status: 'pending',
          decisionNote: null,
          decidedAt: null,
          createdAt: 't',
          updatedAt: 't',
        },
      ],
    });
    expect(result.autoCommittedIds).toEqual(['cp_ok']);
    expect(result.confirmationRequired).toEqual([
      {
        proposalId: 'cp_conflict',
        reason: 'canon_conflict',
        policyRuleId: CONTINUITY_CANON_CONFLICT_RULE_ID,
      },
    ]);
    expect(confirmProposal).toHaveBeenCalledTimes(1);
    expect(confirmProposal).toHaveBeenCalledWith({
      proposalId: 'cp_ok',
      decisionNote: `auto_commit:${CONTINUITY_AUTO_COMMIT_RULE_ID}`,
    });
  });
});

describe('ONE Memory ready gate', () => {
  test('unfinished extract blocks next-chapter freeze', () => {
    const gate = evaluatePostWritingMemoryReady({
      pendingStateExtractionCount: 1,
      storyMemoryStatus: 'ready',
      pendingConfirmationCount: 0,
    });
    expect(gate.ready).toBe(false);
    expect(gate.nextChapterMayFreeze).toBe(false);
    expect(gate.status).toBe('waiting');
  });

  test('ordinary confirmation count of 0 is ready', () => {
    const gate = evaluatePostWritingMemoryReady({
      pendingStateExtractionCount: 0,
      storyMemoryStatus: 'ready',
      pendingConfirmationCount: 0,
    });
    expect(gate).toMatchObject({
      ready: true,
      status: 'ready',
      nextChapterMayFreeze: true,
    });
  });

  test('conflict-only pending does not pretend to be a normal barrier', () => {
    const gate = evaluatePostWritingMemoryReady({
      pendingStateExtractionCount: 0,
      storyMemoryStatus: 'ready',
      pendingConfirmationCount: 2,
    });
    expect(gate.ready).toBe(true);
    expect(gate.status).toBe('conflict_parked');
    expect(gate.nextChapterMayFreeze).toBe(true);
  });
});

describe('ONE Memory production call graph', () => {
  test('exactly one narrative long-term memory system: Story Memory', () => {
    expect(ONE_NARRATIVE_LONG_TERM_MEMORY_SYSTEM).toBe('story_memory');
    expect(exists('src/services/storyMemory/storyMemoryService.ts')).toBe(true);
    expect(exists('src/data/repositories/storyMemoryRepository.ts')).toBe(true);
    for (const file of FORBIDDEN_SECOND_LONG_TERM_MEMORY_FILES) {
      expect(exists(file)).toBe(false);
    }
  });

  test('Outline and Continuation both emit Story Memory as context candidates', () => {
    const outline = read('src/services/writing/scenario/outlineWritingAdapter.ts');
    const continuation = read(
      'src/services/writing/scenario/continuationWritingAdapter.ts',
    );
    expect(outline).toContain("'story_memory'");
    expect(continuation).toContain("'story_memory'");
    expect(continuation).toContain("'episodic_memory'");
  });

  test('Continuation retains Canon and Structured Continuity State, not a second LTM', () => {
    const collection = read(
      'src/services/writing/scenario/continuationSourceCollection.ts',
    );
    const state = read(
      'src/services/continuation/generation/continuationStateService.ts',
    );
    expect(collection).toContain('CanonQueryService');
    expect(collection).toContain('getEffectiveContinuationState');
    expect(state).toContain('applyContinuityEventWithAuthority');
    expect(state).not.toMatch(/class ContinuationLongTermMemory|createContinuationMemory\(/);
  });

  test('extract_state auto-commits through the ONE Memory policy', () => {
    const worker = read(
      'src/services/continuation/generation/continuationStateOutboxWorker.ts',
    );
    expect(worker).toContain('autoCommitRoutineContinuityProposals');
    const autoCommit = read(
      'src/services/writing/memory/continuityStateAutoCommit.ts',
    );
    expect(autoCommit).toContain('commitAcceptedProposal');
    expect(autoCommit).not.toContain('await import(');
    const repo = read(
      'src/services/continuation/generation/generationRepository.ts',
    );
    expect(repo).toMatch(
      /status = 'pending'[\s\S]*FROM continuation_state_proposals|FROM continuation_state_proposals[\s\S]*status = 'pending'/,
    );
    expect(repo).not.toMatch(
      /proposal_type IN \(\s*'relationship_change'/,
    );
  });

  test('review UI is conflict-only, not every-chapter confirmation', () => {
    const screen = read(
      'src/screens/continuation/ContinuationStateReviewScreen.tsx',
    );
    expect(screen).toMatch(/冲突|低置信|自动提交/);
    expect(screen).not.toMatch(/定稿章节会提取状态变化供你审核/);
    const home = read('src/screens/continuation/ContinuationHomeScreen.tsx');
    expect(home).toMatch(/冲突|低置信/);
  });

  test('One-Shot writing paid call stays 1 and is not a second memory path', () => {
    const freeze = buildWritingKernelFreezeTrace({
      request: outlineRequest({ executionProfile: 'one_shot' }),
    });
    const sample = measureStructuralChapterObservability({
      frozenContext: freeze.frozenContext,
      sampleKind: 'one_shot',
    });
    expect(sample.llm.chapterWritingPaidCallCount).toBe(1);
    expect(sample.llm.postWritingAuxiliaryCallCount).toBe(0);
  });
});
