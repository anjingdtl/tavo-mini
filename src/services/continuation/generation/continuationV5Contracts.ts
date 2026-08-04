/**
 * Continuation V5 envelopes, hashes, length policy, and parsers.
 * Client-computed hashes are authoritative; model-reported hashes are soft-checked
 * (mismatch/missing → warning + force expected). Temporary soft-gate mode: prefer
 * degrade-and-continue so the pipeline can finish; harden gates later.
 */
import { stripModelJson } from '../canon/canonJsonValidators';
import { sha256Hex } from '../hashUtils';
import { countHanCharacters } from './continuationLengthContract';
import type {
  ContinuationV5ArchitectureEnvelope,
  ContinuationV5AuditEnvelope,
  ContinuationV5DraftEnvelope,
  ContinuationV5FinalEnvelope,
  ContinuationV5LengthPolicy,
  ContinuationV5RevisionAnchor,
  ContinuationV5RevisionEnvelope,
  ContinuationV5SceneUnit,
} from './types';

/** Temporary global soft-gate switch for V5 technical gates. */
export const CONTINUATION_V5_SOFT_GATES = true;

export const CONTINUATION_V5_LENGTH_POLICY: ContinuationV5LengthPolicy = {
  preferredMinRatio: 0.9,
  preferredMaxRatio: 1.1,
  severeUnderRatio: 0.65,
  outputHeadroomRatio: 1.2,
};

export type V5SoftWarning = string;

function noteSoft(
  softWarnings: V5SoftWarning[] | undefined,
  code: string,
): void {
  if (softWarnings) softWarnings.push(code);
}

export function resolveV5LengthTargets(
  targetHan: number,
  policy: ContinuationV5LengthPolicy = CONTINUATION_V5_LENGTH_POLICY,
): {
  targetHan: number;
  preferredMinHan: number;
  preferredMaxHan: number;
  severeUnderHan: number;
} {
  const safe = Math.max(1, Math.floor(targetHan));
  return {
    targetHan: safe,
    preferredMinHan: Math.max(1, Math.round(safe * policy.preferredMinRatio)),
    preferredMaxHan: Math.max(1, Math.round(safe * policy.preferredMaxRatio)),
    severeUnderHan: Math.max(1, Math.round(safe * policy.severeUnderRatio)),
  };
}

