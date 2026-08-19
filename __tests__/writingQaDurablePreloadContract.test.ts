/**
 * Phase 4R P0-1 — Outline QA durable preload across action / resume.
 *
 * Red contract: `run_brief` (revision) executes as a SEPARATE kernel action
 * after `run_qa`. The durable preload in `runWritingStages` must restore the
 * `qa` artifact before Revision computes `aggregateStageFindings()`, otherwise
 * `hasExecutableFindings()` sees no `qa` key and the Revision is wrongly
 * skipped even though QA reported a blocking finding (a false empty-findings
 * pass). The fix is a one-line durable-preload registration for `qa`.
 */
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { runWritingStages } from '../src/services/writing/stages/writingStageRunner';
import { continuationRequest } from './helpers/oneShotFixtures';
import type {
  SharedWritingArtifact,
  SharedWritingStageName,
  WritingDurablePersistAdapter,
} from '../src/services/writing/contracts/writingStage';

const qaBlockingFinding = {
  verdict: 'revise',
  findings: [
    {
      issue: '人物动机与前文设定冲突，需补充铺垫',
      severity: 'blocking',
      target: '第3段',
      instruction: '在动作描写前补一句心理独白',
      requirementIds: ['R-applied'],
    },
  ],
};

function makeAdapter(
  loadExisting: NonNullable<WritingDurablePersistAdapter['loadExisting']>,
) {
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

describe('Phase 4R P0-1 — Outline QA durable preload (cross action/resume)', () => {
  test('run_revision preloads the qa artifact so an executable finding triggers Revision; QA is not re-dispatched', async () => {
    const freeze = buildWritingKernelFreezeTrace({
      request: continuationRequest({}),
    });
    const loadExisting = jest.fn(
      async (
        stage?: SharedWritingStageName,
      ): Promise<SharedWritingArtifact | null> => {
        if (stage === 'qa') {
          return { stage: 'qa', body: JSON.stringify(qaBlockingFinding) };
        }
        return null;
      },
    );
    const callStage = jest.fn(async () => ({
      text: '{"content":"修订后正文","appliedObligationIds":["R-applied"]}',
    }));

    const results = await runWritingStages({
      frozenContext: freeze.frozenContext,
      trace: freeze.trace,
      stages: ['revision'],
      persistAdapter: makeAdapter(loadExisting),
      callStage,
    });

    // The durable `qa` artifact must be part of the preload registration.
    expect(loadExisting).toHaveBeenCalledWith('qa');
    // Revision must execute — not be skipped — because QA holds a blocking,
    // executable finding that survived the action boundary.
    expect(callStage).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe('completed');
    expect(results[0].skipReason).toBeUndefined();
  });
});