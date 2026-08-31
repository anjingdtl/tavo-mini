/**
 * Phase IV-12A: offline Writer Style acceptance contract.
 *
 * This module is deliberately not imported by the production writing kernel.
 * It projects an already-frozen Writer Style into test requirements and
 * combines deterministic findings with a blind human/independent-evaluator
 * annotation. It never calls an LLM, changes a prompt, adds a runtime Gate,
 * retries a request, or re-plans a chapter.
 */

import { sha256Hex } from '../../src/services/continuation/hashUtils';
import type { FrozenWriterStyleV1 } from '../../src/services/writerStyle/types';

export const WRITER_STYLE_ADHERENCE_SCHEMA =
  'shinewriter.writer-style-adherence.v1' as const;
export const WRITER_STYLE_ADHERENCE_CONTRACT_VERSION =
  'writer-style-adherence-v1' as const;
export const WRITER_STYLE_EVIDENCE_BODY_POLICY =
  'metadata-only: no prompts, plans, synopsis, titles, chapter bodies, reasoning content, response bodies, API keys, or error messages' as const;

export const NARRATIVE_QUALITY_DIMENSIONS = [
  'sceneCompletion',
  'beatRealization',
  'characterConsistency',
  'causalContinuity',
  'endingEffectiveness',
] as const;

export type NarrativeQualityDimension =
  (typeof NARRATIVE_QUALITY_DIMENSIONS)[number];

export type StyleRequirementStrength = 'MANDATORY' | 'PREFERRED' | 'AVOID';

export type StyleRequirementCategory =
  | 'POV'
  | 'PSYCHOLOGY'
  | 'LANGUAGE'
  | 'DESCRIPTION'
  | 'VOICE'
  | 'DIALOGUE'
  | 'RHYTHM'
  | 'INFORMATION'
  | 'CONTINUITY'
  | 'ENDING'
  | 'PROHIBITION'
  | 'LEGACY'
  | 'OTHER';

export type StyleRuleAssessment =
  | 'satisfied'
  | 'violated'
  | 'not_applicable'
  | 'unknown';

export interface StyleRequirement {
  id: string;
  category: StyleRequirementCategory;
  rule: string;
  strength: StyleRequirementStrength;
  /** V1 uses unit weights; MANDATORY is enforced separately. */
  weight: 1;
  applicability: 'chapter';
  evidenceExpectation: string;
  sourcePath: string;
}

export type WriterStyleProjectionCompleteness =
  | 'complete'
  | 'missing'
  | 'legacy_unparsed'
  | 'incomplete_semantic'
  | 'fingerprint_missing';

export interface WriterStyleRequirementProjection {
  schema: typeof WRITER_STYLE_ADHERENCE_SCHEMA;
  contractVersion: typeof WRITER_STYLE_ADHERENCE_CONTRACT_VERSION;
  assetId: number | null;
  assetName: string;
  sourceFormat: string;
  styleFingerprint: string | null;
  completeness: WriterStyleProjectionCompleteness;
  requirements: StyleRequirement[];
}

export interface StyleFinding {
  requirementId: string;
  category: StyleRequirementCategory;
  findingType:
    | 'forbidden_pattern'
    | 'pov_drift'
    | 'blind_rule_violation';
  severity: 'hard' | 'drift';
  hardStyleViolation: boolean;
  evidenceCode: string;
}

export interface DeterministicStyleEvaluation {
  status: 'pass' | 'violation' | 'not_proven';
  findings: StyleFinding[];
  checkedRuleCount: number;
}

export interface BlindStyleRuleAnnotation {
  assessment: StyleRuleAssessment;
  evidenceCodes?: string[];
}

export interface BlindStyleAnnotation {
  source: 'human' | 'independent_evaluator';
  status: 'complete' | 'partial' | 'not_collected';
  rules: Record<string, BlindStyleRuleAnnotation>;
}

export interface WriterStyleEvaluationSummary {
  evaluationStatus: 'pass' | 'fail' | 'manual_required' | 'incomplete_contract';
  applicableRuleCount: number;
  assessedRuleCount: number;
  unknownRuleCount: number;
  satisfiedRuleCount: number;
  mandatoryRuleCount: number;
  mandatorySatisfiedCount: number;
  mandatoryPass: boolean;
  writerStyleAdherenceRate: number | null;
  hardStyleViolationCount: number;
  forbiddenPatternCount: number;
  styleDriftCount: number;
  violatedRuleIds: string[];
}

