/**
 * Phase 5 — Revision Trigger Contract (§5.1 / §5.2 / §5.7).
 *
 * Revision must dispatch only when ALL hold:
 *   - QA verdict is not a pass-like verdict (or absent), AND
 *   - there exists an Executable Finding, where executable means:
 *       issue non-empty (not a generic/void phrase)
 *       && severity ∈ {blocking, warning}          (info never triggers)
 *       && (target OR requirementIds) present       (§5.2 locatable)
 *       && (instruction OR target) present          (§5.2 actionable)
 *
 * The red state is the pre-fix behavior: `hasExecutableFindings` only looked
 * at a non-empty `issue`, so an info-only finding, a generic suggestion, or a
 * warning under a `pass` verdict still triggered Revision. These cases must
 * now formally SKIP Revision (2-call Clean Standard becomes the norm).
 */

import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { runWritingStages } from '../src/services/writing/stages/writingStageRunner';
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import { continuationRequest } from './helpers/oneShotFixtures';
import type {
  SharedWritingArtifact,
  WritingDurablePersistAdapter,
} from '../src/services/writing/contracts/writingStage';

function qaArtifact(body: Record<string, unknown>): SharedWritingArtifact {
  return { stage: 'qa', body: JSON.stringify(body) };
}

function makeAdapter(loadExisting: NonNullable<WritingDurablePersistAdapter['loadExisting']>) {
  return {
    binding: 'continuation-generation-ledger' as const,
    loadExisting,
    reserve: async () => {},
    persistStageArtifact: async () => {},
    persistStageFailure: async () => {},
    persistStageSkip: async () => {},
    persistFinal: async () => {},
  };
}

async function runRevision(qa: Record<string, unknown>, text?: string, topology?: unknown) {
  const freeze = buildWritingKernelFreezeTrace({
    request: continuationRequest({ pipelineTopologyVersion: topology }),
  });
  const loadExisting = jest.fn(async (stage?: string) =>
    stage === 'qa' ? qaArtifact(qa) : null,
  );
  const callStage = jest.fn(async () => ({
    text: text ?? '{"content":"修订后正文","appliedObligationIds":["R1"]}',
  }));
  const results = await runWritingStages({
    frozenContext: freeze.frozenContext,
    trace: freeze.trace,
    stages: ['revision'],
    persistAdapter: makeAdapter(loadExisting as any),
    callStage,
  });
  return { result: results[0], callStage };
}

describe('Phase 5 — Revision Trigger Contract (compact ONE-QA Standard path)', () => {
  test('QA pass + [] findings → Revision is skipped (0 calls)', async () => {
    const { result, callStage } = await runRevision({ verdict: 'pass', findings: [] }, undefined, 'compact_standard');
    expect(result.status).toBe('skipped');
    expect(callStage).not.toHaveBeenCalled();
  });

  test('info-only finding → Revision is skipped (severity gate)', async () => {
    const { result, callStage } = await runRevision({
      verdict: 'revise',
      findings: [{ issue: '可更生动', severity: 'info', target: '第2段', instruction: '再润色' }],
    }, undefined, 'compact_standard');
    expect(result.status).toBe('skipped');
    expect(callStage).not.toHaveBeenCalled();
  });

  test('warning finding under a pass verdict → Revision is skipped (verdict gate)', async () => {
    const { result, callStage } = await runRevision({
      verdict: 'pass',
      findings: [{ issue: '这里不够流畅', severity: 'warning', target: '第2段', instruction: '调整语序' }],
    }, undefined, 'compact_standard');
    expect(result.status).toBe('skipped');
    expect(callStage).not.toHaveBeenCalled();
  });

  test('generic non-locatable suggestion → Revision is skipped (executable gate)', async () => {
    const { result, callStage } = await runRevision({
      verdict: 'revise',
      findings: [{ issue: '总体不错，略显平淡', severity: 'blocking' }],
    }, undefined, 'compact_standard');
    expect(result.status).toBe('skipped');
    expect(callStage).not.toHaveBeenCalled();
  });

  test('blocking finding with empty issue → Revision is skipped', async () => {
    const { result, callStage } = await runRevision({
      verdict: 'revise',
      findings: [{ severity: 'blocking', target: '第2段', instruction: '补充铺垫' }],
    }, undefined, 'compact_standard');
    expect(result.status).toBe('skipped');
    expect(callStage).not.toHaveBeenCalled();
  });

  test('blocking executable finding (verdict revise) → Revision executes', async () => {
    const { result, callStage } = await runRevision({
      verdict: 'revise',
      findings: [
        { issue: '人物动机与前文冲突', severity: 'blocking', target: '第3段', instruction: '补一句话', requirementIds: ['R1'] },
      ],
    }, undefined, 'compact_standard');
    expect(result.status).toBe('completed');
    expect(callStage).toHaveBeenCalledTimes(1);
  });

  test('warning executable finding (verdict absent) → Revision executes', async () => {
    const { result, callStage } = await runRevision({
      findings: [
        { issue: '这句太简短', severity: 'warning', instruction: '扩写这句', requirementIds: ['R2'] },
      ],
    }, undefined, 'compact_standard');
    expect(result.status).toBe('completed');
    expect(callStage).toHaveBeenCalledTimes(1);
  });
});