/** Stable JSON for hashing: sorted object keys, no undefined. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

export function hashArchitectureEnvelope(
  envelope: ContinuationV5ArchitectureEnvelope,
): string {
  return sha256Hex(canonicalJson(envelope));
}

export function hashAuditEnvelope(
  envelope: ContinuationV5AuditEnvelope,
): string {
  return sha256Hex(canonicalJson(envelope));
}

export function hashContent(content: string): string {
  return sha256Hex(content);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (typeof item === 'number' ? item : Number(item)))
    .filter(item => Number.isFinite(item));
}

function extractChapterContent(value: unknown, depth = 0): string {
  if (depth > 3) return '';
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    return value
      .map(item => extractChapterContent(item, depth + 1))
      .filter(Boolean)
      .join('\n\n');
  }
  if (!value || typeof value !== 'object') return '';
  const object = value as Record<string, unknown>;
  for (const key of [
    'content',
    'chapterContent',
    'text',
    'body',
    'draft',
    'finalText',
    'paragraphs',
    '正文',
  ]) {
    const extracted = extractChapterContent(object[key], depth + 1);
    if (extracted) return extracted;
  }
  return '';
}

function assertNoPatchFields(
  parsed: Record<string, unknown>,
  label: string,
  softWarnings?: V5SoftWarning[],
): void {
  const forbidden = ['patches', 'offset', 'diff', 'delta'];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      if (CONTINUATION_V5_SOFT_GATES) {
        noteSoft(softWarnings, `${label}_soft_ignored_patch_field:${key}`);
        delete parsed[key];
        continue;
      }
      throw new Error(`${label} 不允许输出局部修改字段 ${key}。`);
    }
  }
}

function sanitizeChapterContent(
  content: string,
  label: string,
  softWarnings?: V5SoftWarning[],
): string {
  let text = content.trim();
  if (!text) {
    throw new Error(`${label} content 不能为空。`);
  }
  try {
    const nested = JSON.parse(text);
    if (nested && typeof nested === 'object') {
      const extracted = extractChapterContent(nested);
      if (extracted && CONTINUATION_V5_SOFT_GATES) {
        noteSoft(softWarnings, `${label}_soft_unwrapped_nested_json_content`);
        text = extracted;
      } else {
        throw new Error(`${label} content 不能再次包含 JSON 外壳。`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('不能再次包含')) {
      throw error;
    }
  }
  if (/```/.test(text) || /<\/?think>/i.test(text)) {
    if (CONTINUATION_V5_SOFT_GATES) {
      noteSoft(softWarnings, `${label}_soft_stripped_protocol_leakage`);
      text = text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/```/g, '')
        .replace(/<\/?think>/gi, '')
        .trim();
      if (!text) {
        throw new Error(`${label} content 不能为空。`);
      }
    } else {
      throw new Error(`${label} content 含协议泄漏标记。`);
    }
  }
  return text;
}

function parseTopObject(
  raw: string,
  label: string,
  softWarnings?: V5SoftWarning[],
): Record<string, any> {
  let parsed: any;
  try {
    parsed = JSON.parse(stripModelJson(raw));
    for (let depth = 0; typeof parsed === 'string' && depth < 2; depth += 1) {
      parsed = JSON.parse(parsed.trim());
    }
  } catch {
    throw new Error(`${label} 返回的不是合法 JSON。`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} JSON 顶层必须是 object。`);
  }
  if (
    parsed.schemaVersion !== undefined &&
    Number(parsed.schemaVersion) !== 1
  ) {
    if (CONTINUATION_V5_SOFT_GATES) {
      noteSoft(
        softWarnings,
        `${label}_soft_schema_version:${String(parsed.schemaVersion)}`,
      );
      parsed.schemaVersion = 1;
    } else {
      throw new Error(`${label} schemaVersion 只能是 1。`);
    }
  }
  return parsed as Record<string, any>;
}

/**
 * Soft hash binding: model-reported value is advisory only.
 * Always return expected; push a warning when missing or mismatched.
 */
function softBindHash(
  reported: string,
  expected: string,
  codePrefix: string,
  field: string,
  softWarnings?: V5SoftWarning[],
): string {
  if (!reported) {
    noteSoft(softWarnings, `${codePrefix}_missing: ${field}`);
    return expected;
  }
  if (reported !== expected) {
    noteSoft(softWarnings, `${codePrefix}_mismatch: ${field}`);
    return expected;
  }
  return expected;
}

export function parseContinuationV5DraftEnvelope(
  raw: string,
  fallback: { chapterGoal?: string; centralConflict?: string } = {},
  softWarnings: V5SoftWarning[] = [],
): ContinuationV5DraftEnvelope {
  const parsed = parseTopObject(raw, 'V5 Draft Writer', softWarnings);
  assertNoPatchFields(parsed, 'V5 Draft Writer', softWarnings);
  const content = sanitizeChapterContent(
    extractChapterContent(
      parsed.content ?? parsed.text ?? parsed.draft ?? parsed.body,
    ),
    'V5 Draft Writer',
    softWarnings,
  );
  const planObj =
    parsed.plan && typeof parsed.plan === 'object' ? parsed.plan : parsed;
  const chapterGoal =
    asString(planObj.chapterGoal) ||
    asString(fallback.chapterGoal) ||
    '完成本章续写推进。';
  const centralConflict =
    asString(planObj.centralConflict) ||
    asString(fallback.centralConflict) ||
    '围绕本章要求推进当前冲突并自然收束。';
  const beatsRaw = Array.isArray(planObj.beats) ? planObj.beats : [];
  const beats =
    beatsRaw.length > 0
      ? beatsRaw.map((beat: any, index: number) => ({
          id: asString(beat?.id) || `beat_${index + 1}`,
          summary:
            asString(beat?.summary) ||
            (typeof beat === 'string' ? beat.trim() : '') ||
            '推进当前冲突',
          stateChange:
            asString(beat?.stateChange) || asString(beat?.state_change) || '',
        }))
      : [
          {
            id: 'beat_1',
            summary: '承接前文，推进当前冲突并形成自然章末。',
            stateChange: '',
          },
        ];
  return {
    schemaVersion: 1,
    plan: { chapterGoal, centralConflict, beats },
    content,
  };
}