export interface WriterStyleSampleEvaluation {
  schema: typeof WRITER_STYLE_ADHERENCE_SCHEMA;
  contractVersion: typeof WRITER_STYLE_ADHERENCE_CONTRACT_VERSION;
  bodyPolicy: typeof WRITER_STYLE_EVIDENCE_BODY_POLICY;
  projection: WriterStyleRequirementProjection;
  deterministic: DeterministicStyleEvaluation;
  blindEvaluation: {
    source: BlindStyleAnnotation['source'] | null;
    status: BlindStyleAnnotation['status'];
  };
  findings: StyleFinding[];
  writerStyle: WriterStyleEvaluationSummary;
}

export interface NarrativeDimensionEvidence {
  status: 'pass' | 'fail' | 'not_collected';
  score: number | null;
  evidenceCodes: string[];
}

export interface NarrativeQualityEvidence {
  rubricVersion: string;
  status: 'pass' | 'fail' | 'not_collected';
  minimumScore: number;
  dimensions: Record<NarrativeQualityDimension, NarrativeDimensionEvidence>;
}

export interface WriterStyleAcceptanceResult {
  status: 'pass' | 'fail' | 'hold';
  reasons: string[];
  writerStyle: WriterStyleEvaluationSummary;
  narrativeQuality: NarrativeQualityEvidence;
}

interface SemanticRuleSpec {
  path: string;
  category: StyleRequirementCategory;
  strength: StyleRequirementStrength;
  evidenceExpectation: string;
}

const SEMANTIC_RULE_SPECS: readonly SemanticRuleSpec[] = [
  {
    path: 'narration.pointOfView',
    category: 'POV',
    strength: 'MANDATORY',
    evidenceExpectation: 'narrative_pov_consistent; dialogue first-person does not count as narrator drift',
  },
  {
    path: 'narration.narratorDistance',
    category: 'POV',
    strength: 'MANDATORY',
    evidenceExpectation: 'narrative_distance_consistent',
  },
  {
    path: 'narration.viewpointSwitching',
    category: 'POV',
    strength: 'MANDATORY',
    evidenceExpectation: 'viewpoint_switching_obeys_rule',
  },
  {
    path: 'narration.interiority',
    category: 'PSYCHOLOGY',
    strength: 'PREFERRED',
    evidenceExpectation: 'interiority_and_psychology_fit',
  },
  {
    path: 'language.texture',
    category: 'LANGUAGE',
    strength: 'PREFERRED',
    evidenceExpectation: 'voice_texture_fit',
  },
  {
    path: 'language.syntax',
    category: 'LANGUAGE',
    strength: 'PREFERRED',
    evidenceExpectation: 'syntax_fit; shape telemetry is supporting evidence only',
  },
  {
    path: 'language.vocabulary',
    category: 'LANGUAGE',
    strength: 'PREFERRED',
    evidenceExpectation: 'vocabulary_register_fit',
  },
  {
    path: 'language.paragraphStructure',
    category: 'LANGUAGE',
    strength: 'PREFERRED',
    evidenceExpectation: 'paragraph_structure_fit; shape telemetry is supporting evidence only',
  },
  {
    path: 'sceneAndCharacter.sceneEnvironment',
    category: 'DESCRIPTION',
    strength: 'PREFERRED',
    evidenceExpectation: 'scene_environment_fit',
  },
  {
    path: 'sceneAndCharacter.characterPresentation',
    category: 'DESCRIPTION',
    strength: 'PREFERRED',
    evidenceExpectation: 'character_presentation_fit',
  },
  {
    path: 'sceneAndCharacter.characterVoice',
    category: 'VOICE',
    strength: 'PREFERRED',
    evidenceExpectation: 'character_voice_fit',
  },
  {
    path: 'sceneAndCharacter.dialogue',
    category: 'DIALOGUE',
    strength: 'PREFERRED',
    evidenceExpectation: 'dialogue_fit; dialogue ratio is supporting evidence only',
  },
  {
    path: 'narrativeMechanics.pacing',
    category: 'RHYTHM',
    strength: 'PREFERRED',
    evidenceExpectation: 'scene_rhythm_fit',
  },
  {
    path: 'narrativeMechanics.conflict',
    category: 'RHYTHM',
    strength: 'PREFERRED',
    evidenceExpectation: 'conflict_realization_fit',
  },
  {
    path: 'narrativeMechanics.informationReveal',
    category: 'INFORMATION',
    strength: 'PREFERRED',
    evidenceExpectation: 'information_reveal_fit',
  },
  {
    path: 'narrativeMechanics.suspense',
    category: 'INFORMATION',
    strength: 'PREFERRED',
    evidenceExpectation: 'suspense_fit',
  },
  {
    path: 'narrativeMechanics.foreshadowing',
    category: 'INFORMATION',
    strength: 'PREFERRED',
    evidenceExpectation: 'foreshadowing_fit',
  },
  {
    path: 'narrativeMechanics.chapterStructure',
    category: 'ENDING',
    strength: 'PREFERRED',
    evidenceExpectation: 'chapter_structure_and_ending_fit',
  },
  {
    path: 'narrativeMechanics.continuity',
    category: 'CONTINUITY',
    strength: 'PREFERRED',
    evidenceExpectation: 'causal_and_fact_continuity_fit',
  },
  {
    path: 'literaryTexture.imagery',
    category: 'DESCRIPTION',
    strength: 'PREFERRED',
    evidenceExpectation: 'imagery_fit; no generic beauty preference',
  },
  {
    path: 'literaryTexture.sensory',
    category: 'DESCRIPTION',
    strength: 'PREFERRED',
    evidenceExpectation: 'sensory_fit',
  },
];