describe('Phase 5 — Legacy topology keeps loose brief trigger (§2.3 / §4.2C)', () => {
  test('legacy topology: an executable review/factCheck finding still runs brief', async () => {
    // Legacy review text (no verdict gate, severity absent) must still trigger
    // brief — historical V4 outline resume semantics are preserved.
    const { result, callStage } = await runRevision(
      {
        findings: [{ issue: '人物动机与前文冲突' }],
      },
      '{"content":"修订后正文","appliedObligationIds":["R1"]}',
      'legacy_standard',
    );
    expect(result.status).toBe('completed');
    expect(callStage).toHaveBeenCalledTimes(1);
  });

  test('legacy topology: empty findings still skips brief', async () => {
    const { result, callStage } = await runRevision(
      { findings: [] },
      undefined,
      'legacy_standard',
    );
    expect(result.status).toBe('skipped');
    expect(callStage).not.toHaveBeenCalled();
  });
});

describe('Phase 5 — QA output / Revision context compaction (§5.3 / §5.5)', () => {
  const freeze = buildWritingKernelFreezeTrace({ request: continuationRequest({}) });
  const input = {
    stage: 'qa' as const,
    frozenContext: freeze.frozenContext,
    artifacts: {},
    requirements: freeze.frozenContext.requirements,
    stagePolicy: freeze.frozenContext.stagePolicy,
  };
  const qaPrompt = compileSharedWritingPrompt(input).messages.map(m => m.content).join('\n');

  test('QA prompt enforces compact output, no default strengths/suggestions', () => {
    expect(qaPrompt).toContain('输出必须紧凑');
    expect(qaPrompt).toContain('findings 必须为 []');
    expect(qaPrompt).toMatch(/禁止默认输出.*strengths/s);
  });

  test('QA protocol forbids unsubstantiated generic suggestions', () => {
    expect(qaPrompt).toMatch(/禁止.*总体不错.*略显平淡.*可以更生动/s);
  });

  test('revision compiles from targeted context — no stacked old full reports', () => {
    const rev = compileSharedWritingPrompt({
      stage: 'revision',
      frozenContext: freeze.frozenContext,
      artifacts: {
        draft: { stage: 'draft', body: '【已有初稿】正文草稿占位' },
      },
      requirements: freeze.frozenContext.requirements,
      stagePolicy: freeze.frozenContext.stagePolicy,
    });
    const text = rev.messages.map(m => m.content).join('\n');
    // §5.5: carries the draft, never a stacked 终稿候选 / legacy report dump.
    expect(text).toContain('已有初稿');
    expect(text).not.toContain('【终稿候选】');
  });
});