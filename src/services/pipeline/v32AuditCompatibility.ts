import type { LLMResult } from '../llm/types';
import { selectStructuredCandidate } from './structuredCandidate';

/**
 * V3.2 compatibility boundary.  It only extracts/unwraps candidate JSON; it
 * never constructs findings or copies the local immutable envelope.
 */
export function adaptV32AuditResult(
  result: LLMResult,
  stage: 'review' | 'factCheck',
): {
  result: LLMResult;
  selection: ReturnType<typeof selectStructuredCandidate>;
} {
  const selection = selectStructuredCandidate({
    result,
    expectedRootKeys:
      stage === 'review'
        ? ['verdict', 'findings', 'outlineAssessment', 'coverage']
        : ['verdict', 'findings', 'confirmedFactRefs', 'coverage'],
    coverageKeys:
      stage === 'review'
        ? [
            'opening_continuity',
            'outline_execution',
            'character',
            'prose',
            'ending_boundary',
          ]
        : [
            'timeline',
            'character_state',
            'object_state',
            'world_rule',
            'spatial_logic',
            'knowledge_boundary',
            'outline_boundary',
          ],
  });
  if (!selection.candidate) return { result, selection };
  return {
    result: {
      ...result,
      text: selection.candidate.text,
      reasoningText: null,
    },
    selection,
  };
}
