/**
 * Phase-2 stage compilers. They accept a frozen snapshot only — never a
 * projectId that would re-query characters / worldbook / presets.
 */
import type {
  FactCheckContext,
  PipelineContextSnapshot,
  ProofConstraints,
  ReviewContext,
} from '../../types/pipelineContext';
import {
  buildFactCheckContextFromSnapshot,
  buildProofConstraintsFromSnapshot,
  buildReviewContextFromSnapshot,
} from '../../types/pipelineContext';
import { renderPresetForStage } from '../context/resources/presetContextCompiler';
import type { FrozenPresetContext } from '../context/resources/resourceAwarenessTypes';
import { clipTextToTokenBudget } from '../../utils/tokenEstimator';
import {
  buildBriefResourceViewFromSnapshotV5,
  buildFactCheckContextFromSnapshotV5,
  buildProofConstraintsFromSnapshotV5,
  buildReviewContextFromSnapshotV5,
} from './stageResourceContextV5';

function frozenPresetFromSnapshot(
  snapshot: PipelineContextSnapshot,
): FrozenPresetContext {
  return {
    presetId: undefined,
    presetName: 'frozen-preset',
    sourceFingerprint: snapshot.presetSourceFingerprint || '',
    presetSource: snapshot.presetSource || 'default_runtime_baseline',
    systemText: snapshot.presetSystemText || snapshot.presetText || '',
    writingStyleText: snapshot.presetWritingStyleText || '',
    extraInstructionsText: snapshot.presetExtraInstructionsText || '',
    combinedText: snapshot.presetText || '',
  };
}

function clipDetails(
  items: NonNullable<PipelineContextSnapshot['resourceDetailItems']>,
  kind: 'character' | 'worldbook' | 'note',
  budget: number,
): string {
  const selected = items.filter(item => item.sourceKind === kind && item.content);
  if (budget <= 0) return '';
  const joined = selected.map(item => item.content).join('\n\n');
  return clipTextToTokenBudget(joined, budget);
}

export function isPhase2Snapshot(snapshot: PipelineContextSnapshot): boolean {
  return (
    snapshot.resourceContextVersion === 2 ||
    snapshot.snapshotVersion === 4 ||
    !!snapshot.globalResourceAwarenessText ||
    !!snapshot.characterAwarenessText ||
    !!snapshot.worldbookAwarenessText
  );
}

export function buildReviewContextFromSnapshotV4(
  snapshot: PipelineContextSnapshot,
  detailBudget = 100000,
): ReviewContext {
  const preset = renderPresetForStage(frozenPresetFromSnapshot(snapshot), 'review');
  const details = snapshot.resourceDetailItems || [];
  return {
    presetText: preset.combinedText,
    characterText: clipDetails(details, 'character', detailBudget),
    worldbookText: clipDetails(details, 'worldbook', detailBudget),
    noteText: clipDetails(details, 'note', detailBudget),
    storyMemoryText: snapshot.storyMemoryText,
    episodicMemoryText: snapshot.episodicMemoryText,
    recentBridgeText: snapshot.recentBridgeText,
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
    outlineText: snapshot.outlineText,
    characterAwarenessText: snapshot.characterAwarenessText || '',
    worldbookAwarenessText: snapshot.worldbookAwarenessText || '',
  };
}

export function buildFactCheckContextFromSnapshotV4(
  snapshot: PipelineContextSnapshot,
  detailBudget = 80000,
): FactCheckContext {
  const preset = renderPresetForStage(frozenPresetFromSnapshot(snapshot), 'factCheck');
  const details = snapshot.resourceDetailItems || [];
  return {
    presetText: preset.combinedText,
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
    recentBridgeText: snapshot.recentBridgeText,
    storyMemoryText: snapshot.storyMemoryText,
    episodicMemoryText: snapshot.episodicMemoryText,
    worldbookText: clipDetails(details, 'worldbook', detailBudget),
    characterText: clipDetails(details, 'character', detailBudget),
    noteText: clipDetails(details, 'note', Math.floor(detailBudget * 0.5)),
    outlineText: snapshot.outlineText,
    characterAwarenessText: snapshot.characterAwarenessText || '',
    worldbookAwarenessText: snapshot.worldbookAwarenessText || '',
  };
}

export function buildProofConstraintsFromSnapshotV4(
  snapshot: PipelineContextSnapshot,
  detailBudget = 90000,
): ProofConstraints {
  const preset = renderPresetForStage(frozenPresetFromSnapshot(snapshot), 'proof');
  const details = snapshot.resourceDetailItems || [];
  return {
    presetText: preset.combinedText,
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
    relevantCharacterConstraints: clipDetails(details, 'character', detailBudget),
    relevantWorldRules: clipDetails(details, 'worldbook', detailBudget),
    currentStoryState: snapshot.storyMemoryText,
    episodicMemoryText: snapshot.episodicMemoryText,
    noteText: clipDetails(details, 'note', Math.floor(detailBudget * 0.5)),
    recentBridgeText: snapshot.recentBridgeText,
    outlineText: snapshot.outlineText,
    characterAwarenessText: snapshot.characterAwarenessText || '',
    worldbookAwarenessText: snapshot.worldbookAwarenessText || '',
  };
}

export function resolveReviewContext(
  snapshot: PipelineContextSnapshot,
): ReviewContext {
  if (snapshot.snapshotVersion === 5 || snapshot.writerStyleSnapshot) {
    return buildReviewContextFromSnapshotV5(snapshot);
  }
  return isPhase2Snapshot(snapshot)
    ? buildReviewContextFromSnapshotV4(snapshot)
    : buildReviewContextFromSnapshot(snapshot);
}

export function resolveFactCheckContext(
  snapshot: PipelineContextSnapshot,
): FactCheckContext {
  if (snapshot.snapshotVersion === 5 || snapshot.writerStyleSnapshot) {
    return buildFactCheckContextFromSnapshotV5(snapshot);
  }
  return isPhase2Snapshot(snapshot)
    ? buildFactCheckContextFromSnapshotV4(snapshot)
    : buildFactCheckContextFromSnapshot(snapshot);
}

export function resolveProofConstraints(
  snapshot: PipelineContextSnapshot,
): ProofConstraints {
  if (snapshot.snapshotVersion === 5 || snapshot.writerStyleSnapshot) {
    return buildProofConstraintsFromSnapshotV5(snapshot);
  }
  return isPhase2Snapshot(snapshot)
    ? buildProofConstraintsFromSnapshotV4(snapshot)
    : buildProofConstraintsFromSnapshot(snapshot);
}

export function buildBriefResourceViewFromSnapshotV4(
  snapshot: PipelineContextSnapshot,
): {
  presetText: string;
  characterAwarenessText: string;
  worldbookAwarenessText: string;
  characterDetailText: string;
  worldbookDetailText: string;
} {
  if (snapshot.snapshotVersion === 5 || snapshot.writerStyleSnapshot) {
    return buildBriefResourceViewFromSnapshotV5(snapshot);
  }
  const preset = renderPresetForStage(frozenPresetFromSnapshot(snapshot), 'brief');
  const details = snapshot.resourceDetailItems || [];
  return {
    presetText: preset.combinedText,
    characterAwarenessText: snapshot.characterAwarenessText || '',
    worldbookAwarenessText: snapshot.worldbookAwarenessText || '',
    characterDetailText: clipDetails(details, 'character', 400),
    worldbookDetailText: clipDetails(details, 'worldbook', 400),
  };
}
