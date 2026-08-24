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
});
