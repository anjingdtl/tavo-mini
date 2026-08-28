import { sha256Hex } from '../src/services/continuation/hashUtils';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import {
  resetWritingObservabilityForTests,
} from '../src/services/writing/observability';
import { runWritingStages } from '../src/services/writing/stages/writingStageRunner';
import type {
  SharedWritingArtifact,
  WritingDurablePersistAdapter,
} from '../src/services/writing/contracts/writingStage';
import { continuationRequest } from './helpers/oneShotFixtures';

const draftBody = '第一段需要修复。';
const qaBody = JSON.stringify({
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
});

function validFullRevision(content: string) {
  return {
    schemaVersion: 1,
    strategy: 'full_revision',
    actions: [{ covers: ['qa-1'], instruction: '改成安全表述' }],
    preserve: ['已成立的事件因果'],
    ending: 'keep',
    content,
  };
}

function revisionResponse(text: string, finishReason?: string) {
  return {
    text,
    inputTokens: 100,
    outputTokens: 100,
    totalTokens: 200,
    finishReason,
    physicalRequestCount: 1,
    protocolFallbackCount: 0,
  } as any;
}

function makePersistAdapter() {
  const persisted: Array<{ stage: string; artifact: SharedWritingArtifact }> = [];
  const adapter: WritingDurablePersistAdapter = {
    binding: 'continuation-generation-ledger',
    reserve: async () => {},
    persistStageArtifact: async (stage, artifact) => {
      persisted.push({ stage, artifact });
    },
    persistStageFailure: async () => {},
  };
  return { adapter, persisted };
}

async function runRevision(response: any) {
  return runSharedStage('revision', response, {
    draft: { stage: 'draft', body: draftBody },
    qa: { stage: 'qa', body: qaBody },
  });
}

async function runSharedStage(
  stage: 'draft' | 'qa' | 'revision',
  response: any,
  artifacts: Record<string, any> = {},
) {
  resetWritingObservabilityForTests();
  const freeze = buildWritingKernelFreezeTrace({
    request: continuationRequest({ pipelineTopologyVersion: 'compact_standard' }),
  });
  const { adapter, persisted } = makePersistAdapter();
  const callStage = jest.fn(async () => response);
  const result = runWritingStages({
    frozenContext: freeze.frozenContext,
    trace: freeze.trace,
    stages: [stage],
    artifacts,
    persistAdapter: adapter,
    callStage,
  });
  return {
    result,
    callStage,
    persisted,
    trace: freeze.trace,
    frozenContext: freeze.frozenContext,
  };
}

describe('Revision structured output contract (P0)', () => {
  test.each([
    ['draft', '截断但看似完整的初稿。'],
    ['qa', qaBody],
  ] as const)('%s length-terminated output fails closed before persistence', async (stage, text) => {
    const { result, callStage, persisted } = await runSharedStage(
      stage,
      revisionResponse(text, 'length'),
      stage === 'qa' ? { draft: { stage: 'draft', body: draftBody } } : {},
    );

    await expect(result).rejects.toMatchObject({
      code: 'SHARED_WRITER_TRUNCATED_OUTPUT',
    });
    expect(callStage).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual([]);
  });

  test('length-terminated JSON fails closed before persistence', async () => {
    const response = revisionResponse(
      JSON.stringify(validFullRevision('截断前看似完整的长正文。')),
      'length',
    );
    const { result, callStage, persisted } = await runRevision(response);

    await expect(result).rejects.toMatchObject({
      code: 'SHARED_WRITER_TRUNCATED_OUTPUT',
    });
    expect(callStage).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual([]);
  });

  test('missing revision contract fields fail closed before persistence', async () => {
    const response = revisionResponse(
      JSON.stringify({ schemaVersion: 1, content: '缺少修订合同字段。' }),
      'stop',
    );
    const { result, persisted } = await runRevision(response);

    await expect(result).rejects.toMatchObject({
      code: 'SHARED_WRITER_INVALID_REVISION_CONTRACT',
    });
    expect(persisted).toEqual([]);
  });

  test('binds provider proposals to the locally assembled final body', async () => {
    const content = '修订正文包含新事实。';
    const response = revisionResponse(
      JSON.stringify({
        ...validFullRevision(content),
        finalStateProposals: [
          {
            proposalType: 'plot_advance',
            payload: { fact: '新事实' },
            evidenceQuote: '正文包含新事实',
            risk: 'normal',
          },
        ],
        proposalSourceBodyFingerprint: sha256Hex('不是最终正文'),
      }),
      'stop',
    );
    const { result, persisted } = await runRevision(response);

    const results = await result;
    expect(results[0].status).toBe('completed');
    const artifact = results[0].artifact as SharedWritingArtifact;
    expect(artifact.structured?.proposalSourceBodyFingerprint).toBe(
      sha256Hex(content),
    );
    expect(artifact.diagnostics).toContain(
      'revision_state_proposal_fingerprint_bound_locally',
    );
    expect(persisted).toHaveLength(1);
  });

  test('invalid segment repair uses same-response full revision fallback', async () => {
    const response = revisionResponse(
      JSON.stringify({
        ...validFullRevision('同一次响应中的完整终稿。'),
        strategy: 'segment_repair',
        segmentRepairs: [
          {
            anchorId: 'draft-p-001',
            paragraphHash: 'wrong',
            replacementText: '不应直接应用。',
            findingIds: ['qa-1'],
            reason: '测试回退',
          },
        ],
      }),
      'stop',
    );
    const { result, callStage, persisted } = await runRevision(response);

    const results = await result;
    expect(results[0].status).toBe('completed');
    expect((results[0].artifact as SharedWritingArtifact).body).toBe(
      '同一次响应中的完整终稿。',
    );
    expect(callStage).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveLength(1);
  });

  test('binds proposals after local segment-repair assembly', async () => {
    const finalBody = '第一段修复完成。';
    const response = revisionResponse(
      JSON.stringify({
        schemaVersion: 1,
        strategy: 'segment_repair',
        actions: [{ covers: ['qa-1'], instruction: '改成安全表述' }],
        preserve: ['已成立的事件因果'],
        ending: 'keep',
        segmentRepairs: [
          {
            anchorId: 'draft-p-001',
            paragraphHash: sha256Hex(draftBody),
            replacementText: finalBody,
            findingIds: ['qa-1'],
            reason: '同一响应中的局部修复',
          },
        ],
        finalStateProposals: [
          {
            proposalType: 'plot_advance',
            payload: { fact: '修复完成' },
            evidenceQuote: '修复完成',
            risk: 'normal',
          },
        ],
        proposalSourceBodyFingerprint: sha256Hex('模型无法可靠计算的值'),
      }),
      'stop',
    );
    const { result, persisted } = await runRevision(response);

    const results = await result;
    expect(results[0].status).toBe('completed');
    const artifact = results[0].artifact as SharedWritingArtifact;
    expect(artifact.body).toBe(finalBody);
    expect(artifact.structured?.proposalSourceBodyFingerprint).toBe(
      sha256Hex(finalBody),
    );
    expect(artifact.diagnostics).toContain(
      'revision_state_proposal_fingerprint_bound_locally',
    );
    expect(persisted).toHaveLength(1);
  });
});
