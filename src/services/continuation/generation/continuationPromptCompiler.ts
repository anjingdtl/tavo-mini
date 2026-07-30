/**
 * Stage-specific prompt compiler (Spec §8.3 / §8 style injection).
 * Never rebuilds live Canon/Story Memory — only uses frozen snapshot.
 * Style text is rendered from snapshot.style (frozen V2); never re-reads DB.
 */
import type { ChatMessage } from '../../llm/types';
import type {
  ContinuationContextSnapshot,
  ContinuationPlan,
  ContinuationCheckResult,
} from './types';
import { makeContinuationChapterNumbering } from '../chapterNumbering/continuationChapterNumbering';
import {
  renderStyleProfile,
  type StyleRenderLevel,
} from '../styleProfile/styleProfileRenderer';

/**
 * User-visible chapter title for the frozen target position (Spec §11.3).
 * Continues from the source boundary; never exposes bare internal position as
 * if it were the display chapter number. Falls back to position+1 when the
 * frozen source snapshot lacks a boundary (legacy / partial fixtures).
 */
function displayTargetTitle(s: ContinuationContextSnapshot): string {
  const boundaryPos = s.source?.boundary?.chapterPosition;
  const boundaryChapterNumber =
    boundaryPos != null && Number.isFinite(Number(boundaryPos))
      ? Number(boundaryPos) + 1
      : null;
  return makeContinuationChapterNumbering(
    boundaryChapterNumber,
  ).getDefaultTitle(s.targetPosition);
}

function displayNumberFor(
  s: ContinuationContextSnapshot,
  position: number,
): number {
  const boundaryPos = s.source?.boundary?.chapterPosition;
  const boundaryChapterNumber =
    boundaryPos != null && Number.isFinite(Number(boundaryPos))
      ? Number(boundaryPos) + 1
      : null;
  return makeContinuationChapterNumbering(
    boundaryChapterNumber,
  ).getDisplayNumber(position as any);
}

function lockedBlock(s: ContinuationContextSnapshot): string {
  return s.bundles.lockedRules.length
    ? `【用户锁定/硬规则】\n${s.bundles.lockedRules.join('\n')}`
    : '【用户锁定/硬规则】（无）';
}

function evidenceLabel(
  s: ContinuationContextSnapshot,
  ownerType: string,
  ownerId: number,
): string {
  const ids =
    s.bundles.canon.evidenceRefsByOwner?.[
      ownerType as keyof NonNullable<typeof s.bundles.canon.evidenceRefsByOwner>
    ]?.[ownerId];
  return ids?.length ? `（证据:${ids.join(',')}）` : '';
}

/**
 * The continuation checker is a factual gate, not merely a style reviewer.
 * Keep every selected Canon family visible here; otherwise a run could have
 * analysed relationships/knowledge/timeline yet never give them to the LLM
 * that decides whether a generated chapter contradicts the original work.
 */
