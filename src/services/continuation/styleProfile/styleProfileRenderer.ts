/**
 * Multi-level style profile renderer for continuation generation (Spec §7.2, §8).
 *
 * Produces compact / standard / detailed text blocks from a frozen
 * OriginalStyleProfileV2 (or a graceful partial record). Never stores or
 * copies long original text samples — only abstract operational instructions.
 *
 * Context Builder selects the highest level that fits `availableTokens`; it
 * must never call Style Analysis LLM from here.
 */
import { estimateTokens } from '../../../utils/tokenEstimator';
import type { OriginalStyleProfileV2 } from './styleProfileV2Schema';

/** Bump when render wording or level structure changes so runs can record it. */
export const STYLE_RENDERER_VERSION = 'style-renderer-v1';

export type StyleRenderLevel = 'compact' | 'standard' | 'detailed';

export type StyleRenderStage = 'planner' | 'writer' | 'checker' | 'repair';

export interface RenderStyleProfileOptions {
  /** Canon character ids participating in this chapter (Writer detailed voices). */
  participatingCharacterIds?: Array<number | string>;
  stage?: StyleRenderStage;
  /** Repair: only re-emit these style dimensions when set. */
  violatedDimensions?: string[];
  /** User overrides merged into the rendered block. */
  userOverrides?: Record<string, unknown>;
  /**
   * Optional free-text cues from the plan (goal/beats/conflict) used to pick
   * relevant sceneVariants for Writer detailed (Spec §8.2).
   */
  planSceneHints?: string[];
}

export interface RenderStyleProfileResult {
  text: string;
  level: StyleRenderLevel;
  estimatedTokens: number;
}

