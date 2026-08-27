/**
 * First-pass recovery that belongs in the Shared Writer.
 *
 * Dual-channel JSON adopt and one thinking-disabled Formatter are production
 * contracts from V3.2. They must not live in a second Outline/Continuation
 * writer core, and they must not become a silent Primary replay.
 */
import type { ChatMessage } from '../../llm/types';
import { selectStructuredCandidate } from '../../pipeline/structuredCandidate';
import { sha256Hex } from '../../continuation/hashUtils';
import {
  QA_STATE_PROPOSAL_TYPES,
  resolveEvidenceQuoteLocations,
} from '../prompt/qaStateProposals';
import { normalizeContinuationProposalSubjectRefType } from '../../continuation/generation/types';
import type { SharedWritingStageName } from '../contracts/writingPolicy';

export interface QaStructuredContractValidation {
  valid: boolean;
  reason: string | null;
}

export interface RevisionStructuredContractValidation {
  valid: boolean;
  reason: string | null;
}

/**
 * Bind revision state proposals after the client has assembled the actual
 * Final body. A model cannot reliably calculate SHA-256, and B7 segment
 * repair may assemble a body that was never present verbatim in the model
 * response. The local body remains authoritative; the returned structured
 * contract is only enriched with that deterministic binding.
 */
export function bindRevisionStateProposalFingerprint(input: {
  parsed: Record<string, unknown>;
  finalBody: string;
}): { parsed: Record<string, unknown>; rebound: boolean } {
  const proposals = input.parsed.finalStateProposals;
  if (!Array.isArray(proposals) || proposals.length === 0) {
    return { parsed: input.parsed, rebound: false };
  }
  const expected = sha256Hex(String(input.finalBody ?? ''));
  if (input.parsed.proposalSourceBodyFingerprint === expected) {
    return { parsed: input.parsed, rebound: false };
  }
  return {
    parsed: {
      ...input.parsed,
      proposalSourceBodyFingerprint: expected,
    },
    rebound: true,
  };
}

/**
 * The compact QA admission contract is intentionally stricter than the
 * historical Review/Audit adapters.  Revision must only see findings that
 * already carry the complete structured semantics; this validator never
 * infers them from natural-language content.
 */
export function validateQaStructuredContract(
  parsed: Record<string, unknown> | undefined,
): QaStructuredContractValidation {
  const invalid = (reason: string): QaStructuredContractValidation => ({
    valid: false,
    reason,
  });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalid('root_not_object');
  }

  const verdict = parsed.verdict;
  if (verdict !== 'pass' && verdict !== 'needs_revision') {
    return invalid('verdict');
  }
  if (!Array.isArray(parsed.findings)) {
    return invalid('findings_not_array');
  }
  if (verdict === 'pass' && parsed.findings.length !== 0) {
    return invalid('pass_findings_not_empty');
  }
  if (verdict === 'needs_revision' && parsed.findings.length === 0) {
    return invalid('needs_revision_findings_empty');
  }

  for (let index = 0; index < parsed.findings.length; index += 1) {
    const raw = parsed.findings[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return invalid(`finding[${index}]_not_object`);
    }
    const finding = raw as Record<string, unknown>;
    const issue = nonEmptyString(finding.issue);
    if (!issue) return invalid(`finding[${index}]_issue`);

    if (finding.severity !== 'blocking' && finding.severity !== 'warning') {
      return invalid(`finding[${index}]_severity`);
    }

    const targetResult = optionalStringField(finding, 'target');
    if (!targetResult.valid) return invalid(`finding[${index}]_target_type`);
    const requirementIdsResult = optionalRequirementIds(
      finding,
      'requirementIds',
    );
    if (!requirementIdsResult.valid) {
      return invalid(`finding[${index}]_requirementIds_type`);
    }
    const target = targetResult.value;
    const requirementIds = requirementIdsResult.value;
    if (!target && requirementIds.length === 0) {
      return invalid(`finding[${index}]_location`);
    }
    const instructionResult = optionalStringField(finding, 'instruction');
    if (!instructionResult.valid) {
      return invalid(`finding[${index}]_instruction_type`);
    }
    const instruction = instructionResult.value;
    if (!instruction && !target) {
      return invalid(`finding[${index}]_instruction`);
    }
  }

  return { valid: true, reason: null };
}

