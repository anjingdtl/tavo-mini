import {
  classifyFinalReviserComplexity,
  resolveFinalReviserReasoning,
} from '../src/services/pipeline/finalReviserReasoningPolicy';
import type { PipelineRevisionContract } from '../src/types/pipelineRevision';

function contract(
  workItems: PipelineRevisionContract['workItems'] = [],
  outlineObligations: Partial<PipelineRevisionContract['outlineObligations']> = {},
): PipelineRevisionContract {
  return {
    schemaVersion: 1,
    compilerVersion: 1,
    draftHash: 'draft-hash',
    workItems,
    protectedAnchorIds: [],
    protectedFacts: [],
    hardConstraints: [],
    outlineObligations: {
      fulfilledBeats: [],
      missingBeats: [],
      mustPreserve: [],
      mustNotAdvance: [],
      ...outlineObligations,
    },
  };
}

function workItem(
  partial: Partial<PipelineRevisionContract['workItems'][number]> = {},
) {
  return {
    id: 'w1',
    scope: 'anchor' as const,
    dimension: 'literary',
    severity: 'warning' as const,
    diagnosis: '需要润色',
    rewriteGoal: '润色',
    preserveMeaning: [],
    ...partial,
  };
}

const deepSeekModel = {
  provider_type: 'openai_compatible' as const,
  model_name: 'deepseek-v4-flash',
  url: 'https://api.deepseek.com/v1/chat/completions',
};

describe('Final Reviser reasoning policy', () => {
  test('maps simple/complex/global contracts to low/high/max', () => {
    expect(classifyFinalReviserComplexity(contract())).toBe('simple');
    expect(
      classifyFinalReviserComplexity(
        contract([workItem({ scope: 'range' })], { missingBeats: ['beat-1'] }),
      ),
    ).toBe('complex');
    expect(
      classifyFinalReviserComplexity(
        contract([workItem({ scope: 'chapter' })]),
      ),
    ).toBe('global');

    expect(
      resolveFinalReviserReasoning({
        execution: {
          outlineWorkflowVersion: 2,
          finalReviserReasoningPolicyVersion: 2,
          reasoningEffort: 'low',
        },
        model: deepSeekModel,
        contract: contract(),
      }),
    ).toEqual(
      expect.objectContaining({
        supported: true,
        complexity: 'simple',
        effort: 'low',
        thinking: { type: 'enabled' },
      }),
    );
  });

  test('omits vendor reasoning fields for historical or unsupported tasks', () => {
    expect(
      resolveFinalReviserReasoning({
        execution: {
          outlineWorkflowVersion: 2,
          finalReviserReasoningPolicyVersion: 1,
          reasoningEffort: 'low',
        },
        model: deepSeekModel,
        contract: contract(),
      }),
    ).toEqual(
      expect.objectContaining({
        supported: false,
        complexity: 'legacy',
      }),
    );

    expect(
      resolveFinalReviserReasoning({
        execution: {
          outlineWorkflowVersion: 2,
          finalReviserReasoningPolicyVersion: 2,
          reasoningEffort: 'high',
        },
        model: {
          ...deepSeekModel,
          url: 'https://gateway.example.com/v1/chat/completions',
        },
        contract: contract(),
      }),
    ).toEqual(
      expect.objectContaining({
        supported: false,
        complexity: 'simple',
      }),
    );
  });
});