const PROFILE_RULE_SPECS: readonly SemanticRuleSpec[] = [
  {
    path: 'global.narrative.person',
    category: 'POV',
    strength: 'MANDATORY',
    evidenceExpectation: 'narrative_pov_consistent; dialogue first-person does not count as narrator drift',
  },
  {
    path: 'global.narrative.narrativeDistance',
    category: 'POV',
    strength: 'MANDATORY',
    evidenceExpectation: 'narrative_distance_consistent',
  },
  {
    path: 'global.narrative.focalization',
    category: 'POV',
    strength: 'MANDATORY',
    evidenceExpectation: 'focalization_consistent',
  },
  {
    path: 'global.narrative.tenseAndTimeHandling',
    category: 'RHYTHM',
    strength: 'PREFERRED',
    evidenceExpectation: 'tense_and_time_handling_fit',
  },
  {
    path: 'global.tone.baseline',
    category: 'LANGUAGE',
    strength: 'PREFERRED',
    evidenceExpectation: 'tone_fit',
  },
  {
    path: 'global.syntax.sentenceLengthPattern',
    category: 'LANGUAGE',
    strength: 'PREFERRED',
    evidenceExpectation: 'syntax_fit; sentence shape is supporting evidence only',
  },
  {
    path: 'global.syntax.paragraphPattern',
    category: 'LANGUAGE',
    strength: 'PREFERRED',
    evidenceExpectation: 'paragraph_structure_fit; shape telemetry is supporting evidence only',
  },
  {
    path: 'global.dialogue.dialogueDensity',
    category: 'DIALOGUE',
    strength: 'PREFERRED',
    evidenceExpectation: 'dialogue_fit; dialogue ratio is supporting evidence only',
  },
  {
    path: 'global.dialogue.turnLength',
    category: 'DIALOGUE',
    strength: 'PREFERRED',
    evidenceExpectation: 'dialogue_turn_length_fit',
  },
  {
    path: 'global.description.sensoryPriorities',
    category: 'DESCRIPTION',
    strength: 'PREFERRED',
    evidenceExpectation: 'sensory_fit',
  },
  {
    path: 'global.description.environmentUsage',
    category: 'DESCRIPTION',
    strength: 'PREFERRED',
    evidenceExpectation: 'environment_usage_fit',
  },
  {
    path: 'global.rhythm.scenePacing',
    category: 'RHYTHM',
    strength: 'PREFERRED',
    evidenceExpectation: 'scene_rhythm_fit',
  },
  {
    path: 'global.rhythm.chapterEndingPatterns',
    category: 'ENDING',
    strength: 'PREFERRED',
    evidenceExpectation: 'ending_fit; no template-ending assumption',
  },
  {
    path: 'global.informationReveal.setupMethod',
    category: 'INFORMATION',
    strength: 'PREFERRED',
    evidenceExpectation: 'information_reveal_fit',
  },
  {
    path: 'global.informationReveal.foreshadowingMethod',
    category: 'INFORMATION',
    strength: 'PREFERRED',
    evidenceExpectation: 'foreshadowing_fit',
  },
  {
    path: 'global.informationReveal.suspenseMethod',
    category: 'INFORMATION',
    strength: 'PREFERRED',
    evidenceExpectation: 'suspense_fit',
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pathValue(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split('.')) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(item => text(item)).filter(Boolean).join('；');
  }
  return '';
}