function parseSceneUnit(
  raw: any,
  index: number,
): ContinuationV5SceneUnit | null {
  if (!raw || typeof raw !== 'object') return null;
  const sceneId =
    asString(raw.sceneId) || asString(raw.id) || `scene_${index + 1}`;
  const characterAction = asString(raw.characterAction) || asString(raw.action);
  const resistance = asString(raw.resistance) || asString(raw.obstacle);
  const turningPoint = asString(raw.turningPoint) || asString(raw.choice);
  const consequence = asString(raw.consequence) || asString(raw.outcome);
  if (!characterAction || !resistance || !turningPoint || !consequence) {
    return null;
  }
  return {
    sceneId,
    entryState: asString(raw.entryState),
    characterAction,
    resistance,
    turningPoint,
    consequence,
    relationshipChange: asString(raw.relationshipChange) || null,
    informationChange: asString(raw.informationChange) || null,
    riskChange: asString(raw.riskChange) || null,
    canonEvidenceIds: asNumberArray(raw.canonEvidenceIds),
    requiredContinuity: asStringArray(raw.requiredContinuity),
    forbiddenInventions: asStringArray(raw.forbiddenInventions),
  };
}

export function parseContinuationV5ArchitectureEnvelope(
  raw: string,
  softWarnings: V5SoftWarning[] = [],
): ContinuationV5ArchitectureEnvelope {
  const parsed = parseTopObject(raw, 'V5 Narrative Architect', softWarnings);
  const unitsRaw = Array.isArray(parsed.sceneUnits)
    ? parsed.sceneUnits
    : Array.isArray(parsed.scenes)
    ? parsed.scenes
    : [];
  const sceneUnits = unitsRaw
    .map((unit: any, index: number) => parseSceneUnit(unit, index))
    .filter((unit): unit is ContinuationV5SceneUnit => unit != null);
  if (sceneUnits.length === 0) {
    // Soft: runner already has buildFallbackArchitecture; still throw so that
    // path is used (degraded success). Soft gate lives in runner catch.
    throw new Error('V5 Narrative Architect 缺少合法 sceneUnits。');
  }
  return {
    schemaVersion: 1,
    chapterGoal: asString(parsed.chapterGoal) || '推进本章',
    centralConflict: asString(parsed.centralConflict) || '中心冲突',
    sceneUnits,
    endingState: asString(parsed.endingState),
    forbiddenPaddingPatterns: asStringArray(parsed.forbiddenPaddingPatterns),
  };
}

export function buildFallbackArchitecture(input: {
  userInstruction: string;
  draftPlan?: ContinuationV5DraftEnvelope['plan'] | null;
  lockedRules?: string[];
}): ContinuationV5ArchitectureEnvelope {
  const goal =
    input.draftPlan?.chapterGoal ||
    input.userInstruction.slice(0, 200) ||
    '推进本章';
  const conflict =
    input.draftPlan?.centralConflict || '围绕用户要求推进当前冲突';
  const beats = input.draftPlan?.beats?.length
    ? input.draftPlan.beats
    : [
        {
          id: 'beat_1',
          summary: '承接前文',
          stateChange: '局面初现变化',
        },
        {
          id: 'beat_2',
          summary: '推进冲突',
          stateChange: '阻力与选择出现',
        },
        {
          id: 'beat_3',
          summary: '形成章末后果',
          stateChange: '局面收束并留下余波',
        },
      ];
  const sceneUnits: ContinuationV5SceneUnit[] = beats.map((beat, index) => ({
    sceneId: `fallback_scene_${index + 1}`,
    entryState: index === 0 ? '承接上一局面' : `承接场景 ${index}`,
    characterAction: beat.summary,
    resistance: '遭遇符合 Canon 的阻力或异常',
    turningPoint: '人物做出选择或被迫转向',
    consequence: beat.stateChange || '局面发生变化',
    relationshipChange: null,
    informationChange: null,
    riskChange: null,
    canonEvidenceIds: [],
    requiredContinuity: [
      '不得新增核心事实',
      ...(input.lockedRules ?? []).slice(0, 3),
    ],
    forbiddenInventions: ['新增核心人物', '新增重大能力', '未来剧透'],
  }));
  return {
    schemaVersion: 1,
    chapterGoal: goal,
    centralConflict: conflict,
    sceneUnits,
    endingState: '形成自然章末并保留可续写余波',
    forbiddenPaddingPatterns: [
      '重复心理描写',
      '堆叠环境描写',
      '无信息对白',
      '总结解释式收束',
    ],
  };
}

