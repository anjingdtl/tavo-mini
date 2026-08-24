/**
 * Phase 3 A Exact-HEAD baseline.
 *
 * Freezes current production contracts without changing production logic.
 * Structural samples: Outline / Continuation × 极速 / 当前平衡 / 当前质量 × 2 chapters.
 * These are Freeze + policy + DAG measurements, not live LLM calls.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import {
  allowsFormatterCall,
  allowsPrimaryRetry,
  resolveExecutionProfileFromValues,
} from '../src/services/writing/contracts/executionProfile';
import {
  COMPACT_WRITING_STAGE_DAG,
  listPaidStagesForPolicy,
  measureStructuralChapterObservability,
  resetWritingObservabilityForTests,
} from '../src/services/writing';
import {
  continuationRequest,
  outlineRequest,
} from './helpers/oneShotFixtures';

beforeEach(() => {
  resetWritingObservabilityForTests();
});

const COMPACT = { pipelineTopologyVersion: 'compact_standard' as const };

/** Current user-facing quality mapping at Exact HEAD (pre A1 rename). */
const QUALITY_TIERS = [
  {
    id: 'fast',
    label: '极速',
    executionProfile: 'one_shot' as const,
    reasoningEffort: 'low' as const,
  },
  {
    id: 'balanced',
    label: '当前平衡',
    executionProfile: 'standard' as const,
    reasoningEffort: 'high' as const,
  },
  {
    id: 'quality',
    label: '当前质量',
    executionProfile: 'standard' as const,
    reasoningEffort: 'max' as const,
  },
] as const;

function freezeSample(input: {
  scenario: 'outline' | 'continuation';
  qualityId: (typeof QUALITY_TIERS)[number]['id'];
  chapterIndex: 1 | 2;
}) {
  const tier = QUALITY_TIERS.find(item => item.id === input.qualityId)!;
  const values = {
    ...COMPACT,
    ...(tier.executionProfile === 'one_shot'
      ? { executionProfile: 'one_shot' as const }
      : {}),
  };
  const base =
    input.scenario === 'outline'
      ? outlineRequest(values)
      : continuationRequest(values);
  const request = {
    ...base,
    writingRunId: `wr-p3a-${input.scenario}-${tier.id}-${input.chapterIndex}`,
    generationTraceId: `gt-p3a-${input.scenario}-${tier.id}-${input.chapterIndex}`,
    chapterId: input.chapterIndex,
    model: {
      ...base.model,
      reasoningEffort: tier.reasoningEffort,
    },
  };
  const freeze = buildWritingKernelFreezeTrace({ request });
  const observability = measureStructuralChapterObservability({
    frozenContext: freeze.frozenContext,
    sampleKind:
      tier.executionProfile === 'one_shot'
        ? 'one_shot'
        : input.scenario === 'outline'
        ? 'outline_standard'
        : 'continuation_standard',
  });
  const paid = listPaidStagesForPolicy(freeze.frozenContext);
  const kinds = [
    ...freeze.frozenContext.sourceBundle.mandatory,
    ...freeze.frozenContext.sourceBundle.preferred,
    ...freeze.frozenContext.sourceBundle.optional,
  ].map(source => source.kind);
  return {
    scenario: input.scenario,
    qualityId: tier.id,
    qualityLabel: tier.label,
    chapterIndex: input.chapterIndex,
    generationTraceId: request.generationTraceId,
    freezeFingerprint: freeze.frozenContext.freezeFingerprint,
    executionProfile: resolveExecutionProfileFromValues(
      freeze.frozenContext.stagePolicy.values,
    ),
    requestedReasoningEffort: tier.reasoningEffort,
    frozenReasoningEffort: freeze.frozenContext.model.reasoningEffort ?? null,
    compactDag: COMPACT_WRITING_STAGE_DAG.map(node => node.stage),
    policyPaidStages: paid.executed,
    policySkippedStages: paid.skipped,
    observabilityPaidStages: observability.stages
      .filter(stage => stage.status !== 'skipped')
      .map(stage => stage.stage),
    chapterWritingPaidCallCount: observability.llm.chapterWritingPaidCallCount,
    physicalRequestCount: observability.llm.physicalRequestCount,
    formatterCallCount: observability.llm.formatterCallCount,
    allowFormatter: allowsFormatterCall(freeze.frozenContext.stagePolicy),
    allowPrimaryRetry: allowsPrimaryRetry(freeze.frozenContext.stagePolicy),
    skipRuleStages: Object.keys(freeze.frozenContext.stagePolicy.skipRules || {}),
    sourceKinds: [...new Set(kinds)].sort(),
    candidateTokens: observability.context.candidateTokens,
    allocatedTokens: observability.context.allocatedTokens,
    renderedTokens: observability.context.renderedTokens,
    frozenContextTokens: observability.context.frozenContextTokens,
    postWritingAuxiliaryCallCount:
      observability.llm.postWritingAuxiliaryCallCount,
    postWritingStateExtractionMs:
      observability.postWriting.stateExtractionMs,
    qaRevisionTrigger: 'conditional_on_executable_findings',
  };
}