function makeRequirement(
  id: string,
  spec: SemanticRuleSpec,
  rule: string,
  sourcePath = spec.path,
): StyleRequirement | null {
  const normalized = rule.trim();
  if (!normalized) return null;
  return {
    id,
    category: spec.category,
    rule: normalized,
    strength: spec.strength,
    weight: 1,
    applicability: 'chapter',
    evidenceExpectation: spec.evidenceExpectation,
    sourcePath,
  };
}

function mandatoryExtraInstruction(value: string): StyleRequirementStrength {
  return /必须|务必|不得|禁止|只能|仅可|不可|请勿|严禁/u.test(value)
    ? 'MANDATORY'
    : 'PREFERRED';
}

function projectionBase(input: {
  assetId?: number | null;
  assetName?: string;
  sourceFormat?: string;
  styleFingerprint?: string | null;
  completeness: WriterStyleProjectionCompleteness;
  requirements: StyleRequirement[];
}): WriterStyleRequirementProjection {
  const completeness =
    input.completeness === 'complete' && !input.styleFingerprint
      ? 'fingerprint_missing'
      : input.completeness;
  return {
    schema: WRITER_STYLE_ADHERENCE_SCHEMA,
    contractVersion: WRITER_STYLE_ADHERENCE_CONTRACT_VERSION,
    assetId: input.assetId ?? null,
    assetName: input.assetName?.trim() || '未命名作家风格',
    sourceFormat: input.sourceFormat?.trim() || 'unknown',
    styleFingerprint: input.styleFingerprint || null,
    completeness,
    requirements: input.requirements,
  };
}

/**
 * Project the real frozen WriterStyleSemanticV1 into test requirements.
 * The semantic asset remains the only source of truth; this is a read-only
 * test projection and is never fed back into production prompt compilation.
 */
export function projectWriterStyleRequirements(
  writerStyle: FrozenWriterStyleV1 | null | undefined,
): WriterStyleRequirementProjection {
  if (!writerStyle) {
    return projectionBase({ completeness: 'missing', requirements: [] });
  }

  const semantic = asRecord(writerStyle.semantic);
  const requirements: StyleRequirement[] = [];
  if (semantic) {
    for (const spec of SEMANTIC_RULE_SPECS) {
      const requirement = makeRequirement(
        `style:${spec.path}`,
        spec,
        scalarText(pathValue(semantic, spec.path)),
      );
      if (requirement) requirements.push(requirement);
    }
    const prohibitions = pathValue(semantic, 'prohibitions');
    if (Array.isArray(prohibitions)) {
      prohibitions.forEach((item, index) => {
        const requirement = makeRequirement(
          `style:prohibitions.${index}`,
          {
            path: 'prohibitions',
            category: 'PROHIBITION',
            strength: 'AVOID',
            evidenceExpectation: 'explicit_forbidden_pattern_absent',
          },
          text(item),
          `semantic.prohibitions[${index}]`,
        );
        if (requirement) requirements.push(requirement);
      });
    }
    const extraInstructions = pathValue(semantic, 'extraInstructions');
    if (Array.isArray(extraInstructions)) {
      extraInstructions.forEach((item, index) => {
        const value = text(item);
        if (!value) return;
        const strength = mandatoryExtraInstruction(value);
        const requirement = makeRequirement(
          `style:extraInstructions.${index}`,
          {
            path: 'extraInstructions',
            category: 'OTHER',
            strength,
            evidenceExpectation: 'explicit_style_instruction_fit',
          },
          value,
          `semantic.extraInstructions[${index}]`,
        );
        if (requirement) requirements.push(requirement);
      });
    }
  }

  const legacyText = [
    writerStyle.legacySystemText,
    writerStyle.legacyWritingStyleText,
    writerStyle.legacyExtraInstructionsText,
  ]
    .map(text)
    .filter(Boolean)
    .join('\n');

  if (!semantic) {
    const legacyRequirement = makeRequirement(
      'style:legacy.protected-text',
      {
        path: 'legacy',
        category: 'LEGACY',
        strength: 'PREFERRED',
        evidenceExpectation: 'independent_evaluator_required_for_unparsed_legacy_style',
      },
      legacyText,
      'frozenWriterStyle.legacy',
    );
    if (legacyRequirement) requirements.push(legacyRequirement);
    return projectionBase({
      assetId: writerStyle.assetId,
      assetName: writerStyle.assetName,
      sourceFormat: writerStyle.sourceFormat,
      styleFingerprint: writerStyle.sourceFingerprint,
      completeness: 'legacy_unparsed',
      requirements,
    });
  }

  const hasSemanticRule = requirements.some(item => item.category !== 'OTHER');
  return projectionBase({
    assetId: writerStyle.assetId,
    assetName: writerStyle.assetName,
    sourceFormat: writerStyle.sourceFormat,
    styleFingerprint: writerStyle.sourceFingerprint,
    completeness: hasSemanticRule ? 'complete' : 'incomplete_semantic',
    requirements,
  });
}