export function parseContinuationV5RevisionEnvelope(
  raw: string,
  expected: { draftArtifactHash: string; architectureHash: string },
  softWarnings: V5SoftWarning[] = [],
): ContinuationV5RevisionEnvelope {
  const parsed = parseTopObject(raw, 'V5 Revision Writer', softWarnings);
  assertNoPatchFields(parsed, 'V5 Revision Writer', softWarnings);
  const content = sanitizeChapterContent(
    extractChapterContent(parsed.content ?? parsed.text),
    'V5 Revision Writer',
    softWarnings,
  );
  const draftArtifactHash = CONTINUATION_V5_SOFT_GATES
    ? softBindHash(
        asString(parsed.draftArtifactHash),
        expected.draftArtifactHash,
        'revision_writer_hash',
        'draftArtifactHash',
        softWarnings,
      )
    : (() => {
        const reported = asString(parsed.draftArtifactHash);
        if (!reported) {
          throw new Error('revision_writer_hash_missing: draftArtifactHash');
        }
        if (reported !== expected.draftArtifactHash) {
          throw new Error('revision_writer_hash_mismatch: draftArtifactHash');
        }
        return reported;
      })();
  const architectureHash = CONTINUATION_V5_SOFT_GATES
    ? softBindHash(
        asString(parsed.architectureHash),
        expected.architectureHash,
        'revision_writer_hash',
        'architectureHash',
        softWarnings,
      )
    : (() => {
        const reported = asString(parsed.architectureHash);
        if (!reported) {
          throw new Error('revision_writer_hash_missing: architectureHash');
        }
        if (reported !== expected.architectureHash) {
          throw new Error('revision_writer_hash_mismatch: architectureHash');
        }
        return reported;
      })();
  return {
    schemaVersion: 1,
    draftArtifactHash,
    architectureHash,
    content,
    usedArchitectSceneIds: asStringArray(parsed.usedArchitectSceneIds),
    omittedArchitectSceneIds: asStringArray(parsed.omittedArchitectSceneIds),
    declaredNewCoreFacts: asStringArray(parsed.declaredNewCoreFacts),
  };
}

const CANON_CATEGORIES = new Set([
  'character',
  'world',
  'relationship',
  'plot',
  'experience',
  'knowledge',
  'timeline',
  'boundary',
  'locked_rule',
]);

const STYLE_DIMENSIONS = new Set([
  'narrative_voice',
  'pov',
  'sentence_rhythm',
  'dialogue_voice',
  'emotional_expression',
  'description_density',
  'subtext',
  'scene_transition',
  'ai_template',
  'padding',
]);

