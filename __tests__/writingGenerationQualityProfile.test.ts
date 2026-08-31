/**
 * Phase 3 A1: user-facing generation quality is 极速 / 标准 / 质量.
 *
 * Internal execution stays WritingExecutionProfile + stageReasoning +
 * WritingStagePolicy. Quality does not add a Stage, Kernel, or Compiler.
 */
import {
  allowsFormatterCall,
  allowsPrimaryRetry,
  resolveExecutionProfileFromValues,
} from '../src/services/writing/contracts/executionProfile';
import {
  GENERATION_QUALITY_PROFILE_OPTIONS,
  deriveGenerationQualityProfile,
  mapGenerationQualityProfile,
  normalizeGenerationQualityProfile,
  resolveQualityProfileFromValues,
} from '../src/services/writing/contracts/generationQualityProfile';
import { buildWritingStagePolicy } from '../src/services/writing/contracts/writingPolicy';
import { COMPACT_WRITING_STAGE_DAG } from '../src/services/writing';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { resolvePipelineGenerationQualityProfile } from '../src/services/pipeline/outlineStageRuntime';
import {
  continuationRequest,
  outlineRequest,
} from './helpers/oneShotFixtures';

const REQUIREMENTS = {
  version: 1 as const,
  items: [],
  fingerprint: 'requirements-quality-profile',
};

