import {
  casUpdateRunState,
  getLatestArtifactForStage,
  getStageResult,
  insertArtifact,
  reserveContinuationStage,
  updateStageResult,
} from '../../continuation/generation/generationRepository';
import { hashContent } from '../../continuation/generation/continuationV5Contracts';
import type {
  ContinuationContextSnapshotV5,
  ContinuationGenerationRun,
} from '../../continuation/generation/types';
import type {
  SharedWritingArtifact,
  SharedWritingStageName,
  SharedWritingStageResult,
  WritingDurablePersistAdapter,
  WritingStageArtifacts,
} from '../contracts/writingStage';

function ledgerStage(
  stage: SharedWritingStageName,
): 'draft' | 'revision_1' | 'final' | null {
  if (stage === 'draft') return 'draft';
  if (stage === 'revision') return 'revision_1';
  if (stage === 'proof' || stage === 'persist' || stage === 'finalValidate') {
    return 'final';
  }
  return null;
}

function receiptNumber(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function summarizeReceiptAccounting(
  receiptsValue: unknown,
  usage: SharedWritingArtifact['usage'] | undefined,
): {
  receipts: unknown[];
  logicalStageCallCount: number;
  formatterCallCount: number;
  physicalRequestCount: number;
  protocolFallbackCount: number;
} {
  const receipts = Array.isArray(receiptsValue) ? receiptsValue : [];
  const logicalStageCallCount = receipts.filter(
    item => (item as { kind?: unknown })?.kind === 'logical_stage',
  ).length;
  const formatterCallCount = receipts.filter(
    item => (item as { kind?: unknown })?.kind === 'formatter',
  ).length;
  const physicalRequestCount = receipts.reduce(
    (sum, item) =>
      sum +
      receiptNumber(
        (item as { physicalRequestCount?: unknown })?.physicalRequestCount,
        1,
      ),
    0,
  );
  const protocolFallbackCount = receipts.reduce(
    (sum, item) =>
      sum +
      receiptNumber(
        (item as { protocolFallbackCount?: unknown })?.protocolFallbackCount,
        0,
      ),
    0,
  );
  if (
    usage?.physicalRequestCount != null &&
    receipts.length > 0 &&
    receiptNumber(usage.physicalRequestCount, 0) !== physicalRequestCount
  ) {
    throw new Error(
      `WRITING_ACCOUNTING_RECEIPT_MISMATCH: usage physical=${usage.physicalRequestCount} receipt physical=${physicalRequestCount}`,
    );
  }
  if (
    usage?.protocolFallbackCount != null &&
    receipts.length > 0 &&
    receiptNumber(usage.protocolFallbackCount, 0) !== protocolFallbackCount
  ) {
    throw new Error(
      `WRITING_ACCOUNTING_RECEIPT_MISMATCH: usage fallback=${usage.protocolFallbackCount} receipt fallback=${protocolFallbackCount}`,
    );
  }
  return {
    receipts,
    logicalStageCallCount:
      usage?.logicalStageCallCount ?? logicalStageCallCount,
    formatterCallCount: usage?.formatterCallCount ?? formatterCallCount,
    physicalRequestCount:
      usage?.physicalRequestCount ?? physicalRequestCount,
    protocolFallbackCount:
      usage?.protocolFallbackCount ?? protocolFallbackCount,
  };
}

export function createContinuationDurableAdapter(input: {
  run: ContinuationGenerationRun;
  snapshot: ContinuationContextSnapshotV5;
}): WritingDurablePersistAdapter {
  return {
    binding: 'continuation-generation-ledger',
    async loadExisting(stage) {
      return loadContinuationArtifact(input.run.id, stage);
    },
    async reserve(stage) {
      const node = continuationNode(stage);
      // final_validate is a local zero-request settlement node; factCheck and
      // persist have no physical V5 ledger node and must remain formal skips.
      if (!node || node === 'final_validate') return;
      const budget = input.snapshot.stageBudgets[node];
      const reservation = await reserveContinuationStage({
        runId: input.run.id,
        stage: node,
        modelConfigId: budget.configId,
        inputTokens: budget.compiledPromptTokens,
        minOutputTokens: budget.minimumOutputTokens,
        maxOutputTokens: budget.maximumOutputTokens,
      });
      if (!reservation.reserved) {
        // A persisted reservation is authoritative. The shared writer must
        // fail closed here instead of issuing a duplicate LLM request after a
        // resume or concurrent driver.
        throw new Error(
          `续写阶段 ${node} 已存在持久 reservation，禁止重复请求。`,
        );
      }
    },
    async persistStageArtifact(stage, artifact) {
      const mapped = ledgerStage(stage);
      if (mapped && artifact.body.trim()) {
        const existing = await getLatestArtifactForStage(input.run.id, mapped);
        if (!existing) {
          await insertArtifact({
            runId: input.run.id,
            stage: mapped,
            content: artifact.body,
            eligibilityStatus: mapped === 'final' ? 'eligible' : 'intermediate',
            requireStageMatch: true,
          });
        }
      }
      const node = continuationNode(stage);
      if (node) {
        const accounting = summarizeReceiptAccounting(
          artifact.requestReceipts,
          artifact.usage,
        );
        await updateStageResult({
          runId: input.run.id,
          stage: node,
          status: artifact.body.trim() || artifact.structured ? 'success' : 'skipped',
          outputJson: JSON.stringify({
            schemaVersion: 1,
            envelope: artifact.structured || { content: artifact.body },
            contentHash: hashContent(artifact.body || ''),
            ...(accounting.receipts.length > 0
              ? { requestReceipts: accounting.receipts }
              : {}),
            logicalStageCallCount: accounting.logicalStageCallCount,
            formatterCallCount: accounting.formatterCallCount,
            physicalRequestCount: accounting.physicalRequestCount,
            protocolFallbackCount: accounting.protocolFallbackCount,
          }),
          inputTokens: artifact.usage?.inputTokens,
          outputTokens: artifact.usage?.outputTokens,
        });
      }
    },
    async persistStageFailure(stage, error) {
      const node = continuationNode(stage);
      if (!node) return;
      const receipts = (error as { requestReceipts?: unknown }).requestReceipts;
      const accounting = summarizeReceiptAccounting(receipts, undefined);
      await updateStageResult({
        runId: input.run.id,
        stage: node,
        status: 'failed',
        outputJson: JSON.stringify({
          schemaVersion: 1,
          error: error instanceof Error ? error.message : String(error || ''),
          ...(accounting.receipts.length > 0
            ? { requestReceipts: accounting.receipts }
            : {}),
          logicalStageCallCount: accounting.logicalStageCallCount,
          formatterCallCount: accounting.formatterCallCount,
          physicalRequestCount: accounting.physicalRequestCount,
          protocolFallbackCount: accounting.protocolFallbackCount,
        }),
      });
    },
    async persistStageSkip(stage, result: SharedWritingStageResult) {
      // Formal skip (One-Shot profile): settle the ledger row on the EXISTING
      // `skipped` status (schema-32 CHECK already allows it) with the frozen
      // skip provenance. No request is issued, no artifact is written, and a
      // skipped stage must never be readable back as executed output.
      const node = continuationNode(stage);
      if (!node) return;
      await updateStageResult({
        runId: input.run.id,
        stage: node,
        status: 'skipped',
        outputJson: JSON.stringify({
          schemaVersion: 1,
          envelope: {
            skipped: true,
            skipReason: result.skipReason || 'policy_skipped',
            policyRuleId: result.policyRuleId || null,
          },
          contentHash: hashContent(''),
        }),
      });
    },
    async persistFinal(artifacts: WritingStageArtifacts) {
      const body = readFinalBody(artifacts);
      if (body.trim()) {
        const existing = await getLatestArtifactForStage(input.run.id, 'final');
        if (!existing) {
          await insertArtifact({
            runId: input.run.id,
            stage: 'final',
            content: body,
            eligibilityStatus: 'eligible',
            requireStageMatch: true,
          });
        }
      }
      await casUpdateRunState(input.run.id, ['running'], {
        state: 'awaiting_user',
        stage: 'awaiting_user',
      });
      void input.snapshot;
    },
  };
}

function continuationNode(
  stage: SharedWritingStageName,
):
  | 'draft_writer'
  | 'narrative_architect'
  | 'revision_writer'
  | 'adversarial_auditor'
  | 'unified_qa'
  | 'final_reviser'
  | 'final_validate'
  | null {
  switch (stage) {
    case 'draft':
      return 'draft_writer';
    case 'review':
      return 'narrative_architect';
    case 'qa':
      // Phase 4 (二 §7.2): the compact Standard QA writes its structured
      // report to a dedicated continuation ledger node. Historical review /
      // audit / factCheck rows stay on narrative_architect / adversarial_
      // auditor for legacy resume.
      return 'unified_qa';
    case 'revision':
      return 'revision_writer';
    case 'audit':
      return 'adversarial_auditor';
    case 'proof':
      return 'final_reviser';
    case 'finalValidate':
      return 'final_validate';
    default:
      return null;
  }
}

function readFinalBody(artifacts: WritingStageArtifacts): string {
  for (const key of ['finalValidate', 'proof', 'revision', 'draft']) {
    const value = artifacts[key] as SharedWritingArtifact | undefined;
    if (value?.body?.trim()) return value.body;
  }
  return '';
}

export async function loadContinuationArtifact(
  runId: string,
  stage: SharedWritingStageName,
): Promise<SharedWritingArtifact | null> {
  const mapped = ledgerStage(stage);
  if (!mapped) {
    const node = continuationNode(stage);
    if (!node) return null;
    const row = await getStageResult(runId, node);
    if (!row?.outputJson) return null;
    try {
      const parsed = JSON.parse(row.outputJson);
      const envelope = parsed?.envelope;
      const body =
        typeof envelope?.content === 'string'
          ? envelope.content
          : typeof envelope?.body === 'string'
            ? envelope.body
            : typeof envelope?.report === 'string'
              ? envelope.report
              : envelope && typeof envelope === 'object'
                ? JSON.stringify(envelope)
                : '';
      return {
        stage,
        body,
        structured: envelope,
      };
    } catch {
      return null;
    }
  }
  const existing = await getLatestArtifactForStage(runId, mapped);
  if (!existing) return null;
  return { stage, body: existing.content, structured: { contentHash: existing.contentHash } };
}
