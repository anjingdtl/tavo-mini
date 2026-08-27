import { sha256Hex } from '../src/services/continuation/hashUtils';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { runWritingStages } from '../src/services/writing/stages/writingStageRunner';
import { continuationRequest } from './helpers/oneShotFixtures';

function compactRequest(profile: 'standard' | 'quality') {
  return continuationRequest({
    pipelineTopologyVersion: 'compact_standard',
    qualityProfile: profile,
  });
}

async function runClean(profile: 'standard' | 'quality') {
  const { frozenContext, trace } = buildWritingKernelFreezeTrace({
    request: compactRequest(profile),
  });
  const callStage = jest.fn(async (input: { stage: string }) => {
    if (input.stage === 'draft') {
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          content: '清洁正文。',
        }),
        inputTokens: 10,
        outputTokens: 10,
      };
    }
    if (input.stage === 'qa') {
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          verdict: 'pass',
          findings: [],
          stateProposals: [],
        }),
        inputTokens: 10,
        outputTokens: 10,
      };
    }
    throw new Error(`unexpected paid stage ${input.stage}`);
  });
  const results = await runWritingStages({
    frozenContext,
    trace,
    stages: ['draft', 'qa', 'revision'],
    callStage: callStage as any,
  });
  return { results, callStage };
}

describe('B8 — three-tier paid-call contract', () => {
  test.each(['standard', 'quality'] as const)(
    '%s Clean: Draft + QA = exactly 2 paid calls and Revision is skipped',
    async profile => {
      const { results, callStage } = await runClean(profile);
      expect(callStage.mock.calls.map(call => call[0].stage)).toEqual([
        'draft',
        'qa',
      ]);
      expect(callStage).toHaveBeenCalledTimes(2);
      expect(results.map(result => `${result.stage}:${result.status}`)).toEqual([
        'draft:completed',
        'qa:completed',
        'revision:skipped',
      ]);
    },
  );

  test.each(['standard', 'quality'] as const)(
    '%s Issue: Draft + QA + one Revision = 3 paid calls, with no fourth call',
    async profile => {
      const { frozenContext, trace } = buildWritingKernelFreezeTrace({
        request: compactRequest(profile),
      });
      const callStage = jest.fn(async (input: { stage: string }) => {
        if (input.stage === 'draft') {
          return {
            text: JSON.stringify({ schemaVersion: 1, content: '第一段需要修复。' }),
            inputTokens: 10,
            outputTokens: 10,
          };
        }
        if (input.stage === 'qa') {
          return {
            text: JSON.stringify({
              schemaVersion: 1,
              verdict: 'needs_revision',
              findings: [
                {
                  findingId: 'qa-1',
                  severity: 'blocking',
                  target: '第一段需要修复',
                  issue: '事实表述需要修正',
                  instruction: '改成安全表述',
                },
              ],
              stateProposals: [],
            }),
            inputTokens: 10,
            outputTokens: 10,
          };
        }
        if (input.stage === 'revision') {
          return {
            text: JSON.stringify({
              schemaVersion: 1,
              strategy: 'segment_repair',
              actions: [{ covers: ['qa-1'] }],
              preserve: [],
              ending: 'keep',
              segmentRepairs: [
                {
                  anchorId: 'draft-p-001',
                  paragraphHash: sha256Hex('第一段需要修复。'),
                  replacementText: '第一段已修复。',
                  findingIds: ['qa-1'],
                  reason: '修正事实',
                },
              ],
            }),
            inputTokens: 10,
            outputTokens: 10,
          };
        }
        throw new Error(`unexpected paid stage ${input.stage}`);
      });
      const results = await runWritingStages({
        frozenContext,
        trace,
        stages: ['draft', 'qa', 'revision'],
        callStage: callStage as any,
      });
      expect(callStage.mock.calls.map(call => call[0].stage)).toEqual([
        'draft',
        'qa',
        'revision',
      ]);
      expect(callStage).toHaveBeenCalledTimes(3);
      expect(results[2].status).toBe('completed');
      expect((results[2].artifact as any).body).toBe('第一段已修复。');
    },
  );
});