export function parseContinuationV5AuditEnvelope(
  raw: string,
  expected: {
    draftArtifactHash: string;
    revisionArtifactHash?: string;
    architectureHash: string;
    canonSnapshotId: string;
    canonRevision: number;
    inputRevisionHash: string;
    styleProfileHash: string | null;
    styleRendererVersion: string | null;
    /** Present for current V2-driven C2 calls; omitted for persisted legacy C2. */
    revisionAnchors?: ContinuationV5RevisionAnchor[];
  },
  softWarnings: V5SoftWarning[] = [],
): ContinuationV5AuditEnvelope {
  const parsed = parseTopObject(raw, 'V5 Adversarial Auditor', softWarnings);
  const draftArtifactHash = CONTINUATION_V5_SOFT_GATES
    ? softBindHash(
        asString(parsed.draftArtifactHash),
        expected.draftArtifactHash,
        'adversarial_audit_binding',
        'draftArtifactHash',
        softWarnings,
      )
    : (() => {
        const reported = asString(parsed.draftArtifactHash);
        if (!reported || reported !== expected.draftArtifactHash) {
          throw new Error(
            'adversarial_audit_binding_failed: draftArtifactHash',
          );
        }
        return reported;
      })();
  const revisionArtifactHash = expected.revisionArtifactHash
    ? CONTINUATION_V5_SOFT_GATES
      ? softBindHash(
          asString(parsed.revisionArtifactHash),
          expected.revisionArtifactHash,
          'adversarial_audit_binding',
          'revisionArtifactHash',
          softWarnings,
        )
      : (() => {
          const reported = asString(parsed.revisionArtifactHash);
          if (!reported || reported !== expected.revisionArtifactHash) {
            throw new Error(
              'adversarial_audit_binding_failed: revisionArtifactHash',
            );
          }
          return reported;
        })()
    : draftArtifactHash;
  const architectureHash = CONTINUATION_V5_SOFT_GATES
    ? softBindHash(
        asString(parsed.architectureHash),
        expected.architectureHash,
        'adversarial_audit_binding',
        'architectureHash',
        softWarnings,
      )
    : (() => {
        const reported = asString(parsed.architectureHash);
        if (!reported || reported !== expected.architectureHash) {
          throw new Error('adversarial_audit_binding_failed: architectureHash');
        }
        return reported;
      })();
  if (asString(parsed.canonSnapshotId) !== expected.canonSnapshotId) {
    if (CONTINUATION_V5_SOFT_GATES) {
      noteSoft(
        softWarnings,
        'adversarial_audit_binding_mismatch: canonSnapshotId',
      );
    } else {
      throw new Error('adversarial_audit_binding_failed: canonSnapshotId');
    }
  }
  if (Number(parsed.canonRevision) !== expected.canonRevision) {
    if (CONTINUATION_V5_SOFT_GATES) {
      noteSoft(
        softWarnings,
        'adversarial_audit_binding_mismatch: canonRevision',
      );
    } else {
      throw new Error('adversarial_audit_binding_failed: canonRevision');
    }
  }
  if (asString(parsed.inputRevisionHash) !== expected.inputRevisionHash) {
    if (CONTINUATION_V5_SOFT_GATES) {
      noteSoft(
        softWarnings,
        'adversarial_audit_binding_mismatch: inputRevisionHash',
      );
    } else {
      throw new Error('adversarial_audit_binding_failed: inputRevisionHash');
    }
  }
  const styleHash =
    parsed.styleProfileHash == null ? null : asString(parsed.styleProfileHash);
  if (
    styleHash !== (expected.styleProfileHash ?? null) &&
    expected.styleProfileHash
  ) {
    if (CONTINUATION_V5_SOFT_GATES) {
      noteSoft(
        softWarnings,
        'adversarial_audit_binding_mismatch: styleProfileHash',
      );
    } else {
      throw new Error('adversarial_audit_binding_failed: styleProfileHash');
    }
  }
  const styleRenderer =
    parsed.styleRendererVersion == null
      ? null
      : asString(parsed.styleRendererVersion);
  if (
    styleRenderer !== (expected.styleRendererVersion ?? null) &&
    expected.styleRendererVersion
  ) {
    if (CONTINUATION_V5_SOFT_GATES) {
      noteSoft(
        softWarnings,
        'adversarial_audit_binding_mismatch: styleRendererVersion',
      );
    } else {
      throw new Error('adversarial_audit_binding_failed: styleRendererVersion');
    }
  }

  const canonCorrections = Array.isArray(parsed.canonAudit?.requiredCorrections)
    ? parsed.canonAudit.requiredCorrections
    : [];
  const styleCorrections = Array.isArray(parsed.styleAudit?.requiredCorrections)
    ? parsed.styleAudit.requiredCorrections
    : [];
  const rejectedScenes = Array.isArray(parsed.architectureAudit?.rejectedScenes)
    ? parsed.architectureAudit.rejectedScenes
    : [];
  const finalObligations = Array.isArray(parsed.finalObligations)
    ? parsed.finalObligations
    : [];

  return {
    schemaVersion: 1,
    draftArtifactHash,
    revisionArtifactHash,
    architectureHash,
    canonSnapshotId: expected.canonSnapshotId,
    canonRevision: expected.canonRevision,
    inputRevisionHash: expected.inputRevisionHash,
    styleProfileHash: expected.styleProfileHash,
    styleRendererVersion: expected.styleRendererVersion,
    canonAudit: {
      requiredCorrections: canonCorrections
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any, index: number) => {
          const evidenceIds = asNumberArray(item.evidenceIds);
          const confidence =
            typeof item.confidence === 'number' &&
            Number.isFinite(item.confidence)
              ? item.confidence
              : 0;
          let severity: 'warning' | 'error' | 'blocking' =
            item.severity === 'blocking' || item.severity === 'error'
              ? item.severity
              : 'warning';
          // Missing evidence cannot be elevated to blocking.
          if (severity === 'blocking' && evidenceIds.length === 0) {
            severity = 'error';
          }
          return {
            requirementId:
              asString(item.requirementId) || `canon_req_${index + 1}`,
            category: CANON_CATEGORIES.has(item.category)
              ? item.category
              : 'world',
            severity,
            confidence,
            generatedStart:
              typeof item.generatedStart === 'number'
                ? item.generatedStart
                : null,
            generatedEnd:
              typeof item.generatedEnd === 'number' ? item.generatedEnd : null,
            generatedExcerpt: asString(item.generatedExcerpt),
            description: asString(item.description) || 'Canon 纠正项',
            evidenceIds,
            requiredOutcome: asString(item.requiredOutcome),
            forbiddenChanges: asStringArray(item.forbiddenChanges),
          };
        }),
      protectedFacts: asStringArray(parsed.canonAudit?.protectedFacts),
      forbiddenFacts: asStringArray(parsed.canonAudit?.forbiddenFacts),
    },
    styleAudit: {
      requiredCorrections: styleCorrections
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any, index: number) => {
          const anchorId = asString(item.anchorId);
          const anchor = expected.revisionAnchors?.find(
            candidate => candidate.anchorId === anchorId,
          );
          // Current C2 must select a client-derived V2 id. This normalizes
          // its task input; it does not reject or gate the later V3 result.
          if (expected.revisionAnchors && !anchor) {
            noteSoft(
              softWarnings,
              `adversarial_audit_anchor_unresolved: ${
                anchorId || `style_${index + 1}`
              }`,
            );
            return null;
          }
          return {
            requirementId:
              asString(item.requirementId) || `style_req_${index + 1}`,
            anchorId: anchor?.anchorId ?? null,
            dimension: STYLE_DIMENSIONS.has(item.dimension)
              ? item.dimension
              : 'narrative_voice',
            severity: item.severity === 'error' ? 'error' : 'warning',
            confidence:
              typeof item.confidence === 'number' &&
              Number.isFinite(item.confidence)
                ? item.confidence
                : 0,
            generatedStart:
              anchor?.start ??
              (typeof item.generatedStart === 'number'
                ? item.generatedStart
                : null),
            generatedEnd:
              anchor?.end ??
              (typeof item.generatedEnd === 'number'
                ? item.generatedEnd
                : null),
            generatedExcerpt: anchor?.text ?? asString(item.generatedExcerpt),
            description: asString(item.description) || '文风纠正项',
            styleEvidenceIds: asStringArray(item.styleEvidenceIds),
            rewriteGoal: asString(item.rewriteGoal),
            preserveMeaning: asStringArray(item.preserveMeaning),
          };
        })
        .filter((item: any) => item !== null),
      protectedPassages: Array.isArray(parsed.styleAudit?.protectedPassages)
        ? parsed.styleAudit.protectedPassages
            .filter((item: any) => item && typeof item === 'object')
            .map((item: any, index: number) => ({
              passageId: asString(item.passageId) || `pass_${index + 1}`,
              generatedStart:
                typeof item.generatedStart === 'number'
                  ? item.generatedStart
                  : 0,
              generatedEnd:
                typeof item.generatedEnd === 'number' ? item.generatedEnd : 0,
              generatedExcerpt: asString(item.generatedExcerpt),
              reason: asString(item.reason),
            }))
            .filter((item: any) => item.generatedExcerpt)
        : [],
      forbiddenExpansionPatterns: asStringArray(
        parsed.styleAudit?.forbiddenExpansionPatterns,
      ),
    },
    architectureAudit: {
      safeSceneIds: asStringArray(parsed.architectureAudit?.safeSceneIds),
      rejectedScenes: rejectedScenes
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any) => ({
          sceneId: asString(item.sceneId),
          reasonCode: item.reasonCode || 'unsupported_core_fact',
          description: asString(item.description),
          evidenceIds: asNumberArray(item.evidenceIds),
        }))
        .filter((item: any) => item.sceneId),
    },
    finalObligations: finalObligations
      .filter((item: any) => item && typeof item === 'object')
      .map((item: any, index: number) => ({
        obligationId: asString(item.obligationId) || `obl_${index + 1}`,
        source:
          item.source === 'canon' ||
          item.source === 'style' ||
          item.source === 'architecture' ||
          item.source === 'user_rule'
            ? item.source
            : 'user_rule',
        priority:
          typeof item.priority === 'number' && Number.isFinite(item.priority)
            ? item.priority
            : index + 1,
        description: asString(item.description),
        requiredOutcome: asString(item.requiredOutcome),
        forbiddenChanges: asStringArray(item.forbiddenChanges),
      })),
  };
}