/** Test-only projection for an already-frozen OriginalStyleProfileV2. */
export function projectOriginalStyleProfileRequirements(input: {
  profile: unknown;
  profileId?: string | number | null;
  profileName?: string;
  styleFingerprint: string | null;
}): WriterStyleRequirementProjection {
  const profile = asRecord(input.profile);
  if (!profile) {
    return projectionBase({
      assetId: input.profileId == null ? null : Number(input.profileId),
      assetName: input.profileName,
      sourceFormat: 'original_style_profile_v2',
      styleFingerprint: input.styleFingerprint,
      completeness: 'missing',
      requirements: [],
    });
  }

  const requirements: StyleRequirement[] = [];
  for (const spec of PROFILE_RULE_SPECS) {
    const requirement = makeRequirement(
      `style:${spec.path}`,
      spec,
      scalarText(pathValue(profile, spec.path)),
      spec.path,
    );
    if (requirement) requirements.push(requirement);
  }

  const avoidValues = [
    ...((Array.isArray(profile.globalAvoid) ? profile.globalAvoid : []) as unknown[]),
    ...((Array.isArray(pathValue(profile, 'global.diction.expressionsToAvoid'))
      ? pathValue(profile, 'global.diction.expressionsToAvoid')
      : []) as unknown[]),
  ];
  avoidValues.forEach((item, index) => {
    const requirement = makeRequirement(
      `style:profileAvoid.${index}`,
      {
        path: 'globalAvoid',
        category: 'PROHIBITION',
        strength: 'AVOID',
        evidenceExpectation: 'explicit_forbidden_pattern_absent',
      },
      text(item),
      `profile.globalAvoid[${index}]`,
    );
    if (requirement) requirements.push(requirement);
  });

  return projectionBase({
    assetId: input.profileId == null ? null : Number(input.profileId),
    assetName: input.profileName || 'Original Style Profile',
    sourceFormat: 'original_style_profile_v2',
    styleFingerprint: input.styleFingerprint,
    completeness:
      requirements.some(item => item.category !== 'OTHER')
        ? 'complete'
        : 'incomplete_semantic',
    requirements,
  });
}

function withoutQuotedDialogue(value: string): string {
  return value.replace(/[“「『"].*?[”」』"]/gsu, '');
}

function hasFirstOrSecondPersonNarration(value: string): boolean {
  const narrative = withoutQuotedDialogue(value);
  return /(?:我|我们|你|你们)(?:看见|看到|走进|走向|想起|想到|想|觉得|知道|感到|感觉|说|问|听见|听到|要|会|已经|没有|不能|不敢|仍然|忽然)/u.test(
    narrative,
  );
}

function isThirdPersonRule(rule: string): boolean {
  return /第三人称|三人称|third[- ]?person/i.test(rule);
}

function forbiddenLiteral(rule: string): string {
  return rule
    .replace(/^(?:禁止|不得|避免|不要|请勿|严禁|不应|不可)\s*/u, '')
    .replace(/[：:，,。；;、]+$/u, '')
    .trim();
}

