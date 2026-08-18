/**
 * Memory → Context (plan §6.3).
 *
 * Story Memory / Continuity State / Canon enter the next chapter only as
 * Context Candidates. They must not compile prompts or bypass ONE Budget.
 */
import type { WritingSourceKind } from '../contracts/writingSource';

export const MEMORY_TO_CONTEXT_CANDIDATE_KINDS = [
  'story_memory',
  'episodic_memory',
  'structured_continuity_state',
  'canon',
] as const satisfies readonly WritingSourceKind[];

export type MemoryContextCandidateKind =
  (typeof MEMORY_TO_CONTEXT_CANDIDATE_KINDS)[number];

function refText(ref: unknown): string {
  if (ref == null) return '';
  if (typeof ref === 'string' || typeof ref === 'number') return String(ref);
  if (typeof ref === 'object') {
    const row = ref as Record<string, unknown>;
    const name = [row.name, row.title, row.id, row.refType]
      .filter(value => value != null && String(value).trim())
      .map(value => String(value));
    return name.join(':');
  }
  return '';
}

function section(title: string, lines: string[]): string {
  const cleaned = lines.map(line => line.trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  return `${title}\n${cleaned.join('\n')}`;
}

/**
 * Compact, deterministic Continuity State text. Canon-layer rows stay in
 * the Canon candidate; this block is post-boundary runtime delta only.
 */
export function renderStructuredContinuityStateCandidate(state: {
  characterStates?: Array<{
    source?: string;
    ref?: unknown;
    summary?: string;
    fields?: Record<string, string | null>;
  }>;
  relationships?: Array<{
    sourceLayer?: string;
    source?: unknown;
    target?: unknown;
    summary?: string;
  }>;
  plotThreads?: Array<{
    sourceLayer?: string;
    title?: string;
    status?: string;
    summary?: string;
  }>;
  knowledge?: Array<{
    ref?: unknown;
    factKey?: string;
    factSummary?: string;
    knowledgeState?: string;
  }>;
  experiences?: Array<{
    ref?: unknown;
    title?: string;
    summary?: string;
  }>;
} | null | undefined): string {
  if (!state || typeof state !== 'object') return '';
  const characters = (state.characterStates || [])
    .filter(row => row && row.source !== 'canon')
    .map(row => `- ${refText(row.ref)}: ${row.summary || ''}`);
  const plots = (state.plotThreads || [])
    .filter(row => row && row.sourceLayer !== 'canon')
    .map(
      row =>
        `- ${row.title || ''} (${row.status || ''}): ${row.summary || ''}`,
    );
  const relationships = (state.relationships || [])
    .filter(row => row && row.sourceLayer !== 'canon')
    .map(
      row =>
        `- ${refText(row.source)} → ${refText(row.target)}: ${row.summary || ''}`,
    );
  const knowledge = (state.knowledge || []).map(
    row =>
      `- ${refText(row.ref)} ${row.factKey || ''}: ${row.factSummary || ''}（${
        row.knowledgeState || ''
      }）`,
  );
  const experiences = (state.experiences || []).map(
    row => `- ${refText(row.ref)}: ${row.title || ''}；${row.summary || ''}`,
  );
  return [
    section('人物状态', characters),
    section('情节线', plots),
    section('关系', relationships),
    section('知识', knowledge),
    section('经历', experiences),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function isMemoryContextCandidateKind(
  kind: string,
): kind is MemoryContextCandidateKind {
  return (MEMORY_TO_CONTEXT_CANDIDATE_KINDS as readonly string[]).includes(
    kind,
  );
}
