/**
 * Phase 0 ONE Flow baseline samples.
 *
 * Structural samples freeze real production requests and compile the
 * stages the frozen policy would dispatch. They do not invent a second
 * budget, writer, or memory system.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import {
  measureStructuralChapterObservability,
  percentileMs,
  resetWritingObservabilityForTests,
  snapshotWritingObservability,
} from '../src/services/writing';
import {
  continuationRequest,
  outlineRequest,
} from './helpers/oneShotFixtures';

beforeEach(() => {
  resetWritingObservabilityForTests();
});

describe('ONE Flow Phase 0 baseline samples', () => {
  test('Outline standard / Continuation standard / One-Shot / Batch samples expose the required metrics', () => {
    const outlineFreeze = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    const outline = measureStructuralChapterObservability({
      frozenContext: outlineFreeze.frozenContext,
      contextTimings: snapshotWritingObservability(outlineFreeze.trace)?.context,
      sampleKind: 'outline_standard',
    });
    const continuationFreeze = buildWritingKernelFreezeTrace({
      request: continuationRequest({}),
    });
    const continuation = measureStructuralChapterObservability({
      frozenContext: continuationFreeze.frozenContext,
      contextTimings: snapshotWritingObservability(continuationFreeze.trace)
        ?.context,
      sampleKind: 'continuation_standard',
    });
    const oneShotFreeze = buildWritingKernelFreezeTrace({
      request: outlineRequest({ executionProfile: 'one_shot' }),
    });
    const oneShot = measureStructuralChapterObservability({
      frozenContext: oneShotFreeze.frozenContext,
      contextTimings: snapshotWritingObservability(oneShotFreeze.trace)?.context,
      sampleKind: 'one_shot',
    });
    const batchChapters = [1, 2, 3].map(index =>
      measureStructuralChapterObservability({
        frozenContext: buildWritingKernelFreezeTrace({
          request: {
            ...outlineRequest({}),
            writingRunId: `wr-batch-${index}`,
            generationTraceId: `gt-batch-${index}`,
            chapterId: index,
          },
        }).frozenContext,
        sampleKind: 'batch',
      }),
    );

    for (const sample of [outline, continuation, oneShot, ...batchChapters]) {
      expect(sample.generationTraceId).toMatch(/^gt-/);
      expect(sample.freezeFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(sample.context.candidateTokens).toBeGreaterThan(0);
      expect(sample.context.allocatedTokens).toBeGreaterThan(0);
      expect(sample.context.renderedTokens).toBeGreaterThan(0);
      expect(sample.context.frozenContextTokens).toBeGreaterThan(0);
      expect(sample.llm.formatterCallCount).toBe(0);
      expect(sample.llm.protocolFallbackCount).toBe(0);
      expect(sample.postWriting.postWritingBlockingMs).toBe(0);
      expect(sample.stages.length).toBeGreaterThan(0);
    }

    expect(outline.llm.chapterWritingPaidCallCount).toBe(5);
    expect(continuation.llm.chapterWritingPaidCallCount).toBe(5);
    expect(oneShot.llm.chapterWritingPaidCallCount).toBe(1);
    expect(oneShot.llm.chapterWritingPaidCallCount).toBeLessThanOrEqual(1);
    expect(batchChapters).toHaveLength(3);
    expect(
      batchChapters.every(chapter => chapter.llm.chapterWritingPaidCallCount === 5),
    ).toBe(true);
    expect(outline.context.duplicateContextRatio).toBeGreaterThan(
      oneShot.context.duplicateContextRatio,
    );
    expect(
      percentileMs(
        batchChapters.map(chapter => chapter.context.frozenContextTokens),
        50,
      ),
    ).toBeGreaterThan(0);

    const report = {
      outline: summarize(outline),
      continuation: summarize(continuation),
      oneShot: summarize(oneShot),
      batch: batchChapters.map(summarize),
    };
    expect(report.outline.paidStages).toEqual([
      'draft',
      'review',
      'factCheck',
      'revision',
      'proof',
    ]);
    expect(report.continuation.paidStages).toEqual([
      'draft',
      'review',
      'audit',
      'revision',
      'proof',
    ]);
    expect(report.oneShot.paidStages).toEqual(['draft']);
    const reportDir = path.join(__dirname, '..', 'test-logs');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, 'phase0-structural-baseline.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  });

  test('Phase 0 does not introduce a second writer, compiler, budget, or memory system', () => {
    const root = path.resolve(__dirname, '..');
    const forbidden = [
      'src/services/writing/stages/fastWriter.ts',
      'src/services/writing/stages/oneShotWriterCore.ts',
      'src/services/writing/prompt/fastPromptCompiler.ts',
      'src/services/writing/context/fastContextBuilder.ts',
      'src/services/writing/memory/continuationMemory.ts',
    ];
    for (const file of forbidden) {
      expect(fs.existsSync(path.join(root, file))).toBe(false);
    }

    const observability = fs.readFileSync(
      path.join(root, 'src/services/writing/observability/writingChapterObservability.ts'),
      'utf8',
    );
    expect(observability).not.toMatch(
      /inputTokenCap|maxInputTokens|32\s*\*\s*1024|100\s*\*\s*1024/,
    );
    expect(observability).toContain('never selects a Writer');

    const allocate = fs.readFileSync(
      path.join(root, 'src/services/writing/context/allocateWritingContextBudget.ts'),
      'utf8',
    );
    expect(allocate).toContain('The sole generic budget decision source');
  });
});

function summarize(
  sample: ReturnType<typeof measureStructuralChapterObservability>,
) {
  return {
    generationTraceId: sample.generationTraceId,
    freezeFingerprint: sample.freezeFingerprint,
    scenario: sample.scenario,
    executionProfile: sample.executionProfile,
    paidStages: sample.stages
      .filter(stage => stage.status !== 'skipped')
      .map(stage => stage.stage),
    skippedStages: sample.stages
      .filter(stage => stage.status === 'skipped')
      .map(stage => ({
        stage: stage.stage,
        skipReason: stage.skipReason,
        policyRuleId: stage.policyRuleId,
      })),
    chapterWritingPaidCallCount: sample.llm.chapterWritingPaidCallCount,
    logicalStageCallCount: sample.llm.logicalStageCallCount,
    formatterCallCount: sample.llm.formatterCallCount,
    physicalRequestCount: sample.llm.physicalRequestCount,
    protocolFallbackCount: sample.llm.protocolFallbackCount,
    postWritingAuxiliaryCallCount: sample.llm.postWritingAuxiliaryCallCount,
    candidateTokens: sample.context.candidateTokens,
    allocatedTokens: sample.context.allocatedTokens,
    renderedTokens: sample.context.renderedTokens,
    frozenContextTokens: sample.context.frozenContextTokens,
    stageProjectedContextTokens: sample.context.stageProjectedContextTokens,
    duplicateContextTokens: sample.context.duplicateContextTokens,
    duplicateContextRatio: sample.context.duplicateContextRatio,
    contextBuildMs: sample.context.contextBuildMs,
    freezeMs: sample.context.freezeMs,
  };
}
