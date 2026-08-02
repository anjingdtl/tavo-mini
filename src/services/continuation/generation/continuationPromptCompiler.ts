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
import {
  countHanCharacters,
  isContinuationLengthIssueSubtype,
  resolveContinuationLengthContract,
} from './continuationLengthContract';

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
    .map(c => `- ${JSON.stringify(c.ref)}: ${c.summary}`)
    .join('\n');
  const plots = st.plotThreads
    .filter(p => p.sourceLayer !== 'canon')
    .map(p => `- ${p.title} (${p.status}): ${p.summary}`)
    .join('\n');
  const relationships = (st.relationships ?? [])
    .filter(r => r.sourceLayer !== 'canon')
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
  plan?: ContinuationPlan,
): ChatMessage[] {
  const standardWorkflow = !plan;
  const lengthContract = resolveContinuationLengthContract(
    snapshot.settingsSnapshot.values.targetChapterChars,
  );
  const lengthRule = [
    `【正文长度硬约束】目标 ${lengthContract.targetHanCharacters} 个汉字；允许范围 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字。`,
    '汉字数只统计 CJK 汉字，不包含标点、空格、换行、数字和英文字母。少于下限或多于上限均视为未完成。',
    '不得通过摘要、提纲、剧情概述、重复句或无意义水文控制长度；必须保留完整场景、人物互动、因果推进和自然章末。',
  ].join('\n');
  const system = [
    standardWorkflow
      ? '你是长篇小说续写写手。只输出一个 JSON object，不要 Markdown、代码围栏、解释文字或推理内容。'
      : '你是长篇小说续写写手。只输出本章正文，不要分析说明、不要标题行。',
    ...(standardWorkflow
      ? [
          'JSON 顶层必须严格为 {"schemaVersion":1,"plan":{...},"content":"..."}。plan 必须包含 chapterGoal、centralConflict、beats、participatingCharacterIds；characterActions、plotAdvances、foreshadowingActions、proposedStateChanges、risks 若无内容可输出空数组或省略，content 只包含本章正文，不含标题、JSON 包装或解释。',
          '先在同一次 completion 的 plan 中收束章节目标、核心冲突、节拍和参与人物，再按该 plan 写 content；不得先独立调用规划，也不得把 plan 写入 content。',
        ]
      : []),
    lengthRule,
    '遵守人物知识边界；不复制大段原著原文；不引入被策略禁止的死亡/复活/新体系。',
    primaryAnchorRule(snapshot),
    '模仿抽象文风特征，禁止复制原著原句。用户本章明确要求优先于自动风格画像。',
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    ...(plan
      ? [
          `【规划（已确认版本）】\n目标：${plan.chapterGoal}\n冲突：${
            plan.centralConflict
          }\n节拍：${plan.beats.map(b => b.summary).join(' / ')}`,
        ]
      : []),
    stateBlock(snapshot),
    primaryAnchorBlock(snapshot),
    recentBlock(snapshot),
    memoryBlock(snapshot),
    episodicBlock(snapshot),
    historicalDigestBlock(snapshot),
    styleBlock(snapshot, 'writer', plan ? { plan } : undefined),
    supplementsBlock(snapshot),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `生成${displayTargetTitle(snapshot)}。正文目标 ${
        lengthContract.targetHanCharacters
      } 个汉字，必须保持在 ${lengthContract.minHanCharacters}–${
        lengthContract.maxHanCharacters
      } 个汉字。用户要求：\n${snapshot.bundles.userInstruction}`,
    },
  ];
}