/**
 * Compact Revision admission contract.
 *
 * Revision is allowed to produce either a complete `content` body or a
 * segment-repair plan.  The latter is resolved locally by the existing
 * Revision stage.  Everything else is fail-closed: a body is never silently
 * replaced with Draft just because a JSON envelope happened to parse.
 */
export function validateRevisionStructuredContract(input: {
  parsed: Record<string, unknown> | undefined;
  finalBody: string;
}): RevisionStructuredContractValidation {
  const invalid = (reason: string): RevisionStructuredContractValidation => ({
    valid: false,
    reason,
  });
  const parsed = input.parsed;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalid('root_not_object');
  }
  if (parsed.schemaVersion !== 1) return invalid('schemaVersion');

  const strategy = nonEmptyString(parsed.strategy);
  if (!strategy) return invalid('strategy');
  if (!Array.isArray(parsed.actions)) return invalid('actions_not_array');
  if (!Array.isArray(parsed.preserve)) return invalid('preserve_not_array');
  if (!nonEmptyString(parsed.ending)) return invalid('ending');

  const hasSegmentRepairs = Object.prototype.hasOwnProperty.call(
    parsed,
    'segmentRepairs',
  );
  const hasPatches = Object.prototype.hasOwnProperty.call(parsed, 'patches');
  const segmentRepair =
    strategy === 'segment_repair' || hasSegmentRepairs || hasPatches;
  if (hasSegmentRepairs && !Array.isArray(parsed.segmentRepairs)) {
    return invalid('segmentRepairs_not_array');
  }
  if (hasPatches && !Array.isArray(parsed.patches)) {
    return invalid('patches_not_array');
  }
  if (
    strategy === 'segment_repair' &&
    !Array.isArray(parsed.segmentRepairs) &&
    !Array.isArray(parsed.patches)
  ) {
    return invalid('segmentRepairs_missing');
  }

  const content = nonEmptyString(parsed.content);
  if (!content && !segmentRepair && !hasExplicitRevisionNoOp(parsed)) {
    return invalid('content_missing');
  }
  if (segmentRepair && !content && !hasExplicitRevisionNoOp(parsed)) {
    // The local resolver will additionally validate anchors and coverage.  A
    // segment plan may omit content only when it is a real plan, not an empty
    // or otherwise content-less envelope.
    const patches = Array.isArray(parsed.segmentRepairs)
      ? parsed.segmentRepairs
      : Array.isArray(parsed.patches)
      ? parsed.patches
      : [];
    if (patches.length === 0) return invalid('segmentRepairs_empty');
  }

  const hasFinalProposals = Object.prototype.hasOwnProperty.call(
    parsed,
    'finalStateProposals',
  );
  const hasFingerprint = Object.prototype.hasOwnProperty.call(
    parsed,
    'proposalSourceBodyFingerprint',
  );
  if (hasFinalProposals && !Array.isArray(parsed.finalStateProposals)) {
    return invalid('finalStateProposals_not_array');
  }
  if (hasFingerprint && !hasFinalProposals) {
    return invalid('proposal_fingerprint_without_proposals');
  }
  const proposals = hasFinalProposals
    ? (parsed.finalStateProposals as unknown[])
    : [];
  if (proposals.length > 0) {
    const fingerprint = nonEmptyString(parsed.proposalSourceBodyFingerprint);
    if (!fingerprint) return invalid('proposal_source_fingerprint_missing');
    if (fingerprint !== sha256Hex(input.finalBody)) {
      return invalid('proposal_source_fingerprint_mismatch');
    }
    if (!input.finalBody.trim()) return invalid('proposal_final_body_empty');
    for (let index = 0; index < proposals.length; index += 1) {
      const proposal = proposals[index];
      const reason = validateFinalStateProposal(proposal, input.finalBody);
      if (reason) return invalid(`finalStateProposals[${index}]_${reason}`);
    }
  }
  return { valid: true, reason: null };
}

export function hasExplicitRevisionNoOp(parsed: Record<string, unknown>): boolean {
  if (!Array.isArray(parsed.actions) || parsed.actions.length !== 0) {
    return false;
  }
  if (!parsed.validNoOpReasons || typeof parsed.validNoOpReasons !== 'object') {
    return false;
  }
  return Object.values(parsed.validNoOpReasons as Record<string, unknown>).some(
    value => nonEmptyString(value).length > 0,
  );
}

