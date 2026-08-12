const mockGetPipelineTaskForDerivedFinalRewrite = jest.fn();
const mockGetPipelineTaskFinalTextPayload = jest.fn();
const mockGetPipelineTaskContextPayload = jest.fn();
const mockCreateDerivedPipelineTaskWithCheckpoints = jest.fn();
const mockGetStageCheckpointsForDerivedFinalRewrite = jest.fn();
const mockParsePersistedPipelineTaskContext = jest.fn();
const mockRegisterPersistedTask = jest.fn();

jest.mock('../src/data/repositories/pipelineTaskRepository', () => ({
  createDerivedPipelineTaskWithCheckpoints: (
    ...args: unknown[]
  ) => mockCreateDerivedPipelineTaskWithCheckpoints(...args),
  getPipelineTaskContextPayload: (...args: unknown[]) =>
    mockGetPipelineTaskContextPayload(...args),
  getPipelineTaskFinalTextPayload: (...args: unknown[]) =>
    mockGetPipelineTaskFinalTextPayload(...args),
  getPipelineTaskForDerivedFinalRewrite: (...args: unknown[]) =>
    mockGetPipelineTaskForDerivedFinalRewrite(...args),
}));

jest.mock('../src/data/repositories/pipelineStageCheckpointRepository', () => ({
  checkpointsToStageResults: jest.requireActual(
    '../src/data/repositories/pipelineStageCheckpointRepository',
  ).checkpointsToStageResults,
  getStageCheckpointsForDerivedFinalRewrite: (...args: unknown[]) =>
    mockGetStageCheckpointsForDerivedFinalRewrite(...args),
}));

jest.mock('../src/services/pipelineTaskContext', () => ({
  parsePersistedPipelineTaskContext: (...args: unknown[]) =>
    mockParsePersistedPipelineTaskContext(...args),
}));

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({ registerPersistedTask: mockRegisterPersistedTask }),
  },
}));

import { createDerivedFinalRewriteTask } from '../src/services/pipeline/derivedFinalRewrite';
import {
  cloneDefaultContextAutomationPolicyV3,
  hashContextAutomationPolicyV3,
} from '../src/services/contextAutomationPolicy';

const sourceTask = {
  id: 'parent-v6-without-policy',
  targetType: 'chapter',
  targetId: 1,
  status: 'completed',
  error: null,
  inputFingerprint: 'input-fingerprint',
  pipelineContextVersion: 4,
  pipelineContextHash: 'context-hash',
  outlineWorkflowVersion: 4,
  contextBudgetVersion: 6,
  parentTaskId: null,
  derivedKind: null,
  derivedInstruction: null,
  createdAt: 1,
  updatedAt: 2,
  resolvedAt: null,
  resolvedAction: null,
};

const sourceCheckpoints = ['draft', 'review', 'factCheck', 'brief', 'proof'].map(
  stage => ({
    taskId: sourceTask.id,
    stage,
    status: 'succeeded',
    outputText: `${stage} output`,
    errorCode: null,
    errorMessage: null,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    durationMs: 1,
    attemptCount: 1,
    startedAt: 1,
    completedAt: 2,
    updatedAt: 2,
  }),
);

describe('derived Final policy freeze', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPipelineTaskForDerivedFinalRewrite.mockResolvedValue(sourceTask);
    mockGetPipelineTaskFinalTextPayload.mockResolvedValue('parent final');
    mockGetPipelineTaskContextPayload.mockResolvedValue('{}');
    mockGetStageCheckpointsForDerivedFinalRewrite.mockResolvedValue(
      sourceCheckpoints,
    );
    mockParsePersistedPipelineTaskContext.mockReturnValue({
      version: 4,
      draftContext: {},
      auditContext: null,
      execution: {
        pipelineMode: 'full',
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 6,
        reasoningProfileVersion: 5,
      },
      frozenDraftRequest: null,
      frozenAuditCandidates: null,
      createdAt: 1,
    });
  });

  test('fails closed when a V6 parent has no frozen V3 policy', async () => {
    await expect(
      createDerivedFinalRewriteTask(sourceTask.id, 'tighten dialogue'),
    ).rejects.toThrow(/冻结.*策略/);
    expect(mockCreateDerivedPipelineTaskWithCheckpoints).not.toHaveBeenCalled();
  });

  test('retains a valid parent V3 policy in the derived task context', async () => {
    const policy = cloneDefaultContextAutomationPolicyV3();
    mockParsePersistedPipelineTaskContext.mockReturnValue({
      version: 4,
      draftContext: {},
      auditContext: null,
      execution: {
        pipelineMode: 'full',
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 6,
        reasoningProfileVersion: 5,
        contextAutomationPolicyVersion: 'context-automation-v3',
        contextAutomationPolicyHash: hashContextAutomationPolicyV3(policy),
        contextAutomationPolicySnapshot: policy,
      },
      frozenDraftRequest: null,
      frozenAuditCandidates: null,
      createdAt: 1,
    });

    await createDerivedFinalRewriteTask(sourceTask.id, 'tighten dialogue');

    expect(mockCreateDerivedPipelineTaskWithCheckpoints).toHaveBeenCalledWith(
      expect.objectContaining({
        contextBudgetVersion: 6,
        pipelineContextJson: '{}',
        parentTaskId: sourceTask.id,
      }),
      expect.any(Array),
    );
  });
});
