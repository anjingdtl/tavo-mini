import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { aggregateStageFindings } from '../src/services/writing/context/findingsAggregator';
import {
  isAdoptableStructuredReport,
  validateQaStructuredContract,
} from '../src/services/writing/stages/writerRecovery';
import { runWritingStages } from '../src/services/writing/stages/writingStageRunner';
import * as stageLlmCall from '../src/services/writing/stages/stageLlmCall';
import { setSecureLLMApiKey } from '../src/services/secureStorage';
import type {
  SharedWritingArtifact,
  SharedWritingStageName,
  WritingDurablePersistAdapter,
} from '../src/services/writing/contracts/writingStage';
import { continuationRequest } from './helpers/oneShotFixtures';
import { qaContentOnlyFailureFixture } from '../src/services/writing/fixtures/qa-content-only-failure';

const validNeedsRevision = {
  verdict: 'needs_revision',
  content: '发现硬约束问题',
  findings: [
    {
      severity: 'blocking',
      target: '交付动作',
      issue: '交付发生过晚',
      instruction: '把交付提前到水位到达第一步之前',
      requirementIds: ['R1'],
    },
  ],
};

const validRevision = {
  schemaVersion: 1,
  strategy: 'full_revision',
  actions: [{ covers: ['R1'], instruction: '改写问题段落' }],
  preserve: [],
  ending: 'keep',
  content: '修订后正文',
};

function physicalResult(text: string) {
  return {
    text,
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
    physicalRequestCount: 1,
    protocolFallbackCount: 0,
  } as any;
}

