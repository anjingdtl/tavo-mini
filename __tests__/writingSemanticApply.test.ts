import { buildFallbackArchitecture, buildFallbackAuditContract, hashArchitectureEnvelope, hashAuditEnvelope } from '../src/services/continuation/generation/continuationV5Contracts';
import { validateFinalArtifact } from '../src/services/continuation/generation/finalArtifactValidator';

const revisionContent =
  '夜色压在城墙上，雨水沿着残破的砖缝缓慢滑落。他推开门，冷风扑面，远处脚步声一声接一声逼近。林砚握紧刀柄，先确认身后的退路，又看向街角那盏忽明忽暗的灯。他知道来者已经发现了自己的踪迹，却没有立刻拔刀，而是等那道影子踏进积水里，才决定迎上去。';

function makeInput() {
  const architecture = buildFallbackArchitecture({ userInstruction: '推进冲突' });
  const architectureHash = hashArchitectureEnvelope(architecture);
  const fallbackAudit = buildFallbackAuditContract({
    draftArtifactHash: 'd'.repeat(64),
    revisionArtifactHash: 'r'.repeat(64),
    architectureHash,
    canonSnapshotId: 'canon_1',
    canonRevision: 1,
    inputRevisionHash: 'input_1',
    styleProfileHash: null,
    styleRendererVersion: null,
    lockedRules: ['保持人物选择连续'],
    hardCanonFacts: [],
  });
  const audit = {
    ...fallbackAudit,
    finalObligations: fallbackAudit.finalObligations.filter(
      item => item.obligationId === 'fallback_user_rule_1',
    ),
  };
  const auditContractHash = hashAuditEnvelope(audit);
  const snapshot = {
    settingsSnapshot: { values: { targetChapterChars: 1000 } },
    lengthPolicy: undefined,
  } as any;
  const base = {
    schemaVersion: 1 as const,
    revisionArtifactHash: 'r'.repeat(64),
    architectureHash,
    auditContractHash,
    appliedCanonRequirementIds: [] as string[],
    appliedStyleRequirementIds: [] as string[],
    usedArchitectSceneIds: [] as string[],
    restoredProtectedPassageIds: [] as string[],
    declaredNewCoreFacts: [] as string[],
    unappliedItems: [] as string[],
  };
  return { architecture, architectureHash, audit, auditContractHash, snapshot, base };
}

describe('REG-WRITING-SEMANTIC-APPLY-001', () => {
  test('blocks declared applied requirement when final body is semantically unchanged', () => {
    const input = makeInput();
    const result = validateFinalArtifact({
      envelope: {
        ...input.base,
        content: `${revisionContent}\n\u200b\u200b`,
        appliedObligationIds: ['fallback_user_rule_1'],
      },
      revisionContent,
      snapshot: input.snapshot,
      architecture: input.architecture,
      architectureHash: input.architectureHash,
      audit: input.audit,
      auditContractHash: input.auditContractHash,
      revisionArtifactHash: 'r'.repeat(64),
    });
    expect(result.passed).toBe(false);
    expect(result.blockingCodes).toContain('final_semantic_apply_failed');
  });

  test('allows an explicit valid no-op with a reason for every applied requirement', () => {
    const input = makeInput();
    const result = validateFinalArtifact({
      envelope: {
        ...input.base,
        content: revisionContent,
        appliedObligationIds: ['fallback_user_rule_1'],
        validNoOpRequirementIds: ['fallback_user_rule_1'],
        validNoOpReasons: {
          fallback_user_rule_1: '该要求已在 Revision 前正文中完整满足，无需改写。',
        },
      },
      revisionContent,
      snapshot: input.snapshot,
      architecture: input.architecture,
      architectureHash: input.architectureHash,
      audit: input.audit,
      auditContractHash: input.auditContractHash,
      revisionArtifactHash: 'r'.repeat(64),
    });
    expect(result.passed).toBe(true);
    expect(result.blockingCodes).not.toContain('final_semantic_apply_failed');
  });
});
