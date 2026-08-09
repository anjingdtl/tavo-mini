import { sha256Hex } from '../continuation/hashUtils';
import {
  briefRequiredSourceIds,
  type BriefCompilerInputV1,
  type BriefSourceItem,
  type FinalWritingBriefV1,
} from './briefCompilerTypes';

export function computeBriefSourceHash(
  input: Omit<BriefCompilerInputV1, 'sourceHash'>,
): string {
  return sha256Hex(JSON.stringify(input)).slice(0, 32);
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = String(raw || '').trim();
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function locationFor(item: BriefSourceItem): string {
  const location = String(item.locationHint || '').trim();
  if (location === 'opening') return '章节开头或开头衔接处';
  if (location === 'ending') return '章节结尾或收束处';
  if (location === 'unlocated') return '本章相关位置（不要扩大为整章重写）';
  if (location === 'middle') return '章节中段相关位置';
  return location || '本章相关位置';
}

function instructionFor(item: BriefSourceItem): string {
  const parts = [item.rewriteGoal.trim()];
  if (item.diagnosis.trim()) parts.unshift(`针对“${item.diagnosis.trim()}”`);
  return parts.filter(Boolean).join('：');
}

function toFix(item: BriefSourceItem) {
  return {
    sourceIds: [item.sourceId],
    location: locationFor(item),
    instruction: instructionFor(item),
    preserve: unique(item.preserveMeaning),
  };
}

/**
 * Deterministic fallback and simple-contract compiler. It never invents a
 * correction and cannot turn advisory text into a must-fix instruction.
 */
export function compileDeterministicBrief(
  input: BriefCompilerInputV1,
): FinalWritingBriefV1 {
  const reviewItems = [
    ...(input.review?.executableCorrections || []),
    ...(input.review?.unlocatedRequired || []),
  ];
  const factItems = input.factCheck?.corrections || [];
  const mustFix = [...reviewItems, ...factItems]
    .filter(item => item.severity === 'hard' || item.severity === 'required')
    .map(toFix);
  const requiredIds = briefRequiredSourceIds(input);
  const mustPreserve = unique([
    ...(input.review?.outlineExecution.mustPreserve || []),
    ...(input.factCheck?.protectedFacts || []),
    ...(input.factCheck?.hardConstraints || []),
  ]);
  const mustNotAdvance = unique(
    input.review?.outlineExecution.mustNotAdvance || [],
  );
  const openingContinuity = unique([
    ...(input.review?.outlineExecution.missingBeats || []).map(
      beat => `承接并补足大纲节点：${beat}`,
    ),
    ...reviewItems
      .filter(item => item.locationHint === 'opening')
      .map(item => item.rewriteGoal),
  ]);
  const advisoryNotes = unique([
    ...(input.review?.advisoryNotes || []),
    ...[...reviewItems, ...factItems]
      .filter(item => item.severity === 'warning')
      .map(item => `${item.dimension}：${item.diagnosis || item.rewriteGoal}`),
  ]);

  return {
    schemaVersion: 1,
    sourceHash: input.sourceHash,
    coveredRequiredIds: requiredIds,
    mustFix,
    mustPreserve,
    mustNotAdvance,
    openingContinuity,
    endingState: input.review?.outlineExecution.endingGoal?.trim() || '',
    advisoryNotes,
  };
}