describe('Phase 3 A Exact HEAD baseline', () => {
  test('Outline and Continuation freeze 极速 / 当前平衡 / 当前质量 × 2 chapters', () => {
    const samples = QUALITY_TIERS.flatMap(tier =>
      (['outline', 'continuation'] as const).flatMap(scenario =>
        ([1, 2] as const).map(chapterIndex =>
          freezeSample({ scenario, qualityId: tier.id, chapterIndex }),
        ),
      ),
    );
    expect(samples).toHaveLength(12);

    for (const sample of samples) {
      expect(sample.freezeFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(sample.chapterWritingPaidCallCount).toBeGreaterThan(0);
      expect(sample.frozenContextTokens).toBeGreaterThan(0);
      expect(sample.compactDag).toEqual([
        'draft',
        'qa',
        'revision',
        'finalValidate',
        'persist',
      ]);
      expect(sample.sourceKinds).toEqual(
        expect.arrayContaining(['writer_style', 'story_memory']),
      );
      if (sample.scenario === 'outline') {
        expect(sample.sourceKinds).toContain('outline');
      } else {
        expect(sample.sourceKinds).toEqual(
          expect.arrayContaining(['canon', 'source_boundary', 'seam']),
        );
      }
    }

    const fast = samples.filter(sample => sample.qualityId === 'fast');
    const balanced = samples.filter(sample => sample.qualityId === 'balanced');
    const quality = samples.filter(sample => sample.qualityId === 'quality');
    expect(fast).toHaveLength(4);
    expect(balanced).toHaveLength(4);
    expect(quality).toHaveLength(4);

    for (const sample of fast) {
      expect(sample.executionProfile).toBe('one_shot');
      expect(sample.chapterWritingPaidCallCount).toBe(1);
      expect(sample.physicalRequestCount).toBe(1);
      expect(sample.formatterCallCount).toBe(0);
      expect(sample.allowFormatter).toBe(false);
      expect(sample.allowPrimaryRetry).toBe(false);
      expect(sample.policyPaidStages).toEqual(['draft']);
      expect(sample.skipRuleStages).toEqual(
        expect.arrayContaining([
          'qa',
          'review',
          'audit',
          'factCheck',
          'revision',
          'proof',
        ]),
      );
      expect(
        sample.policySkippedStages.map(item => item.stage),
      ).toEqual(
        expect.arrayContaining(['review', 'audit', 'factCheck', 'revision', 'proof']),
      );
    }

    for (const sample of [...balanced, ...quality]) {
      expect(sample.executionProfile).toBe('standard');
      expect(sample.allowFormatter).toBe(true);
      expect(sample.allowPrimaryRetry).toBe(true);
      expect(sample.chapterWritingPaidCallCount).toBeGreaterThan(1);
      expect(sample.compactDag.slice(0, 3)).toEqual(['draft', 'qa', 'revision']);
    }

    const pairFingerprints = (qualityId: (typeof QUALITY_TIERS)[number]['id']) => {
      const outline = samples.filter(
        sample => sample.qualityId === qualityId && sample.scenario === 'outline',
      );
      expect(outline[0].freezeFingerprint).not.toBe(outline[1].freezeFingerprint);
    };
    pairFingerprints('fast');
    pairFingerprints('balanced');
    pairFingerprints('quality');

    const report = {
      exactHead: 'fc65973c09b682d2400ddb39768cad707a891cc4',
      version: '2.21.1',
      schemaVersion: 56,
      capturedAt: '2026-08-24',
      note:
        'Structural Freeze baseline at Exact HEAD. Physical LLM calls are policy-expected counts, not live HTTP. PostWriting State Extraction remains a post-Persist auxiliary call on the current ONE Flow and is not skipped by One-Shot.',
      compactStandardDag: COMPACT_WRITING_STAGE_DAG.map(node => node.stage),
      currentUserFacingTiers: QUALITY_TIERS.map(tier => ({
        id: tier.id,
        label: tier.label,
        executionProfile: tier.executionProfile,
        reasoningEffort: tier.reasoningEffort,
      })),
      samples,
    };
    const reportDir = path.join(__dirname, '..', 'test-logs');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, 'phase3-a-structural-baseline.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  });

  test('Exact HEAD still has ONE Kernel / Context / Prompt Compiler / QA / Memory', () => {
    const root = path.resolve(__dirname, '..');
    const forbidden = [
      'src/services/writing/stages/fastWriter.ts',
      'src/services/writing/stages/qualityWriterCore.ts',
      'src/services/writing/prompt/fastPromptCompiler.ts',
      'src/services/writing/prompt/qualityPromptCompiler.ts',
      'src/services/writing/context/secondFrozenContext.ts',
      'src/services/writing/memory/secondMemory.ts',
    ];
    for (const file of forbidden) {
      expect(fs.existsSync(path.join(root, file))).toBe(false);
    }
    expect(
      fs.existsSync(
        path.join(root, 'src/services/writing/unifiedWritingKernel.ts'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(root, 'src/services/writing/context/buildFrozenWritingContext.ts'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(root, 'src/services/writing/prompt/sharedPromptCompiler.ts'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(root, 'src/services/writing/stages/qa.ts')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(root, 'src/services/writing/memory/index.ts')),
    ).toBe(true);
  });
});