function canonFactCheckBlock(s: ContinuationContextSnapshot): string {
  const canon = s.bundles.canon;
  const plotFactKeys = new Set(
    (canon.plotThreads ?? []).map(
      plot => `${plot.title.trim()}:${plot.description.trim()}`,
    ),
  );
  const names = new Map(
    (canon.characters ?? []).map(character => [
      character.id,
      character.canonicalName,
    ]),
  );
  const nameOf = (id: number) => names.get(id) ?? `人物#${id}`;
  const line = (body: string, ownerType: string, id: number) =>
    `- ${body}${evidenceLabel(s, ownerType, id)}`;

  const sections = [
    [
      '世界规则',
      (canon.worldRules ?? []).map(r =>
        line(`${r.title}: ${r.description}`, 'world_rule', r.id),
      ),
    ],
    [
      '人物资料',
      (canon.characters ?? []).map(c =>
        line(`${c.canonicalName}: ${c.description}`, 'character', c.id),
      ),
    ],
    [
      '人物状态',
      (canon.characterStates ?? []).map(state =>
        line(
          `${nameOf(state.characterId)}：${
            state.summary || `状态=${state.aliveState}`
          }`,
          'character_state',
          state.id,
        ),
      ),
    ],
    [
      '人物关系',
      (canon.relationships ?? []).map(rel =>
        line(
          `${nameOf(rel.sourceCharacterId)}→${nameOf(rel.targetCharacterId)}（${
            rel.relationType
          }/${rel.attitude}）：${rel.description}`,
          'relationship',
          rel.id,
        ),
      ),
    ],
    [
      '人物经历',
      (canon.experiences ?? []).map(exp =>
        line(
          `${nameOf(exp.characterId)}：${exp.title}；${exp.description}`,
          'experience',
          exp.id,
        ),
      ),
    ],
    [
      '知识边界',
      (canon.knowledge ?? []).map(item =>
        line(
          `${nameOf(item.characterId)}对“${item.factKey}”=${
            item.knowledgeState
          }；${item.factSummary}`,
          'knowledge',
          item.id,
        ),
      ),
    ],
    [
      '剧情线索',
      (canon.plotThreads ?? []).map(plot =>
        line(
          `${plot.title}（${plot.status}）：${plot.description}`,
          'plot_thread',
          plot.id,
        ),
      ),
    ],
    [
      '时间线',
      (canon.timelineEvents ?? [])
        // A timeline item can materialize the exact same fact as a plot
        // thread. Keep the plot (it has the continuation status) and avoid
        // sending the same fact twice to the planner/writer.
        .filter(
          event =>
            !plotFactKeys.has(`${event.title.trim()}:${event.summary.trim()}`),
        )
        .map(event =>
          line(`${event.title}：${event.summary}`, 'timeline_event', event.id),
        ),
    ],
  ] as Array<[string, string[]]>;
  const rendered = sections
    .filter(([, lines]) => lines.length > 0)
    .map(([title, lines]) => `${title}:\n${lines.join('\n')}`)
    .join('\n');
  return `【原著事实复核依据】\n${
    rendered || '（当前快照未检索到与本章相关的原著事实）'
  }`;
}

function stateBlock(s: ContinuationContextSnapshot): string {
  const st = s.bundles.effectiveState;
  // Baseline Canon facts have their own complete block. This block contains
  // only post-boundary continuation deltas, avoiding duplicate injection.
  const chars = st.characterStates
    .filter(c => c.source !== 'canon')
    .slice(0, 20)
    .map(c => `- ${JSON.stringify(c.ref)}: ${c.summary}`)
    .join('\n');
  const plots = st.plotThreads
    .filter(p => p.sourceLayer !== 'canon')
    .slice(0, 10)
    .map(p => `- ${p.title} (${p.status}): ${p.summary}`)
    .join('\n');
  const relationships = (st.relationships ?? [])
    .filter(r => r.sourceLayer !== 'canon')
    .slice(0, 20)
    .map(
      r =>
        `- ${JSON.stringify(r.source)} → ${JSON.stringify(r.target)}: ${
          r.summary
        }`,
    )
    .join('\n');
  const canonKnowledge = new Set(
    (s.bundles.canon.knowledge ?? []).map(
      item => `${item.characterId}:${item.factKey}:${item.factSummary}`,
    ),
  );
  const knowledge = (st.knowledge ?? [])
    .filter(
      k =>
        !canonKnowledge.has(
          `${k.ref.refType === 'canon_character' ? k.ref.id : ''}:${
            k.factKey
          }:${k.factSummary}`,
        ),
    )
    .slice(0, 20)
    .map(
      k =>
        `- ${JSON.stringify(k.ref)} ${k.factKey}: ${k.factSummary}（${
          k.knowledgeState
        }）`,
    )
    .join('\n');
  const canonExperiences = new Set(
    (s.bundles.canon.experiences ?? []).map(
      item => `${item.characterId}:${item.title}:${item.description}`,
    ),
  );
  const experiences = (st.experiences ?? [])
    .filter(
      e =>
        !canonExperiences.has(
          `${e.ref.refType === 'canon_character' ? e.ref.id : ''}:${e.title}:${
            e.summary
          }`,
        ),
    )
    .slice(0, 20)
    .map(e => `- ${JSON.stringify(e.ref)}: ${e.title}；${e.summary}`)
    .join('\n');
  return `【第 ${displayNumberFor(
    s,
    s.targetPosition,
  )} 章已确认续写增量状态】\n人物状态:\n${chars || '（无新增）'}\n人物关系:\n${
    relationships || '（无新增）'
  }\n知识边界:\n${knowledge || '（无）'}\n人物经历:\n${
    experiences || '（无新增）'
  }\n剧情:\n${plots || '（无新增）'}`;
}

