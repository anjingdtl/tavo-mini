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

export function isStructuredWriterStage(stage: SharedWritingStageName): boolean {
  return (
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
  if (stage === 'factCheck' || stage === 'audit') {
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
        input.stage === 'review' || input.stage === 'factCheck'
          ? '你也是一次性的 Audit Formatter。'
          : '',
        '只整理候选里已经出现的语义，不得重新审阅、不得读取长上下文、不得新增长篇正文。',
        '必须把结果写在 message.content 的 JSON object 里。',
        '禁止只输出 reasoning_content、Markdown 围栏或解释。',
        input.stage === 'revision'
          ? 'JSON 必须包含 strategy、actions、preserve、ending；如候选已有正文则放入 content。'
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
        : `pipeline_${input.stage}_formatter`,
  };
}
