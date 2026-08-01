/**
 * Style Profile V2 schema and validator (Spec §5.5).
 *
 * The profile is the operational writing-constraint layer produced by the
 * `style_analysis` stage. It is NOT a vague literary critique ("语言优美") —
 * every field must be an actionable instruction that Writer/Checker/Repair can
 * apply. Character voices describe abstract habits only and never require
 * reproducing long original character sentences (Spec §4, §5.5).
 *
 * The JSON shape is produced by the analyzer LLM and persisted as
 * `profile_json`. `validateStyleProfileV2` is the single schema gate the
 * analysis service relies on; it returns aggregated structural errors so the
 * caller can feed them to the one allowed repair retry (Spec §5.6).
 */

/** Scene types recognised by the stratified sampler and scene variants. */
export type StyleSceneType =
  | 'action'
  | 'dialogue'
  | 'emotion'
  | 'description'
  | 'transition';

/** Canonical narrative / syntax / etc. sub-objects. */
export interface OriginalStyleProfileV2 {
  schemaVersion: 2;
  summary: string;
  global: {
    narrative: {
      person: string;
      focalization: string;
      narrativeDistance: string;
      tenseAndTimeHandling: string;
      perspectiveSwitchRules: string[];
    };
    syntax: {
      sentenceLengthPattern: string;
      sentenceStructures: string[];
      punctuationHabits: string[];
      paragraphPattern: string;
    };
    diction: {
      register: string;
      concreteness: string;
      lexicalPreferences: string[];
      expressionsToAvoid: string[];
    };
    tone: {
      baseline: string;
      emotionalAmplitude: string;
      humorAndRestraint: string;
    };
    rhythm: {
      scenePacing: string;
      expositionDensity: string;
      transitionMethods: string[];
      chapterEndingPatterns: string[];
    };
    description: {
      sensoryPriorities: string[];
      environmentUsage: string;
      actionVsInteriorBalance: string;
      imageryHabits: string[];
    };
    dialogue: {
      dialogueDensity: string;
      turnLength: string;
      attributionStyle: string;
      subtextStyle: string;
      expositionAvoidance: string[];
    };
    informationReveal: {
      setupMethod: string;
      foreshadowingMethod: string;
      suspenseMethod: string;
    };
  };
  boundaryLocalDelta: {
    tone: string;
    pacing: string;
    sentenceAndParagraphShift: string;
    activeNarrativePatterns: string[];
  };
  sceneVariants: Array<{
    sceneType: StyleSceneType;
    instructions: string[];
    avoid: string[];
    confidence: number;
  }>;
  characterVoices: Array<{
    canonCharacterId: number | null;
    sourceName: string;
    speechRegister: string;
    sentenceHabits: string[];
    interactionHabits: string[];
    avoid: string[];
    confidence: number;
  }>;
  globalAvoid: string[];
  confidence: number;
  coverage: {
    sourceChapterCount: number;
    sampledChapterCount: number;
    sampledKinds: string[];
  };
}

export interface ValidateStyleProfileV2Result {
  ok: boolean;
  errors: string[];
  profile?: OriginalStyleProfileV2;
}

const VALID_SCENE_TYPES: ReadonlySet<StyleSceneType> = new Set([
  'action',
  'dialogue',
  'emotion',
  'description',
  'transition',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

/**
 * LLM outputs often return a single string or mixed array where a string[] is
 * required (CAN-101 style failure: imageryHabits as string). Coerce leniently
 * before hard-failing validation.
 */
function coerceStringArray(value: unknown): string[] | null {
  if (isStringArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        if (item.trim()) out.push(item);
        continue;
      }
      if (item == null) continue;
      if (typeof item === 'number' || typeof item === 'boolean') {
        out.push(String(item));
        continue;
      }
      // objects / nested arrays: not coercible
      return null;
    }
    return out;
  }
  return null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Require a string field on `obj`. Empty/whitespace-only strings are rejected
 * because operational instructions must carry actual guidance (Spec §5.5).
 */
function requireString(
  obj: Record<string, unknown>,
  path: string,
  errors: string[],
): string | null {
  const v = obj[path.split('.').pop() as string];
  if (!isString(v) || v.trim() === '') {
    errors.push(`缺少或空白的字符串字段：${path}`);
    return null;
  }
  return v;
}

function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): string[] | null {
  const coerced = coerceStringArray(obj[key]);
  if (coerced == null) {
    errors.push(`字段 ${path} 必须是字符串数组`);
    return null;
  }
  // Write back so the built profile uses the coerced value.
  obj[key] = coerced;
  return coerced;
}