/** Deterministic checks intentionally cover only hard, mechanically visible signals. */
export function evaluateDeterministicWriterStyle(input: {
  projection: WriterStyleRequirementProjection;
  text: string;
}): DeterministicStyleEvaluation {
  const body = input.text.trim();
  const findings: StyleFinding[] = [];
  for (const requirement of input.projection.requirements) {
    if (!body) continue;
    if (
      requirement.strength === 'AVOID' &&
      forbiddenLiteral(requirement.rule) &&
      body.includes(forbiddenLiteral(requirement.rule))
    ) {
      findings.push({
        requirementId: requirement.id,
        category: requirement.category,
        findingType: 'forbidden_pattern',
        severity: 'hard',
        hardStyleViolation: true,
        evidenceCode: 'literal_forbidden_pattern_present',
      });
      continue;
    }
    if (
      requirement.category === 'POV' &&
      isThirdPersonRule(requirement.rule) &&
      hasFirstOrSecondPersonNarration(body)
    ) {
      findings.push({
        requirementId: requirement.id,
        category: requirement.category,
        findingType: 'pov_drift',
        severity: 'hard',
        hardStyleViolation: requirement.strength === 'MANDATORY',
        evidenceCode: 'first_or_second_person_narration_outside_dialogue',
      });
    }
  }
  return {
    status: findings.length > 0 ? 'violation' : 'not_proven',
    findings,
    checkedRuleCount: input.projection.requirements.length,
  };
}

