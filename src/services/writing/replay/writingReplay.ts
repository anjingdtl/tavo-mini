import type { WritingRequest } from '../contracts/writingSource';
import { buildFrozenWritingContext } from '../context/buildFrozenWritingContext';

export interface WritingDecisionReplay {
  sourceFingerprint: string;
  contextPlanFingerprint: string;
  allocationFingerprint: string;
  renderFingerprint: string;
  freezeFingerprint: string;
  selectionDiff: string[];
  allocationDiff: string[];
  renderDiff: string[];
  fingerprintDiff: string[];
  obligationDiff: string[];
  finalValidationDiff: string[];
}

export function replayWritingDecisions(request: WritingRequest): WritingDecisionReplay {
  const frozen = buildFrozenWritingContext(request);
  return {
    sourceFingerprint: frozen.sourceFingerprint,
    contextPlanFingerprint: frozen.plan.fingerprint,
    allocationFingerprint: frozen.allocation.fingerprint,
    renderFingerprint: frozen.rendered.fingerprint,
    freezeFingerprint: frozen.freezeFingerprint,
    selectionDiff: [],
    allocationDiff: [],
    renderDiff: [],
    fingerprintDiff: [],
    obligationDiff: [],
    finalValidationDiff: [],
  };
}

export function replayWritingDecisionsX10(request: WritingRequest): WritingDecisionReplay[] {
  return Array.from({ length: 10 }, () => replayWritingDecisions(request));
}
