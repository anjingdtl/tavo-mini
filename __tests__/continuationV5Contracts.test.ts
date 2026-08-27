import {
  CONTINUATION_V5_LENGTH_POLICY,
  buildFallbackArchitecture,
  buildFallbackAuditContract,
  hashArchitectureEnvelope,
  hashAuditEnvelope,
  parseContinuationV5ArchitectureEnvelope,
  parseContinuationV5AuditEnvelope,
  parseContinuationV5DraftEnvelope,
  parseContinuationV5FinalEnvelope,
  parseContinuationV5RevisionEnvelope,
  resolveV5LengthTargets,
} from '../src/services/continuation/generation/continuationV5Contracts';
import { validateFinalArtifact } from '../src/services/continuation/generation/finalArtifactValidator';
import type { ContinuationContextSnapshotV5 } from '../src/services/continuation/generation/types';
import { CONTINUATION_V5_MAX_PHYSICAL_REQUESTS } from '../src/services/continuation/generation/types';

describe('Continuation V5 contracts', () => {
  test('workflowVersion 5 constants and length policy', () => {
    expect(CONTINUATION_V5_MAX_PHYSICAL_REQUESTS).toBe(5);
    expect(CONTINUATION_V5_LENGTH_POLICY.preferredMinRatio).toBe(0.9);
    expect(CONTINUATION_V5_LENGTH_POLICY.preferredMaxRatio).toBe(1.1);
    expect(CONTINUATION_V5_LENGTH_POLICY.severeUnderRatio).toBe(0.65);
    expect(CONTINUATION_V5_LENGTH_POLICY.outputHeadroomRatio).toBe(2.4);
    const t = resolveV5LengthTargets(3000);
    expect(t.preferredMinHan).toBe(2700);
    expect(t.preferredMaxHan).toBe(3300);
    expect(t.severeUnderHan).toBe(1950);
  });

  test('Draft envelope requires complete content; patch fields are rejected', () => {
    const draft = parseContinuationV5DraftEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        plan: {
          chapterGoal: '推进冲突',
          centralConflict: '门外有追兵',
          beats: [{ id: 'b1', summary: '承接', stateChange: '局面初变' }],
        },
        content: '完整的 V1 初稿正文，包含行动与后果。',
      }),
    );
    expect(draft.content).toContain('完整的 V1');
    expect(draft.plan.beats[0].stateChange).toBe('局面初变');
    expect(() =>
      parseContinuationV5DraftEnvelope(
        JSON.stringify({
          schemaVersion: 1,
          content: '完整的 V1 初稿正文，包含行动与后果，不是局部补丁。',
          patches: [{ start: 0, end: 1, replacement: 'x' }],
        }),
        {},
      ),
    ).toThrow(/局部修改字段/);
  });

  test('Architecture scene units and client hash', () => {
    const arch = parseContinuationV5ArchitectureEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        chapterGoal: '推进',
        centralConflict: '冲突',
        sceneUnits: [
          {
            sceneId: 's1',
            entryState: '门口',
            characterAction: '推门',
            resistance: '门锁住了',
            turningPoint: '决定撬锁',
            consequence: '警报响起',
          },
        ],
        endingState: '章末',
        forbiddenPaddingPatterns: ['重复心理'],
      }),
    );
    expect(arch.sceneUnits).toHaveLength(1);
    const hash = hashArchitectureEnvelope(arch);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashArchitectureEnvelope(arch)).toBe(hash);
  });

  test('Revision/Final hash binding rejects mismatched hashes', () => {
    const draftHash = 'a'.repeat(64);
    const archHash = 'b'.repeat(64);
    const rev = parseContinuationV5RevisionEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        draftArtifactHash: draftHash,
        architectureHash: archHash,
        content: '完整 V2 正文，事件链已展开。',
        usedArchitectSceneIds: ['s1'],
        omittedArchitectSceneIds: [],
        declaredNewCoreFacts: [],
      }),
      { draftArtifactHash: draftHash, architectureHash: archHash },
    );
    expect(rev.content).toContain('V2');
    expect(() =>
      parseContinuationV5RevisionEnvelope(
        JSON.stringify({
          schemaVersion: 1,
          draftArtifactHash: 'wrong',
          architectureHash: archHash,
          content: '完整 V2 正文，hash 错误必须阻断。',
        }),
        { draftArtifactHash: draftHash, architectureHash: archHash },
      ),
    ).toThrow(/revision_writer_hash_mismatch/);

    const auditHash = 'c'.repeat(64);
    const finalEnv = parseContinuationV5FinalEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        revisionArtifactHash: draftHash,
        architectureHash: archHash,
        auditContractHash: auditHash,
        content: '完整 V3 最终章节正文。',
        appliedObligationIds: ['o1'],
        appliedCanonRequirementIds: [],
        appliedStyleRequirementIds: [],
        usedArchitectSceneIds: ['s1'],
        restoredProtectedPassageIds: [],
        declaredNewCoreFacts: [],
        unappliedItems: [],
      }),
      {
        revisionArtifactHash: draftHash,
        architectureHash: archHash,
        auditContractHash: auditHash,
      },
    );
    expect(finalEnv.content).toContain('V3');
    expect(() =>
      parseContinuationV5FinalEnvelope(
        JSON.stringify({
          schemaVersion: 1,
          revisionArtifactHash: 'nope',
          architectureHash: 'nope',
          auditContractHash: 'nope',
          content: '完整 V3 最终章节正文，绑定错误必须阻断。',
        }),
        {
          revisionArtifactHash: draftHash,
          architectureHash: archHash,
          auditContractHash: auditHash,
        },
      ),
    ).toThrow(/final_revision_hash_mismatch/);
  });

  test('Auditor binding rejects mismatched ids', () => {
    const expected = {
      draftArtifactHash: 'd'.repeat(64),
      revisionArtifactHash: 'r'.repeat(64),
      architectureHash: 'e'.repeat(64),
      canonSnapshotId: 'cs_1',
      canonRevision: 2,
      inputRevisionHash: 'ir_1',
      styleProfileHash: 'sp_1',
      styleRendererVersion: '1.0',
    };
    expect(() =>
      parseContinuationV5AuditEnvelope(
        JSON.stringify({
          schemaVersion: 1,
          draftArtifactHash: 'wrong',
          revisionArtifactHash: 'wrong',
          architectureHash: expected.architectureHash,
          canonSnapshotId: expected.canonSnapshotId,
          canonRevision: expected.canonRevision,
          inputRevisionHash: expected.inputRevisionHash,
          styleProfileHash: expected.styleProfileHash,
          styleRendererVersion: expected.styleRendererVersion,
          canonAudit: {
            requiredCorrections: [],
            protectedFacts: [],
            forbiddenFacts: [],
          },
          styleAudit: {
            requiredCorrections: [],
            protectedPassages: [],
            forbiddenExpansionPatterns: [],
          },
          architectureAudit: { safeSceneIds: [], rejectedScenes: [] },
          finalObligations: [],
        }),
        expected,
      ),
    ).toThrow(/adversarial_audit_binding_failed/);

    const fallback = buildFallbackAuditContract({
      ...expected,
      lockedRules: ['不得提前揭秘'],
      hardCanonFacts: ['主角不能飞'],
    });
    expect(fallback.architectureAudit.safeSceneIds).toEqual([]);
    expect(fallback.finalObligations.some(o => o.source === 'user_rule')).toBe(
      true,
    );
    expect(hashAuditEnvelope(fallback)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('Auditor resolves style tasks from client-owned V2 anchor ids', () => {
    const expected = {
      draftArtifactHash: 'd'.repeat(64),
      revisionArtifactHash: 'r'.repeat(64),
      architectureHash: 'a'.repeat(64),
      canonSnapshotId: 'cs',
      canonRevision: 1,
      inputRevisionHash: 'ir',
      styleProfileHash: null,
      styleRendererVersion: null,
      revisionAnchors: [
        { anchorId: 'v2-p-007', start: 40, end: 48, text: '真实 V2 片段。' },
      ],
    };
    const audit = parseContinuationV5AuditEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        ...expected,
        canonAudit: {
          requiredCorrections: [],
          protectedFacts: [],
          forbiddenFacts: [],
        },
        styleAudit: {
          requiredCorrections: [
            {
              requirementId: 'style_1',
              anchorId: 'v2-p-007',
              generatedExcerpt: '模型自行转述，必须不用它。',
              dimension: 'sentence_rhythm',
              severity: 'warning',
              description: '节奏过平',
              rewriteGoal: '整体改写为短促动作段',
              preserveMeaning: ['保留事件'],
            },
            {
              requirementId: 'style_2',
              anchorId: 'v2-p-missing',
              dimension: 'narrative_voice',
              severity: 'warning',
            },
          ],
          protectedPassages: [],
          forbiddenExpansionPatterns: [],
        },
        architectureAudit: { safeSceneIds: [], rejectedScenes: [] },
        finalObligations: [],
      }),
      expected,
      [],
    );
    expect(audit.styleAudit.requiredCorrections).toHaveLength(1);
    expect(audit.styleAudit.requiredCorrections[0]).toMatchObject({
      anchorId: 'v2-p-007',
      generatedStart: 40,
      generatedEnd: 48,
      generatedExcerpt: '真实 V2 片段。',
    });
  });

  test('Fallback architecture does not invent core facts', () => {
    const fb = buildFallbackArchitecture({
      userInstruction: '推进主线',
      draftPlan: {
        chapterGoal: 'g',
        centralConflict: 'c',
        beats: [{ id: 'b1', summary: '行动', stateChange: '变' }],
      },
      lockedRules: ['锁定规则'],
    });
    expect(fb.sceneUnits[0].forbiddenInventions.length).toBeGreaterThan(0);
    expect(fb.sceneUnits[0].sceneId.startsWith('fallback_')).toBe(true);
  });

  test('Draft envelope with empty content throws (no artifact should be created)', () => {
    // Regression: a parseable JSON with an empty body must NOT produce content.
    // The runner relies on this throw to avoid persisting a V1 artifact.
    const emptyContentJson = JSON.stringify({
      schemaVersion: 1,
      plan: {
        chapterGoal: '推进冲突',
        centralConflict: '门外有追兵',
        beats: [{ id: 'b1', summary: '承接', stateChange: '局面初变' }],
      },
      content: '',
    });
    expect(() =>
      parseContinuationV5DraftEnvelope(emptyContentJson),
    ).toThrow(/content 不能为空/);
    // whitespace-only content is equally invalid
    const whitespaceContentJson = JSON.stringify({
      schemaVersion: 1,
      content: '   \n\t  ',
    });
    expect(() =>
      parseContinuationV5DraftEnvelope(whitespaceContentJson),
    ).toThrow(/content 不能为空/);
    // plan-only body (no content key at all) is also rejected
    const planOnlyJson = JSON.stringify({
      schemaVersion: 1,
      plan: {
        chapterGoal: '推进冲突',
        centralConflict: '冲突',
        beats: [{ id: 'b1', summary: '承接' }],
      },
    });
    expect(() => parseContinuationV5DraftEnvelope(planOnlyJson)).toThrow(
      /content 不能为空/,
    );
  });

  test('Draft envelope with valid content still parses normally', () => {
    const validJson = JSON.stringify({
      schemaVersion: 1,
      plan: {
        chapterGoal: '推进',
        centralConflict: '冲突',
        beats: [{ id: 'b1', summary: '行动', stateChange: '变化' }],
      },
      content: '这是完整的正文，包含实际推进的事件与后果，足够长度。',
    });
    const draft = parseContinuationV5DraftEnvelope(validJson);
    expect(draft.content).toContain('完整的正文');
    expect(draft.plan.chapterGoal).toBe('推进');
    expect(draft.plan.beats).toHaveLength(1);
  });
});