describe('GenerationQualityProfile contract', () => {
  test('user-facing options are exactly 极速 / 标准 / 质量', () => {
    expect(GENERATION_QUALITY_PROFILE_OPTIONS.map(item => item.value)).toEqual([
      'fast',
      'standard',
      'quality',
    ]);
    expect(GENERATION_QUALITY_PROFILE_OPTIONS.map(item => item.label)).toEqual([
      '极速',
      '标准',
      '质量',
    ]);
  });

  test('maps onto existing execution profile and reasoning without new stages', () => {
    expect(mapGenerationQualityProfile('fast')).toEqual({
      executionProfile: 'one_shot',
      reasoningEffort: 'low',
    });
    expect(mapGenerationQualityProfile('standard')).toEqual({
      executionProfile: 'standard',
      reasoningEffort: 'high',
    });
    expect(mapGenerationQualityProfile('quality')).toEqual({
      executionProfile: 'standard',
      reasoningEffort: 'max',
    });
    expect(normalizeGenerationQualityProfile('nope')).toBe('standard');
    expect(
      deriveGenerationQualityProfile({ executionProfile: 'one_shot' }),
    ).toBe('fast');
    expect(
      deriveGenerationQualityProfile({
        executionProfile: 'standard',
        reasoningEffort: 'max',
      }),
    ).toBe('quality');
    expect(
      deriveGenerationQualityProfile({
        executionProfile: 'standard',
        reasoningEffort: 'high',
      }),
    ).toBe('standard');
  });

  test('batch-frozen tier/profile overrides a stale live quality setting', () => {
    expect(
      resolvePipelineGenerationQualityProfile({
        liveQualityProfile: 'fast',
        selectedExecutionProfile: 'standard',
        selectedReasoningEffort: 'high',
        hasFrozenProfileOverride: true,
      }),
    ).toBe('standard');
    expect(
      resolvePipelineGenerationQualityProfile({
        liveQualityProfile: 'fast',
        selectedExecutionProfile: 'standard',
        selectedReasoningEffort: 'max',
        hasFrozenProfileOverride: true,
      }),
    ).toBe('quality');
    expect(
      resolvePipelineGenerationQualityProfile({
        liveQualityProfile: 'quality',
        selectedExecutionProfile: 'one_shot',
        selectedReasoningEffort: 'low',
        hasFrozenProfileOverride: true,
      }),
    ).toBe('fast');
    expect(
      resolvePipelineGenerationQualityProfile({
        liveQualityProfile: 'quality',
        selectedExecutionProfile: 'standard',
        selectedReasoningEffort: 'high',
        hasFrozenProfileOverride: false,
      }),
    ).toBe('quality');
  });

  test('Freeze fast inherits One-Shot: 1 paid call, no formatter, no primary retry', () => {
    const freeze = buildWritingKernelFreezeTrace({
      request: outlineRequest({
        pipelineTopologyVersion: 'compact_standard',
        qualityProfile: 'fast',
      }),
    });
    const values = freeze.frozenContext.stagePolicy.values;
    expect(resolveQualityProfileFromValues(values)).toBe('fast');
    expect(resolveExecutionProfileFromValues(values)).toBe('one_shot');
    expect(allowsFormatterCall(freeze.frozenContext.stagePolicy)).toBe(false);
    expect(allowsPrimaryRetry(freeze.frozenContext.stagePolicy)).toBe(false);
    expect(freeze.frozenContext.stagePolicy.skipRules.qa).toBeTruthy();
    expect(freeze.frozenContext.stagePolicy.skipRules.revision).toBeTruthy();
    expect(freeze.frozenContext.sourceBundle.preferred.map(s => s.kind)).toEqual(
      expect.arrayContaining(['writer_style', 'story_memory']),
    );
  });

  test('Freeze standard and quality keep Compact Standard DAG and do not add stages', () => {
    for (const qualityProfile of ['standard', 'quality'] as const) {
      const freeze = buildWritingKernelFreezeTrace({
        request: continuationRequest({
          pipelineTopologyVersion: 'compact_standard',
          qualityProfile,
        }),
      });
      expect(
        resolveQualityProfileFromValues(freeze.frozenContext.stagePolicy.values),
      ).toBe(qualityProfile);
      expect(
        resolveExecutionProfileFromValues(
          freeze.frozenContext.stagePolicy.values,
        ),
      ).toBe('standard');
      expect(COMPACT_WRITING_STAGE_DAG.map(node => node.stage)).toEqual([
        'draft',
        'qa',
        'revision',
        'finalValidate',
        'persist',
      ]);
      expect(freeze.frozenContext.stagePolicy.skipRules.qa).toBeFalsy();
      expect(
        freeze.frozenContext.sourceBundle.mandatory.map(s => s.kind),
      ).toEqual(
        expect.arrayContaining(['canon', 'source_boundary', 'seam']),
      );
    }
    expect(COMPACT_WRITING_STAGE_DAG).toHaveLength(5);
  });

  test('historical freeze without qualityProfile stays byte-identical', () => {
    const historical = buildWritingStagePolicy(
      outlineRequest({}),
      REQUIREMENTS,
    );
    expect(historical.values).not.toHaveProperty('qualityProfile');
    expect(historical.values).not.toHaveProperty('executionProfile');
    const oneShot = buildWritingStagePolicy(
      outlineRequest({ executionProfile: 'one_shot' }),
      REQUIREMENTS,
    );
    expect(oneShot.values).not.toHaveProperty('qualityProfile');
    expect(resolveExecutionProfileFromValues(oneShot.values)).toBe('one_shot');
  });

  test('explicit qualityProfile governs paid LLM stage reasoning over a stale 4-tier snapshot', () => {
    // Residual per-stage reasoning from the retired 极速/低/中/高 UI. A
    // quality-profile task must never inherit draft=max from it.
    const stale = {
      draft: { stage: 'draft', thinking: 'enabled', effectiveTier: 'max', effort: 'max' },
      review: { stage: 'review', thinking: 'enabled', effectiveTier: 'max', effort: 'max' },
      factCheck: { stage: 'factCheck', thinking: 'enabled', effectiveTier: 'low', effort: 'low' },
      brief: { stage: 'brief', thinking: 'enabled', effectiveTier: 'high', effort: 'high' },
      proof: { stage: 'proof', thinking: 'enabled', effectiveTier: 'max', effort: 'max' },
    } as any;

    // standard → the frozen mapping says high, the stale snapshot must not win.
    const standard = buildWritingStagePolicy(
      outlineRequest({
        qualityProfile: 'standard',
        executionProfile: 'standard',
        outlineStageReasoning: stale,
      }),
      REQUIREMENTS,
    );
    const standardReasoning = standard.values.stageReasoning as Record<
      string,
      { reasoningEffort?: string; thinking: { type: string } }
    >;
    expect(standardReasoning.draft.reasoningEffort).toBe('high');
    // Current unified semantics: Review follows the user tier; FactCheck and
    // the compact QA stage stay low — the quality mapping only leaves
    // factCheck/audit pinned.
    expect(standardReasoning.review.reasoningEffort).toBe('high');
    expect(standardReasoning.factCheck.reasoningEffort).toBe('low');
    expect(standardReasoning.review.thinking.type).toBe('enabled');

    // quality → max
    const quality = buildWritingStagePolicy(
      outlineRequest({
        qualityProfile: 'quality',
        executionProfile: 'standard',
        outlineStageReasoning: stale,
      }),
      REQUIREMENTS,
    );
    expect(
      (quality.values.stageReasoning as Record<string, { reasoningEffort?: string }>)
        .draft.reasoningEffort,
    ).toBe('max');

    // fast → low and inherits One-Shot
    const fast = buildWritingStagePolicy(
      outlineRequest({
        qualityProfile: 'fast',
        executionProfile: 'standard',
        outlineStageReasoning: stale,
      }),
      REQUIREMENTS,
    );
    expect(
      (fast.values.stageReasoning as Record<string, { reasoningEffort?: string }>)
        .draft.reasoningEffort,
    ).toBe('low');
    expect(resolveExecutionProfileFromValues(fast.values)).toBe('one_shot');

    // Historical run WITHOUT the quality key keeps the frozen 4-tier result
    // (draft=max), preserving frozen Resume semantics byte-for-byte.
    const historical = buildWritingStagePolicy(
      outlineRequest({
        executionProfile: 'standard',
        reasoningEffort: 'max',
        outlineStageReasoning: stale,
      }),
      REQUIREMENTS,
    );
    expect(
      (historical.values.stageReasoning as Record<string, { reasoningEffort?: string }>)
        .draft.reasoningEffort,
    ).toBe('max');
  });
});