describe('Compact QA Structured Contract admission', () => {
  test('enforces the exact verdict/findings/finding contract', () => {
    expect(
      validateQaStructuredContract({ verdict: 'pass', findings: [] }),
    ).toEqual({ valid: true, reason: null });
    expect(validateQaStructuredContract(validNeedsRevision)).toEqual({
      valid: true,
      reason: null,
    });

    const invalidCases = [
      { verdict: 'pass', findings: [validNeedsRevision.findings[0]] },
      {
        verdict: 'needs_revision',
        findings: [
          { ...validNeedsRevision.findings[0], severity: 'info' },
        ],
      },
      {
        verdict: 'needs_revision',
        findings: [
          {
            ...validNeedsRevision.findings[0],
            target: '',
            requirementIds: [],
          },
        ],
      },
      {
        verdict: 'needs_revision',
        findings: [
          {
            ...validNeedsRevision.findings[0],
            target: '',
            requirementIds: [],
            instruction: '',
          },
        ],
      },
      { verdict: 'revise', findings: [] },
      { verdict: 'needs_revision' },
    ];

    for (const candidate of invalidCases) {
      expect(validateQaStructuredContract(candidate).valid).toBe(false);
    }
  });

  test('real content-only failure uses one Formatter, persists valid QA, triggers one Revision, and passes final stages', async () => {
    await setSecureLLMApiKey('sk-qa-contract-test', 7);
    const freeze = buildWritingKernelFreezeTrace({
      request: continuationRequest({
        pipelineTopologyVersion: 'compact_standard',
      }),
    });
    const persisted: Array<{ stage: string; artifact: any }> = [];
    const durable = new Map<string, string>();
    const persistFinal = jest.fn(async () => {});
    const persistAdapter: WritingDurablePersistAdapter = {
      binding: 'continuation-generation-ledger' as const,
      loadExisting: jest.fn(async (stage: SharedWritingStageName) => {
        const body = durable.get(stage);
        return (body ? { stage, body } : null) as SharedWritingArtifact | null;
      }),
      reserve: jest.fn(async () => {}),
      persistStageArtifact: jest.fn(
        async (stage: SharedWritingStageName, artifact: SharedWritingArtifact) => {
          persisted.push({ stage, artifact });
          durable.set(
            stage,
            stage === 'qa' && artifact.structured
              ? JSON.stringify(artifact.structured)
              : artifact.body,
          );
        },
      ),
      persistStageFailure: jest.fn(async () => {}),
      persistStageSkip: jest.fn(async () => {}),
      persistFinal,
    };
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValueOnce(
        physicalResult(JSON.stringify({ content: '初稿正文' })),
      )
      .mockResolvedValueOnce(
        physicalResult(JSON.stringify(qaContentOnlyFailureFixture)),
      )
      .mockResolvedValueOnce(physicalResult(JSON.stringify(validNeedsRevision)))
      .mockResolvedValueOnce(physicalResult(JSON.stringify(validRevision)));

    try {
      await runWritingStages({
        frozenContext: freeze.frozenContext,
        trace: freeze.trace,
        stages: ['draft', 'qa'],
        persistAdapter,
      });

      const results = await runWritingStages({
        frozenContext: freeze.frozenContext,
        trace: freeze.trace,
        stages: ['revision', 'finalValidate', 'persist'],
        persistAdapter,
      });

      const qaPersist = persisted.find(item => item.stage === 'qa')?.artifact;
      expect(transport).toHaveBeenCalledTimes(4);
      expect(
        transport.mock.calls.filter(call =>
          String(call[2].scenario).includes('qa_formatter'),
        ),
      ).toHaveLength(1);
      expect(qaPersist?.formatterUsed).toBe(true);
      expect(qaPersist?.usage?.logicalStageCallCount).toBe(1);
      expect(qaPersist?.usage?.formatterCallCount).toBe(1);
      expect(qaPersist?.usage?.physicalRequestCount).toBe(2);
      expect(validateQaStructuredContract(qaPersist?.structured).valid).toBe(
        true,
      );
      expect(
        validateQaStructuredContract(JSON.parse(durable.get('qa') || '{}'))
          .valid,
      ).toBe(true);
      expect(aggregateStageFindings({ qa: qaPersist })).toEqual([
        expect.objectContaining({
          severity: 'blocking',
          target: '交付动作',
          issue: '交付发生过晚',
          instruction: '把交付提前到水位到达第一步之前',
        }),
      ]);
      expect(results.find(result => result.stage === 'revision')?.status).toBe(
        'completed',
      );
      expect(results.find(result => result.stage === 'finalValidate')?.status).toBe(
        'completed',
      );
      expect(results.find(result => result.stage === 'persist')?.status).toBe(
        'completed',
      );
      expect(
        transport.mock.calls.filter(call => call[2].scenario === 'pipeline_brief'),
      ).toHaveLength(1);
      expect(persistFinal).toHaveBeenCalledTimes(1);
    } finally {
      transport.mockRestore();
    }
  });

  test('content-only QA is not adoptable before recovery', () => {
    expect(
      isAdoptableStructuredReport('qa', qaContentOnlyFailureFixture),
    ).toBe(false);
    expect(
      aggregateStageFindings({
        qa: {
          stage: 'qa',
          body: JSON.stringify(qaContentOnlyFailureFixture),
        },
      }),
    ).toEqual([]);
  });

  test('Formatter output that remains invalid fails closed without QA persistence', async () => {
    await setSecureLLMApiKey('sk-qa-contract-test', 7);
    const freeze = buildWritingKernelFreezeTrace({
      request: continuationRequest({
        pipelineTopologyVersion: 'compact_standard',
      }),
    });
    const persistStageArtifact = jest.fn(async () => {});
    const persistStageFailure = jest.fn(async () => {});
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValueOnce(
        physicalResult(JSON.stringify(qaContentOnlyFailureFixture)),
      )
      .mockResolvedValueOnce(
        physicalResult(JSON.stringify(qaContentOnlyFailureFixture)),
      );

    try {
      await expect(
        runWritingStages({
          frozenContext: freeze.frozenContext,
          trace: freeze.trace,
          stages: ['qa'],
          persistAdapter: {
            binding: 'continuation-generation-ledger' as const,
            loadExisting: async () => null,
            reserve: async () => {},
            persistStageArtifact,
            persistStageFailure,
            persistStageSkip: async () => {},
          },
        }),
      ).rejects.toMatchObject({ code: 'SHARED_WRITER_INVALID_REPORT' });
      expect(transport).toHaveBeenCalledTimes(2);
      expect(persistStageArtifact).not.toHaveBeenCalledWith(
        'qa',
        expect.anything(),
      );
      expect(persistStageFailure).toHaveBeenCalledTimes(1);
    } finally {
      transport.mockRestore();
    }
  });
});