function requireObject(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): Record<string, unknown> | null {
  const v = obj[key];
  if (!isObject(v)) {
    errors.push(`字段 ${path} 必须是对象`);
    return null;
  }
  return v;
}

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): number | null {
  const v = obj[key];
  if (!isNumber(v)) {
    errors.push(`字段 ${path} 必须是有限数字`);
    return null;
  }
  return v;
}

function requireProbability(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): number | null {
  const v = requireNumber(obj, key, path, errors);
  if (v === null) return null;
  if (v < 0 || v > 1) {
    errors.push(`字段 ${path} 必须在 [0, 1] 范围内`);
    return null;
  }
  return v;
}

/**
 * Validate an unknown value against {@link OriginalStyleProfileV2}.
 *
 * Returns `ok: false` with aggregated `errors` for any structural problem
 * (missing field, wrong type, out-of-range confidence, unknown sceneType). The
 * analysis service feeds `errors` into the one allowed repair retry and never
 * retries infinitely (Spec §5.6).
 */
export function validateStyleProfileV2(
  value: unknown,
): ValidateStyleProfileV2Result {
  const errors: string[] = [];
  if (!isObject(value)) {
    return { ok: false, errors: ['顶层必须是一个对象'] };
  }

  if (value.schemaVersion !== 2) {
    errors.push('schemaVersion 必须为 2');
  }

  // summary — must be a non-empty operational summary.
  if (!isString(value.summary) || value.summary.trim() === '') {
    errors.push('summary 必须是非空字符串');
  }

  // global
  const globalRaw = requireObject(value, 'global', 'global', errors);
  if (globalRaw) {
    validateGlobal(globalRaw, errors);
  }

  // boundaryLocalDelta
  const boundaryRaw = requireObject(
    value,
    'boundaryLocalDelta',
    'boundaryLocalDelta',
    errors,
  );
  if (boundaryRaw) {
    const tone = requireString({ tone: boundaryRaw.tone }, 'boundaryLocalDelta.tone', errors);
    const pacing = requireString(
      { pacing: boundaryRaw.pacing },
      'boundaryLocalDelta.pacing',
      errors,
    );
    const shift = requireString(
      { sentenceAndParagraphShift: boundaryRaw.sentenceAndParagraphShift },
      'boundaryLocalDelta.sentenceAndParagraphShift',
      errors,
    );
    const active = requireStringArray(
      boundaryRaw,
      'activeNarrativePatterns',
      'boundaryLocalDelta.activeNarrativePatterns',
      errors,
    );
    void tone;
    void pacing;
    void shift;
    void active;
  }

  // sceneVariants
  if (!Array.isArray(value.sceneVariants)) {
    errors.push('sceneVariants 必须是数组');
  } else {
    value.sceneVariants.forEach((sv, i) => {
      const path = `sceneVariants[${i}]`;
      if (!isObject(sv)) {
        errors.push(`${path} 必须是对象`);
        return;
      }
      if (!isString(sv.sceneType) || !VALID_SCENE_TYPES.has(sv.sceneType as StyleSceneType)) {
        errors.push(
          `${path}.sceneType 必须是 action|dialogue|emotion|description|transition 之一`,
        );
      }
      requireStringArray(sv, 'instructions', `${path}.instructions`, errors);
      requireStringArray(sv, 'avoid', `${path}.avoid`, errors);
      requireProbability(sv, 'confidence', `${path}.confidence`, errors);
    });
  }

  // characterVoices — may be empty, but entries must be well-formed. Voices
  // describe abstract habits only; the validator never requires original quotes.
  if (!Array.isArray(value.characterVoices)) {
    errors.push('characterVoices 必须是数组');
  } else {
    value.characterVoices.forEach((cv, i) => {
      const path = `characterVoices[${i}]`;
      if (!isObject(cv)) {
        errors.push(`${path} 必须是对象`);
        return;
      }
      // canonCharacterId may be null (voice not yet linked to a Canon entity).
      if (
        cv.canonCharacterId !== null &&
        cv.canonCharacterId !== undefined &&
        !isNumber(cv.canonCharacterId)
      ) {
        errors.push(`${path}.canonCharacterId 必须是数字或 null`);
      }
      if (!isString(cv.sourceName) || cv.sourceName.trim() === '') {
        errors.push(`${path}.sourceName 必须是非空字符串`);
      }
      requireString({ speechRegister: cv.speechRegister }, `${path}.speechRegister`, errors);
      requireStringArray(cv, 'sentenceHabits', `${path}.sentenceHabits`, errors);
      requireStringArray(cv, 'interactionHabits', `${path}.interactionHabits`, errors);
      requireStringArray(cv, 'avoid', `${path}.avoid`, errors);
      requireProbability(cv, 'confidence', `${path}.confidence`, errors);
    });
  }

  // globalAvoid
  if (!isStringArray(value.globalAvoid)) {
    errors.push('globalAvoid 必须是字符串数组');
  }

  // confidence
  requireProbability(value, 'confidence', 'confidence', errors);

  // coverage
  const coverageRaw = requireObject(value, 'coverage', 'coverage', errors);
  if (coverageRaw) {
    const scc = requireNumber(
      coverageRaw,
      'sourceChapterCount',
      'coverage.sourceChapterCount',
      errors,
    );
    const sampled = requireNumber(
      coverageRaw,
      'sampledChapterCount',
      'coverage.sampledChapterCount',
      errors,
    );
    const kinds = requireStringArray(
      coverageRaw,
      'sampledKinds',
      'coverage.sampledKinds',
      errors,
    );
    if (
      scc !== null &&
      sampled !== null &&
      sampled > scc
    ) {
      errors.push('coverage.sampledChapterCount 不能超过 sourceChapterCount');
    }
    void kinds;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, errors: [], profile: value as unknown as OriginalStyleProfileV2 };
}