function validateFinalStateProposal(
  value: unknown,
  finalBody: string,
): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'not_object';
  }
  const proposal = value as Record<string, unknown>;
  if (
    typeof proposal.proposalType !== 'string' ||
    !(QA_STATE_PROPOSAL_TYPES as readonly string[]).includes(
      proposal.proposalType,
    )
  ) {
    return 'proposalType';
  }
  if (
    !proposal.payload ||
    typeof proposal.payload !== 'object' ||
    Array.isArray(proposal.payload)
  ) {
    return 'payload';
  }
  if (proposal.risk !== 'normal' && proposal.risk !== 'major') {
    return 'risk';
  }
  const evidenceQuote = nonEmptyString(proposal.evidenceQuote);
  if (evidenceQuote.length < 4 || evidenceQuote.length > 80) {
    return 'evidenceQuote_length';
  }
  if (resolveEvidenceQuoteLocations(finalBody, evidenceQuote).status !== 'accepted') {
    return 'evidenceQuote_not_unique_in_final_body';
  }
  if (
    Object.prototype.hasOwnProperty.call(proposal, 'subjectRefType') &&
    (typeof proposal.subjectRefType !== 'string' ||
      !normalizeContinuationProposalSubjectRefType(proposal.subjectRefType))
  ) {
    return 'subjectRefType';
  }
  if (
    Object.prototype.hasOwnProperty.call(proposal, 'subjectRefId') &&
    (typeof proposal.subjectRefId !== 'string' || !proposal.subjectRefId.trim())
  ) {
    return 'subjectRefId';
  }
  return null;
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalStringField(
  row: Record<string, unknown>,
  key: string,
): { valid: boolean; value: string } {
  if (!Object.prototype.hasOwnProperty.call(row, key)) {
    return { valid: true, value: '' };
  }
  return typeof row[key] === 'string'
    ? { valid: true, value: row[key].trim() }
    : { valid: false, value: '' };
}

function optionalRequirementIds(
  row: Record<string, unknown>,
  key: string,
): { valid: boolean; value: string[] } {
  if (!Object.prototype.hasOwnProperty.call(row, key)) {
    return { valid: true, value: [] };
  }
  if (!Array.isArray(row[key])) return { valid: false, value: [] };
  const values = row[key] as unknown[];
  if (values.some(item => typeof item !== 'string' || !item.trim())) {
    return { valid: false, value: [] };
  }
  return { valid: true, value: values.map(item => (item as string).trim()) };
}

const REVISION_WRAPPER_KEYS = [
  'data',
  'result',
  'output',
  'response',
  'payload',
  'revision',
  'brief',
  'plan',
  'revisionPlan',
  'revision_report',
  'report',
] as const;

const REVISION_CONTENT_ALIASES = [
  'finalContent',
  'revisedContent',
  'revisedText',
  'finalBody',
  'revisedBody',
  'final_body',
  'revised_body',
  'body',
] as const;

const REVISION_ACTION_ALIASES = [
  'changes',
  'modifications',
  'edits',
  'corrections',
] as const;

/**
 * Revision is the only structured stage whose payload has appeared behind a
 * few harmless compatibility envelopes in OpenAI-compatible gateways. Keep
 * that compatibility at the Shared Writer boundary: no scenario adapter or
 * finalizer is allowed to invent a second interpretation.
 *
 * This is shape normalization only. It does not infer QA findings, state
 * proposals, offsets, or any semantic correction. In particular, a
 * `stateProposals` field is never promoted to `finalStateProposals` here.
 */
