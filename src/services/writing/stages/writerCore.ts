/**
 * THE one Shared Writer Core. Every post-Freeze prose stage goes through here.
 */
import type { LLMRequestConfig } from '../../llm/types';
import { compileSharedWritingPrompt } from '../prompt/sharedPromptCompiler';
import { resolveWritingCredential } from './resolveFrozenCredential';
import type {
  SharedWritingArtifact,
  SharedWritingStageInput,
} from '../contracts/writingStage';
import type { SharedWritingStageName } from '../contracts/writingPolicy';
import { resolveSharedStageSkip } from '../contracts/writingPolicy';
import { evaluateWritingRequirements } from '../contracts/writingRequirement';
import { callWritingStageLLM } from './stageLlmCall';

export function emptyRequirementResult() {
  return {
    ok: false,
    satisfiedIds: [] as string[],
    missingIds: [] as string[],
    blockingIds: [] as string[],
    falseAppliedIds: [] as string[],
  };
}

export function gateSharedStageInput(input: SharedWritingStageInput): string | null {
  if (
    input.stagePolicy.requirementsFingerprint !== input.requirements.fingerprint
  ) {
    return 'WRITING_REQUIREMENT_FINGERPRINT_DRIFT';
  }
  if (!input.frozenContext.freezeFingerprint) {
    return 'WRITING_FROZEN_CONTEXT_MISSING';
  }
  if (input.trace.freezeFingerprint !== input.frozenContext.freezeFingerprint) {
    return 'WRITING_FREEZE_FINGERPRINT_DRIFT';
  }
  if (
    input.trace.requirementsFingerprint &&
    input.trace.requirementsFingerprint !== input.requirements.fingerprint
  ) {
    return 'WRITING_REQUIREMENT_FINGERPRINT_DRIFT';
  }
  return null;
}

export function skippedStageResult(
  stage: SharedWritingStageName,
  input: SharedWritingStageInput,
  skipReason: string,
  policyRuleId: string,
) {
  return {
    stage,
    status: 'skipped' as const,
    artifact: {
      stage,
      body: '',
      structured: { skipped: true, skipReason, policyRuleId },
      diagnostics: [skipReason],
    },
    diagnostics: [skipReason],
    skipReason,
    policyRuleId,
    requirementResult: evaluateWritingRequirements({
      requirements: input.requirements,
      satisfiedIds: [],
    }),
  };
}

export function parseSharedWriterOutput(
  stage: SharedWritingStageName,
  text: string,
): SharedWritingArtifact {
  const trimmed = String(text || '').trim();
  const extracted = extractJsonObject(trimmed);
  if (extracted) {
    const json = extracted.value;
    const body =
      typeof json.content === 'string' && json.content.trim()
        ? json.content
        : typeof json.body === 'string' && json.body.trim()
        ? json.body
        : typeof json.report === 'string' && json.report.trim()
        ? json.report
        : extracted.raw;
    return {
      stage,
      body,
      structured: json,
      appliedRequirementIds: asStringArray(
        json.appliedObligationIds ||
          json.appliedRequirementIds ||
          json.appliedCanonRequirementIds,
      ),
      validNoOpRequirementIds: asStringArray(json.validNoOpRequirementIds),
      validNoOpReasons:
        json.validNoOpReasons && typeof json.validNoOpReasons === 'object'
          ? (json.validNoOpReasons as Record<string, string>)
          : undefined,
      diagnostics: asStringArray(json.diagnostics || json.findings),
    };
  }
  return { stage, body: trimmed, diagnostics: [] };
}

function assertStructuredReport(
  stage: SharedWritingStageName,
  artifact: SharedWritingArtifact,
): void {
  if (stage !== 'review' && stage !== 'audit' && stage !== 'factCheck') {
    return;
  }
  const structured = artifact.structured;
  const keys = [
    'issues',
    'findings',
    'errors',
    'suggestions',
    'strengths',
    'verdict',
    'report',
    'checked',
    'warnings',
    'confirmed',
  ];
  const hasSignal =
    structured != null &&
    keys.some(key => structured[key] != null);
  if (!hasSignal) {
    throw Object.assign(new Error(`${stage} 返回格式无效，需要结构化报告`), {
      code: 'SHARED_WRITER_INVALID_REPORT',
    });
  }
}

