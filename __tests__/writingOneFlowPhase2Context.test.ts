/**
 * Phase 2 ONE Context — partial construction gates.
 *
 * Production still has one planner and one generic budget. Stage projection
 * is a deterministic slice of the frozen render, not a second allocator.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  aggregateStageFindings,
  compileSharedWritingPrompt,
  formatAggregatedFindingsBlock,
  projectFrozenContextForStage,
  STAGE_CONTEXT_KIND_ALLOWLIST,
} from '../src/services/writing';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { continuationRequest, outlineRequest } from './helpers/oneShotFixtures';

const ROOT = path.resolve(__dirname, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('ONE Context planner and budget', () => {
  test('production final planner and generic budget each have one implementation', () => {
    const plan = read('src/services/writing/context/buildWritingContextPlan.ts');
    const allocate = read(
      'src/services/writing/context/allocateWritingContextBudget.ts',
    );
    const freeze = read('src/services/writing/context/buildFrozenWritingContext.ts');
    expect(plan).toMatch(/export function buildWritingContextPlan\b/);
    expect(allocate).toContain('The sole generic budget decision source');
    expect(freeze).toContain('buildWritingContextPlan(normalized)');
    expect(freeze).toContain('allocateWritingContextBudget({');
    expect(freeze).not.toMatch(/planContinuationContextBudget|32\s*\*\s*1024|100K/);
  });

  test('adapters do not call the final budget allocator', () => {
    const outline = read('src/services/writing/scenario/outlineWritingAdapter.ts');
    const continuation = read(
      'src/services/writing/scenario/continuationWritingAdapter.ts',
    );
    expect(outline).not.toContain('allocateWritingContextBudget');
    expect(continuation).not.toContain('allocateWritingContextBudget');
    expect(outline).not.toContain('buildWritingContextPlan');
    expect(continuation).not.toContain('buildWritingContextPlan');
  });

  test('no new hard input token caps in projection or aggregator', () => {
    const projection = read(
      'src/services/writing/context/stageContextProjection.ts',
    );
    const findings = read('src/services/writing/context/findingsAggregator.ts');
    for (const text of [projection, findings]) {
      expect(text).not.toMatch(/32\s*\*\s*1024|100\s*\*\s*1024|maxInputTokens\s*=/);
    }
  });

  test('Continuation collection is fetch demand, not a second final budget', () => {
    const collection = read(
      'src/services/writing/scenario/continuationSourceCollection.ts',
    );
    const capacity = read(
      'src/services/writing/scenario/continuationStageCapacity.ts',
    );
    const freeze = read('src/services/writing/context/buildFrozenWritingContext.ts');
    expect(collection).toContain('planContinuationSourceDemand');
    expect(collection).not.toContain('planContinuationContextBudget({');
    expect(collection).not.toMatch(/已组装约 \$\{totalInputTokens\}/);
    expect(capacity).toContain('This is NOT the production final Context Budget');
    expect(freeze).toContain('allocateWritingContextBudget({');
    expect(freeze).not.toContain('planContinuationSourceDemand');
    expect(freeze).not.toContain('planContinuationV4ContextBudget');
  });
});

describe('Deterministic stage projection', () => {
  test('draft keeps the full frozen render; later stages slice by kind', () => {
    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: continuationRequest({}),
    });
    const draft = projectFrozenContextForStage({
      frozenContext,
      stage: 'draft',
    });
    const review = projectFrozenContextForStage({
      frozenContext,
      stage: 'review',
    });
    const audit = projectFrozenContextForStage({
      frozenContext,
      stage: 'audit',
    });
    expect(draft.carriesFullFrozenContext).toBe(true);
    expect(draft.text).toBe(frozenContext.rendered.text);
    expect(review.carriesFullFrozenContext).toBe(false);
    expect(review.projectedTokens).toBeLessThan(draft.projectedTokens);
    expect(review.includedKinds.every(kind =>
      STAGE_CONTEXT_KIND_ALLOWLIST.review.includes(kind as never),
    )).toBe(true);
    expect(audit.includedKinds).not.toContain('writer_style');
    const again = projectFrozenContextForStage({
      frozenContext,
      stage: 'review',
    });
    expect(again.fingerprint).toBe(review.fingerprint);
    expect(again.text).toBe(review.text);
  });

  test('shared compiler uses the projected slice, not a second budget', () => {
    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    const review = compileSharedWritingPrompt({
      stage: 'review',
      frozenContext,
      artifacts: { draft: { stage: 'draft', body: '初稿' } },
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
    });
    const user = review.messages[1].content;
    expect(user).toContain('【冻结上下文】');
    expect(user).toContain('【已有初稿】');
    expect(user).not.toContain('【已有审阅】');
  });
});

describe('Findings aggregator', () => {
  test('revision consumes structured findings instead of full stacked reports', () => {
    const findings = aggregateStageFindings({
      review: {
        stage: 'review',
        body: JSON.stringify({
          findings: [
            {
              findingId: 'rv-1',
              severity: 'blocking',
              target: 'p3',
              issue: '结尾没有代价',
              instruction: '补上选择的后果',
            },
          ],
        }),
      },
      audit: {
        stage: 'audit',
        structured: {
          findings: [
            {
              id: 'au-1',
              severity: 'warning',
              issue: '地点与 Canon 不完全一致',
              instruction: '核对码头夜色',
            },
          ],
        },
      },
      factCheck: {
        stage: 'factCheck',
        body: '整篇事实核查长文。'.repeat(30),
      },
    });
    expect(findings).toHaveLength(3);
    expect(findings[0]).toMatchObject({
      findingId: 'rv-1',
      sourceStage: 'review',
      severity: 'blocking',
    });
    const block = formatAggregatedFindingsBlock(findings);
    expect(block).toContain('【汇总 Findings】');
    expect(block).toContain('结尾没有代价');
    expect(block.length).toBeLessThan('整篇事实核查长文。'.repeat(80).length);

    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    const compiled = compileSharedWritingPrompt({
      stage: 'revision',
      frozenContext,
      artifacts: {
        draft: { stage: 'draft', body: '初稿正文' },
        review: {
          stage: 'review',
          body: JSON.stringify({
            findings: [{ issue: '节奏偏慢', instruction: '压缩开场' }],
          }),
        },
        factCheck: { stage: 'factCheck', body: '超长事实核查报告'.repeat(20) },
      },
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
    });
    const text = compiled.messages[1].content;
    expect(text).toContain('【汇总 Findings】');
    expect(text).toContain('节奏偏慢');
    expect(text).not.toContain('【已有审阅】');
    expect(text).not.toContain('【已有事实核查】');
  });
});