export interface SelectStyleRenderLevelResult {
  level: StyleRenderLevel | null;
  blocked?: boolean;
  reason?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strList(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map(x => x.trim())
    .slice(0, limit);
}

function joinList(items: string[], sep = '；'): string {
  return items.filter(Boolean).join(sep);
}

function line(label: string, body: string): string {
  const t = body.trim();
  return t ? `${label}：${t}` : '';
}

function lines(parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join('\n');
}

/**
 * Read nested path from a partial profile without throwing.
 */
function nest(
  root: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | null {
  let cur: unknown = root;
  for (const key of keys) {
    const obj = asRecord(cur);
    if (!obj) return null;
    cur = obj[key];
  }
  return asRecord(cur);
}

function compactBlock(profile: Record<string, unknown>): string {
  const narrative = nest(profile, 'global', 'narrative');
  const tone = nest(profile, 'global', 'tone');
  const avoid = strList(profile.globalAvoid, 8);
  const diction = nest(profile, 'global', 'diction');
  const avoidMore = strList(diction?.expressionsToAvoid, 6);
  const coreTaboos = [...avoid, ...avoidMore].slice(0, 10);

  return lines([
    '【原著风格·精简】',
    line('人称', str(narrative?.person)),
    line('叙事距离', str(narrative?.narrativeDistance)),
    line('基础语气', str(tone?.baseline)),
    coreTaboos.length ? `核心禁忌：${joinList(coreTaboos)}` : '',
    str(profile.summary) ? `摘要：${str(profile.summary)}` : '',
  ]);
}

function standardBlock(profile: Record<string, unknown>): string {
  const syntax = nest(profile, 'global', 'syntax');
  const dialogue = nest(profile, 'global', 'dialogue');
  const description = nest(profile, 'global', 'description');
  const rhythm = nest(profile, 'global', 'rhythm');
  const diction = nest(profile, 'global', 'diction');
  const boundary = asRecord(profile.boundaryLocalDelta);

  return lines([
    compactBlock(profile).replace('【原著风格·精简】', '【原著风格·标准】'),
    line('句式节奏', str(syntax?.sentenceLengthPattern)),
    line(
      '句式结构',
      joinList(strList(syntax?.sentenceStructures, 6)),
    ),
    line('段落', str(syntax?.paragraphPattern)),
    line('对话密度', str(dialogue?.dialogueDensity)),
    line('对话轮次', str(dialogue?.turnLength)),
    line('对白标签', str(dialogue?.attributionStyle)),
    line('描写感官', joinList(strList(description?.sensoryPriorities, 5))),
    line('环境用法', str(description?.environmentUsage)),
    line('场景节奏', str(rhythm?.scenePacing)),
    line('转场', joinList(strList(rhythm?.transitionMethods, 5))),
    line('章末结构', joinList(strList(rhythm?.chapterEndingPatterns, 4))),
    line('语域', str(diction?.register)),
    line('偏好用词', joinList(strList(diction?.lexicalPreferences, 6))),
    boundary
      ? lines([
          '【边界附近风格增量】',
          line('语气', str(boundary.tone)),
          line('节奏', str(boundary.pacing)),
          line('句段变化', str(boundary.sentenceAndParagraphShift)),
          line(
            '活跃叙事模式',
            joinList(strList(boundary.activeNarrativePatterns, 5)),
          ),
        ])
      : '',
  ]);
}

function filterCharacterVoices(
  profile: Record<string, unknown>,
  participatingCharacterIds?: Array<number | string>,
): Array<Record<string, unknown>> {
  const raw = Array.isArray(profile.characterVoices)
    ? profile.characterVoices
    : [];
  const voices = raw
    .map(asRecord)
    .filter((v): v is Record<string, unknown> => v != null);
  if (!participatingCharacterIds || participatingCharacterIds.length === 0) {
    // Without a participant filter, keep a short high-confidence subset only.
    return voices.slice(0, 3);
  }
  const idSet = new Set(participatingCharacterIds.map(String));
  // Cap at 5 so level selection (no plan yet) and Writer compile stay aligned.
  return voices
    .filter(v => {
      if (v.canonCharacterId != null && idSet.has(String(v.canonCharacterId))) {
        return true;
      }
      // Name match is not attempted — only structured ids (Spec §8.2).
      return false;
    })
    .slice(0, 5);
}

function selectSceneVariants(
  profile: Record<string, unknown>,
  planSceneHints?: string[],
): Array<Record<string, unknown>> {
  const all = Array.isArray(profile.sceneVariants)
    ? profile.sceneVariants
        .map(asRecord)
        .filter((s): s is Record<string, unknown> => s != null)
    : [];
  if (all.length === 0) return [];
  if (!planSceneHints || planSceneHints.length === 0) {
    return all.slice(0, 5);
  }
  const hints = planSceneHints
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);
  const scored = all.map((scene, index) => {
    const type = str(scene.sceneType).toLowerCase();
    const blob = `${type} ${joinList(strList(scene.instructions, 8))}`.toLowerCase();
    let score = 0;
    for (const hint of hints) {
      if (!hint) continue;
      if (type && (hint.includes(type) || type.includes(hint))) score += 3;
      if (blob.includes(hint)) score += 1;
      // Token-ish overlap on CJK/ASCII chunks ≥ 2 chars.
      for (const part of hint.split(/[\s,，、/|]+/).filter(p => p.length >= 2)) {
        if (blob.includes(part)) score += 1;
      }
    }
    return { scene, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = scored.filter(s => s.score > 0).slice(0, 5).map(s => s.scene);
  return picked.length > 0 ? picked : all.slice(0, 3);
}

function detailedBlock(
  profile: Record<string, unknown>,
  options?: RenderStyleProfileOptions,
): string {
  const scenes = selectSceneVariants(profile, options?.planSceneHints);
  const voices = filterCharacterVoices(
    profile,
    options?.participatingCharacterIds,
  );
  const avoid = strList(profile.globalAvoid, 16);
  const info = nest(profile, 'global', 'informationReveal');
  const narrative = nest(profile, 'global', 'narrative');

  const sceneText = scenes
    .map(s => {
      const type = str(s.sceneType) || 'scene';
      const instructions = joinList(strList(s.instructions, 6));
      const avoidItems = joinList(strList(s.avoid, 4));
      return `- ${type}：${instructions}${avoidItems ? `；避免：${avoidItems}` : ''}`;
    })
    .join('\n');

  const voiceText = voices
    .map(v => {
      const name = str(v.sourceName) || '人物';
      const register = str(v.speechRegister);
      const habits = joinList(strList(v.sentenceHabits, 4));
      const interaction = joinList(strList(v.interactionHabits, 3));
      const avoidItems = joinList(strList(v.avoid, 3));
      return `- ${name}：语域=${register}；句式=${habits}；互动=${interaction}${
        avoidItems ? `；避免=${avoidItems}` : ''
      }`;
    })
    .join('\n');

  return lines([
    standardBlock(profile).replace('【原著风格·标准】', '【原著风格·详细】'),
    line('聚焦', str(narrative?.focalization)),
    line('时态与时间', str(narrative?.tenseAndTimeHandling)),
    line(
      '视角切换',
      joinList(strList(narrative?.perspectiveSwitchRules, 4)),
    ),
    info
      ? lines([
          line('信息铺垫', str(info.setupMethod)),
          line('伏笔', str(info.foreshadowingMethod)),
          line('悬念', str(info.suspenseMethod)),
        ])
      : '',
    avoid.length ? `完整禁忌：${joinList(avoid)}` : '',
    sceneText ? `【场景变体】\n${sceneText}` : '',
    voiceText ? `【参与人物口吻】\n${voiceText}` : '',
    '（模仿抽象特征，禁止复制原著原句）',
  ]);
}

/**
 * Planner only needs planning-relevant style: pacing, transition, reveal speed,
 * chapter-end structure, and user overrides (Spec §8.1).
 */
function plannerBlock(profile: Record<string, unknown>): string {
  const rhythm = nest(profile, 'global', 'rhythm');
  const info = nest(profile, 'global', 'informationReveal');
  const tone = nest(profile, 'global', 'tone');
  const boundary = asRecord(profile.boundaryLocalDelta);

  return lines([
    '【原著风格·规划约束】',
    line('场景节奏', str(rhythm?.scenePacing)),
    line('信息密度', str(rhythm?.expositionDensity)),
    line('转场方式', joinList(strList(rhythm?.transitionMethods, 6))),
    line('章末结构', joinList(strList(rhythm?.chapterEndingPatterns, 5))),
    line('信息揭示', str(info?.setupMethod)),
    line('伏笔节奏', str(info?.foreshadowingMethod)),
    line('悬念节奏', str(info?.suspenseMethod)),
    line('基础语气', str(tone?.baseline)),
    boundary
      ? lines([
          line('边界语气', str(boundary.tone)),
          line('边界节奏', str(boundary.pacing)),
        ])
      : '',
  ]);
}

/**
 * Checker contract: compact metrics + taboos enough to judge drift (Spec §8.3).
 */
function checkerBlock(profile: Record<string, unknown>): string {
  const narrative = nest(profile, 'global', 'narrative');
  const tone = nest(profile, 'global', 'tone');
  const syntax = nest(profile, 'global', 'syntax');
  const dialogue = nest(profile, 'global', 'dialogue');
  const avoid = strList(profile.globalAvoid, 10);
  return lines([
    '【原著风格·检查契约】',
    line('人称', str(narrative?.person)),
    line('聚焦', str(narrative?.focalization)),
    line('时态', str(narrative?.tenseAndTimeHandling)),
    line('叙事距离', str(narrative?.narrativeDistance)),
    line('基础语气', str(tone?.baseline)),
    line('句长模式', str(syntax?.sentenceLengthPattern)),
    line('段落模式', str(syntax?.paragraphPattern)),
    line('对话密度', str(dialogue?.dialogueDensity)),
    avoid.length ? `禁忌：${joinList(avoid)}` : '',
    '请检查人称/时态漂移、句长段落偏移、对话比例、AI 腔模板、口吻串位、章末转场偏离、异常长连续重合。',
  ]);
}

/**
 * Repair: only violated dimensions when provided (Spec §8.4).
 */
function repairBlock(
  profile: Record<string, unknown>,
  violatedDimensions?: string[],
): string {
  if (!violatedDimensions || violatedDimensions.length === 0) {
    return compactBlock(profile).replace(
      '【原著风格·精简】',
      '【原著风格·修复约束】',
    );
  }
  const dim = new Set(violatedDimensions.map(d => d.toLowerCase()));
  const narrative = nest(profile, 'global', 'narrative');
  const tone = nest(profile, 'global', 'tone');
  const syntax = nest(profile, 'global', 'syntax');
  const dialogue = nest(profile, 'global', 'dialogue');
  const rhythm = nest(profile, 'global', 'rhythm');
  const diction = nest(profile, 'global', 'diction');
  const parts: string[] = ['【原著风格·违规维度修复】'];

  if (dim.has('person') || dim.has('pov') || dim.has('pov_shift') || dim.has('narrative')) {
    parts.push(line('人称', str(narrative?.person)));
    parts.push(line('聚焦', str(narrative?.focalization)));
  }
  if (dim.has('tense') || dim.has('tense_drift')) {
    parts.push(line('时态', str(narrative?.tenseAndTimeHandling)));
  }
  if (
    dim.has('sentence') ||
    dim.has('paragraph') ||
    dim.has('sentence_length') ||
    dim.has('syntax')
  ) {
    parts.push(line('句长', str(syntax?.sentenceLengthPattern)));
    parts.push(line('段落', str(syntax?.paragraphPattern)));
  }
  if (dim.has('dialogue') || dim.has('dialogue_ratio')) {
    parts.push(line('对话', str(dialogue?.dialogueDensity)));
    parts.push(line('对白标签', str(dialogue?.attributionStyle)));
  }
  if (dim.has('tone') || dim.has('ai_template') || dim.has('style')) {
    parts.push(line('语气', str(tone?.baseline)));
    parts.push(line('禁忌', joinList(strList(profile.globalAvoid, 8))));
    parts.push(
      line('避免表达', joinList(strList(diction?.expressionsToAvoid, 6))),
    );
  }
  if (dim.has('pacing') || dim.has('transition') || dim.has('chapter_end')) {
    parts.push(line('节奏', str(rhythm?.scenePacing)));
    parts.push(line('转场', joinList(strList(rhythm?.transitionMethods, 5))));
    parts.push(
      line('章末', joinList(strList(rhythm?.chapterEndingPatterns, 4))),
    );
  }
  if (dim.has('voice') || dim.has('character_voice')) {
    const voices = filterCharacterVoices(profile);
    for (const v of voices.slice(0, 4)) {
      parts.push(
        line(
          `口吻·${str(v.sourceName) || '人物'}`,
          str(v.speechRegister),
        ),
      );
    }
  }
  parts.push('只修复违规片段，保留已通过的事实与无关段落。');
  return lines(parts);
}

function renderUserOverrides(overrides: Record<string, unknown> | undefined): string {
  if (!overrides || Object.keys(overrides).length === 0) return '';
  const entries = Object.entries(overrides)
    .map(([k, v]) => {
      if (typeof v === 'string' && v.trim()) return `- ${k}：${v.trim()}`;
      if (typeof v === 'number' || typeof v === 'boolean') return `- ${k}：${v}`;
      if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
        return `- ${k}：${(v as string[]).join('；')}`;
      }
      try {
        return `- ${k}：${JSON.stringify(v)}`;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  if (!entries.length) return '';
  return `【用户风格修正（优先于自动画像）】\n${entries.join('\n')}`;
}

/**
 * Render a frozen style profile at the requested level.
 * Accepts OriginalStyleProfileV2 or a partial Record for graceful fallback.
 */
export function renderStyleProfile(
  profile: OriginalStyleProfileV2 | Record<string, unknown>,
  level: StyleRenderLevel,
  options?: RenderStyleProfileOptions & {
    userOverrides?: Record<string, unknown>;
  },
): RenderStyleProfileResult {
  const root = asRecord(profile) ?? {};
  const stage = options?.stage ?? 'writer';

  let body: string;
  if (stage === 'planner') {
    body = plannerBlock(root);
  } else if (stage === 'checker') {
    body = checkerBlock(root);
  } else if (stage === 'repair') {
    body = repairBlock(root, options?.violatedDimensions);
  } else {
    // writer (default): full multi-level
    if (level === 'compact') body = compactBlock(root);
    else if (level === 'standard') body = standardBlock(root);
    else body = detailedBlock(root, options);
  }

  const overrideText = renderUserOverrides(options?.userOverrides);
  const text = overrideText ? `${body}\n\n${overrideText}` : body;
  return {
    text,
    level,
    estimatedTokens: estimateTokens(text),
  };
}

const LEVEL_ORDER: StyleRenderLevel[] = ['detailed', 'standard', 'compact'];

/**
 * Pick the highest style render level that fits `availableTokens`.
 *
 * - off → null (caller skips injection)
 * - balanced → degrade detailed→standard→compact→omit
 * - strict → try compact; if even compact does not fit, blocked=true
 */
export function selectStyleRenderLevel(
  profile: OriginalStyleProfileV2 | Record<string, unknown> | null | undefined,
  availableTokens: number,
  styleLevel: 'off' | 'balanced' | 'strict',
  options?: RenderStyleProfileOptions & {
    userOverrides?: Record<string, unknown>;
  },
): SelectStyleRenderLevelResult {
  if (styleLevel === 'off') {
    return { level: null, reason: 'style_level_off' };
  }
  if (!profile || (typeof profile === 'object' && Object.keys(profile).length === 0)) {
    return {
      level: null,
      blocked: styleLevel === 'strict',
      reason: 'profile_missing',
    };
  }
  if (!(availableTokens > 0)) {
    if (styleLevel === 'strict') {
      return {
        level: null,
        blocked: true,
        reason: 'insufficient_tokens_for_compact',
      };
    }
    return { level: null, reason: 'insufficient_tokens' };
  }

  for (const level of LEVEL_ORDER) {
    const rendered = renderStyleProfile(profile, level, {
      ...options,
      stage: options?.stage ?? 'writer',
    });
    if (rendered.estimatedTokens <= availableTokens) {
      return {
        level,
        reason:
          level === 'detailed'
            ? undefined
            : `degraded_to_${level}`,
      };
    }
  }

  if (styleLevel === 'strict') {
    return {
      level: null,
      blocked: true,
      reason: 'insufficient_tokens_for_compact',
    };
  }
  return { level: null, reason: 'omitted_budget' };
}

export type { OriginalStyleProfileV2 };