export function normalizeStructuredWriterPayload(
  stage: SharedWritingStageName,
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  if (stage !== 'revision') return parsed;

  const hasRevisionSignal = (value: Record<string, unknown>): boolean => {
    const direct = [
      'content',
      'strategy',
      'actions',
      'preserve',
      'ending',
      'verdict',
      'instructions',
      'segmentRepairs',
      'patches',
    ].some(key => Object.prototype.hasOwnProperty.call(value, key));
    if (direct) return true;
    // A string report is a legacy Brief payload; an object report is a
    // wrapper and must still be unwrapped below so B7 fields are not lost.
    return typeof value.report === 'string' && value.report.trim().length > 0;
  };

  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;

  let selected = parsed;
  if (!hasRevisionSignal(selected)) {
    for (const key of REVISION_WRAPPER_KEYS) {
      const nested = asRecord(selected[key]);
      if (!nested) continue;
      const normalizedNested = normalizeStructuredWriterPayload(
        stage,
        nested,
      );
      if (hasRevisionSignal(normalizedNested)) {
        // Retain only revision metadata that a wrapper may legitimately carry.
        // Arbitrary wrapper fields must not become part of the business
        // contract or accidentally look like a QA report.
        const inherited: Record<string, unknown> = {};
        for (const metadataKey of [
          'schemaVersion',
          'finalStateProposals',
          'proposalSourceBodyFingerprint',
          'evidenceQuote',
          'diagnostics',
          'validNoOpRequirementIds',
          'validNoOpReasons',
        ]) {
          if (Object.prototype.hasOwnProperty.call(selected, metadataKey)) {
            inherited[metadataKey] = selected[metadataKey];
          }
        }
        selected = { ...inherited, ...normalizedNested };
        break;
      }
    }
  }

  const normalized = { ...selected };
  if (
    !Object.prototype.hasOwnProperty.call(normalized, 'content') ||
    !String(normalized.content || '').trim()
  ) {
    for (const key of REVISION_CONTENT_ALIASES) {
      const value = normalized[key];
      if (typeof value === 'string' && value.trim()) {
        normalized.content = value;
        break;
      }
    }
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'actions')) {
    for (const key of REVISION_ACTION_ALIASES) {
      if (Array.isArray(normalized[key])) {
        normalized.actions = normalized[key];
        break;
      }
    }
  }
  if (
    !Object.prototype.hasOwnProperty.call(normalized, 'strategy') &&
    typeof normalized.mode === 'string' &&
    normalized.mode.trim()
  ) {
    normalized.strategy = normalized.mode;
  }
  if (
    !Object.prototype.hasOwnProperty.call(normalized, 'ending') &&
    typeof normalized.conclusion === 'string' &&
    normalized.conclusion.trim()
  ) {
    normalized.ending = normalized.conclusion;
  }
  return normalized;
}

export function isStructuredWriterStage(stage: SharedWritingStageName): boolean {
  // Phase 4 (二 §7.2): the unified `qa` stage is structurally identical to
  // the legacy review/audit/factCheck trio for adoption purposes (json
  // envelope + verdict + findings).
  return (
    stage === 'qa' ||
    stage === 'review' ||
    stage === 'audit' ||
    stage === 'factCheck' ||
    stage === 'revision'
  );
}

export function adoptStructuredWriterText(input: {
  stage: SharedWritingStageName;
  outputContract: 'prose' | 'json_envelope';
  text?: string | null;
  reasoningText?: string | null;
}): { text: string; adoptedFrom: 'content' | 'reasoning' | null } {
  const content = String(input.text || '').trim();
  const reasoning = String(input.reasoningText || '').trim();
  const structured =
    isStructuredWriterStage(input.stage) ||
    input.outputContract === 'json_envelope';
  if (!structured) {
    return { text: content, adoptedFrom: content ? 'content' : null };
  }
  const selection = selectStructuredCandidate({
    content,
    reasoning,
    allowSingleItemArray: input.stage === 'revision',
    expectedRootKeys:
      input.stage === 'revision'
        ? [
            'content',
            'body',
            'finalContent',
            'revisedBody',
            'strategy',
            'actions',
            'preserve',
            'ending',
            'verdict',
            'report',
          ]
        : ['content', 'verdict', 'findings'],
    findingKeys: ['findings', 'actions', 'issues', 'errors', 'warnings'],
  });
  if (selection.candidate?.text) {
    const normalized = normalizeStructuredWriterPayload(
      input.stage,
      selection.candidate.parsed,
    );
    return {
      text: JSON.stringify(normalized),
      adoptedFrom: selection.candidate.channel,
    };
  }
  return { text: content, adoptedFrom: content ? 'content' : null };
}

