import {
  buildWritingStagePolicy,
  resolveSharedStageSkip,
} from '../src/services/writing/contracts/writingPolicy';
import { buildWritingRequirements } from '../src/services/writing/contracts/writingRequirement';
import type { WritingRequest } from '../src/services/writing/contracts/writingSource';

function request(reviewMode: string, values: Record<string, unknown> = {}): WritingRequest {
  return {
    writingRunId: 'wr_policy',
    generationTraceId: 'gt_policy',
    projectId: 1,
    chapterId: 2,
    scenario: reviewMode === 'continuation-v5' ? 'continuation' : 'outline',
    instruction: {
      title: 't',
      synopsis: 's',
      userInstruction: 'u',
      currentContent: '',
      targetPosition: 1,
    },
    sourceBundle: { mandatory: [], preferred: [], optional: [] },
    model: {
      configId: 1,
      provider: 'openai_compatible',
      modelName: 'fixture',
      contextWindow: 8192,
      maxOutputTokens: 1024,
    },
    policy: {
      version: 1,
      reviewMode,
      strictness: 'fail-closed',
      values,
    },
  };
}

describe('Writing stage policy', () => {
  test('continuation policy skips factCheck with a formal rule', () => {
    const req = request('continuation-v5', { workflowVersion: 5 });
    const policy = buildWritingStagePolicy(req, buildWritingRequirements(req));
    expect(policy.outputContract).toBe('json_envelope');
    const skip = resolveSharedStageSkip(policy, 'factCheck');
    expect(skip.skip).toBe(true);
    if (skip.skip) {
      expect(skip.policyRuleId).toBe('policy.continuation.audit_covers_factcheck');
    }
    expect(resolveSharedStageSkip(policy, 'draft').skip).toBe(false);
  });

  test('outline policy skips audit with a formal rule', () => {
    const req = request('full');
    const policy = buildWritingStagePolicy(req, buildWritingRequirements(req));
    expect(policy.outputContract).toBe('prose');
    const skip = resolveSharedStageSkip(policy, 'audit');
    expect(skip.skip).toBe(true);
    if (skip.skip) {
      expect(skip.policyRuleId).toBe('policy.outline.review_covers_audit');
    }
  });
});
