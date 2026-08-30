import {
  PHASE4_GATE_INVENTORY,
  classifyPhase4Gate,
  countPhase4Gates,
  isPhase4HardGate,
} from '../src/services/writing/gates/phase4GatePolicy';
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import {
  validateQaStructuredContract,
  validateRevisionStructuredContract,
} from '../src/services/writing/stages/writerRecovery';
import { parseSharedWriterOutput } from '../src/services/writing/stages/writerCore';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { continuationRequest } from './helpers/oneShotFixtures';

describe('Phase IV-1 gate simplification contract', () => {
  test('keeps only safety and capability boundaries as hard gates', () => {
    expect(isPhase4HardGate('truncated_output')).toBe(true);
    expect(isPhase4HardGate('outcome_unknown')).toBe(true);
    expect(isPhase4HardGate('mandatory_truth')).toBe(true);
    expect(isPhase4HardGate('persistence_transaction')).toBe(true);
    expect(isPhase4HardGate('quality_report_shape')).toBe(false);
    expect(isPhase4HardGate('governor_current_request')).toBe(false);
    expect(isPhase4HardGate('formatter_rescue_call')).toBe(false);
  });

  test('removes current-request Governor veto and formatter rescue from the main chain', () => {
    expect(classifyPhase4Gate('governor_current_request')).toBe('remove');
    expect(classifyPhase4Gate('formatter_rescue_call')).toBe('remove');
    expect(classifyPhase4Gate('model_side_fingerprint')).toBe('remove');
  });

  test('merges candidate validation and persistence safety into one local boundary', () => {
    expect(classifyPhase4Gate('final_candidate_and_persistence')).toBe('merge');
    expect(classifyPhase4Gate('quality_report_shape')).toBe('advisory');
  });

  test('hard-gate inventory is materially smaller than the pre-Phase-IV surface', () => {
    const counts = countPhase4Gates(PHASE4_GATE_INVENTORY);
    expect(counts.total).toBeGreaterThanOrEqual(12);
    expect(counts.hardBlock).toBeLessThan(counts.total / 2);
    expect(counts.remove).toBeGreaterThan(0);
    expect(counts.merge).toBeGreaterThan(0);
  });

  test('Phase IV QA accepts the minimal decision/findings protocol', () => {
    expect(
      validateQaStructuredContract({ decision: 'clean' }),
    ).toEqual({ valid: true, reason: null });
    expect(
      validateQaStructuredContract({
        decision: 'revise',
        findings: [{ type: 'continuity', target: '第三段' }],
      }),
    ).toEqual({ valid: true, reason: null });
  });

  test('Phase IV Revision accepts complete正文 with no bookkeeping envelope', () => {
    expect(
      validateRevisionStructuredContract({
        parsed: { content: '完整修订正文。' },
        finalBody: '完整修订正文。',
        phase4Contract: true,
      }),
    ).toEqual({ valid: true, reason: null });
  });

  test('Phase IV compiler removes state proposal and legacy revision fields from normal protocol', () => {
    const freeze = buildWritingKernelFreezeTrace({
      request: continuationRequest({
        pipelineTopologyVersion: 'compact_standard',
        phase4GatePolicyVersion: 'phase4-gates-v1',
      }),
    });
    const qa = compileSharedWritingPrompt({
      stage: 'qa',
      frozenContext: freeze.frozenContext,
      artifacts: { draft: { stage: 'draft', body: '正文。' } },
      requirements: freeze.frozenContext.requirements,
      stagePolicy: freeze.frozenContext.stagePolicy,
    });
    const revision = compileSharedWritingPrompt({
      stage: 'revision',
      frozenContext: freeze.frozenContext,
      artifacts: {
        draft: { stage: 'draft', body: '正文。' },
        qa: { stage: 'qa', body: JSON.stringify({ decision: 'revise', findings: [{ type: 'continuity', target: '第一段' }] }) },
      },
      requirements: freeze.frozenContext.requirements,
      stagePolicy: freeze.frozenContext.stagePolicy,
    });
    const qaPrompt = qa.messages.map(message => message.content).join('\n');
    const revisionPrompt = revision.messages
      .map(message => message.content)
      .join('\n');
    expect(qaPrompt).toContain('decision');
    expect(qaPrompt).not.toContain('stateProposals');
    expect(revisionPrompt).toContain('content');
    expect(revisionPrompt).not.toContain('必须包含 strategy');
    expect(revisionPrompt).not.toContain('必须包含 schemaVersion');
  });

  test('Phase IV parser normalizes decision locally without expanding provider output', () => {
    const parsed = parseSharedWriterOutput(
      'qa',
      JSON.stringify({ decision: 'clean' }),
    );
    expect(parsed.structured).toEqual(
      expect.objectContaining({ decision: 'clean', verdict: 'pass', findings: [] }),
    );
    expect(JSON.stringify({ decision: 'clean' }).length).toBeLessThan(
      JSON.stringify({ schemaVersion: 1, content: '检查通过', verdict: 'pass', findings: [], analysis: '', confidence: 1 }).length,
    );
  });
});
