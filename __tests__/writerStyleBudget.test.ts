import {
  assertWriterStyleProjectionFits,
  resolveFrozenBriefWriterStyleProjection,
} from '../src/services/pipeline/stageResourceContextV5';
import { buildReviewMessages } from '../src/services/pipelineMessages';
import { compileReviewStageRequest } from '../src/services/pipeline/compileStageRequest';
import { compileBriefStageRequest } from '../src/services/pipeline/compileBriefStageRequest';
import { compileWriterStyleProjections } from '../src/services/writerStyle/compiler';
import { normalizeWriterStyleSemantic } from '../src/services/writerStyle/semantic';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { BriefCompilerInputV1 } from '../src/services/pipeline/briefCompilerTypes';

function snapshot(tokens: number): PipelineContextSnapshot {
  return {
    projectId: 1,
    chapterId: 2,
    createdAt: 1,
    snapshotVersion: 5,
    resourceContextVersion: 2,
    presetText: '',
    presetSource: 'user_selected',
    presetSourceFingerprint: 'style-fp',
    presetSystemText: '',
    presetWritingStyleText: '',
    presetExtraInstructionsText: '',
    characterText: '',
    worldbookText: '',
    noteText: '',
    retrievalUserPrompt: '',
    outlineText: '',
    storyMemoryText: '',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '',
    outlineFingerprint: '',
    outlineIds: [],
    outlineComplete: true,
    outlineEstimatedTokens: 0,
    resourceDetailItems: [],
    writerStyleSnapshot: {
      semanticVersion: 1,
      assetId: 9,
      assetName: '测试风格',
      sourceFormat: 'shinewriter',
      semantic: null,
      legacySystemText: 'x'.repeat(tokens * 4),
      legacyWritingStyleText: '',
      legacyExtraInstructionsText: '',
      sourceFingerprint: 'style-fp',
      samplerResolution: {
        temperature: 0.8,
        topP: 0.9,
        preservedFields: [],
        ignoredAtPipeline: ['max_tokens', 'openai_max_tokens'],
      },
      stageProjections: {
        draft: { stage: 'draft', mode: 'FULL', protected: true, text: '', estimatedTokens: tokens, compilerVersion: 'writer-style-projection-v1' },
        review: { stage: 'review', mode: 'EVALUATION', protected: true, text: '', estimatedTokens: tokens, compilerVersion: 'writer-style-projection-v1' },
        factCheck: { stage: 'factCheck', mode: 'HARD', protected: true, text: '', estimatedTokens: tokens, compilerVersion: 'writer-style-projection-v1' },
        brief: { stage: 'brief', mode: 'MINIMAL', protected: true, text: '', estimatedTokens: tokens, compilerVersion: 'writer-style-projection-v1' },
        proof: { stage: 'proof', mode: 'FULL', protected: true, text: '', estimatedTokens: tokens, compilerVersion: 'writer-style-projection-v1' },
      },
    },
  };
}

describe('Writer Style Protected budget', () => {
  test('blocks before provider admission when the frozen projection exceeds the hard input budget', () => {
    let providerCalls = 0;
    expect(() => {
      assertWriterStyleProjectionFits(snapshot(100), 'review', 80);
      providerCalls += 1;
    }).toThrow(/WRITER_STYLE_OVER_BUDGET/);
    expect(providerCalls).toBe(0);
  });

  test('does not treat a fitting projection as optional clipping input', () => {
    expect(() => assertWriterStyleProjectionFits(snapshot(3), 'proof', 10)).not.toThrow();
  });

  test('the stage message renderer preserves a Protected projection verbatim', () => {
    const protectedText = `【WRITER_STYLE_PROTECTED_V5】\n${'风格约束'.repeat(5000)}`;
    const messages = buildReviewMessages('draft', {
      presetText: protectedText,
      characterText: '',
      worldbookText: '',
      noteText: '',
      storyMemoryText: '',
      episodicMemoryText: '',
      recentBridgeText: '',
      currentInstructionText: '',
      retrievalUserPrompt: '',
      outlineText: '',
      writerStyleProtectedTokens: 5000,
      writerStyleProjectionMode: 'EVALUATION',
    });
    expect(messages.some(message => message.content.includes(protectedText))).toBe(true);
  });

  test('V5 allocator treats Writer Style as mandatory and never emits preset optional allocation', () => {
    const protectedText = `【WRITER_STYLE_PROTECTED_V5】\n${'受保护风格'.repeat(800)}`;
    const compiled = compileReviewStageRequest({
      draftText: '初稿',
      context: {
        presetText: protectedText,
        characterText: '角色'.repeat(800),
        noteText: '笔记'.repeat(800),
        worldbookText: '世界'.repeat(800),
        storyMemoryText: '',
        episodicMemoryText: '',
        recentBridgeText: '',
        currentInstructionText: '',
        retrievalUserPrompt: '',
        outlineText: '',
        writerStyleProtectedTokens: 1600,
        writerStyleProjectionMode: 'EVALUATION',
      },
      maxTokens: 256,
      contextWindow: 12000,
    });
    expect(compiled.ready).toBe(true);
    if (!compiled.ready) return;
    const writerStyle = compiled.elasticBudgetTrace?.modules.find(
      module => module.id === 'writerStyle',
    );
    expect(writerStyle?.requirement).toBe('mandatory');
    expect(compiled.elasticBudgetTrace?.modules.some(module => module.id === 'preset')).toBe(false);
    expect(compiled.messages.map(message => message.content).join('\n')).toContain(
      protectedText,
    );
  });
});

function briefInput(advisory = '注意保持克制的叙事语气。'): BriefCompilerInputV1 {
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
      advisoryNotes: [advisory],
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
  };
}