export function compileCheckerMessages(
  snapshot: ContinuationContextSnapshot,
  artifactText: string,
): ChatMessage[] {
  const system = [
    '你是续写一致性检查器。先逐段核对正文，再只输出 JSON 对象 {"issues":[]}；禁止 Markdown、解释、思维过程和正文复述。每项含 category, subtype, severity, confidence, generatedStart, generatedEnd, generatedExcerpt, description, evidenceIds, suggestedFix。',
    'category ∈ world|character|relationship|plot|experience|knowledge|timeline|style；severity ∈ info|warning|error|blocking。',
    '没有 Canon 证据且不属于本地硬门禁时只能 warning，并说明是推测；主观文风偏好不得使用 error/blocking。位置使用 UTF-16 半开区间，generatedExcerpt 必须是正文中的原文片段。',
    '若原著事实与正文冲突，只有明确违反 hard/locked 规则、冻结状态/知识边界，或有可追溯 Canon 证据的事实冲突，才使用 error/blocking；能对应行内证据编号时必须写入 evidenceIds。不得把缺少资料当作原著不存在。error/blocking 必须同时给出可定位的正文片段、具体事实、证据 id 和可执行 suggestedFix；任一项无法提供就降为 warning。',
    '目标字数、接缝连续重合和 future leakage 由本地确定性复核负责；不要把目标长度当作 error/blocking，也不要用模糊的重复问题制造第二个严重问题。若本地硬门禁已经能识别接缝重合或 future leakage，不得重复报告同一问题；把 LLM 检查预算用于 Canon、状态和人物关系的语义冲突。',
    '按根因合并重复问题：同一事实冲突只输出一项，最多补充必要的关联问题。先区分“正文明确写错”与“正文没有交代”，后者不能判错。',
    '若正文只是合理推进、补写未确定细节或与 Canon 没有明确冲突，返回 {"issues":[]} 或 warning，不要要求用户人工确认。',
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    stateBlock(snapshot),
    styleBlock(snapshot, 'checker'),
    `【可引用证据 id】${JSON.stringify(snapshot.bundles.canon.evidenceRefs)}`,
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
  delivery: 'full' | 'patch' = 'full',
): ChatMessage[] {
  const patchDelivery = delivery === 'patch';
  const lengthContract = resolveContinuationLengthContract(
    snapshot.settingsSnapshot.values.targetChapterChars,
  );
  const originalHanCharacters = countHanCharacters(artifactText);
  const issues = openChecks
    .filter(c => c.severity === 'error' || c.severity === 'blocking')
    .map(c => {
      const chapterLevel = isContinuationLengthIssueSubtype(c.subtype);
      const location = chapterLevel
        ? '章节级长度问题（无局部 offset）'
        : `@${c.generatedStart}-${c.generatedEnd} 命中片段:${
            c.generatedExcerpt || '（无定位片段）'
          }`;
      return `- [${c.severity}/${c.category}/${c.subtype}] ${
        c.description
      } ${location} 建议:${c.suggestedFix ?? ''}`;
    })
    .join('\n');
  const anchorExcerpt =
    snapshot.primaryAnchor?.excerpt || snapshot.bundles.seam?.excerpt || '';
  const repairLengthContract = [
    `【Repair 长度硬性验收】当前完整正文含 ${originalHanCharacters} 个汉字；本次目标 ${lengthContract.targetHanCharacters} 个汉字，应用全部补丁后的完整正文必须保持在 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字。`,
    '汉字数只统计 CJK 汉字，不包含标点、空格、换行、数字和英文字母。长度不足时应补充具体动作、对话、因果、人物反应、冲突推进或结果余波；长度超出时优先压缩重复描写、重复心理和不推进剧情的对话。',
    '不得用摘要、提纲、概括句、重复同一句、无意义水文或大段删除来规避长度要求；必须保留完整事件链、人物互动和自然收束。',
  ].join('\n');
  const overlapInstructions = openChecks.some(
    c =>
      c.subtype === 'source_overlap' ||
      c.subtype === 'continuation_anchor_overlap',
  )
    ? [
        patchDelivery
          ? '本次标准 Repair 的输出是应用到最终候选正文的 JSON 补丁，不是修改建议、解释、审查报告或完整正文。'
          : '本次修复的输出就是最终候选正文，不是修改建议、解释、审查报告、JSON 或局部补丁。',
        '接缝重合是硬错误：必须重写命中段落的叙事动作、信息组织和措辞，让正文从接缝之后的新事件继续推进；不能只删标点、替换几个词、压缩句子或把同一段原文换位置。',
        '修复后正文不得再次复制接缝或命中片段中的连续原文，也不得用“刚才/此前发生的事情”重新复述同一段；若无法保留原句，优先保证章节目标、冲突和节拍继续成立。',
        anchorExcerpt
          ? `【仅用于消除接缝重合的参考接缝】\n${anchorExcerpt}`
          : '【接缝参考】（快照未提供可展示片段，仍须依据检查命中片段改写）',
      ].join('\n')
    : patchDelivery
    ? '本次标准 Repair 的输出是应用到最终候选正文的 JSON 补丁；不要输出问题清单、解释或完整正文。'
    : '本次修复的输出就是最终候选正文，只输出修复后的完整正文；不要输出问题清单、解释、JSON 或局部补丁。';
  const system = [
    patchDelivery
      ? '你是续写终稿修复助手。先在内部逐项执行修复清单，然后只输出严格 JSON 修订补丁。不得输出思维过程、审查说明、Markdown 标题或“已修复”等套话。'
      : '你是续写终稿修复助手。先在内部逐项执行修复清单，再只输出修复后的完整正文。不得输出思维过程、审查说明、JSON、Markdown 标题或“已修复”等套话。',
    overlapInstructions,
    '对每一项 error/blocking 都必须完成可验证的修改；输出前重新检查：硬规则/Canon 证据、冻结状态与知识边界、人物关系、章节目标与冲突、接缝不重复。不要因单一风格问题重写无关段落，也不要修改已通过的 Canon 事实。',
    patchDelivery
      ? `你返回的是应用到完整原文的局部补丁。普通问题必须由覆盖其 @start-@end 区间的补丁实质修正；章节级长度问题没有局部 offset，可以在自然段边界使用 start=end 的纯插入补丁，或用较大区间的精简替换补丁。客户端会保留所有未命中的有效正文。`
      : '原文不是参考摘要，而是必须覆盖的完整修订底稿。先保留原文每个有效段落、事件节点、人物互动、情绪转折和结尾收束，再逐项完成 Checker 指出的实质修正；Repair 不是原文复述、机械删句、只改命中句或只返回局部补丁。',
    ...(patchDelivery
      ? [
          '定向修订原则：事实与 Canon 优先；不引入未被原文或 Canon 支持的新人物、新地点、新物品、新能力或规则；不得擅自改变章节目标；不得删除不存在问题的重要情节；尽量最小必要修改，并保留原文创意与叙事风格。',
        ]
      : [
          `除非 Checker 明确要求删除，修正后必须在原有完整事件链、人物互动、细节和收束的基础上输出完整终稿；不得把整章压缩成摘要、提纲、几百字短候选或“修改建议”。`,
        ]),
    repairLengthContract,
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
      content: patchDelivery
        ? [
            '【Repair 补丁交付契约：优先级最高】',
            '只输出严格 JSON：{"patches":[{"start":0,"end":12,"replacement":"替换后的连续正文"}]}。start/end 必须是下方原文的 UTF-16 半开位置，start 包含、end 不包含；允许 start=end 表示纯插入。patches 按 start 升序、不得重叠，也不得在同一位置重复插入。replacement 必须是可直接应用的自然小说正文，不能为空。',
            '普通 error/blocking 必须由覆盖其 @start-@end 的补丁实质修正；章节级长度问题不要求覆盖局部区间。扩写时优先在自然段边界插入完整段落，压缩时用更短但叙事完整的段落替换冗余区间。',
            `应用补丁后的完整正文必须包含 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字，并尽量接近 ${lengthContract.targetHanCharacters}。不要返回完整章节、摘要、问题说明、Markdown 或 JSON 之外的文字。`,
            '【完整原文开始】',
            artifactText,
            '【完整原文结束】',
            '现在只输出 JSON 补丁对象。',
          ].join('\n\n')
        : [
            '【最终交付契约：优先级最高】',
            '交付物必须是可直接替换下方原文的完整修订章节，不是修改说明、摘要、提纲、局部重写或只包含命中段落的补丁。输出从修订后章节第一句开始，到自然章末结束；不得加入前言、计数、标签或解释。',
            `最终正文必须包含 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字，并尽量接近 ${lengthContract.targetHanCharacters}。`,
            '先在内部以原文的每个有效段落、事件节点、人物互动、因果、情绪转折和结尾为覆盖清单；修正问题时改写对应段落，但不得遗漏其余有效内容。',
            '【完整原文开始】',
            artifactText,
            '【完整原文结束】',
            '现在仅输出完整修订章节。',
          ].join('\n\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// V3 quality-first workflow prompts (Implementation plan §8).
// Separate from the V2 compile* functions so V1/V2 prompts never change.
// All V3 prompts receive the frozen dynamic length contract; no hardcoded 3000.
// ---------------------------------------------------------------------------

export interface ContinuationV3PlanEcho {
  targetHanCharacters: number;
  chapterGoal: string;
  centralConflict: string;
  beats: Array<{ order: number; summary: string; targetHanCharacters: number }>;
}

/**
 * V3 Writer prompt (plan §8.1). Emits schemaVersion=2 JSON with a plan that
 * echoes the frozen dynamic target, then full chapter prose in `content`.
 */
export function compileV3WriterMessages(
  snapshot: ContinuationContextSnapshot,
): ChatMessage[] {
  const lengthContract = resolveContinuationLengthContract(
    snapshot.settingsSnapshot.values.targetChapterChars,
  );
  const lengthRule = [
    `【正文长度硬约束】本次冻结目标为 ${lengthContract.targetHanCharacters} 个汉字；合法区间 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字（含边界）。`,
    '汉字数只统计 Unicode CJK 汉字（含扩展区），不包含标点、空格、换行、数字和英文字母。少于下限或多于上限均视为未完成。',
    `plan.targetHanCharacters 必须严格等于 ${lengthContract.targetHanCharacters}；每个 beat 必须给出正整数 targetHanCharacters，且各 beat 目标之和应接近 ${lengthContract.targetHanCharacters}。`,
    '覆盖全部节拍不等于完成；正文还必须达到本次动态长度契约。请为每个 beat 分配足够的场景、对话、动作和情绪推进，避免把节拍压缩成摘要。',
    '不得通过摘要、提纲、剧情概述、重复句或无意义水文凑长度；必须保留完整场景、人物互动、因果推进、结果余波和自然章末收束。',
    '禁止复制原著原句或大段原文；禁止复述接缝已发生的事件；从接缝之后的新事件继续推进。',
  ].join('\n');
  const system = [
    '你是长篇小说原著续写写手。只输出一个 JSON object，不要 Markdown、代码围栏、解释文字或标题。',
    'JSON 顶层严格为 {"schemaVersion":2,"plan":{...},"content":"..."}。',
    'plan 必须包含 schemaVersion=2、targetHanCharacters（等于本次冻结目标）、chapterGoal、centralConflict、beats[]（每项含正整数 order、非空 summary、正整数 targetHanCharacters）、participatingCharacterIds[]；characterActions、plotAdvances、foreshadowingActions、proposedStateChanges、risks 若无内容可输出空数组。',
    'content 只包含本章正文，不含标题、JSON 包装、Markdown 或解释；不得在 content 中再次嵌套 plan 或 JSON。',
    '先在 plan 中收束目标、冲突、节拍与参与人物（按本次动态目标分配 beat 字数），再按 plan 写 content；不得先独立调用规划，也不得把 plan 写入 content。',
    lengthRule,
    '遵守人物知识边界与冻结状态；不引入被策略禁止的死亡/复活/新体系；不引入未被原著或前文支持的新设定。',
    primaryAnchorRule(snapshot),
    '模仿冻结文风画像，禁止逐字复制原著；用户本章明确要求优先于自动风格画像。',
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    stateBlock(snapshot),
    primaryAnchorBlock(snapshot),
    recentBlock(snapshot),
    memoryBlock(snapshot),
    episodicBlock(snapshot),
    historicalDigestBlock(snapshot),
    styleBlock(snapshot, 'writer'),
    supplementsBlock(snapshot),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `生成${displayTargetTitle(snapshot)}。本次目标 ${
        lengthContract.targetHanCharacters
      } 个汉字，合法区间 ${lengthContract.minHanCharacters}–${
        lengthContract.maxHanCharacters
      } 个汉字。用户要求：\n${snapshot.bundles.userInstruction}`,
    },
  ];
}

/**
 * Phase-aware V3 Checker prompt (plan §8.2). Initial and Final share a common
 * compiler but receive an explicit phase so the check record is distinguishable
 * in telemetry/UI. Length, duplication and seam overlap remain local-authority;
 * the Checker focuses on Canon/state/character semantic conflicts.
 */
export function compileV3CheckerMessages(
  snapshot: ContinuationContextSnapshot,
  artifactText: string,
  phase: 'initial' | 'final',
): ChatMessage[] {
  const phaseLine =
    phase === 'initial'
      ? '本次是初检（Initial Checker）：你的检查结果将作为 Integrated Reviser 的修订输入，不是最终判决。'
      : '本次是终检（Final Checker）：检查的是修订后的最终候选正文，你的结论将决定本次续写能否进入用户采纳。';
  const system = [
    '你是续写一致性检查器。先逐段核对正文，再只输出 JSON 对象 {"issues":[]}；禁止 Markdown、解释、思维过程和正文复述。每项含 category, subtype, severity, confidence, generatedStart, generatedEnd, generatedExcerpt, description, evidenceIds, suggestedFix。',
    phaseLine,
    'category ∈ world|character|relationship|plot|experience|knowledge|timeline|style；severity ∈ info|warning|error|blocking。',
    '没有 Canon 证据且不属于本地硬门禁时只能 warning，并说明是推测；主观文风偏好不得使用 error/blocking。位置使用 UTF-16 半开区间，generatedExcerpt 必须是正文中的原文片段。',
    '若原著事实与正文冲突，只有明确违反 hard/locked 规则、冻结状态/知识边界，或有可追溯 Canon 证据的事实冲突，才使用 error/blocking；能对应行内证据编号时必须写入 evidenceIds。不得把缺少资料当作原著不存在。error/blocking 必须同时给出可定位的正文片段、具体事实、证据 id 和可执行 suggestedFix；任一项无法提供就降为 warning。',
    '目标字数、整章自重复、接缝连续重合和 future leakage 由本地确定性门禁权威判定；不要把目标长度或自重复当作 error/blocking，也不要用模糊的重复问题制造第二个严重问题。若本地硬门禁已经能识别接缝重合或 future leakage，不得重复报告同一问题；把 LLM 检查预算用于 Canon、状态和人物关系的语义冲突。',
    '按根因合并重复问题：同一事实冲突只输出一项，最多补充必要的关联问题。先区分“正文明确写错”与“正文没有交代”，后者不能判错。',
    '若正文只是合理推进、补写未确定细节或与 Canon 没有明确冲突，返回 {"issues":[]} 或 warning，不要要求用户人工确认。',
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    stateBlock(snapshot),
    styleBlock(snapshot, 'checker'),
    `【可引用证据 id】${JSON.stringify(snapshot.bundles.canon.evidenceRefs)}`,
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

/**
 * V3 Integrated Reviser prompt (plan §8.3). Returns the FULL revised chapter
 * (never an offset patch). Priority order is explicit and matches plan §2.1.
 */
export function compileIntegratedReviserMessages(
  snapshot: ContinuationContextSnapshot,
  writerContent: string,
  initialOpenChecks: ContinuationCheckResult[],
  localGateSummary: {
    lengthStatus: 'within' | 'under' | 'over';
    actualHanCharacters: number;
    duplicateStatus: 'within' | 'suspicious' | 'blocking';
    hardBlockingSubtypes: string[];
  },
): ChatMessage[] {
  const lengthContract = resolveContinuationLengthContract(
    snapshot.settingsSnapshot.values.targetChapterChars,
  );
  const writerHan = countHanCharacters(writerContent);
  const gap =
    lengthContract.targetHanCharacters - writerHan;
  const gapDesc =
    gap > 0
      ? `当前正文 ${writerHan} 个汉字，距目标 ${lengthContract.targetHanCharacters} 仍缺 ${gap} 个汉字，距下限 ${lengthContract.minHanCharacters} 缺 ${Math.max(0, lengthContract.minHanCharacters - writerHan)} 个汉字。`
      : gap < 0
      ? `当前正文 ${writerHan} 个汉字，超出目标 ${Math.abs(gap)} 个汉字，超出上限 ${Math.max(0, writerHan - lengthContract.maxHanCharacters)} 个汉字。`
      : `当前正文 ${writerHan} 个汉字，恰好等于目标 ${lengthContract.targetHanCharacters}。`;
  const issues = initialOpenChecks
    .filter(c => c.severity === 'error' || c.severity === 'blocking')
    .map(c => {
      const chapterLevel = isContinuationLengthIssueSubtype(c.subtype);
      const location = chapterLevel
        ? '章节级问题（无局部 offset）'
        : `@${c.generatedStart}-${c.generatedEnd} 命中片段:${c.generatedExcerpt || '（无定位片段）'}`;
      return `- [${c.severity}/${c.category}/${c.subtype}] ${c.description} ${location} 建议:${c.suggestedFix ?? ''}`;
    })
    .join('\n');
  const localGateDesc = [
    `本地门禁：长度=${localGateSummary.lengthStatus}（${localGateSummary.actualHanCharacters} 汉字）；自重复=${localGateSummary.duplicateStatus}；硬阻断子类型=${JSON.stringify(localGateSummary.hardBlockingSubtypes)}。`,
  ].join('\n');

  const system = [
    '你是续写终稿综合修订助手。先在内部逐项执行修订清单，再只输出严格 JSON：{"schemaVersion":1,"content":"完整修订章节正文"}。不得输出思维过程、审查说明、Markdown 标题、offset 补丁或“已修复”等套话。',
    '修订优先级（严格字典序，不允许用低优先补偿高优先）：',
    '1. 不破坏 Canon、冻结状态、人物动机、接缝与完整事件链；',
    '2. 修复全部 error/blocking 语义问题；',
    `3. 达到本次冻结动态汉字区间 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters}（目标 ${lengthContract.targetHanCharacters}）；`,
    '4. 保持原著文风和自然叙事；',
    '5. 只输出严格 JSON 中的完整修订正文。',
    `本次必须输出完整修订章节正文，不是 offset 补丁、摘要、提纲、问题说明或局部重写。content 从修订后章节第一句开始，到自然章末结束；不得加入前言、计数、标签或解释。`,
    `修订后正文必须包含 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字，并尽量接近 ${lengthContract.targetHanCharacters}。${gapDesc}`,
    '长度不足时应补充具体动作、对话、因果、人物反应、冲突推进或结果余波；长度超出时优先压缩重复描写、重复心理和不推进剧情的对话。不得用摘要、提纲、概括句、重复同一句、无意义水文或大段删除来规避长度要求。',
    '不得复制原著原句或复述接缝已发生的事件；不得复制 Writer 原文形成 writer+writer 自重复；必须保留并改善 Writer 的事件链、人物互动、因果、情绪转折和自然收束。',
    '模型声明“已修复”不具证据效力；是否通过只看最终本地门禁和 Final Checker。',
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    stateBlock(snapshot),
    styleBlock(snapshot, 'repair', { openChecks: initialOpenChecks }),
    localGateDesc,
    `【待修复问题】\n${issues || '（无 error/blocking，但仍需按本地门禁调整长度/重复）'}`,
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        '【Integrated Reviser 交付契约：优先级最高】',
        '只输出严格 JSON：{"schemaVersion":1,"content":"完整修订章节正文"}。',
        `content 必须包含 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字，并尽量接近 ${lengthContract.targetHanCharacters}。`,
        '【Writer 原文开始】',
        writerContent,
        '【Writer 原文结束】',
        '现在只输出 JSON 对象。',
      ].join('\n\n'),
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
