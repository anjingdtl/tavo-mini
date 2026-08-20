/**
 * Unified Findings Aggregator.
 *
 * Revision / Proof consume this list instead of stacking the full
 * Review + Audit + FactCheck report bodies.
 */
import type { WritingStageArtifacts } from '../contracts/writingStage';
import { validateQaStructuredContract } from '../stages/writerRecovery';

export type FindingsSourceStage = 'qa' | 'review' | 'audit' | 'factCheck';

export interface AggregatedFinding {
  findingId: string;
  sourceStage: FindingsSourceStage;
  severity: 'blocking' | 'warning' | 'info';
  target: string;
  issue: string;
  instruction: string;
  requirementIds: string[];
  evidence: string;
}

const SOURCE_STAGES: FindingsSourceStage[] = [
  'qa',
  'review',
  'audit',
  'factCheck',
];
const BODY_PREVIEW_LIMIT = 400;

export function aggregateStageFindings(
  artifacts: WritingStageArtifacts,
): AggregatedFinding[] {
  const out: AggregatedFinding[] = [];
  for (const sourceStage of SOURCE_STAGES) {
    const artifact = artifacts[sourceStage];
    if (!artifact) continue;
    const parsed = extractFindings(artifact, sourceStage);
    parsed.forEach((item, index) => {
      out.push(normalizeFinding(sourceStage, item, index));
    });
  }
  return out;
}

export function formatAggregatedFindingsBlock(
  findings: AggregatedFinding[],
): string {
  if (findings.length === 0) {
    return '【汇总 Findings】\n（无必须修订的问题）';
  }
  const lines = findings.map(finding => {
    const bits = [
      `${finding.findingId}`,
      `source=${finding.sourceStage}`,
      `severity=${finding.severity}`,
      finding.target ? `target=${finding.target}` : '',
      finding.issue,
      finding.instruction ? `→ ${finding.instruction}` : '',
    ].filter(Boolean);
    return `- ${bits.join(' | ')}`;
  });
  return `【汇总 Findings】\n${lines.join('\n')}`;
}

function extractFindings(
  artifact: unknown,
  sourceStage: FindingsSourceStage,
): unknown[] {
  if (!artifact || typeof artifact !== 'object') return [];
  const row = artifact as Record<string, unknown>;
  const structured =
    row.structured && typeof row.structured === 'object'
      ? (row.structured as Record<string, unknown>)
      : null;
  const fromStructured = asFindingList(structured?.findings);
  if (fromStructured) return fromStructured;
  const fromTop = asFindingList(row.findings);
  if (fromTop) return fromTop;
  const body = typeof row.body === 'string' ? row.body : typeof row.content === 'string' ? row.content : '';
  if (!body.trim()) return [];
  const json = tryParseJson(body);
  if (sourceStage === 'qa') {
    const qaStructured = structured || json || undefined;
    if (!validateQaStructuredContract(qaStructured).valid) return [];
    return asFindingList(qaStructured?.findings) || [];
  }
  const fromBody = asFindingList(json?.findings);
  if (fromBody) return fromBody;
  if (json && typeof json.issue === 'string') return [json];
  return [
    {
      issue: body.trim().slice(0, BODY_PREVIEW_LIMIT),
      instruction: '',
      target: '',
    },
  ];
}

function asFindingList(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function normalizeFinding(
  sourceStage: FindingsSourceStage,
  raw: unknown,
  index: number,
): AggregatedFinding {
  const row =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : { issue: String(raw ?? '') };
  const issue = String(row.issue ?? row.summary ?? row.content ?? '').trim();
  const instruction = String(row.instruction ?? row.fix ?? '').trim();
  const target = String(row.target ?? row.span ?? '').trim();
  const evidence = String(row.evidence ?? '').trim();
  const requirementIds = Array.isArray(row.requirementIds)
    ? row.requirementIds.map(item => String(item))
    : [];
  const severity = normalizeSeverity(row.severity);
  return {
    findingId: String(row.findingId ?? row.id ?? `${sourceStage}-${index + 1}`),
    sourceStage,
    severity,
    target,
    issue: issue || '（无摘要）',
    instruction,
    requirementIds,
    evidence,
  };
}

function normalizeSeverity(value: unknown): AggregatedFinding['severity'] {
  const text = String(value ?? '').toLowerCase();
  if (text === 'blocking' || text === 'error' || text === 'mandatory') {
    return 'blocking';
  }
  if (text === 'warning' || text === 'preferred') return 'warning';
  return 'info';
}