function validateGlobal(
  global: Record<string, unknown>,
  errors: string[],
): void {
  // narrative
  const narrative = requireObject(global, 'narrative', 'global.narrative', errors);
  if (narrative) {
    requireString({ person: narrative.person }, 'global.narrative.person', errors);
    requireString(
      { focalization: narrative.focalization },
      'global.narrative.focalization',
      errors,
    );
    requireString(
      { narrativeDistance: narrative.narrativeDistance },
      'global.narrative.narrativeDistance',
      errors,
    );
    requireString(
      { tenseAndTimeHandling: narrative.tenseAndTimeHandling },
      'global.narrative.tenseAndTimeHandling',
      errors,
    );
    requireStringArray(
      narrative,
      'perspectiveSwitchRules',
      'global.narrative.perspectiveSwitchRules',
      errors,
    );
  }

  // syntax
  const syntax = requireObject(global, 'syntax', 'global.syntax', errors);
  if (syntax) {
    requireString(
      { sentenceLengthPattern: syntax.sentenceLengthPattern },
      'global.syntax.sentenceLengthPattern',
      errors,
    );
    requireStringArray(
      syntax,
      'sentenceStructures',
      'global.syntax.sentenceStructures',
      errors,
    );
    requireStringArray(
      syntax,
      'punctuationHabits',
      'global.syntax.punctuationHabits',
      errors,
    );
    requireString(
      { paragraphPattern: syntax.paragraphPattern },
      'global.syntax.paragraphPattern',
      errors,
    );
  }

  // diction
  const diction = requireObject(global, 'diction', 'global.diction', errors);
  if (diction) {
    requireString({ register: diction.register }, 'global.diction.register', errors);
    requireString(
      { concreteness: diction.concreteness },
      'global.diction.concreteness',
      errors,
    );
    requireStringArray(
      diction,
      'lexicalPreferences',
      'global.diction.lexicalPreferences',
      errors,
    );
    requireStringArray(
      diction,
      'expressionsToAvoid',
      'global.diction.expressionsToAvoid',
      errors,
    );
  }

  // tone
  const tone = requireObject(global, 'tone', 'global.tone', errors);
  if (tone) {
    requireString({ baseline: tone.baseline }, 'global.tone.baseline', errors);
    requireString(
      { emotionalAmplitude: tone.emotionalAmplitude },
      'global.tone.emotionalAmplitude',
      errors,
    );
    requireString(
      { humorAndRestraint: tone.humorAndRestraint },
      'global.tone.humorAndRestraint',
      errors,
    );
  }

  // rhythm
  const rhythm = requireObject(global, 'rhythm', 'global.rhythm', errors);
  if (rhythm) {
    requireString(
      { scenePacing: rhythm.scenePacing },
      'global.rhythm.scenePacing',
      errors,
    );
    requireString(
      { expositionDensity: rhythm.expositionDensity },
      'global.rhythm.expositionDensity',
      errors,
    );
    requireStringArray(
      rhythm,
      'transitionMethods',
      'global.rhythm.transitionMethods',
      errors,
    );
    requireStringArray(
      rhythm,
      'chapterEndingPatterns',
      'global.rhythm.chapterEndingPatterns',
      errors,
    );
  }

  // description
  const description = requireObject(
    global,
    'description',
    'global.description',
    errors,
  );
  if (description) {
    requireStringArray(
      description,
      'sensoryPriorities',
      'global.description.sensoryPriorities',
      errors,
    );
    requireString(
      { environmentUsage: description.environmentUsage },
      'global.description.environmentUsage',
      errors,
    );
    requireString(
      { actionVsInteriorBalance: description.actionVsInteriorBalance },
      'global.description.actionVsInteriorBalance',
      errors,
    );
    requireStringArray(
      description,
      'imageryHabits',
      'global.description.imageryHabits',
      errors,
    );
  }

  // dialogue
  const dialogue = requireObject(global, 'dialogue', 'global.dialogue', errors);
  if (dialogue) {
    requireString(
      { dialogueDensity: dialogue.dialogueDensity },
      'global.dialogue.dialogueDensity',
      errors,
    );
    requireString(
      { turnLength: dialogue.turnLength },
      'global.dialogue.turnLength',
      errors,
    );
    requireString(
      { attributionStyle: dialogue.attributionStyle },
      'global.dialogue.attributionStyle',
      errors,
    );
    requireString(
      { subtextStyle: dialogue.subtextStyle },
      'global.dialogue.subtextStyle',
      errors,
    );
    requireStringArray(
      dialogue,
      'expositionAvoidance',
      'global.dialogue.expositionAvoidance',
      errors,
    );
  }

  // informationReveal
  const info = requireObject(
    global,
    'informationReveal',
    'global.informationReveal',
    errors,
  );
  if (info) {
    requireString(
      { setupMethod: info.setupMethod },
      'global.informationReveal.setupMethod',
      errors,
    );
    requireString(
      { foreshadowingMethod: info.foreshadowingMethod },
      'global.informationReveal.foreshadowingMethod',
      errors,
    );
    requireString(
      { suspenseMethod: info.suspenseMethod },
      'global.informationReveal.suspenseMethod',
      errors,
    );
  }
}
