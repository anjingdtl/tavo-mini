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
import {
  buildContinuationV4Context,
  compileContinuationV4WriterMessages,
  ensureGenerationSettings,
} from '../services/continuation/generation';
import {
  type ContinuationV4BudgetPreview,
  type ContinuationV4StageBudget,
  type FrozenContinuationStageModel,
} from '../services/continuation/generation/continuationV4Budget';
import { ensureContextAutomationPolicy } from '../services/contextAutoAllocator';
import { getContinuationChapterNumbering } from '../services/continuation/chapterNumbering/continuationChapterNumbering';
import type {
  ContextTraceItem,
  ContextSourceKind,
} from '../types/contextTrace';
import type { ChatMessage } from '../services/llm';

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
  const [expandedMsg, setExpandedMsg] = useState<number | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [continuationPreview, setContinuationPreview] = useState(false);
  const [continuationBudgetSummary, setContinuationBudgetSummary] =
    useState('');
  const [continuationStageBudgets, setContinuationStageBudgets] =
    useState<ContinuationV4BudgetPreview | null>(null);
  const [continuationFreezeSummary, setContinuationFreezeSummary] = useState<{
    policyHash: string;
    canonSnapshotId: string;
    canonRevision: number;
    styleProfileHash: string | null;
    supplementHashes: string[];
  } | null>(null);
  const [selectedContinuationStage, setSelectedContinuationStage] = useState<
    'writer' | 'checker' | 'control' | 'repair'
  >('writer');

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
        const stageConfig = async (
          id: number | null,
          fallback: typeof writerConfig,
        ): Promise<FrozenContinuationStageModel> => {
          const config = await resolveStage(id);
          const contextWindow = Number(config.context_window);
          const maxOutputTokens = Number(config.max_output_tokens);
          if (!(contextWindow > 0) || !(maxOutputTokens > 0)) {
            throw new Error(
              'V4 阶段模型缺少有效的 context_window 或 max_output_tokens，请先完善 LLM 配置。',
            );
          }
          return {
            configId: Number(config.id || fallback.id || 0),
            contextWindow,
            maxOutputTokens,
          };
        };
        const [checkerModel, controlModel, repairModel] = await Promise.all([
          stageConfig(settings.checkerLlmConfigId, writerConfig),
          stageConfig(settings.controlLlmConfigId ?? settings.checkerLlmConfigId, writerConfig),
          stageConfig(settings.repairLlmConfigId, writerConfig),
        ]);
        const result = await buildContinuationV4Context({
          projectId: chapter.project_id,
          targetChapterId: chapter.id,
          targetPosition: chapter.position as any,
          currentChapterContent: chapter.content || '',
          userInstruction: instruction,
          activeLlmConfigId: requestConfig.id || 1,
          policy,
          stageModels: {
            writer: {
              configId: Number(writerConfig.id || 0),
              contextWindow: writerWindow,
              maxOutputTokens: writerMaxOutputTokens,
            },
            checker: checkerModel,
            control: controlModel,
            repair: repairModel,
          },
        });
        const writerMessages = compileContinuationV4WriterMessages(
          result.snapshot.stageViews.writer,
        );
        setContinuationStageBudgets({ stages: result.snapshot.stageBudgets });
        setContinuationFreezeSummary({
          policyHash: result.snapshot.budgetPolicy.policyHash,
          canonSnapshotId: result.snapshot.canon.snapshotId,
          canonRevision: result.snapshot.canon.revision,
          styleProfileHash: result.snapshot.style?.profileHash ?? null,
          supplementHashes: Array.from(
            new Set(
              Object.values(result.snapshot.stageViews).flatMap(view =>
                'supplements' in view ? view.supplements.contentHashes : [],
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
        const writerBudget = result.snapshot.stageBudgets.writer;
        setContinuationBudgetSummary(
          `V4 policy ${policy.allocatorVersion} · Writer 有效窗口 ${
            writerBudget.effectiveWindow
          } · Writer 动态输出 min/max ${writerBudget.minimumOutputTokens}/${writerBudget.maximumOutputTokens}`,
        );
        setMessages(
          writerMessages.map(m => ({
            ...m,
            content: `【Writer：同次返回 plan + content】\n${m.content}`,
          })),
        );
        return;
      }
      setContinuationPreview(false);
      setContinuationBudgetSummary('');
      setContinuationStageBudgets(null);
      setContinuationFreezeSummary(null);
      // Non-continuation: same Draft compiler as reconcile (preview mode).
      // Without a frozen task snapshot this is an estimated request, not a
      // committed send payload.
      const { compileDraftStageRequest } = await import(
        '../services/pipeline/compileStageRequest'
      );
      const compiled = await compileDraftStageRequest({
        chapter,
        preview: true,
      });
      setTrace(compiled.draftCompile?.trace || []);
      setEstimatedInputTokens(compiled.estimatedInputTokens ?? 0);
      setMessages(compiled.ready ? compiled.messages : compiled.messages || []);
      if (!compiled.ready) {
        setOutlineBlock(
          compiled.error.message ||
            compiled.draftCompile?.blockingReason ||
            '请求超出模型上下文窗口',
        );
      } else {
        setOutlineBlock(null);
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
        e?.name === 'OutlineContextError';
      if (isOutlineBlock) {
        setOutlineBlock(message);
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

  const selectedBudget: ContinuationV4StageBudget | null =
    continuationStageBudgets
      ? continuationStageBudgets.stages[selectedContinuationStage]
      : null;

  return (
    <Screen>
      <Header
        title="上下文预览"
        subtitle={`${
          continuationPreview
            ? `续写 Writer（plan + content）· ${continuationBudgetSummary} · `
            : ''
        }预估 ${estimatedInputTokens.toLocaleString()} 词元`}
        action={
          <Button
            label="关闭"
            variant="ghost"
            icon={X}
            onPress={onClose}
            compact
          />
        }
      />
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
            大纲超出上下文预算，已阻止生成
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
            V4 四节点预算（模拟 / 实际 Writer 已测）
          </Text>
          <View style={styles.stageTabRow}>
            {(['writer', 'checker', 'control', 'repair'] as const).map(
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
                    {stage.toUpperCase()}
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
      {showMessages ? (
        <FlatList
          data={messages}
          // 11.15 修复：ChatMessage 无 id，用 index+role 拼接稳定 key
          keyExtractor={(item, i) => `${i}-${item.role}`}
          renderItem={renderMessageItem}
          contentContainerStyle={styles.listContent}
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