export function buildFallbackAuditContract(input: {
  draftArtifactHash: string;
  revisionArtifactHash?: string;
  architectureHash: string;
  canonSnapshotId: string;
  canonRevision: number;
  inputRevisionHash: string;
  styleProfileHash: string | null;
  styleRendererVersion: string | null;
  lockedRules: string[];
  hardCanonFacts: string[];
}): ContinuationV5AuditEnvelope {
  const obligations = [
    ...input.lockedRules.slice(0, 8).map((rule, index) => ({
      obligationId: `fallback_user_rule_${index + 1}`,
      source: 'user_rule' as const,
      priority: index + 1,
      description: rule,
      requiredOutcome: '遵守用户锁定规则与续写边界',
      forbiddenChanges: ['违反锁定规则'],
    })),
    {
      obligationId: 'fallback_no_new_core_facts',
      source: 'canon' as const,
      priority: 100,
      description: '禁止新增核心人物、能力、组织、关系状态、世界规则或后续事实',
      requiredOutcome: 'declaredNewCoreFacts 必须为空',
      forbiddenChanges: ['新增核心事实'],
    },
    {
      obligationId: 'fallback_no_future_leakage',
      source: 'canon' as const,
      priority: 101,
      description: '禁止未来剧透与越界知识',
      requiredOutcome: '不引入边界后事实',
      forbiddenChanges: ['future_leakage'],
    },
    {
      obligationId: 'fallback_no_padding',
      source: 'style' as const,
      priority: 102,
      description: '禁止 padding 与 AI 模板化注水',
      requiredOutcome: '不通过重复心理/环境/对白凑字数',
      forbiddenChanges: ['padding', 'ai_template'],
    },
  ];
  return {
    schemaVersion: 1,
    draftArtifactHash: input.draftArtifactHash,
    revisionArtifactHash: input.revisionArtifactHash ?? input.draftArtifactHash,
    architectureHash: input.architectureHash,
    canonSnapshotId: input.canonSnapshotId,
    canonRevision: input.canonRevision,
    inputRevisionHash: input.inputRevisionHash,
    styleProfileHash: input.styleProfileHash,
    styleRendererVersion: input.styleRendererVersion,
    canonAudit: {
      requiredCorrections: [],
      protectedFacts: input.hardCanonFacts.slice(0, 20),
      forbiddenFacts: ['新增核心事实', '未来剧透'],
    },
    styleAudit: {
      requiredCorrections: [],
      protectedPassages: [],
      forbiddenExpansionPatterns: [
        '重复心理',
        '堆叠环境',
        '无信息对白',
        '总结解释',
      ],
    },
    architectureAudit: {
      // Fallback: scenes are reference-only, not pre-approved.
      safeSceneIds: [],
      rejectedScenes: [],
    },
    finalObligations: obligations,
  };
}