function extractJsonObject(
  text: string,
): { value: Record<string, unknown>; raw: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const raw = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { value: parsed as Record<string, unknown>, raw }
      : null;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

export async function executeSharedWriterStage(input: {
  stage: SharedWritingStageName;
  stageInput: SharedWritingStageInput;
}): Promise<SharedWritingArtifact> {
  const { stage, stageInput } = input;
  const existing = await stageInput.persistAdapter?.loadExisting?.(stage);
  if (existing?.body?.trim()) {
    return existing;
  }
  await stageInput.persistAdapter?.reserve?.(stage);
  const compiled = compileSharedWritingPrompt({
    stage,
    frozenContext: stageInput.frozenContext,
    artifacts: stageInput.artifacts,
    requirements: stageInput.requirements,
    stagePolicy: stageInput.stagePolicy,
  });
  const maxTokens = Math.min(
    compiled.maxTokens,
    Math.max(256, stageInput.modelConfig.maxOutputTokens || compiled.maxTokens),
  );
  if (stageInput.callStage) {
    const injected = await stageInput.callStage({
      stage,
      messages: compiled.messages,
      maxTokens,
      configId: stageInput.modelConfig.configId,
      responseFormat: compiled.responseFormat,
    });
    const artifact = parseSharedWriterOutput(stage, injected.text || '');
    if (!artifact.body.trim()) {
      throw emptyWriterError(stage, injected);
    }
    assertStructuredReport(stage, artifact);
    attachUsage(artifact, injected);
    await stageInput.persistAdapter?.persistStageArtifact(stage, artifact);
    return artifact;
  }

  const requestConfig = await resolveFrozenRequestConfig(stageInput);
  const isReport =
    stage === 'review' || stage === 'audit' || stage === 'factCheck';
  const result = await callWritingStageLLM(
    compiled.messages,
    maxTokens,
    {
      queueClass: 'pipeline',
      queuePriority: 'normal',
      projectId: stageInput.frozenContext.projectId,
      taskId: stageInput.frozenContext.writingRunId,
      scenario:
        stage === 'revision'
          ? 'pipeline_brief'
          : stage === 'factCheck'
          ? 'pipeline_factcheck'
          : `pipeline_${stage}`,
      responseFormat:
        compiled.responseFormat === 'json_object' || isReport
          ? 'json_object'
          : undefined,
      thinking: isReport
        ? { type: 'disabled' }
        : stageInput.modelConfig.thinking,
      reasoningEffort: isReport
        ? undefined
        : stageInput.modelConfig.reasoningEffort,
      temperature: isReport ? 0.2 : undefined,
      top_p: isReport ? 1 : undefined,
      requestConfig,
    },
    stageInput.abortSignal,
  );
  const artifact = parseSharedWriterOutput(stage, result.text || '');
  if (!artifact.body.trim()) {
    throw emptyWriterError(stage, result);
  }
  assertStructuredReport(stage, artifact);
  attachUsage(artifact, result);
  await stageInput.persistAdapter?.persistStageArtifact(stage, artifact);
  return artifact;
}

function attachUsage(
  artifact: SharedWritingArtifact,
  result: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    usage?: { prompt?: number; completion?: number; total?: number };
  },
): void {
  const inputTokens = Number(
    result.inputTokens ?? result.usage?.prompt ?? 0,
  );
  const outputTokens = Number(
    result.outputTokens ?? result.usage?.completion ?? 0,
  );
  artifact.usage = {
    inputTokens,
    outputTokens,
    totalTokens: Number(
      result.totalTokens ?? result.usage?.total ?? inputTokens + outputTokens,
    ),
  };
}

function emptyWriterError(
  stage: SharedWritingStageName,
  result: {
    emptyReason?: string | null;
    finishReason?: string | null;
    reasoningText?: string | null;
    text?: string | null;
  },
): Error & { code: string } {
  const reason = result.emptyReason || result.finishReason || 'empty';
  const reasoningOnly =
    result.emptyReason === 'reasoning_only' ||
    (Boolean(result.reasoningText && String(result.reasoningText).trim()) &&
      !String(result.text || '').trim());
  const message = reasoningOnly
    ? `${stage} 只返回了推理内容，未返回正文（${reason}）`
    : `${stage} 未返回正文（${reason}）`;
  return Object.assign(new Error(message), {
    code: 'SHARED_WRITER_EMPTY_OUTPUT',
  });
}

async function resolveFrozenRequestConfig(
  input: SharedWritingStageInput,
): Promise<LLMRequestConfig> {
  const frozen = input.modelConfig;
  if (!String(frozen.url || '').trim()) {
    throw Object.assign(
      new Error('冻结模型缺少 endpoint，无法在 Freeze 后发起请求'),
      { code: 'WRITING_FROZEN_MODEL_INCOMPLETE' },
    );
  }
  const apiKey = await resolveWritingCredential(
    frozen.credentialRef ??
      (frozen.configId != null
        ? { kind: 'llm-config-api-key', configId: frozen.configId }
        : null),
  );
  return {
    id: frozen.configId ?? undefined,
    name: frozen.name,
    provider_type: (frozen.providerType ||
      'openai_compatible') as LLMRequestConfig['provider_type'],
    api_key: apiKey,
    model_name: frozen.modelName,
    url: frozen.url,
    context_window: frozen.contextWindow,
    max_output_tokens: frozen.maxOutputTokens,
    allow_insecure_lan_http: frozen.allowInsecureLanHttp,
    thinking: frozen.thinking,
  };
}

export function evaluateStageRequirements(
  input: SharedWritingStageInput,
  artifact: SharedWritingArtifact,
) {
  return evaluateWritingRequirements({
    requirements: input.requirements,
    satisfiedIds: artifact.appliedRequirementIds || [],
  });
}

export function resolveStageSkipOrNull(
  stage: SharedWritingStageName,
  input: SharedWritingStageInput,
) {
  return resolveSharedStageSkip(input.stagePolicy, stage);
}