function primaryAnchorBlock(s: ContinuationContextSnapshot): string {
  const anchor = s.primaryAnchor;
  if (!anchor) {
    // Schema 1 compatibility: historical runs only have bundles.seam.
    return `【原著接缝】${s.bundles.seam.summary}\n${s.bundles.seam.excerpt}`;
  }
  if (anchor.kind === 'continuation_chapter') {
    return `【当前正文接缝：最近续写第 ${displayNumberFor(
      s,
      anchor.position ?? 0,
    )} 章】${anchor.summary}\n${anchor.excerpt}`;
  }
  return `【当前正文接缝：原著边界】${anchor.summary}\n${anchor.excerpt}`;
}

function primaryAnchorRule(s: ContinuationContextSnapshot): string {
  if (s.primaryAnchor?.kind === 'continuation_chapter') {
    return '存在“当前正文接缝：最近续写”时，必须从该续写章结尾继续推进。原著内容仅用于 Canon/背景核验；不得从原著末章重新起笔、复述或连续复制原著正文。';
  }
  return '仅在没有任何前序续写正文时，从当前正文接缝继续；不得复制原著原句。';
}

function recentBlock(s: ContinuationContextSnapshot): string {
  if (!s.bundles.recentChapters.length) return '【最近续写正文】（无）';
  return (
    '【最近续写正文】\n' +
    s.bundles.recentChapters
      .map(
        c =>
          `--- 第 ${displayNumberFor(
            s,
            c.position,
          )} 章 (hash=${c.revisionHash.slice(0, 8)}) ---\n${c.excerpt}`,
      )
      .join('\n')
  );
}

function memoryBlock(s: ContinuationContextSnapshot): string {
  const memory = s.bundles.storyMemory;
  return `【Story Memory 长期状态 status=${s.storyMemory.status} eligibility=${
    memory.eligibilityReason ?? 'legacy'
  }】\n${memory.summary || '（当前无可安全注入的长期记忆）'}`;
}

function episodicBlock(s: ContinuationContextSnapshot): string {
  const text = (s.bundles.episodic ?? [])
    .map(item => item.summary)
    .filter(Boolean)
    .join('\n');
  return text
    ? `【相关续写章节事件记忆】\n${text}`
    : '【相关续写章节事件记忆】（无）';
}

function historicalDigestBlock(s: ContinuationContextSnapshot): string {
  const cards = (s.bundles.historicalDigests ?? [])
    .map(
      digest =>
        `- position ${digest.startPosition}-${digest.endPosition - 1}: ${
          digest.summary
        }`,
    )
    .join('\n');
  return cards
    ? `【历史概览（非 Canon、非逐字核验事实）】\n${cards}\n仅作为可能相关线索；与 Canon 冲突时以 Canon 为准，需核实请回溯原文。`
    : '【历史概览（非 Canon）】（无匹配卡片）';
}

/**
 * Stage-aware style injection from the frozen snapshot profile (Spec §8).
 * Falls back to legacy thin metrics when only bundles.style is present.
 */