export function parseContinuationV5FinalEnvelope(
  raw: string,
  expected: {
    revisionArtifactHash: string;
    architectureHash: string;
    auditContractHash: string;
  },
  softWarnings: V5SoftWarning[] = [],
): ContinuationV5FinalEnvelope {
  const parsed = parseTopObject(raw, 'V5 Final Reviser', softWarnings);
  assertNoPatchFields(parsed, 'V5 Final Reviser', softWarnings);
  const content = sanitizeChapterContent(
    extractChapterContent(parsed.content ?? parsed.text),
    'V5 Final Reviser',
    softWarnings,
  );
  const revisionArtifactHash = CONTINUATION_V5_SOFT_GATES
    ? softBindHash(
        asString(parsed.revisionArtifactHash),
        expected.revisionArtifactHash,
        'final_revision_hash',
        'revisionArtifactHash',
        softWarnings,
      )
    : (() => {
        const reported = asString(parsed.revisionArtifactHash);
        if (!reported) throw new Error('final_revision_hash_missing');
        if (reported !== expected.revisionArtifactHash) {
          throw new Error('final_revision_hash_mismatch');
        }
        return reported;
      })();
  const architectureHash = CONTINUATION_V5_SOFT_GATES
    ? softBindHash(
        asString(parsed.architectureHash),
        expected.architectureHash,
        'final_architecture_hash',
        'architectureHash',
        softWarnings,
      )
    : (() => {
        const reported = asString(parsed.architectureHash);
        if (!reported) throw new Error('final_architecture_hash_missing');
        if (reported !== expected.architectureHash) {
          throw new Error('final_architecture_hash_mismatch');
        }
        return reported;
      })();
  const auditContractHash = CONTINUATION_V5_SOFT_GATES
    ? softBindHash(
        asString(parsed.auditContractHash),
        expected.auditContractHash,
        'final_audit_hash',
        'auditContractHash',
        softWarnings,
      )
    : (() => {
        const reported = asString(parsed.auditContractHash);
        if (!reported) throw new Error('final_audit_hash_missing');
        if (reported !== expected.auditContractHash) {
          throw new Error('final_audit_hash_mismatch');
        }
        return reported;
      })();
  return {
    schemaVersion: 1,
    revisionArtifactHash,
    architectureHash,
    auditContractHash,
    content,
    appliedObligationIds: asStringArray(parsed.appliedObligationIds),
    appliedCanonRequirementIds: asStringArray(
      parsed.appliedCanonRequirementIds,
    ),
    appliedStyleRequirementIds: asStringArray(
      parsed.appliedStyleRequirementIds,
    ),
    usedArchitectSceneIds: asStringArray(parsed.usedArchitectSceneIds),
    restoredProtectedPassageIds: asStringArray(
      parsed.restoredProtectedPassageIds,
    ),
    declaredNewCoreFacts: asStringArray(parsed.declaredNewCoreFacts),
    unappliedItems: asStringArray(parsed.unappliedItems),
  };
}

