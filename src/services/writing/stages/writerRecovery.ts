/**
 * First-pass recovery that belongs in the Shared Writer.
 *
 * Dual-channel JSON adopt and one thinking-disabled Formatter are production
 * contracts from V3.2. They must not live in a second Outline/Continuation
 * writer core, and they must not become a silent Primary replay.
 */
import type { ChatMessage } from '../../llm/types';
import { selectStructuredCandidate } from '../../pipeline/structuredCandidate';
import type { SharedWritingStageName } from '../contracts/writingPolicy';

export interface QaStructuredContractValidation {
  valid: boolean;
  reason: string | null;
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
    expectedRootKeys:
      input.stage === 'revision'
        ? ['content', 'strategy', 'actions', 'preserve', 'ending', 'verdict']
        : ['content', 'verdict', 'findings'],
    findingKeys: ['findings', 'actions', 'issues', 'errors', 'warnings'],
  });
  if (selection.candidate?.text) {
    return {
      text: selection.candidate.text,
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
        parsed.instructions,
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
          ? 'QA JSON 必须包含 verdict（只能是 pass 或 needs_revision）和 findings 数组；pass 必须 findings=[]，needs_revision 必须至少一条完整 finding。每条 finding 必须有非空 issue、severity（blocking 或 warning）、target 或 requirementIds，以及 instruction 或 target。只能整理候选已有语义，不得猜测或补造字段。'
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