function styleBlock(
  s: ContinuationContextSnapshot,
  stage: 'planner' | 'writer' | 'checker' | 'repair',
  options?: {
    plan?: ContinuationPlan;
    openChecks?: ContinuationCheckResult[];
  },
): string {
  const frozen = s.style;
  if (frozen?.frozenProfile) {
    const level: StyleRenderLevel =
      frozen.renderLevel === 'compact' ||
      frozen.renderLevel === 'standard' ||
      frozen.renderLevel === 'detailed'
        ? frozen.renderLevel
        : 'standard';

    const violatedDimensions =
      stage === 'repair' && options?.openChecks
        ? options.openChecks
            .filter(
              c =>
                c.category === 'style' &&
                (c.severity === 'error' ||
                  c.severity === 'blocking' ||
                  c.severity === 'warning'),
            )
            .map(c => c.subtype)
        : undefined;

    const participating =
      stage === 'writer' && options?.plan
        ? options.plan.participatingCharacterIds
        : undefined;

    const planSceneHints =
      stage === 'writer' && options?.plan
        ? [
            options.plan.chapterGoal,
            options.plan.centralConflict,
            ...options.plan.beats.map(b => b.summary),
          ].filter(Boolean)
        : undefined;

    const rendered = renderStyleProfile(frozen.frozenProfile, level, {
      stage,
      participatingCharacterIds: participating,
      violatedDimensions,
      userOverrides: frozen.userOverrides,
      planSceneHints,
    });
    return rendered.text;
  }

  // Legacy thin metrics (pre-V2 snapshots)
  const st = s.bundles.style;
  if (!st) {
    return frozen?.omitReason
      ? `【文风】（未注入：${frozen.omitReason}）`
      : '【文风】（缺少可用原著画风画像）';
  }
  return `【文风特征】人称=${st.narrativePerson} 时态=${st.tense} 均句长=${st.averageSentenceLength} 对话比=${st.dialogueRatio}\n${st.pacingNotes}\n${st.lexicalNotes}`;
}

function supplementsBlock(s: ContinuationContextSnapshot): string {
  const supplements = s.bundles.supplements;
  if (!supplements) return '【原著之外的外部补充资料】（无）';
  const parts = [
    supplements.presetText,
    supplements.characterText,
    supplements.worldbookText,
    supplements.noteText,
  ].filter(Boolean);
  return parts.length
    ? `【原著之外的外部补充资料】\n以下仅补充创作；与 Canon、已确认续写状态或锁定规则冲突时，以上述内容为准。\n${parts.join(
        '\n\n',
      )}`
    : '【原著之外的外部补充资料】（无）';
}

export function compilePlannerMessages(
  snapshot: ContinuationContextSnapshot,
): ChatMessage[] {
  const system = [
    '你是长篇小说续写规划助手。只输出 JSON，不要写完整正文。',
    'schemaVersion 必须为 1。字段：chapterGoal, centralConflict, beats[], participatingCharacterIds[], characterActions[], plotAdvances[], foreshadowingActions[], proposedStateChanges[], risks[]。',
    '不得违反用户锁定规则与原著 hard Canon。不得读取或编造 boundary 之后的原著情节。',
    primaryAnchorRule(snapshot),
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    stateBlock(snapshot),
    primaryAnchorBlock(snapshot),
    recentBlock(snapshot),
    memoryBlock(snapshot),
    episodicBlock(snapshot),
    historicalDigestBlock(snapshot),
    styleBlock(snapshot, 'planner'),
    supplementsBlock(snapshot),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `请为${displayTargetTitle(snapshot)}规划续写。用户要求：\n${
        snapshot.bundles.userInstruction
      }\n目标字数约 ${snapshot.settingsSnapshot.values.targetChapterChars}。`,
    },
  ];
}