export function diagnoseLengthTelemetry(input: {
  content: string;
  targetHan: number;
  finishReason?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  maximumOutputTokens?: number | null;
  declaredMaxOutputTokens?: number | null;
  minimumOutputTokens?: number | null;
  effectiveMaxOutputTokens?: number | null;
}): {
  targetHan: number;
  preferredMinHan: number;
  preferredMaxHan: number;
  severeUnderHan: number;
  actualHan: number;
  targetAttainmentRatio: number;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  maximumOutputTokens: number | null;
  declaredMaxOutputTokens: number | null;
  minimumOutputTokens: number | null;
  effectiveMaxOutputTokens: number | null;
  actualTokensPerHan: number | null;
  severeUnderTarget: boolean;
} {
  const targets = resolveV5LengthTargets(input.targetHan);
  const actualHan = countHanCharacters(input.content);
  const ratio = targets.targetHan > 0 ? actualHan / targets.targetHan : 0;
  const completion = input.completionTokens ?? null;
  return {
    ...targets,
    actualHan,
    targetAttainmentRatio: ratio,
    finishReason: input.finishReason ?? null,
    promptTokens: input.promptTokens ?? null,
    completionTokens: completion,
    maximumOutputTokens: input.maximumOutputTokens ?? null,
    declaredMaxOutputTokens: input.declaredMaxOutputTokens ?? null,
    minimumOutputTokens: input.minimumOutputTokens ?? null,
    effectiveMaxOutputTokens: input.effectiveMaxOutputTokens ?? null,
    actualTokensPerHan:
      completion != null && actualHan > 0 ? completion / actualHan : null,
    severeUnderTarget: actualHan < targets.severeUnderHan,
  };
}