function uniqueFindings(findings: StyleFinding[]): StyleFinding[] {
  const seen = new Set<string>();
  return findings.filter(finding => {
    const key = `${finding.requirementId}:${finding.findingType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function annotationStatus(
  annotation: BlindStyleAnnotation | undefined,
  requirements: StyleRequirement[],
): { status: BlindStyleAnnotation['status']; unknownCount: number } {
  if (!annotation) {
    return { status: 'not_collected', unknownCount: requirements.length };
  }
  const unknownCount = requirements.filter(
    requirement =>
      !annotation.rules[requirement.id] ||
      annotation.rules[requirement.id].assessment === 'unknown',
  ).length;
  if (unknownCount > 0) return { status: 'partial', unknownCount };
  return { status: annotation.status === 'not_collected' ? 'partial' : 'complete', unknownCount: 0 };
}

export function evaluateWriterStyleSample(input: {
  projection: WriterStyleRequirementProjection;
  text: string;
  blindAnnotation?: BlindStyleAnnotation;
}): WriterStyleSampleEvaluation {
  const deterministic = evaluateDeterministicWriterStyle({
    projection: input.projection,
    text: input.text,
  });
  const annotationInfo = annotationStatus(
    input.blindAnnotation,
    input.projection.requirements,
  );
  const annotations = input.blindAnnotation?.rules || {};
  const deterministicFindings = deterministic.findings;
  const blindFindings = input.projection.requirements.flatMap(requirement => {
    const annotation = annotations[requirement.id];
    if (!annotation || annotation.assessment !== 'violated') return [];
    return [
      {
        requirementId: requirement.id,
        category: requirement.category,
        findingType: 'blind_rule_violation' as const,
        severity: requirement.strength === 'MANDATORY' ? 'hard' as const : 'drift' as const,
        hardStyleViolation:
          requirement.strength === 'MANDATORY' || requirement.strength === 'AVOID',
        evidenceCode: annotation.evidenceCodes?.[0] || 'blind_annotation_violation',
      },
    ];
  });
  const findings = uniqueFindings([...deterministicFindings, ...blindFindings]);
  const assessedRequirements = input.projection.requirements.filter(requirement => {
    const assessment = annotations[requirement.id]?.assessment;
    return assessment && assessment !== 'unknown';
  });
  const applicableRequirements = input.projection.requirements.filter(
    requirement => annotations[requirement.id]?.assessment !== 'not_applicable',
  );
  const satisfiedRequirements = applicableRequirements.filter(
    requirement => annotations[requirement.id]?.assessment === 'satisfied',
  );
  const mandatoryRequirements = applicableRequirements.filter(
    requirement => requirement.strength === 'MANDATORY',
  );
  const mandatorySatisfiedRequirements = mandatoryRequirements.filter(
    requirement => annotations[requirement.id]?.assessment === 'satisfied',
  );
  const completeAnnotation = annotationInfo.status === 'complete';
  const adherenceRate = completeAnnotation && applicableRequirements.length > 0
    ? satisfiedRequirements.reduce((sum, requirement) => sum + requirement.weight, 0) /
      applicableRequirements.reduce((sum, requirement) => sum + requirement.weight, 0)
    : null;
  const hardStyleViolationCount = findings.filter(
    finding => finding.hardStyleViolation,
  ).length;
  const forbiddenPatternCount = findings.filter(
    finding => finding.findingType === 'forbidden_pattern',
  ).length;
  const violatedRuleIds = [...new Set(findings.map(finding => finding.requirementId))].sort();
  const mandatoryPass =
    completeAnnotation &&
    mandatorySatisfiedRequirements.length === mandatoryRequirements.length;
  const evaluationStatus: WriterStyleEvaluationSummary['evaluationStatus'] =
    input.projection.completeness !== 'complete'
      ? 'incomplete_contract'
      : !completeAnnotation
        ? 'manual_required'
        : hardStyleViolationCount > 0 || !mandatoryPass || forbiddenPatternCount > 0
          ? 'fail'
          : 'pass';

  return {
    schema: WRITER_STYLE_ADHERENCE_SCHEMA,
    contractVersion: WRITER_STYLE_ADHERENCE_CONTRACT_VERSION,
    bodyPolicy: WRITER_STYLE_EVIDENCE_BODY_POLICY,
    projection: input.projection,
    deterministic,
    blindEvaluation: {
      source: input.blindAnnotation?.source || null,
      status: annotationInfo.status,
    },
    findings,
    writerStyle: {
      evaluationStatus,
      applicableRuleCount: applicableRequirements.length,
      assessedRuleCount: assessedRequirements.length,
      unknownRuleCount: annotationInfo.unknownCount,
      satisfiedRuleCount: satisfiedRequirements.length,
      mandatoryRuleCount: mandatoryRequirements.length,
      mandatorySatisfiedCount: mandatorySatisfiedRequirements.length,
      mandatoryPass,
      writerStyleAdherenceRate: adherenceRate,
      hardStyleViolationCount,
      forbiddenPatternCount,
      styleDriftCount: violatedRuleIds.length,
      violatedRuleIds,
    },
  };
}

function emptyNarrativeDimensions(): Record<
  NarrativeQualityDimension,
  NarrativeDimensionEvidence
> {
  return Object.fromEntries(
    NARRATIVE_QUALITY_DIMENSIONS.map(dimension => [
      dimension,
      { status: 'not_collected', score: null, evidenceCodes: [] },
    ]),
  ) as unknown as Record<NarrativeQualityDimension, NarrativeDimensionEvidence>;
}

export function buildNarrativeQualityEvidence(input?: {
  rubricVersion?: string;
  minimumScore?: number;
  dimensions?: Partial<
    Record<NarrativeQualityDimension, NarrativeDimensionEvidence>
  >;
}): NarrativeQualityEvidence {
  const minimumScore = input?.minimumScore ?? 3;
  const dimensions = emptyNarrativeDimensions();
  for (const dimension of NARRATIVE_QUALITY_DIMENSIONS) {
    const value = input?.dimensions?.[dimension];
    if (!value) continue;
    const score =
      typeof value.score === 'number' && Number.isFinite(value.score)
        ? Math.max(0, Math.min(4, value.score))
        : null;
    dimensions[dimension] = {
      status: value.status,
      score,
      evidenceCodes: [...value.evidenceCodes],
    };
  }
  const values = NARRATIVE_QUALITY_DIMENSIONS.map(dimension => dimensions[dimension]);
  const status = values.some(value => value.status === 'not_collected')
    ? 'not_collected'
    : values.every(value => value.status === 'pass' && (value.score ?? -1) >= minimumScore)
      ? 'pass'
      : 'fail';
  return {
    rubricVersion: input?.rubricVersion || 'phase4-narrative-quality-v1',
    status,
    minimumScore,
    dimensions,
  };
}

export function assessWriterStyleAcceptance(input: {
  sample: WriterStyleSampleEvaluation;
  narrativeQuality: NarrativeQualityEvidence;
  minimumAdherenceRate?: number;
}): WriterStyleAcceptanceResult {
  const minimumAdherenceRate = input.minimumAdherenceRate ?? 0.8;
  const reasons: string[] = [];
  const writerStyle = input.sample.writerStyle;
  if (input.sample.projection.completeness !== 'complete') {
    reasons.push('writer_style_projection_incomplete');
  }
  if (writerStyle.evaluationStatus === 'manual_required') {
    reasons.push('blind_writer_style_annotation_missing');
  }
  if (writerStyle.hardStyleViolationCount !== 0) {
    reasons.push('hard_style_violation_detected');
  }
  if (writerStyle.forbiddenPatternCount !== 0) {
    reasons.push('forbidden_style_pattern_detected');
  }
  if (!writerStyle.mandatoryPass) {
    reasons.push('mandatory_style_rule_not_satisfied');
  }
  if (
    writerStyle.writerStyleAdherenceRate == null ||
    writerStyle.writerStyleAdherenceRate < minimumAdherenceRate
  ) {
    reasons.push('writer_style_adherence_below_threshold');
  }
  if (input.narrativeQuality.status === 'not_collected') {
    reasons.push('narrative_quality_annotation_missing');
  } else if (input.narrativeQuality.status !== 'pass') {
    reasons.push('narrative_quality_threshold_failed');
  }
  const hasIncompleteEvidence = reasons.some(reason =>
    reason.includes('missing') || reason.includes('incomplete'),
  );
  return {
    status:
      reasons.length === 0
        ? 'pass'
        : hasIncompleteEvidence
          ? 'hold'
          : 'fail',
    reasons,
    writerStyle,
    narrativeQuality: input.narrativeQuality,
  };
}

/**
 * Return only metadata safe for repository evidence. In particular, do not
 * persist rule text, source content, prompts, or any generated body.
 */
export function redactWriterStyleEvidence(input: WriterStyleSampleEvaluation): {
  schema: typeof WRITER_STYLE_ADHERENCE_SCHEMA;
  contractVersion: typeof WRITER_STYLE_ADHERENCE_CONTRACT_VERSION;
  bodyPolicy: typeof WRITER_STYLE_EVIDENCE_BODY_POLICY;
  writerStyle: {
    assetId: number | null;
    assetName: string;
    sourceFormat: string;
    styleFingerprint: string | null;
    projectionCompleteness: WriterStyleProjectionCompleteness;
    requirementCount: number;
    mandatoryRuleIds: string[];
    preferredRuleIds: string[];
    avoidRuleIds: string[];
  };
  adherence: WriterStyleEvaluationSummary;
  findings: Array<{
    requirementId: string;
    category: StyleRequirementCategory;
    findingType: StyleFinding['findingType'];
    severity: StyleFinding['severity'];
    hardStyleViolation: boolean;
    evidenceCode: string;
  }>;
  blindEvaluation: WriterStyleSampleEvaluation['blindEvaluation'];
} {
  const requirements = input.projection.requirements;
  return {
    schema: WRITER_STYLE_ADHERENCE_SCHEMA,
    contractVersion: WRITER_STYLE_ADHERENCE_CONTRACT_VERSION,
    bodyPolicy: WRITER_STYLE_EVIDENCE_BODY_POLICY,
    writerStyle: {
      assetId: input.projection.assetId,
      assetName: input.projection.assetName,
      sourceFormat: input.projection.sourceFormat,
      styleFingerprint: input.projection.styleFingerprint,
      projectionCompleteness: input.projection.completeness,
      requirementCount: requirements.length,
      mandatoryRuleIds: requirements
        .filter(requirement => requirement.strength === 'MANDATORY')
        .map(requirement => requirement.id),
      preferredRuleIds: requirements
        .filter(requirement => requirement.strength === 'PREFERRED')
        .map(requirement => requirement.id),
      avoidRuleIds: requirements
        .filter(requirement => requirement.strength === 'AVOID')
        .map(requirement => requirement.id),
    },
    adherence: input.writerStyle,
    findings: input.findings,
    blindEvaluation: input.blindEvaluation,
  };
}

export function fingerprintStyleRequirementProjection(
  projection: WriterStyleRequirementProjection,
): string {
  return sha256Hex(
    JSON.stringify(
      projection.requirements.map(requirement => ({
        id: requirement.id,
        category: requirement.category,
        rule: requirement.rule,
        strength: requirement.strength,
        sourcePath: requirement.sourcePath,
      })),
    ),
  );
}
