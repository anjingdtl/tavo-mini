import {
  buildBriefCompilerMessages,
  calculateBriefBudget,
  compileBriefStageRequest,
} from '../src/services/pipeline/compileBriefStageRequest';
import {
  allocateOutlinePipelineBudgetV3,
  resolveElasticStageOutputReservation,
} from '../src/services/contextAutoAllocator';
import {
  DEFAULT_BRIEF_TRIGGER_POLICY,
  type BriefCompilerInputV1,
} from '../src/services/pipeline/briefCompilerTypes';
import { shouldCallBriefCompiler } from '../src/services/pipeline/briefTriggerPolicy';
import { compileDeterministicBrief } from '../src/services/pipeline/deterministicBriefCompiler';
import { renderFinalWritingBrief } from '../src/services/pipeline/renderFinalWritingBrief';
import { validateFinalWritingBrief } from '../src/services/pipeline/briefResultValidator';
import { resolveV3StageReasoning } from '../src/services/pipeline/reasoningPolicy';
import { compileFinalReviserV3StageRequest } from '../src/services/pipeline/compileStageRequest';
import { buildFinalContinuityCapsule } from '../src/types/pipelineContext';
import { validateFinalBriefCompliance } from '../src/services/pipeline/finalBriefComplianceValidator';

function input(
  overrides?: Partial<BriefCompilerInputV1>,
): BriefCompilerInputV1 {
  return {
    schemaVersion: 1,
    sourceHash: 'source-hash',
    workflowMode: 'full',
    review: {
      executableCorrections: [
        {
          sourceId: 'review-1',
          severity: 'required',
          dimension: 'continuity',
          diagnosis: '开头没有承接上一章的门声。',
          rewriteGoal: '在开头补上门声和人物反应。',
          preserveMeaning: ['人物仍在旧宅。'],
          locationHint: 'opening',
        },
      ],
      unlocatedRequired: [],
      advisoryNotes: ['注意保持克制的叙事语气。'],
      outlineExecution: {
        fulfilledBeats: ['抵达旧宅'],
        missingBeats: [],
        deviations: [],
        prematureBeats: [],
        mustPreserve: ['人物仍在旧宅。'],
        endingGoal: '以门声后的选择收束。',
        mustNotAdvance: ['不得揭示幕后身份。'],
      },
    },
    factCheck: {
      corrections: [],
      protectedFacts: ['门声来自东侧。'],
      hardConstraints: ['不得揭示幕后身份。'],
    },
    ...overrides,
  };
}