describe('Snapshot V5 Brief MINIMAL Writer Style', () => {
  const semantic = normalizeWriterStyleSemantic({
    name: '限知悬念推进',
    narration: { pointOfView: '第三人称限知', narratorDistance: '中近距离' },
    narrativeMechanics: {
      informationReveal: '先细节后因果',
      continuity: '事实不可漂移',
    },
    prohibitions: ['禁止凭空出现关键证据'],
    extraInstructions: ['不要解释创作过程'],
  });
  const briefProjection = compileWriterStyleProjections(semantic, {
    system: '',
    style: '',
    extra: '不要解释创作过程',
  }).brief;

  test('sends the frozen MINIMAL projection as a protected mandatory module', () => {
    const compiled = compileBriefStageRequest({
      input: briefInput(),
      contextWindow: 32_000,
      modelMaxOutputTokens: 8_000,
      writerStyle: briefProjection,
    });
    expect(compiled.ready).toBe(true);
    expect(briefProjection.mode).toBe('MINIMAL');
    expect(compiled.messages.map(message => message.content).join('\n')).toContain(
      briefProjection.text,
    );
    const writerStyle = compiled.elasticBudgetTrace?.modules.find(
      module => module.id === 'writerStyle',
    );
    expect(writerStyle?.requirement).toBe('mandatory');
    expect(writerStyle?.mode).toBe('MINIMAL');
    expect(writerStyle?.protected).toBe(true);
    expect(writerStyle?.allocated).toBe('full');
    expect(writerStyle?.clipped).toBe(false);
    expect(compiled.writerStyleTrace).toEqual(
      expect.objectContaining({
        id: 'writerStyle',
        mode: 'MINIMAL',
        protected: true,
        allocated: 'full',
        clipped: false,
      }),
    );
    expect(compiled.allocations?.find(item => item.id === 'writerStyle')).toEqual(
      expect.objectContaining({
        mode: 'MINIMAL',
        protected: true,
        clipped: false,
        truncated: false,
      }),
    );
  });

  test('does not clip the frozen MINIMAL projection under elastic advisory pressure', () => {
    const compiled = compileBriefStageRequest({
      input: briefInput('风格建议。'.repeat(8_000)),
      contextWindow: 16_000,
      modelMaxOutputTokens: 4_000,
      writerStyle: briefProjection,
    });
    expect(compiled.ready).toBe(true);
    expect(compiled.messages.map(message => message.content).join('\n')).toContain(
      briefProjection.text,
    );
    const writerStyle = compiled.elasticBudgetTrace?.modules.find(
      module => module.id === 'writerStyle',
    );
    const advisory = compiled.elasticBudgetTrace?.modules.find(
      module => module.id === 'brief_advisory',
    );
    expect(writerStyle?.requirement).toBe('mandatory');
    expect(writerStyle?.clipped).toBe(false);
    expect(writerStyle?.finalAllocatedTokens).toBe(writerStyle?.availableTokens);
    expect((advisory?.finalAllocatedTokens || 0) <= (advisory?.availableTokens || 0)).toBe(true);
  });

  test('blocks the provider when the frozen Brief projection exceeds the hard input budget', () => {
    let providerCalls = 0;
    const oversized = {
      ...briefProjection,
      text: `【WRITER_STYLE_PROTECTED_V5】\n${'硬边界'.repeat(20_000)}`,
      estimatedTokens: 20_000,
    };
    expect(() => {
      assertWriterStyleProjectionFits(
        snapshot(oversized.estimatedTokens),
        'brief',
        80,
      );
      providerCalls += 1;
    }).toThrow(/WRITER_STYLE_OVER_BUDGET/);
    expect(providerCalls).toBe(0);

    const compiled = compileBriefStageRequest({
      input: briefInput(),
      contextWindow: 4_000,
      modelMaxOutputTokens: 512,
      writerStyle: oversized,
    });
    if (compiled.ready) providerCalls += 1;
    expect(compiled.ready).toBe(false);
    expect(providerCalls).toBe(0);
  });

  test('consumes the frozen Snapshot V5 brief projection instead of re-deriving it', () => {
    const frozenText = '【WRITER_STYLE_PROTECTED_V5】\n冻结的 Brief MINIMAL 投影不得重算';
    const v5 = snapshot(12);
    v5.writerStyleSnapshot!.stageProjections.brief = {
      stage: 'brief',
      mode: 'MINIMAL',
      protected: true,
      text: frozenText,
      estimatedTokens: 12,
      compilerVersion: 'writer-style-projection-v1',
    };
    const resolved = resolveFrozenBriefWriterStyleProjection(v5);
    expect(resolved?.text).toBe(frozenText);
    const compiled = compileBriefStageRequest({
      input: briefInput(),
      contextWindow: 32_000,
      modelMaxOutputTokens: 8_000,
      writerStyle: resolved,
    });
    expect(compiled.ready).toBe(true);
    expect(compiled.messages.map(message => message.content).join('\n')).toContain(frozenText);
    expect(resolveFrozenBriefWriterStyleProjection({ ...v5, snapshotVersion: 4, writerStyleSnapshot: undefined } as any)).toBeUndefined();
  });

  test('legacy V3/V4 Brief stays unchanged when no frozen Writer Style is supplied', () => {
    const compiled = compileBriefStageRequest({
      input: briefInput(),
      contextWindow: 32_000,
      modelMaxOutputTokens: 8_000,
    });
    expect(compiled.ready).toBe(true);
    expect(compiled.writerStyleTrace).toBeUndefined();
    expect(
      compiled.elasticBudgetTrace?.modules.some(module => module.id === 'writerStyle'),
    ).toBe(false);
    expect(compiled.messages.map(message => message.content).join('\n')).not.toContain(
      '【WRITER_STYLE_PROTECTED_V5】',
    );
  });
});
