import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Bot,
  BookOpen,
  Brain,
  ChevronDown,
  ChevronRight,
  Globe,
  ListTree,
  MessageSquare,
  StickyNote,
  Users,
  X,
} from 'lucide-react-native';
import {
  Button,
  Card,
  EmptyState,
  Header,
  LoadingState,
  Screen,
  spacing,
} from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import Toast from 'react-native-toast-message';
import * as db from '../services/database';
import {
  resolveLLMRequestConfig,
  resolveLLMRequestConfigById,
} from '../services/llm';
import { ensureGenerationSettings } from '../services/continuation/generation';
import { buildContinuationV5Context } from '../services/writing/scenario/continuationSourceCollection';
import type {
  ContinuationContextSnapshotV5,
  ContinuationV5PhysicalNode,
  ContinuationV5StageBudget,
  ContinuationV5StageBudgets,
  FrozenContinuationModelConfig,
} from '../services/continuation/generation/types';
import { ensureContextAutomationPolicy } from '../services/contextAutoAllocator';
import { resolveActiveWriterStyle } from '../services/writerStyle/activeStyleResolver';
import { getContinuationChapterNumbering } from '../services/continuation/chapterNumbering/continuationChapterNumbering';
import type {
  ContextTraceItem,
  ContextSourceKind,
} from '../types/contextTrace';
import type { ChatMessage } from '../services/llm';
import type { StoryMemoryPrepareWarning } from '../services/storyMemory/storyMemoryPrepare';

interface Props {
  chapterId: number;
  onClose: () => void;
  /** Navigate to the Resources > 大纲 management tab. Injected by the route. */
  onNavigateOutlines?: () => void;
}

const KIND_ICON: Record<
  ContextSourceKind,
  React.ComponentType<{ size: number; color: string }>
> = {
  preset: Bot,
  chapter: BookOpen,
  memory: Brain,
  story_memory: Brain,
  story_memory_bridge: BookOpen,
  character: Users,
  note: StickyNote,
  worldbook: Globe,
  instruction: MessageSquare,
  outline: ListTree,
  writer_style: Bot,
  writer_style_projection: Bot,
  writer_style_compat: Bot,
  writer_style_sampler: Bot,
};

/** 续写 context category 内部名 → 中文展示（Spec §10.3） */
const CONTINUATION_CATEGORY_LABELS: Record<string, string> = {
  originalStyle: '原著风格画像',
  supplements: '外部补充',
  lockedRules: '用户锁定规则',
  historicalDigests: '历史概览',
  canon: '原著设定与事实',
  effectiveState: '当前状态',
  seam: '原著接缝',
  primaryAnchor: '续写接缝（紧接上一章）',
  recentChapters: '最近续写',
  storyMemory: '长期故事记忆',
  episodic: '章节事件摘要',
};

/** Read-only V3 board order for Preview diagnostics. Not an editor. */
const V3_BOARD_ORDER: Array<{
  key: 'storyState' | 'resources' | 'slidingWindow' | 'episodic';
  label: string;
}> = [
  { key: 'storyState', label: 'Story State' },
  { key: 'resources', label: 'Resources' },
  { key: 'slidingWindow', label: 'Sliding Window' },
  { key: 'episodic', label: 'Episodic Memory' },
];

/** V5 冻结 stage view 节点 → 预览页短标签（五节点物理管线）。 */
const V5_STAGE_LABELS: Record<ContinuationV5PhysicalNode, string> = {
  draft_writer: 'V1 写手',
  narrative_architect: 'A1 架构',
  revision_writer: 'V2 修订',
  adversarial_auditor: 'C2 审计',
  // Phase 4 §7.2: the unified qa label mirrors the new compact Standard ONE
  // QA node; legacy preview still surfaces narrative_architect + C2 first.
  unified_qa: 'ONE QA',
  final_reviser: 'V3 终审',
};

/**
 * Frozen V5 draft-writer stage view → preview pseudo-messages. The preview
 * renders the frozen content blocks of the draft_writer view (locked rules,
 * canon guard, effective state, seam, style, supplements); the real V5 prompt
 * is compiled from the same frozen view at send time.
 */