describe('Outline Pipeline V3 reasoning and independent budget contracts', () => {
  test('normalizes product tiers without upgrading Brief', () => {
    const model = {
      provider_type: 'openai_compatible' as const,
      model_name: 'deepseek-v4-flash',
      url: 'https://api.deepseek.com',
    };
    expect(resolveV3StageReasoning('max', 'draft', model)).toMatchObject({
      effectiveTier: 'max',
      thinking: { type: 'enabled' },
      effort: 'max',
    });
    expect(resolveV3StageReasoning('max', 'review', model).effectiveTier).toBe(
      'high',
    );
    expect(
      resolveV3StageReasoning('max', 'factCheck', model).effectiveTier,
    ).toBe('high');
    expect(resolveV3StageReasoning('max', 'brief', model)).toMatchObject({
      effectiveTier: 'low',
      effort: 'low',
      thinking: { type: 'enabled' },
    });
  });

  test('a 1M model gets a per-request 80% soft input ceiling', () => {
    const allocation = allocateOutlinePipelineBudgetV3({
      contextWindow: 1_000_000,
      modelMaxOutputTokens: 1_000_000,
      requestMaxTokenOverrides: {
        brief: resolveElasticStageOutputReservation({
          contextWindow: 1_000_000,
          modelMaxOutputTokens: 1_000_000,
        }),
      },
      requestedTier: 'max',
      estimatedMandatoryInputTokens: { draft: 20_000, brief: 5_000 },
    });
    expect(allocation.stages.draft.softInputLimit).toBeLessThanOrEqual(800_000);
    expect(allocation.stages.draft.fitsSoftInput).toBe(true);
    expect(allocation.stages.brief.effectiveTier).toBe('low');
    expect(allocation.stages.brief.requestMaxTokens).toBe(200_000);
    expect(allocation.stages.brief.fitsModelOutput).toBe(true);
  });

  test('Brief visible JSON and low Thinking headroom are separate accounts', () => {
    const budget = calculateBriefBudget({
      input: input(),
      contextWindow: 1_000_000,
      modelMaxOutputTokens: 1_000_000,
      visibleOutputFloor: 1200,
      reasoningHeadroom: 1200,
    });
    expect(budget.visibleOutputFloor).toBeGreaterThanOrEqual(1200);
    expect(budget.reasoningHeadroom).toBe(1200);
    expect(budget.requestMaxTokens).toBe(200_000);
    expect(budget.requestMaxTokens).toBeGreaterThan(
      budget.visibleOutputFloor + budget.reasoningHeadroom,
    );
    expect(budget.softInputLimit).toBeGreaterThan(500_000);
    expect(budget.fits).toBe(true);
  });

  test('Brief prompt explicitly preserves the validator contract fields', () => {
    const system = String(buildBriefCompilerMessages(input())[0].content);
    expect(system).toContain('schemaVersion 必须为 1');
    expect(system).toContain('sourceHash 必须原样等于 source-hash');
    expect(system).toContain('sourceId 白名单');
    expect(system).toContain('review-1');
    expect(system).toContain('instruction');
    expect(system).toContain('mustFix 项模板');
    expect(system).toContain('message.content');
    expect(system).toContain('reasoning_content');
  });

  test('insufficient model output capacity uses local Brief instead of disabling Thinking', () => {
    const compiled = compileBriefStageRequest({
      input: input(),
      contextWindow: 32_000,
      modelMaxOutputTokens: 1800,
      visibleOutputFloor: 1200,
      reasoningHeadroom: 1200,
    });
    expect(compiled.ready).toBe(false);
    expect(compiled.error?.message).toMatch(/low Thinking|Thinking/);
    expect(compiled.error?.message).not.toMatch(/disabled|关闭/);
  });

  test('Final V3 also exposes the same elastic allocation trace', () => {
    const compiled = compileFinalReviserV3StageRequest({
      writingBrief: '保持门声、旧宅和幕后身份未揭示。',
      canonicalDraft: '林晚站在旧宅门前。'.repeat(80),
      capsule: buildFinalContinuityCapsule({
        presetText: '克制、紧张。',
        storyMemoryText: '林晚仍在旧宅。',
        characterText: '林晚擅长推理。',
        noteText: '',
        worldbookText: '普通人不知道灵气。',
        episodicMemoryText: '',
        recentBridgeText: '门声从东侧传来。',
        immediatePreviousChapterText: '上一章完整正文。'.repeat(200),
        immediatePreviousChapterEnding: '门声再次响起。',
        currentInstructionText: '本章承接门声。',
        retrievalUserPrompt: '',
        outlineText: '本章只抵达旧宅，不揭示幕后身份。',
        outlineFingerprint: 'outline',
        outlineIds: [1],
        outlineComplete: true,
        outlineEstimatedTokens: 20,
      }),
      maxTokens: 4000,
      contextWindow: 1_000_000,
      modelMaxOutputTokens: 1_000_000,
      elasticBudget: true,
    });
    expect(compiled.ready).toBe(true);
    expect(compiled.elasticBudgetTrace).toBeDefined();
    expect(compiled.elasticBudgetTrace!.softInputLimit).toBeLessThanOrEqual(
      800_000,
    );
    expect(
      compiled.elasticBudgetTrace!.modules.find(m => m.id === 'canonical_draft')
        ?.requirement,
    ).toBe('mandatory');
  });

  test('Final Brief compliance gate catches a future beat retained from draft', () => {
    const brief = compileDeterministicBrief(input());
    const invalid = validateFinalBriefCompliance({
      brief: {
        ...brief,
        mustNotAdvance: ['不得提前确认“G”开头档案或“不在这一层”的事实。'],
        mustFix: [{
          sourceIds: ['review-1'],
          location: 'ending',
          instruction: '删除或后移至下一章G档案分布、纸条指令等内容。',
          preserve: [],
        }],
      },
      text: '铁门合拢。她看见编号以“G”开头的档案，并确认它们不在这一层。',
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.code).toBe('must_not_advance_detected');

    const valid = validateFinalBriefCompliance({
      brief,
      text: '钟声停了。铁门合拢，她独自留在密室里。',
    });
    expect(valid.valid).toBe(true);
  });

  test('Final V3 prompt makes Brief hard boundaries override canonical draft', () => {
    const compiled = compileFinalReviserV3StageRequest({
      writingBrief: '不得提前推进G档案；章末停在铁门合拢与守字。',
      canonicalDraft: '草稿中包含未来线索。',
      capsule: buildFinalContinuityCapsule({
        presetText: '', storyMemoryText: '', characterText: '', noteText: '',
        worldbookText: '', episodicMemoryText: '', recentBridgeText: '',
        immediatePreviousChapterText: '上一章。', immediatePreviousChapterEnding: '门声。',
        currentInstructionText: '本章目标。', retrievalUserPrompt: '',
        outlineText: '当前大纲。', outlineFingerprint: 'x', outlineIds: [],
        outlineComplete: true, outlineEstimatedTokens: 2,
      }),
      maxTokens: 4000, contextWindow: 1_000_000,
      modelMaxOutputTokens: 1_000_000, elasticBudget: true,
    });
    expect(compiled.ready).toBe(true);
    if (!compiled.ready) throw new Error('expected final V3 request to compile');
    expect(String(compiled.messages[0].content)).toContain('优先于 canonical draft');
  });
});

describe('Brief trigger, deterministic fallback and output gate', () => {
  test('chapter-scope required correction triggers API Brief', () => {
    const decision = shouldCallBriefCompiler(
      input({
        review: {
          ...input().review!,
          executableCorrections: [
            {
              ...input().review!.executableCorrections[0],
              locationHint: 'chapter',
            },
          ],
        },
      }),
      DEFAULT_BRIEF_TRIGGER_POLICY,
    );
    expect(decision.callApi).toBe(true);
  });

  test('local Brief covers required/hard constraints and Final hides machine ids', () => {
    const source = input();
    const brief = compileDeterministicBrief(source);
    expect(brief.coveredRequiredIds).toContain('review-1');
    expect(brief.mustNotAdvance).toContain('不得揭示幕后身份。');
    const rendered = renderFinalWritingBrief(brief);
    expect(rendered).toContain('不得揭示幕后身份。');
    expect(rendered).not.toContain('review-1');
    expect(rendered).not.toContain('sourceHash');
  });

  test('Brief validator rejects unknown source ids and contradictory duplicates', () => {
    const source = input();
    const invalidUnknown = validateFinalWritingBrief({
      input: source,
      raw: JSON.stringify({
        schemaVersion: 1,
        sourceHash: source.sourceHash,
        coveredRequiredIds: ['unknown'],
        mustFix: [],
        mustPreserve: [],
        mustNotAdvance: source.review!.outlineExecution.mustNotAdvance,
        openingContinuity: [],
        endingState: source.review!.outlineExecution.endingGoal,
        advisoryNotes: [],
      }),
    });
    expect(invalidUnknown.valid).toBe(false);

    const invalidConflict = validateFinalWritingBrief({
      input: source,
      raw: JSON.stringify({
        schemaVersion: 1,
        sourceHash: source.sourceHash,
        coveredRequiredIds: [],
        mustFix: [
          {
            sourceIds: ['review-1'],
            location: 'opening',
            instruction: '先补门声。',
            preserve: [],
          },
          {
            sourceIds: ['review-1'],
            location: 'ending',
            instruction: '改到结尾。',
            preserve: [],
          },
        ],
        mustPreserve: ['不得揭示幕后身份。'],
        mustNotAdvance: source.review!.outlineExecution.mustNotAdvance,
        openingContinuity: [],
        endingState: source.review!.outlineExecution.endingGoal,
        advisoryNotes: [],
      }),
    });
    expect(invalidConflict.valid).toBe(false);
  });
});