export function compileWriterMessages(
  snapshot: ContinuationContextSnapshot,
  plan: ContinuationPlan,
): ChatMessage[] {
  const system = [
    '你是长篇小说续写写手。只输出本章正文，不要分析说明、不要标题行。',
    '遵守人物知识边界；不复制大段原著原文；不引入被策略禁止的死亡/复活/新体系。',
    primaryAnchorRule(snapshot),
    '模仿抽象文风特征，禁止复制原著原句。用户本章明确要求优先于自动风格画像。',
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    `【规划（已确认版本）】\n目标：${plan.chapterGoal}\n冲突：${
      plan.centralConflict
    }\n节拍：${plan.beats.map(b => b.summary).join(' / ')}`,
    stateBlock(snapshot),
    primaryAnchorBlock(snapshot),
    recentBlock(snapshot),
    memoryBlock(snapshot),
    episodicBlock(snapshot),
    historicalDigestBlock(snapshot),
    styleBlock(snapshot, 'writer', { plan }),
    supplementsBlock(snapshot),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `写${displayTargetTitle(snapshot)}正文，约 ${
        snapshot.settingsSnapshot.values.targetChapterChars
      } 字。用户要求：\n${snapshot.bundles.userInstruction}`,
    },
  ];
}

export function compileCheckerMessages(
  snapshot: ContinuationContextSnapshot,
  artifactText: string,
): ChatMessage[] {
  const system = [
    '你是续写一致性检查器。只输出 JSON 数组 issues[]，每项含 category, subtype, severity, confidence, generatedStart, generatedEnd, generatedExcerpt, description, evidenceIds, suggestedFix。',
    'category ∈ world|character|relationship|plot|experience|knowledge|timeline|style；severity ∈ info|warning|error|blocking。',
    '没有证据时只能 warning 并说明是推测。位置使用 UTF-16 半开区间。',
    '若原著事实与正文冲突，必须输出问题；能对应行内证据编号时写入 evidenceIds。不得把缺少资料当作原著不存在。',
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    stateBlock(snapshot),
    styleBlock(snapshot, 'checker'),
    `【可引用证据 id】${JSON.stringify(
      snapshot.bundles.canon.evidenceRefs.slice(0, 50),
    )}`,
    supplementsBlock(snapshot),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `检查以下正文：\n---\n${artifactText}\n---`,
    },
  ];
}

export function compileRepairMessages(
  snapshot: ContinuationContextSnapshot,
  artifactText: string,
  openChecks: ContinuationCheckResult[],
): ChatMessage[] {
  const issues = openChecks
    .filter(c => c.severity === 'error' || c.severity === 'blocking')
    .map(
      c =>
        `- [${c.severity}/${c.category}] ${c.description} @${
          c.generatedStart
        }-${c.generatedEnd} 建议:${c.suggestedFix ?? ''}`,
    )
    .join('\n');
  const system = [
    '你是续写局部修复助手。只修改冲突片段，保留无问题段落。只输出修复后的完整正文。',
    '不要因单一风格问题重写无关段落；不要修改已通过的 Canon 事实。',
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    stateBlock(snapshot),
    styleBlock(snapshot, 'repair', { openChecks }),
    `【待修复问题】\n${issues || '（无 blocking/error）'}`,
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `原文：\n---\n${artifactText}\n---\n请输出修复后正文。`,
    },
  ];
}

export function compileStateExtractionMessages(
  finalizedText: string,
  entityIndex: string,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你从已定稿续写正文提取状态 proposal。只输出 JSON：{ proposals: [...] }。',
        '每项：proposalType, subjectRefType?, subjectRefId?, payload, evidenceStart, evidenceEnd, risk(normal|major)。',
        'proposalType ∈ character_state|relationship_change|plot_advance|character_experience|knowledge_change|new_world_fact|new_character|new_location|new_organization|foreshadowing|other。',
        'evidence offset 必须在正文 UTF-16 范围内。不得编造原著未来情节。',
        `【实体索引】\n${entityIndex}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `定稿正文：\n---\n${finalizedText}\n---`,
    },
  ];
}