function renderV5StageViewMessages(
  view: ContinuationContextSnapshotV5['stageViews']['draft_writer'],
): ChatMessage[] {
  const evidence = (ids: number[]) =>
    ids.length ? `（证据:${ids.join(',')}）` : '';
  const canonLines = [
    ...view.canon.hardFacts.map(f => `- ${f.text}${evidence(f.evidenceIds)}`),
    ...view.canon.softFacts.map(f => `- ${f.text}${evidence(f.evidenceIds)}`),
  ];
  const state = view.effectiveState;
  const stateLines = [
    ...state.characterStates.map(
      c => `- ${JSON.stringify(c.ref)}: ${c.summary}`,
    ),
    ...(state.relationships ?? []).map(
      r => `- ${JSON.stringify(r.source)} → ${JSON.stringify(r.target)}: ${r.summary}`,
    ),
    ...state.plotThreads.map(
      p => `- ${p.title} (${p.status}): ${p.summary}`,
    ),
    ...(state.knowledge ?? []).map(
      k => `- ${JSON.stringify(k.ref)} ${k.factKey}: ${k.factSummary}（${k.knowledgeState}）`,
    ),
    ...(state.experiences ?? []).map(
      e => `- ${JSON.stringify(e.ref)}: ${e.title}；${e.summary}`,
    ),
  ];
  return [
    {
      role: 'system',
      content: [
        '【V5 冻结 stage view：draft_writer】',
        `目标章节 ${view.targetChapterChars} 字（${view.preferredMinHan}–${view.preferredMaxHan} 汉字）。`,
        `【用户锁定/硬规则】\n${view.lockedRules.join('\n') || '（无）'}`,
        `【原著事实复核依据】\n${canonLines.join('\n') || '（当前快照未检索到与本章相关的原著事实）'}`,
      ].join('\n'),
    },
    {
      role: 'system',
      content: [
        `【已确认续写增量状态】\n${stateLines.join('\n') || '（无新增）'}`,
        `【接缝】\n${view.primaryAnchorSeamText || '（无）'}`,
        `【最近续写】\n${view.recentBridgeSummary || '（无）'}`,
      ].join('\n'),
    },
    {
      role: 'system',
      content: [
        `【文风】\n${view.style.text}`,
        `【原著之外的外部补充资料】\n${view.supplements.text || '（无）'}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `用户要求：\n${view.userInstruction}`,
    },
  ];
}

const STYLE_OMIT_REASON_LABELS: Record<string, string> = {
  style_level_off: '文风约束已关闭',
  no_injectable_profile: '无可注入风格画像',
  invalid_profile_hash: '画像哈希无效',
  repository_error: '读取画像失败',
  omitted_budget: '预算不足已省略',
  degraded_to_standard: '已降为标准级',
  degraded_to_compact: '已降为精简级',
  strict_soft_trim_for_style: '严格模式已优先压缩软资料',
  insufficient_tokens: '上下文额度不足',
  insufficient_tokens_for_compact: '精简级也无法放入上下文',
  already_covered_by_primary_anchor: '已由续写接缝完整覆盖',
  recent_bridge_budget_exhausted: '最近续写额度已用完',
};

function styleTraceReason(
  omitted: Record<string, number>,
  tokens: number,
  selected: number,
): string {
  const levelKey = Object.keys(omitted).find(k => k.startsWith('level_'));
  const level = levelKey ? levelKey.replace('level_', '') : null;
  const levelLabel =
    level === 'detailed'
      ? '详细'
      : level === 'standard'
      ? '标准'
      : level === 'compact'
      ? '精简'
      : null;
  const degradeKeys = Object.keys(omitted).filter(
    k =>
      !k.startsWith('level_') &&
      !k.startsWith('profile_') &&
      !k.startsWith('hash_') &&
      omitted[k] > 0,
  );
  const degradeText = degradeKeys
    .map(k => STYLE_OMIT_REASON_LABELS[k] || k)
    .join('；');
  const parts = [
    selected > 0 ? '已按原著严格遵循' : '未注入',
    levelLabel ? `${levelLabel}画像` : null,
    `${tokens} 词元`,
    degradeText || null,
  ].filter(Boolean);
  return parts.join(' · ');
}

function statusBadge(item: ContextTraceItem) {
  if (item.resourcePreviewStatus === 'DISABLED') {
    return <Text style={styles.badgeEmpty}>已关闭</Text>;
  }
  if (item.resourcePreviewStatus === 'ERROR') {
    return <Text style={styles.badgeExcluded}>错误</Text>;
  }
  if (item.resourcePreviewStatus === 'AWARENESS_ONLY') {
    return <Text style={styles.badgeClipped}>仅全局感知</Text>;
  }
  if (item.resourcePreviewStatus === 'NOT_SELECTED') {
    return <Text style={styles.badgeExcluded}>未选入详情</Text>;
  }
  if (item.resourcePreviewStatus === 'DETAIL_CLIPPED') {
    return <Text style={styles.badgeClipped}>详情已裁剪</Text>;
  }
  if (item.resourcePreviewStatus === 'DETAIL_FULL') {
    return <Text style={styles.badgeIncluded}>详情已展开</Text>;
  }
  if (item.empty) {
    return <Text style={styles.badgeEmpty}>暂无内容</Text>;
  }
  if (item.included && !item.clipped) {
    return <Text style={styles.badgeIncluded}>已包含</Text>;
  }
  if (item.clipped) {
    return <Text style={styles.badgeClipped}>已裁剪</Text>;
  }
  return <Text style={styles.badgeExcluded}>未包含</Text>;
}

export const ContextPreviewScreen: React.FC<Props> = ({
  chapterId,
  onClose,
  onNavigateOutlines,
}) => {
  const { theme } = useThemeStore();
  const [loading, setLoading] = useState(true);
  const [trace, setTrace] = useState<ContextTraceItem[]>([]);
  const [estimatedInputTokens, setEstimatedInputTokens] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [showMessages, setShowMessages] = useState(false);
  // Outline-budget block: when buildContext throws because the enabled
  // outlines do not fit, capture the reason so the preview can show an
  // actionable panel (with a link to 大纲 management) instead of just a Toast.
  const [outlineBlock, setOutlineBlock] = useState<string | null>(null);
  const [outlineBlockCode, setOutlineBlockCode] = useState<string>('');
  // Non-blocking Story Memory degradation (V2.11.38 repair plan P0):
  // missing / dirty / failed checkpoint or partially omitted history.
  const [storyMemoryWarnings, setStoryMemoryWarnings] = useState<
    StoryMemoryPrepareWarning[]
  >([]);
  const [expandedMsg, setExpandedMsg] = useState<number | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [continuationPreview, setContinuationPreview] = useState(false);
  const [continuationBudgetSummary, setContinuationBudgetSummary] =
    useState('');
  const [continuationStageBudgets, setContinuationStageBudgets] =
    useState<ContinuationV5StageBudgets | null>(null);
  const [continuationFreezeSummary, setContinuationFreezeSummary] = useState<{
    policyHash: string;
    canonSnapshotId: string;
    canonRevision: number;
    styleProfileHash: string | null;
    supplementHashes: string[];
  } | null>(null);
  const [selectedContinuationStage, setSelectedContinuationStage] = useState<
    ContinuationV5PhysicalNode
  >('draft_writer');
  /** Context Budget V3 hierarchical trace for the read-only preview. */
  const [hierarchicalBudgetTrace, setHierarchicalBudgetTrace] = useState<
    import('../services/context/hierarchicalContextAllocator').HierarchicalBudgetResult | null
  >(null);
  /** Compact by default; expand only to inspect board-level diagnostics. */
  const [showV3BoardDetail, setShowV3BoardDetail] = useState(false);

  const loadContext = useCallback(async () => {
    setLoading(true);
    try {
      const chapter = await db.getChapterById(chapterId);
      if (!chapter) {
        setNotFound(true);
        return;
      }
      setNotFound(false);
      const project =
        typeof (db as any).getProjectById === 'function'
          ? await (db as any).getProjectById(chapter.project_id)
          : null;
      if (project?.mode === 'continuation') {
        setContinuationPreview(true);
        setStoryMemoryWarnings([]);
        const requestConfig = await resolveLLMRequestConfig();
        const settings = await ensureGenerationSettings(chapter.project_id);
        const policy = await ensureContextAutomationPolicy();
        const resolveStage = async (id: number | null) =>
          id == null
            ? requestConfig
            : resolveLLMRequestConfigById(id).catch(() => requestConfig);
        const writerConfig = await resolveStage(settings.writerLlmConfigId);
        const writerWindow = Number(writerConfig.context_window);
        const writerMaxOutputTokens = Number(writerConfig.max_output_tokens);
        if (!(writerWindow > 0) || !(writerMaxOutputTokens > 0)) {
          throw new Error(
            'Writer 模型缺少有效的 context_window 或 max_output_tokens，请先完善 LLM 配置。',
          );
        }
        const continuationNumbering = await getContinuationChapterNumbering(
          chapter.project_id,
        );
        const instruction =
          chapter.synopsis?.trim() ||
          `续写${continuationNumbering.getDefaultTitle(
            chapter.position as any,
          )}，保持与前文一致。`;
        const freezeModel = (
          config: typeof writerConfig,
        ): FrozenContinuationModelConfig => ({
          configId: Number(config.id || 0),
          name: String(config.name || `LLM 配置 #${config.id}`),
          providerType: config.provider_type,
          url: config.url,
          modelName: config.model_name,
          contextWindow: Number(config.context_window),
          maxOutputTokens: Number(config.max_output_tokens),
        });
        const stageConfig = async (id: number | null) => {
          const config = await resolveStage(id);
          const contextWindow = Number(config.context_window);
          const maxOutputTokens = Number(config.max_output_tokens);
          if (!(contextWindow > 0) || !(maxOutputTokens > 0)) {
            throw new Error(
              'V5 阶段模型缺少有效的 context_window 或 max_output_tokens，请先完善 LLM 配置。',
            );
          }
          return config;
        };
        const [plannerCfg, checkerCfg, controlCfg, repairCfg] =
          await Promise.all([
            stageConfig(settings.plannerLlmConfigId),
            stageConfig(settings.checkerLlmConfigId),
            stageConfig(
              settings.controlLlmConfigId ?? settings.checkerLlmConfigId,
            ),
            stageConfig(settings.repairLlmConfigId),
          ]);
        // V5 auditor pick: prefer larger context, then max output, then a
        // stable config id (same rule as the production stage model resolver).
        const score = (config: typeof writerConfig) =>
          (Number(config.context_window) || 0) * 1_000_000 +
          (Number(config.max_output_tokens) || 0) * 100 +
          (Number(config.id) || 0);
        const auditorCfg =
          score(controlCfg) > score(checkerCfg) ? controlCfg : checkerCfg;
        const writerFrozen = freezeModel(writerConfig);
        const plannerFrozen = freezeModel(plannerCfg);
        const checkerFrozen = freezeModel(checkerCfg);
        const controlFrozen = freezeModel(controlCfg);
        const repairFrozen = freezeModel(repairCfg);
        const auditorFrozen = freezeModel(auditorCfg);
        const stageModelOf = (frozen: FrozenContinuationModelConfig) => ({
          configId: frozen.configId,
          contextWindow: frozen.contextWindow,
          maxOutputTokens: frozen.maxOutputTokens,
        });
        const result = await buildContinuationV5Context({
          projectId: chapter.project_id,
          targetChapterId: chapter.id,
          targetPosition: chapter.position as any,
          currentChapterContent: chapter.content || '',
          userInstruction: instruction,
          activeLlmConfigId: requestConfig.id || 1,
          policy,
          stageModels: {
            draft_writer: stageModelOf(writerFrozen),
            narrative_architect: stageModelOf(plannerFrozen),
            revision_writer: stageModelOf(repairFrozen),
            adversarial_auditor: stageModelOf(auditorFrozen),
            // Phase 4 §7.2: compact Standard unified QA reuses the auditor
            // model config; preview page keeps the legacy labels untouched.
            unified_qa: stageModelOf(auditorFrozen),
            final_reviser: stageModelOf(repairFrozen),
          },
          frozenModelConfigs: {
            planner: plannerFrozen,
            writer: writerFrozen,
            checker: checkerFrozen,
            repair: repairFrozen,
            stateExtraction: null,
            control: controlFrozen,
            draftWriter: writerFrozen,
            narrativeArchitect: plannerFrozen,
            revisionWriter: repairFrozen,
            adversarialAuditor: auditorFrozen,
            finalReviser: repairFrozen,
          },
        });
        setContinuationStageBudgets(result.snapshot.stageBudgets);
        setContinuationFreezeSummary({
          policyHash: result.snapshot.budgetPolicy.policyHash,
          canonSnapshotId: result.snapshot.canon.snapshotId,
          canonRevision: result.snapshot.canon.revision,
          styleProfileHash: result.snapshot.style?.profileHash ?? null,
          supplementHashes: Array.from(
            new Set(
              Object.values(result.snapshot.stageViews).flatMap(
                view => view.supplements.contentHashes,
              ),
            ),
          ),
        });
        setTrace(
          result.trace.categories.map(category => {
            const title =
              CONTINUATION_CATEGORY_LABELS[category.name] || category.name;
            const isStyle = category.name === 'originalStyle';
            const coveredByPrimaryAnchor = category.coveredByPrimaryAnchor ?? 0;
            const empty = category.candidates === 0;
            const reason = empty
              ? '暂无可用资料'
              : isStyle
              ? styleTraceReason(
                  category.omittedReasonCounts,
                  category.tokens,
                  category.selected,
                )
              : coveredByPrimaryAnchor > 0
              ? `候选 ${category.candidates} · 最近续写 ${category.selected} · 接缝覆盖 ${coveredByPrimaryAnchor}`
              : `候选 ${category.candidates} · 已选 ${category.selected}`;
            const omitPreview = Object.entries(category.omittedReasonCounts)
              .map(([reasonKey, count]) => {
                const label = STYLE_OMIT_REASON_LABELS[reasonKey] || reasonKey;
                return `${label} × ${count}`;
              })
              .join('\n');
            return {
              kind: 'instruction' as const,
              sourceId: null,
              title: isStyle ? `★ ${title}` : title,
              reason,
              estimatedTokens: category.tokens,
              included: category.selected + coveredByPrimaryAnchor > 0,
              empty,
              clipped:
                !empty &&
                (isStyle
                  ? category.selected > 0 &&
                    Object.keys(category.omittedReasonCounts).some(k =>
                      k.startsWith('degraded'),
                    )
                  : category.selected + coveredByPrimaryAnchor <
                    category.candidates),
              preview: omitPreview,
            };
          }),
        );
        setEstimatedInputTokens(result.trace.totalInputTokens);
        const draftBudget = result.snapshot.stageBudgets.draft_writer;
        setContinuationBudgetSummary(
          `V5 policy ${policy.allocatorVersion} · draft_writer 有效窗口 ${
            draftBudget.effectiveWindow
          } · draft_writer 动态输出 min/max ${draftBudget.minimumOutputTokens}/${draftBudget.maximumOutputTokens}`,
        );
        setMessages(renderV5StageViewMessages(result.snapshot.stageViews.draft_writer));
        return;
      }
      setContinuationPreview(false);
      setContinuationBudgetSummary('');
      setContinuationStageBudgets(null);
      setContinuationFreezeSummary(null);
      // Match the chapter send path: new outline chapter tasks freeze V7,
      // while historical/freeform paths keep their legacy protocol. The old
      // global auto-mode switch is not a Preview input anymore.
      const contextBudgetVersion =
        project?.mode === 'outline' && chapter.id > 0 ? 7 : undefined;
      let contextAutomationPolicyV3: any;
      if (contextBudgetVersion != null && contextBudgetVersion >= 6) {
        try {
        const mod = await import(
          '../data/repositories/contextAutoRepository'
        );
          const persisted = await mod.getContextAutomationPolicyV3();
          if (persisted) contextAutomationPolicyV3 = persisted;
        } catch {
          // Settings read failure: allocator uses its frozen default policy.
        }
      }
      // Non-continuation: same Draft compiler as reconcile (preview mode).
      // Without a frozen task snapshot this is an estimated request, not a
      // committed send payload.
      const pipelineConfig = await db.getPipelineConfig({
        projectId: chapter.project_id,
      });
      const {
        writerStyle: previewWriterStyle,
        draftPreset: previewPreset,
      } = await resolveActiveWriterStyle(
        chapter.project_id,
        pipelineConfig.activeWriterStyleId,
      );
      const { compileDraftStageRequest } = await import(
        '../services/pipeline/compileStageRequest'
      );
      const compiled = await compileDraftStageRequest({
        chapter,
        draftPreset: previewPreset,
        writerStyleSnapshot: previewWriterStyle,
        preview: true,
        contextBudgetVersion,
        contextAutomationPolicyV3,
      });
      setTrace(compiled.draftCompile?.trace || []);
      setStoryMemoryWarnings(
        compiled.draftCompile?.storyMemoryWarnings || [],
      );
      setEstimatedInputTokens(compiled.estimatedInputTokens ?? 0);
      setHierarchicalBudgetTrace(
        compiled.hierarchicalBudgetTrace ?? compiled.draftCompile?.hierarchicalBudgetTrace ?? null,
      );
      setMessages(compiled.ready ? compiled.messages : compiled.messages || []);
      if (!compiled.ready) {
        setOutlineBlock(
          compiled.error.message ||
            compiled.draftCompile?.blockingReason ||
            '请求超出模型上下文窗口',
        );
        setOutlineBlockCode(String(compiled.error.code || ''));
      } else {
        setOutlineBlock(null);
        setOutlineBlockCode('');
      }
    } catch (e: any) {
      const message = e?.message ? String(e.message) : '构建上下文失败';
      // Prefer structured OutlineContextError codes over Chinese regex matching.
      const code = e?.code ? String(e.code) : '';
      const isOutlineBlock =
        code === 'OUTLINE_OVER_BUDGET' ||
        code === 'OUTLINE_BUDGET_UNKNOWN' ||
        code === 'OUTLINE_READ_FAILED' ||
        code === 'OUTLINE_MODEL_UNAVAILABLE' ||
        code === 'OUTLINE_SNAPSHOT_INVALID' ||
        code === 'OUTLINE_SNAPSHOT_PERSIST_FAILED' ||
        code === 'OUTLINE_EXECUTION_CONFIG_INVALID' ||
        code === 'RESOURCE_AWARENESS_OVER_BUDGET' ||
        code === 'RESOURCE_AWARENESS_READ_FAILED' ||
        code === 'RESOURCE_AWARENESS_COMPILE_FAILED' ||
        code === 'PRESET_SOURCE_READ_FAILED' ||
        code === 'RESOURCE_SOURCE_CHANGED_DURING_BUILD' ||
        code === 'ACTIVE_WRITER_STYLE_MISSING' ||
        code === 'WRITER_STYLE_OVER_BUDGET' ||
        e?.name === 'OutlineContextError' ||
        e?.name === 'ResourceContextError';
      if (isOutlineBlock) {
        setOutlineBlock(message);
        setOutlineBlockCode(code);
        setTrace([]);
        setMessages([]);
      } else {
      setOutlineBlock(null);
        Toast.show({ type: 'error', text1: '构建上下文失败', text2: message });
      }
    } finally {
      setLoading(false);
    }
  }, [chapterId]);

  useEffect(() => {
    loadContext();
  }, [loadContext]);

  if (loading) {
    return (
      <Screen>
        <Header
          title="上下文预览"
          action={<Button label="关闭" variant="ghost" onPress={onClose} />}
        />
        <LoadingState label="正在构建上下文..." />
      </Screen>
    );
  }

  if (notFound) {
    return (
      <Screen>
        <Header
          title="上下文预览"
          action={<Button label="关闭" variant="ghost" onPress={onClose} />}
        />
        <EmptyState title="章节不存在或已被删除" />
      </Screen>
    );
  }

  const renderTraceItem = ({ item }: { item: ContextTraceItem }) => {
    const Icon = KIND_ICON[item.kind];
    const hasV3Detail =
      typeof item.demandTokens === 'number' ||
      typeof item.allocatedTokens === 'number' ||
      typeof item.softTargetTokens === 'number' ||
      typeof item.borrowedTokens === 'number';
    return (
      <Card style={styles.traceCard}>
        <View style={styles.traceRow}>
          <View
            style={[
              styles.traceIconWrap,
              { backgroundColor: theme.colors.accentSoft },
            ]}
          >
            <Icon size={16} color={theme.colors.accent} />
          </View>
          <View style={styles.traceInfo}>
            <Text
              style={[styles.traceTitle, { color: theme.colors.textPrimary }]}
              numberOfLines={1}
            >
              {item.title}
            </Text>
            <Text
              style={[
                styles.traceReason,
                { color: theme.colors.textSecondary },
              ]}
              numberOfLines={1}
            >
              {item.reason}
            </Text>
            {item.warning ? (
              <Text
                style={{
                  color: theme.colors.warning,
                  fontSize: 11,
                  marginTop: 3,
                }}
                numberOfLines={3}
              >
                {item.warning}
              </Text>
            ) : null}
            {hasV3Detail ? (
              <Text
                style={{
                  color: theme.colors.textMuted,
                  fontSize: 11,
                  marginTop: 2,
                }}
                numberOfLines={2}
              >
                {typeof item.demandTokens === 'number'
                  ? `需求 ${item.demandTokens.toLocaleString()} · `
                  : ''}
                {typeof item.softTargetTokens === 'number'
                  ? `软目标 ${item.softTargetTokens.toLocaleString()} · `
                  : ''}
                {typeof item.allocatedTokens === 'number'
                  ? `分配 ${item.allocatedTokens.toLocaleString()}`
                  : ''}
                {typeof item.borrowedTokens === 'number'
                  ? item.borrowedTokens > 0
                    ? ` · 借调 +${item.borrowedTokens.toLocaleString()}`
                    : ' · 借调 0'
                  : ''}
                {item.allocationReason ? ` （${item.allocationReason}）` : ''}
              </Text>
            ) : null}
          </View>
          <View style={styles.traceMeta}>
            <Text
              style={[
                styles.traceTokens,
                { color: theme.colors.textSecondary },
              ]}
            >
              {item.estimatedTokens} 词元
            </Text>
            {statusBadge(item)}
          </View>
        </View>
      </Card>
    );
  };

  const renderMessageItem = ({
    item,
    index,
  }: {
    item: ChatMessage;
    index: number;
  }) => {
    const expanded = expandedMsg === index;
    const roleLabel =
      item.role === 'system' ? '系统' : item.role === 'user' ? '用户' : '助手';
    const roleColor =
      item.role === 'system'
        ? '#8b5cf6'
        : item.role === 'user'
        ? theme.colors.accent
        : '#f59e0b';

    return (
      <Card style={styles.msgCard}>
        <TouchableOpacity
          style={styles.msgHeader}
          onPress={() => setExpandedMsg(expanded ? null : index)}
          activeOpacity={0.7}
        >
          {expanded ? (
            <ChevronDown size={16} color={theme.colors.textSecondary} />
          ) : (
            <ChevronRight size={16} color={theme.colors.textSecondary} />
          )}
          <Text style={[styles.msgRole, { color: roleColor }]}>
            {roleLabel}
          </Text>
          <Text
            style={[styles.msgPreview, { color: theme.colors.textSecondary }]}
            numberOfLines={1}
          >
            {item.content.slice(0, 80)}
          </Text>
        </TouchableOpacity>
        {expanded ? (
          <Text
            style={[
              styles.msgContent,
              {
                color: theme.colors.textPrimary,
                borderColor: theme.colors.border,
              },
            ]}
          >
            {item.content}
          </Text>
        ) : null}
      </Card>
    );
  };

  const selectedBudget: ContinuationV5StageBudget | null =
    continuationStageBudgets
      ? continuationStageBudgets[selectedContinuationStage]
      : null;

  // The summary cards live INSIDE the scrolling list header: the budget
  // panel can grow taller than the screen (board details, per-resource
  // rows), and cards outside the FlatList made everything below them
  // unreachable (the list itself was squeezed to zero height).
  const listHeader = (
    <>
      {outlineBlock ? (
        <View
          style={[
            styles.outlineBlockPanel,
            {
              backgroundColor: `${theme.colors.danger}1A`,
              borderColor: theme.colors.danger,
            },
          ]}
        >
          <Text style={[styles.outlineBlockTitle, { color: theme.colors.danger }]}>
            {outlineBlockCode.startsWith('RESOURCE') ||
            outlineBlockCode.startsWith('PRESET')
              ? '资料上下文无法安全构建，已阻止生成'
              : '大纲超出上下文预算，已阻止生成'}
          </Text>
          <Text style={[styles.outlineBlockText, { color: theme.colors.textPrimary }]}>
            {outlineBlock}
          </Text>
          {onNavigateOutlines ? (
            <Button
              label="前往大纲管理"
              variant="secondary"
              compact
              onPress={onNavigateOutlines}
            />
          ) : null}
        </View>
      ) : null}
      {storyMemoryWarnings.length > 0 ? (
        <View
          style={[
            styles.outlineBlockPanel,
            {
              backgroundColor: `${theme.colors.warning}1A`,
              borderColor: theme.colors.warning,
            },
          ]}
        >
          <Text
            style={[
              styles.outlineBlockTitle,
              { color: theme.colors.warning },
            ]}
          >
            长期记忆暂不可用，已降级上下文
          </Text>
          {storyMemoryWarnings.map((warning, index) => (
            <Text
              key={`${warning.code}-${index}`}
              style={[
                styles.outlineBlockText,
                { color: theme.colors.textPrimary },
              ]}
            >
              {warning.message}
            </Text>
          ))}
          <Text
            style={[
              styles.outlineBlockText,
              { color: theme.colors.textSecondary },
            ]}
          >
            你可以继续生成，或稍后前往「故事记忆」重新整理。
          </Text>
        </View>
      ) : null}
      {hierarchicalBudgetTrace ? (
        <View
          style={[
            styles.outlineBlockPanel,
            {
              borderColor: theme.colors.accent,
              backgroundColor: theme.colors.accentSoft,
            },
            ]}
          >
            <Text
              style={[
                styles.outlineBlockTitle,
                { color: theme.colors.textPrimary },
              ]}
            >
              上下文预算 V3 分层弹性
            </Text>
            <Text
              style={[
                styles.outlineBlockText,
                { color: theme.colors.textSecondary },
              ]}
            >
              模型窗口 {hierarchicalBudgetTrace.envelope.contextWindow.toLocaleString()} ·
              强制输入上限 {hierarchicalBudgetTrace.envelope.hardInputLimit.toLocaleString()} ·
              软线 {hierarchicalBudgetTrace.envelope.softInputLimit.toLocaleString()} ·
              突发线 {hierarchicalBudgetTrace.envelope.burstInputLimit.toLocaleString()}
            </Text>
            <Text
              style={[
                styles.outlineBlockText,
                { color: theme.colors.textSecondary, marginTop: spacing.xs },
              ]}
            >
              必须保留 {hierarchicalBudgetTrace.envelope.mandatoryTokens.toLocaleString()} ·
              弹性池 {hierarchicalBudgetTrace.envelope.softElasticPool.toLocaleString()} ·
              突发池 {hierarchicalBudgetTrace.envelope.burstElasticPool.toLocaleString()} ·
              风险等级 {hierarchicalBudgetTrace.riskLevel}
            </Text>
            <Text
              style={[
                styles.outlineBlockText,
                { color: theme.colors.textSecondary, marginTop: spacing.xs },
              ]}
            >
              Context Protocol V7 · Resource Context V2 · Snapshot V5 · Snapshot V4 legacy resume ·
              Active Writer Style 为 Protected 输入，普通详情才进入弹性分配
            </Text>
            <Text
              style={[
                styles.outlineBlockText,
                styles.v3BoardLine,
                { color: theme.colors.textPrimary },
              ]}
            >
              总预计输入 {hierarchicalBudgetTrace.totalEstimatedInputTokens.toLocaleString()} ·
              必须保留 {hierarchicalBudgetTrace.envelope.mandatoryTokens.toLocaleString()} ·
              hard limit {hierarchicalBudgetTrace.envelope.hardInputLimit.toLocaleString()}
            </Text>
            <TouchableOpacity
              onPress={() => setShowV3BoardDetail(open => !open)}
              accessibilityRole="button"
              accessibilityLabel={
                showV3BoardDetail ? '收起详细分配' : '展开详细分配'
              }
              style={styles.v3BoardToggle}
            >
              <Text
                style={[
                  styles.v3BoardToggleText,
                  { color: theme.colors.accent },
                ]}
              >
                {showV3BoardDetail ? '收起详细分配' : '展开详细分配'}
              </Text>
            </TouchableOpacity>
            {showV3BoardDetail
              ? V3_BOARD_ORDER.map(({ key, label }) => {
                  const board =
                    hierarchicalBudgetTrace.boardAllocations[key];
                  if (!board) {
                    return null;
                  }
                  const borrowedLabel =
                    board.borrowedTokens > 0
                      ? `跨板借调 +${board.borrowedTokens.toLocaleString()}`
                      : '借调 0';
                  return (
                    <Text
                      key={key}
                      style={[
                        styles.outlineBlockText,
                        styles.v3BoardLine,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      {label}
                      {'\n'}
                      需求 {board.actualDemandTokens.toLocaleString()}
                      {'\n'}
                      软目标 {board.softTargetTokens.toLocaleString()}
                      {'\n'}
                      最终分配 {board.allocatedTokens.toLocaleString()}
                      {'\n'}
                      {borrowedLabel}
                    </Text>
                  );
                })
              : null}
            </View>
          ) : null}
      <View
        style={[styles.toggleRow, { borderBottomColor: theme.colors.border }]}
      >
        <Button
          label={showMessages ? '查看资料分配' : '查看预估请求'}
          variant="secondary"
          compact
          onPress={() => {
            setShowMessages(!showMessages);
            setExpandedMsg(null);
          }}
        />
        <Text
          style={[styles.tokenSummary, { color: theme.colors.textSecondary }]}
        >
          {showMessages
            ? `${messages.length} 条预估请求消息（未冻结任务）`
            : `${trace.length} 项资料分配`}
        </Text>
      </View>
      {continuationPreview && continuationStageBudgets ? (
        <Card style={styles.stageBudgetCard}>
          <Text
            style={[
              styles.stageBudgetTitle,
              { color: theme.colors.textPrimary },
            ]}
          >
            V5 五节点预算（冻结 stage views）
          </Text>
          <View style={styles.stageTabRow}>
            {(Object.keys(V5_STAGE_LABELS) as ContinuationV5PhysicalNode[]).map(
              stage => (
                <TouchableOpacity
                  key={stage}
                  onPress={() => setSelectedContinuationStage(stage)}
                  style={[
                    styles.stageTab,
                    {
                      borderColor:
                        selectedContinuationStage === stage
                          ? theme.colors.accent
                          : theme.colors.border,
                      backgroundColor:
                        selectedContinuationStage === stage
                          ? theme.colors.accentSoft
                          : theme.colors.card,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.stageTabText,
                      {
                        color:
                          selectedContinuationStage === stage
                            ? theme.colors.accent
                            : theme.colors.textSecondary,
                      },
                    ]}
                  >
                    {V5_STAGE_LABELS[stage]}
                  </Text>
                </TouchableOpacity>
              ),
            )}
          </View>
          {selectedBudget ? (
            <View style={styles.stageBudgetDetails}>
              <Text
                style={[
                  styles.stageBudgetLine,
                  { color: theme.colors.textSecondary },
                ]}
              >
                context_window {selectedBudget.contextWindow.toLocaleString()} ·
                有效窗口 {selectedBudget.effectiveWindow.toLocaleString()}
              </Text>
              <Text
                style={[
                  styles.stageBudgetLine,
                  { color: theme.colors.textSecondary },
                ]}
              >
                实测 Prompt{' '}
                {selectedBudget.compiledPromptTokens.toLocaleString()} · 动态
                min/max {selectedBudget.minimumOutputTokens.toLocaleString()} /{' '}
                {selectedBudget.maximumOutputTokens.toLocaleString()}
              </Text>
              {selectedBudget.blockedReason ? (
                <Text
                  style={[
                    styles.stageBudgetLine,
                    { color: theme.colors.warning },
                  ]}
                >
                  {selectedBudget.blockedReason}
                </Text>
              ) : null}
              {continuationFreezeSummary ? (
                <Text
                  style={[
                    styles.stageBudgetLine,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  policy {continuationFreezeSummary.policyHash.slice(0, 12)} ·
                  Canon {continuationFreezeSummary.canonSnapshotId.slice(0, 12)}@
                  {continuationFreezeSummary.canonRevision} · Style{' '}
                  {continuationFreezeSummary.styleProfileHash?.slice(0, 12) ||
                    'none'}
                </Text>
              ) : null}
              {continuationFreezeSummary ? (
                <Text
                  style={[
                    styles.stageBudgetLine,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  Supplement hashes{' '}
                  {continuationFreezeSummary.supplementHashes.length || 0} ·
                  预览不发送请求、不创建 run
                </Text>
              ) : null}
            </View>
          ) : null}
        </Card>
      ) : null}
    </>
  );

  return (
    <Screen>
      <Header
        testID="context-preview"
        title="上下文预览"
        subtitle={`${
          continuationPreview
            ? `续写 draft_writer（V5 冻结视图）· ${continuationBudgetSummary} · `
            : ''
        }预估 ${estimatedInputTokens.toLocaleString()} 词元`}
        action={
          <Button
            testID="context-preview-close"
            label="关闭"
            variant="ghost"
            icon={X}
            onPress={onClose}
            compact
          />
        }
      />
      {showMessages ? (
        <FlatList
          data={messages}
          // 11.15 修复：ChatMessage 无 id，用 index+role 拼接稳定 key
          keyExtractor={(item, i) => `${i}-${item.role}`}
          renderItem={renderMessageItem}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={listHeader}
        />
      ) : (
        <FlatList
          data={trace}
          // 11.15 修复：ContextTraceItem 有 sourceId，用 kind+sourceId+title 组合稳定 key
          keyExtractor={item =>
            `${item.kind}-${item.sourceId ?? 'none'}-${item.title}`
          }
          renderItem={renderTraceItem}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={listHeader}
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  outlineBlockPanel: {
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    gap: spacing.xs,
  },
  outlineBlockTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  outlineBlockText: {
    fontSize: 13,
    lineHeight: 19,
  },
  v3BoardLine: {
    marginTop: spacing.xs,
  },
  v3BoardToggle: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
  },
  v3BoardToggleText: {
    fontSize: 13,
    fontWeight: '700',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tokenSummary: {
    fontSize: 13,
    fontWeight: '600',
  },
  listContent: {
    padding: spacing.lg,
    paddingBottom: 48,
  },
  traceCard: {
    marginBottom: spacing.sm,
  },
  traceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  traceIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  traceInfo: {
    flex: 1,
    gap: 2,
  },
  traceTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  traceReason: {
    fontSize: 12,
  },
  traceMeta: {
    alignItems: 'flex-end',
    gap: 4,
  },
  traceTokens: {
    fontSize: 11,
    fontWeight: '600',
  },
  badgeIncluded: {
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: '#22c55e20',
    color: '#16a34a',
  },
  badgeClipped: {
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: '#f9731620',
    color: '#ea580c',
  },
  badgeExcluded: {
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: '#ef444420',
    color: '#dc2626',
  },
  badgeEmpty: {
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: '#64748b18',
    color: '#64748b',
  },
  msgCard: {
    marginBottom: spacing.sm,
  },
  msgHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  msgRole: {
    fontSize: 12,
    fontWeight: '800',
  },
  msgPreview: {
    flex: 1,
    fontSize: 13,
  },
  msgContent: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    fontSize: 13,
    lineHeight: 20,
  },
  stageBudgetCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
  stageBudgetTitle: {
    fontSize: 14,
    fontWeight: '800',
    marginBottom: spacing.xs,
  },
  stageTabRow: { flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap' },
  stageTab: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  stageTabText: { fontSize: 12, fontWeight: '700' },
  stageBudgetDetails: { marginTop: spacing.sm, gap: 3 },
  stageBudgetLine: { fontSize: 12, lineHeight: 18 },
});