describe('Final Artifact Validator', () => {
  function snapshot(): ContinuationContextSnapshotV5 {
    return {
      schemaVersion: 4,
      workflowVersion: 5,
      projectId: 1,
      targetChapterId: 2,
      targetPosition: 1 as any,
      source: {} as any,
      canon: {
        snapshotId: 'cs',
        revision: 1,
        boundaryGlobalCharOffset: 0,
        capabilities: {} as any,
      },
      storyMemory: {
        stateFingerprint: 's',
        throughPosition: -1,
        status: 'ready',
      },
      inputRevisionHash: 'ir',
      settingsSnapshot: {
        schemaVersion: 1,
        workflowVersion: 5,
        values: { targetChapterChars: 3000 } as any,
        resolvedModelConfigIds: {} as any,
      },
      bundles: {
        lockedRules: [],
        canon: {
          snapshot: {} as any,
          worldRules: [],
          characters: [],
          characterStates: [],
          relationships: [],
          experiences: [],
          knowledge: [],
          plotThreads: [],
          timelineEvents: [],
          evidenceRefs: [],
          estimatedTokens: 0,
          omittedReasonCounts: {},
        },
        effectiveState: {
          characterStates: [],
          relationships: [],
          plotThreads: [],
          knowledge: [],
          experiences: [],
          freshness: {
            canonReady: true,
            storyMemoryStatus: 'ready',
            pendingStateExtractionCount: 0,
            pendingMajorProposalCount: 0,
            dirtyFromPosition: null,
          },
          appliedEventIds: [],
          omittedReasons: [],
          schemaVersion: 1,
          targetPosition: 1 as any,
        },
        seam: { summary: '', excerpt: '' },
        recentChapters: [],
        storyMemory: { summary: '', estimatedTokens: 0 },
        episodic: [],
        style: null,
        userInstruction: '推进',
      },
      style: null,
      primaryAnchor: undefined,
      createdAt: '2026-08-04T00:00:00.000Z',
      budgetPolicy: {} as any,
      stageBudgets: {} as any,
      stageViews: {} as any,
      lengthPolicy: CONTINUATION_V5_LENGTH_POLICY,
    };
  }

  const architecture = buildFallbackArchitecture({
    userInstruction: '推进',
  });
  const architectureHash = hashArchitectureEnvelope(architecture);
  const audit = buildFallbackAuditContract({
    draftArtifactHash: 'd'.repeat(64),
    architectureHash,
    canonSnapshotId: 'cs',
    canonRevision: 1,
    inputRevisionHash: 'ir',
    styleProfileHash: null,
    styleRendererVersion: null,
    lockedRules: [],
    hardCanonFacts: [],
  });
  const auditHash = hashAuditEnvelope(audit);

  test('does not reject for short length; does not check minimal intervention', () => {
    const shortBody =
      '他推开门，冷风扑面。远处脚步声逼近，他握紧刀柄，决定迎上去，而不是退回阴影。'.repeat(
        3,
      );
    const result = validateFinalArtifact({
      envelope: {
        schemaVersion: 1,
        revisionArtifactHash: 'r'.repeat(64),
        architectureHash,
        auditContractHash: auditHash,
        content: shortBody,
        appliedObligationIds: audit.finalObligations.map(o => o.obligationId),
        appliedCanonRequirementIds: [],
        appliedStyleRequirementIds: [],
        usedArchitectSceneIds: [],
        restoredProtectedPassageIds: [],
        declaredNewCoreFacts: [],
        unappliedItems: [],
      },
      snapshot: snapshot(),
      architecture,
      architectureHash,
      audit,
      auditContractHash: auditHash,
      revisionArtifactHash: 'r'.repeat(64),
    });
    // Length is warning only — may pass if content is complete enough.
    expect(
      result.warnings.includes('final_severe_under_target') || result.passed,
    ).toBe(true);
    expect(result.blockingCodes).not.toContain('final_severe_under_target');
    expect(result.codes.join(',')).not.toMatch(
      /repair_candidate_unchanged|minimal|retention/,
    );
  });

  test('strict gates: quality issues block delivery', () => {
    const base = {
      schemaVersion: 1 as const,
      revisionArtifactHash: 'r'.repeat(64),
      architectureHash,
      auditContractHash: auditHash,
      appliedObligationIds: audit.finalObligations.map(o => o.obligationId),
      appliedCanonRequirementIds: [] as string[],
      appliedStyleRequirementIds: [] as string[],
      usedArchitectSceneIds: [] as string[],
      restoredProtectedPassageIds: [] as string[],
      declaredNewCoreFacts: [] as string[],
      unappliedItems: [] as string[],
    };
    const summary = validateFinalArtifact({
      envelope: {
        ...base,
        content: '本章主要讲述众人随后经过一番最终他们解决了问题。内容略。',
      },
      snapshot: snapshot(),
      architecture,
      architectureHash,
      audit,
      auditContractHash: auditHash,
      revisionArtifactHash: 'r'.repeat(64),
    });
    expect(summary.passed).toBe(false);
    expect(summary.blockingCodes).toContain('final_summary_output');

    const facts = validateFinalArtifact({
      envelope: {
        ...base,
        content:
          '他推开门。冷风灌进来。门外是追兵。他拔刀迎上，刀锋在灯火下闪了一下，随后真正交手。'.repeat(
            4,
          ),
        declaredNewCoreFacts: ['新出现的神器'],
        unappliedItems: ['obl_x'],
        usedArchitectSceneIds: ['unknown_rejected'],
      },
      snapshot: snapshot(),
      architecture,
      architectureHash,
      audit: {
        ...audit,
        architectureAudit: {
          safeSceneIds: [],
          rejectedScenes: [
            {
              sceneId: 'unknown_rejected',
              reasonCode: 'unsupported_core_fact',
              description: '拒',
              evidenceIds: [],
            },
          ],
        },
      },
      auditContractHash: auditHash,
      revisionArtifactHash: 'r'.repeat(64),
    });
    expect(facts.passed).toBe(false);
    expect(facts.blockingCodes).toEqual(
      expect.arrayContaining([
        'final_declared_new_core_fact',
        'final_unapplied_items',
        'final_rejected_architect_scene_used',
      ]),
    );
  });

  test('null envelope still fails; truncated alone without body is non-deliverable', () => {
    const result = validateFinalArtifact({
      envelope: null,
      finishReason: 'length',
      snapshot: snapshot(),
      architecture,
      architectureHash,
      audit,
      auditContractHash: auditHash,
      revisionArtifactHash: 'r'.repeat(64),
    });
    expect(result.passed).toBe(false);
    expect(result.blockingCodes).toContain('final_output_truncated');
  });
});
