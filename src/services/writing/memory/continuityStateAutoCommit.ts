/**
 * After Continuation state extraction, auto-commit routine proposals.
 * Conflict / unmergeable / low-confidence-affects-later stay pending
 * for the existing review screen.
 */
import { CanonQueryService } from '../../continuation/canon/canonQueryService';
import { commitAcceptedProposal } from '../../continuation/generation/commitStateProposal';
import type { ContinuationStateProposal } from '../../continuation/generation/types';
import {
  classifyContinuityProposalCommit,
  type ContinuityCommitCanonFact,
  type ContinuityConfirmationReason,
} from './continuityStateCommitPolicy';

export interface AutoCommitContinuityResult {
  autoCommittedIds: string[];
  confirmationRequired: Array<{
    proposalId: string;
    reason: ContinuityConfirmationReason;
    policyRuleId: string;
  }>;
}

export async function autoCommitRoutineContinuityProposals(input: {
  projectId: number;
  proposals: ContinuationStateProposal[];
  canonFacts?: ContinuityCommitCanonFact[];
  confirmProposal?: (input: {
    proposalId: string;
    decisionNote?: string;
    processOutbox?: boolean;
  }) => Promise<unknown>;
}): Promise<AutoCommitContinuityResult> {
  const pending = input.proposals.filter(
    proposal => proposal.status === 'pending' && proposal.id,
  );
  const result: AutoCommitContinuityResult = {
    autoCommittedIds: [],
    confirmationRequired: [],
  };
  if (pending.length === 0) return result;

  const canonFacts =
    input.canonFacts ?? (await loadCanonFactsForCommit(input.projectId, pending));
  const confirm = input.confirmProposal ?? commitAcceptedProposal;

  for (const proposal of pending) {
    const decision = classifyContinuityProposalCommit({
      proposalType: proposal.proposalType,
      subjectRefType: proposal.subjectRefType,
      subjectRefId: proposal.subjectRefId,
      payloadJson: proposal.payloadJson,
      canonFacts,
      siblingPending: pending
        .filter(other => other.id !== proposal.id)
        .map(other => ({
          proposalType: other.proposalType,
          subjectRefType: other.subjectRefType,
          subjectRefId: other.subjectRefId,
          payloadJson: other.payloadJson,
        })),
    });
    if (decision.action === 'require_user_confirmation' && decision.reason) {
      result.confirmationRequired.push({
        proposalId: proposal.id,
        reason: decision.reason,
        policyRuleId: decision.policyRuleId,
      });
      continue;
    }
    try {
      await confirm({
        proposalId: proposal.id,
        decisionNote: `auto_commit:${decision.policyRuleId}`,
      });
      result.autoCommittedIds.push(proposal.id);
    } catch {
      result.confirmationRequired.push({
        proposalId: proposal.id,
        reason: 'unmergeable',
        policyRuleId: 'one_memory.auto_commit_failed_fail_closed',
      });
    }
  }
  return result;
}

async function loadCanonFactsForCommit(
  projectId: number,
  proposals: ContinuationStateProposal[],
): Promise<ContinuityCommitCanonFact[]> {
  const characterIds = [
    ...new Set(
      proposals
        .filter(
          proposal =>
            proposal.subjectRefType === 'canon_character' && proposal.subjectRefId,
        )
        .map(proposal => Number(proposal.subjectRefId))
        .filter(id => Number.isFinite(id) && id > 0),
    ),
  ];
  if (characterIds.length === 0) return [];
  try {
    const snap = await CanonQueryService.getActiveSnapshot(projectId);
    const states = await CanonQueryService.getCharacterStates({
      projectId,
      snapshotId: snap.id,
      snapshotRevision: snap.revision,
      characterIds,
      atSourcePosition: snap.boundaryPosition,
    });
    return states.map(state => ({
      characterId: state.characterId,
      aliveState: state.aliveState,
      identityState: state.identityState,
      knowledgeBoundary: null,
    }));
  } catch {
    return [];
  }
}
