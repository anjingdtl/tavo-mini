const mockGetLatestArtifactForStage = jest.fn();
const mockGetStageResult = jest.fn();
const mockInsertArtifact = jest.fn();
const mockReserveContinuationStage = jest.fn();
const mockUpdateStageResult = jest.fn();
const mockCasUpdateRunState = jest.fn();

jest.mock('../src/services/continuation/generation/generationRepository', () => ({
  casUpdateRunState: (...args: unknown[]) => mockCasUpdateRunState(...args),
  getLatestArtifactForStage: (...args: unknown[]) =>
    mockGetLatestArtifactForStage(...args),
  getStageResult: (...args: unknown[]) => mockGetStageResult(...args),
  insertArtifact: (...args: unknown[]) => mockInsertArtifact(...args),
  reserveContinuationStage: (...args: unknown[]) =>
    mockReserveContinuationStage(...args),
  updateStageResult: (...args: unknown[]) => mockUpdateStageResult(...args),
}));

import { createContinuationDurableAdapter } from '../src/services/writing/persistence/continuationDurableAdapter';

function snapshot() {
  const makeBudget = (stage: string) => ({
    stage,
    configId: 7,
    compiledPromptTokens: 123,
    minimumOutputTokens: 50,
    maximumOutputTokens: 400,
  });
  return {
    stageBudgets: {
      draft_writer: makeBudget('draft_writer'),
      narrative_architect: makeBudget('narrative_architect'),
      revision_writer: makeBudget('revision_writer'),
      adversarial_auditor: makeBudget('adversarial_auditor'),
      // Phase 4 §7.2: the compact Standard ONE QA ledger node.
      unified_qa: makeBudget('unified_qa'),
      final_reviser: makeBudget('final_reviser'),
    },
  } as any;
}

describe('continuation shared-writer durable adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReserveContinuationStage.mockResolvedValue({
      reserved: true,
      result: { requestReserved: true, requestCount: 1 },
    });
    mockGetLatestArtifactForStage.mockResolvedValue(null);
    mockGetStageResult.mockResolvedValue(null);
    mockInsertArtifact.mockResolvedValue({ id: 'artifact-1' });
    mockUpdateStageResult.mockResolvedValue(null);
    mockCasUpdateRunState.mockResolvedValue(true);
  });

  it('reserves the physical ledger node before the shared writer calls the LLM', async () => {
    const adapter = createContinuationDurableAdapter({
      run: { id: 'ct_adapter' } as any,
      snapshot: snapshot(),
    });

    await adapter.reserve?.('draft');

    expect(mockReserveContinuationStage).toHaveBeenCalledWith({
      runId: 'ct_adapter',
      stage: 'draft_writer',
      modelConfigId: 7,
      inputTokens: 123,
      minOutputTokens: 50,
      maxOutputTokens: 400,
    });
  });

  it('persists shared-writer usage into the reserved stage row', async () => {
    const adapter = createContinuationDurableAdapter({
      run: { id: 'ct_adapter' } as any,
      snapshot: snapshot(),
    });

    await adapter.persistStageArtifact('draft', {
      stage: 'draft',
      body: '正文',
      usage: {
        inputTokens: 111,
        outputTokens: 222,
        totalTokens: 333,
        logicalStageCallCount: 1,
        formatterCallCount: 0,
        physicalRequestCount: 2,
        protocolFallbackCount: 1,
      },
      requestReceipts: [
        {
          requestId: 'req_1',
          requestFingerprint: 'abc',
          outcome: 'succeeded',
          kind: 'logical_stage',
          physicalRequestCount: 2,
          protocolFallbackCount: 1,
        } as any,
      ],
    });

    expect(mockUpdateStageResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'ct_adapter',
        stage: 'draft_writer',
        status: 'success',
        inputTokens: 111,
        outputTokens: 222,
      }),
    );
    const persisted = JSON.parse(
      String(mockUpdateStageResult.mock.calls[0][0].outputJson),
    );
    expect(persisted.requestReceipts[0]).toEqual(
      expect.objectContaining({
        requestId: 'req_1',
        requestFingerprint: 'abc',
        outcome: 'succeeded',
      }),
    );
    expect(persisted).toMatchObject({
      logicalStageCallCount: 1,
      formatterCallCount: 0,
      physicalRequestCount: 2,
      protocolFallbackCount: 1,
    });
  });

  it('persists failed-request receipts on the existing stage ledger row', async () => {
    const adapter = createContinuationDurableAdapter({
      run: { id: 'ct_adapter' } as any,
      snapshot: snapshot(),
    });
    await adapter.persistStageFailure?.(
      'revision',
      Object.assign(new Error('provider timeout'), {
        requestReceipts: [
          {
            requestId: 'req_fail',
            requestFingerprint: 'def',
            outcome: 'failed',
          },
        ],
      }),
    );
    const persisted = JSON.parse(
      String(mockUpdateStageResult.mock.calls[0][0].outputJson),
    );
    expect(mockUpdateStageResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'ct_adapter',
        stage: 'revision_writer',
        status: 'failed',
      }),
    );
    expect(persisted.requestReceipts[0].outcome).toBe('failed');
  });

  it('persists failed provider usage alongside the failed request receipt', async () => {
    const adapter = createContinuationDurableAdapter({
      run: { id: 'ct_adapter' } as any,
      snapshot: snapshot(),
    });
    await adapter.persistStageFailure?.(
      'revision',
      Object.assign(new Error('Revision contract rejected'), {
        requestReceipts: [
          {
            requestId: 'req_contract_rejected',
            requestFingerprint: 'ghi',
            outcome: 'succeeded',
            kind: 'logical_stage',
            finishReason: 'stop',
            physicalRequestCount: 1,
            protocolFallbackCount: 0,
            usage: {
              inputTokens: 33445,
              outputTokens: 3767,
              totalTokens: 37212,
            },
          },
        ],
      }),
    );

    expect(mockUpdateStageResult).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 33445,
        outputTokens: 3767,
      }),
    );
  });

  it('can reload a structured report without issuing a duplicate request', async () => {
    mockGetStageResult.mockResolvedValue({
      status: 'success',
      outputJson: JSON.stringify({
        envelope: { findings: [], verdict: 'pass' },
      }),
    });
    const adapter = createContinuationDurableAdapter({
      run: { id: 'ct_adapter' } as any,
      snapshot: snapshot(),
    });

    await expect(adapter.loadExisting?.('review')).resolves.toEqual(
      expect.objectContaining({
        stage: 'review',
        body: JSON.stringify({ findings: [], verdict: 'pass' }),
        structured: { findings: [], verdict: 'pass' },
      }),
    );
  });
});
