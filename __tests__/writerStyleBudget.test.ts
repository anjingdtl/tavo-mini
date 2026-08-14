import { assertWriterStyleProjectionFits } from '../src/services/pipeline/stageResourceContextV5';
import { buildReviewMessages } from '../src/services/pipelineMessages';
import { compileReviewStageRequest } from '../src/services/pipeline/compileStageRequest';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';

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
