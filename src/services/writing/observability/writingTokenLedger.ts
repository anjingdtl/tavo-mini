import type {
  WritingChapterObservability,
  WritingLlmCallRecord,
  WritingStageTimingRecord,
} from './writingChapterObservability';

export interface WritingTokenLedgerCall {
  kind: WritingLlmCallRecord['kind'];
  stage: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  physicalRequestCount: number;
  protocolFallbackCount: number;
  primaryRetryCount: number;
}

export interface WritingTokenLedgerStage {
  status: WritingStageTimingRecord['status'];
  logicalStageCallCount: number;
  formatterCallCount: number;
  physicalRequestCount: number;
  protocolFallbackCount: number;
  primaryRetryCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  calls: WritingTokenLedgerCall[];
}

export interface WritingTokenLedger {
  schemaVersion: 1;
  workflowVersion?: number;
  maxPhysicalRequests?: number;
  logicalStageCallCount: number;
  formatterCallCount: number;
  physicalRequestCount: number;
  protocolFallbackCount: number;
  primaryRetryCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  stages: Record<string, WritingTokenLedgerStage>;
  calls: WritingTokenLedgerCall[];
  postWriting?: WritingChapterObservability['postWriting'];
  writingObservabilityVersion: number;
}

function nonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseObject(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function callLedgerRow(call: WritingLlmCallRecord): WritingTokenLedgerCall {
  const inputTokens = nonNegative(call.inputTokens);
  const outputTokens = nonNegative(call.outputTokens);
  return {
    kind: call.kind,
    stage: call.stage,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    physicalRequestCount: nonNegative(call.physicalRequestCount),
    protocolFallbackCount: nonNegative(call.protocolFallbackCount),
    // The shared post-Freeze Kernel has no automatic primary replay. Keeping
    // this explicit prevents a formatter or protocol fallback from being
    // misreported as a retry.
    primaryRetryCount: 0,
  };
}

function stageLedgerRow(
  stage: WritingStageTimingRecord,
  calls: WritingTokenLedgerCall[],
): WritingTokenLedgerStage {
  const stageCalls = calls.filter(call => call.stage === stage.stage);
  const inputTokens = nonNegative(stage.inputTokens);
  const outputTokens = nonNegative(stage.outputTokens);
  return {
    status: stage.status,
    logicalStageCallCount: nonNegative(stage.logicalStageCallCount),
    formatterCallCount: nonNegative(stage.formatterCallCount),
    physicalRequestCount: nonNegative(stage.physicalRequestCount),
    protocolFallbackCount: nonNegative(stage.protocolFallbackCount),
    primaryRetryCount: 0,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    calls: stageCalls,
  };
}

/**
 * Project the finalized Kernel observability snapshot into the durable run's
 * token ledger. The stage-result `request_count` remains the single logical
 * reservation (and its schema intentionally caps it at one); this separate
 * projection is the authoritative place for the real physical count when a
 * bounded QA Formatter adds a second HTTP request.
 */
export function mergeWritingTokenLedger(
  existingJson: string | null | undefined,
  observability: WritingChapterObservability,
): WritingTokenLedger {
  const existing = parseObject(existingJson);
  const calls = observability.llm.calls.map(callLedgerRow);
  const stages: Record<string, WritingTokenLedgerStage> = {
    ...(existing.stages || {}),
  };
  for (const stage of observability.stages) {
    stages[stage.stage] = stageLedgerRow(stage, calls);
  }

  const inputTokens = nonNegative(observability.llm.inputTokens);
  const outputTokens = nonNegative(observability.llm.outputTokens);
  return {
    ...existing,
    schemaVersion: 1,
    logicalStageCallCount: nonNegative(
      observability.llm.logicalStageCallCount,
    ),
    formatterCallCount: nonNegative(observability.llm.formatterCallCount),
    physicalRequestCount: nonNegative(observability.llm.physicalRequestCount),
    protocolFallbackCount: nonNegative(
      observability.llm.protocolFallbackCount,
    ),
    primaryRetryCount: nonNegative(existing.primaryRetryCount),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    stages,
    calls,
    postWriting: observability.postWriting,
    writingObservabilityVersion: observability.version,
  };
}