export function isAdoptableStructuredReport(
  stage: SharedWritingStageName,
  parsed: Record<string, unknown> | undefined,
): boolean {
  if (!parsed) return false;
  // Phase 4 §7.2: ONE QA uses the simplified verdict + findings contract; the
  // legacy review stage keeps its stricter requirement (verdict + another
  // structural field) so historical resume does not silently swallow empty
  // reviews.
  if (stage === 'qa') {
    return validateQaStructuredContract(parsed).valid;
  }
  if (stage === 'review') {
    return Boolean(
      (parsed.verdict &&
        (parsed.outlineAssessment ||
          parsed.coverage ||
          parsed.checked ||
          parsed.content)) ||
        parsed.issues ||
        parsed.strengths ||
        parsed.suggestions,
    );
  }
  if (stage === 'audit' || stage === 'factCheck') {
    return Boolean(
      parsed.verdict ||
        parsed.errors ||
        parsed.warnings ||
        parsed.confirmed,
    );
  }
  if (stage === 'revision') {
    return Boolean(
      parsed.content ||
        parsed.strategy ||
        parsed.verdict ||
        parsed.actions ||
        parsed.instructions ||
        parsed.preserve ||
        parsed.ending ||
        parsed.segmentRepairs ||
        parsed.patches ||
        parsed.report,
    );
  }
  return true;
}

export function shouldRunWriterFormatter(input: {
  stage: SharedWritingStageName;
  outputContract: 'prose' | 'json_envelope';
  adoptedText: string;
  hasReasoning: boolean;
}): boolean {
  if (input.adoptedText.trim()) return false;
  if (
    isStructuredWriterStage(input.stage) ||
    input.outputContract === 'json_envelope'
  ) {
    return true;
  }
  return input.stage === 'draft' || input.stage === 'proof'
    ? input.hasReasoning
    : false;
}

export function compileSharedWriterFormatterPrompt(input: {
  stage: SharedWritingStageName;
  outputContract: 'prose' | 'json_envelope';
  candidate: string;
}): { messages: ChatMessage[]; scenario: string } {
  const structured =
    isStructuredWriterStage(input.stage) ||
    input.outputContract === 'json_envelope';
  const stageLabel =
    input.stage === 'revision'
      ? 'Brief'
      : input.stage === 'factCheck'
      ? 'FactCheck'
      : input.stage === 'qa'
      ? 'QA'
      : input.stage === 'review'
      ? 'Review'
      : input.stage;
  const system = structured
    ? [
        `你是一次性的 Shared ${input.stage} Formatter。`,
        `当前阶段：${stageLabel}。`,
        input.stage === 'revision'
          ? '当前统一流水线的 Brief Compiler 只整理修订合同。'
          : '',
        input.stage === 'qa' ||
        input.stage === 'review' ||
        input.stage === 'factCheck'
          ? '你也是一次性的 QA / Audit Formatter。'
          : '',
        '只整理候选里已经出现的语义，不得重新审阅、不得读取长上下文、不得新增长篇正文。',
        '必须把结果写在 message.content 的 JSON object 里。',
        '禁止只输出 reasoning_content、Markdown 围栏或解释。',
        input.stage === 'revision'
          ? 'JSON 必须包含 strategy、actions、preserve、ending；如候选已有正文则放入 content。'
          : input.stage === 'qa'
          ? 'QA JSON 必须包含 verdict（只能是 pass 或 needs_revision）和 findings 数组；pass 必须 findings=[]，needs_revision 必须至少一条完整 finding。每条 finding 必须有非空 issue、severity（blocking 或 warning）、target 或 requirementIds，以及 instruction 或 target。最多保留 3 条最高优先级问题，字段保持简短；只能整理候选已有语义，不得猜测或补造字段。'
          : 'JSON 必须包含 content、verdict、findings；没有问题时 findings 必须是 []。',
      ]
        .filter(Boolean)
        .join('\n')
    : [
        `你是一次性的 Shared ${input.stage} Formatter。`,
        '候选只有推理、没有正文。请直接输出本章完整正文。',
        '不要输出标题、分析、JSON 或过程说明。',
      ].join('\n');
  return {
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({
          stage: input.stage,
          candidate: String(input.candidate || '').trim().slice(0, 12000),
        }),
      },
    ],
    scenario:
      input.stage === 'revision'
        ? 'pipeline_brief_formatter'
        : input.stage === 'factCheck'
        ? 'pipeline_factcheck_formatter'
        : input.stage === 'qa'
        ? 'pipeline_qa_formatter'
        : `pipeline_${input.stage}_formatter`,
  };
}
