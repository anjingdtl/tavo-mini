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
  MessageSquare,
  StickyNote,
  Users,
  X,
} from 'lucide-react-native';
import { Button, Card, EmptyState, Header, LoadingState, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import Toast from 'react-native-toast-message';
import * as db from '../services/database';
import { buildContext } from '../services/contextBuilder';
import { resolveLLMRequestConfig, resolveLLMRequestConfigById } from '../services/llm';
import {
  buildContinuationContext,
  compilePlannerMessages,
  compileWriterMessages,
  ensureGenerationSettings,
} from '../services/continuation/generation';
import { getContinuationChapterNumbering } from '../services/continuation/chapterNumbering/continuationChapterNumbering';
import type { ContextTraceItem, ContextSourceKind } from '../types/contextTrace';
import type { ChatMessage } from '../services/llm';

interface Props {
  chapterId: number;
  onClose: () => void;
}

const KIND_ICON: Record<ContextSourceKind, React.ComponentType<{ size: number; color: string }>> = {
  preset: Bot,
  chapter: BookOpen,
  memory: Brain,
  story_memory: Brain,
  story_memory_bridge: BookOpen,
  character: Users,
  note: StickyNote,
  worldbook: Globe,
  instruction: MessageSquare,
};

/** 续写 context category 内部名 → 中文展示（Spec §10.3） */
const CONTINUATION_CATEGORY_LABELS: Record<string, string> = {
  originalStyle: '原著风格画像',
  supplements: '外部补充',
  historicalDigests: '历史概览',
  canon: '原著 Canon',
  effectiveState: '当前状态',
  seam: '原著接缝',
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
  insufficient_tokens: 'token 不足',
  insufficient_tokens_for_compact: '连精简级都放不下',
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
    selected > 0 ? '已注入' : '未注入',
    levelLabel ? `级别 ${levelLabel}` : null,
    `${tokens} tokens`,
    degradeText || null,
  ].filter(Boolean);
  return parts.join(' · ');
}

function statusBadge(item: ContextTraceItem) {
  if (item.included && !item.clipped) {
    return <Text style={styles.badgeIncluded}>已包含</Text>;
  }
  if (item.clipped) {
    return <Text style={styles.badgeClipped}>已裁剪</Text>;
  }
  return <Text style={styles.badgeExcluded}>未包含</Text>;
}

export const ContextPreviewScreen: React.FC<Props> = ({ chapterId, onClose }) => {
  const { theme } = useThemeStore();
  const [loading, setLoading] = useState(true);
  const [trace, setTrace] = useState<ContextTraceItem[]>([]);
  const [estimatedInputTokens, setEstimatedInputTokens] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [showMessages, setShowMessages] = useState(false);
  const [expandedMsg, setExpandedMsg] = useState<number | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [continuationPreview, setContinuationPreview] = useState(false);

  const loadContext = useCallback(async () => {
    setLoading(true);
    try {
      const chapter = await db.getChapterById(chapterId);
      if (!chapter) {
        setNotFound(true);
        return;
      }
      setNotFound(false);
      const project = typeof (db as any).getProjectById === 'function'
        ? await (db as any).getProjectById(chapter.project_id)
        : null;
      if (project?.mode === 'continuation') {
        setContinuationPreview(true);
        const requestConfig = await resolveLLMRequestConfig();
        const settings = await ensureGenerationSettings(chapter.project_id);
        const resolveStage = async (id: number | null) =>
          id == null
            ? requestConfig
            : resolveLLMRequestConfigById(id).catch(() => requestConfig);
        const [plannerConfig, writerConfig] = await Promise.all([
          resolveStage(settings.plannerLlmConfigId),
          resolveStage(settings.writerLlmConfigId),
        ]);
        // Layout budget follows Writer window (Spec §7.1) — never Math.min across
        // stages, which would under-allocate style relative to the real run.
        const writerWindow =
          (typeof writerConfig.context_window === 'number' &&
          writerConfig.context_window > 0
            ? writerConfig.context_window
            : null) ||
          requestConfig.context_window ||
          8192;
        const writerOutput = Math.min(
          4096,
          settings.targetChapterChars * 2,
          writerConfig.max_output_tokens || Number.MAX_SAFE_INTEGER,
        );
        const continuationNumbering = await getContinuationChapterNumbering(chapter.project_id);
        const instruction = chapter.synopsis?.trim() || `续写${continuationNumbering.getDefaultTitle(chapter.position as any)}，保持与前文一致。`;
        const result = await buildContinuationContext({
          projectId: chapter.project_id,
          targetChapterId: chapter.id,
          targetPosition: chapter.position as any,
          currentChapterContent: chapter.content || '',
          userInstruction: instruction,
          modelContextLimit: writerWindow,
          maxOutputTokens: writerOutput,
          activeLlmConfigId: requestConfig.id || 1,
        });
        setTrace(
          result.trace.categories.map(category => {
            const title =
              CONTINUATION_CATEGORY_LABELS[category.name] || category.name;
            const isStyle = category.name === 'originalStyle';
            const reason = isStyle
              ? styleTraceReason(
                  category.omittedReasonCounts,
                  category.tokens,
                  category.selected,
                )
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
              included: category.selected > 0,
              clipped:
                isStyle && category.selected > 0
                  ? Object.keys(category.omittedReasonCounts).some(k =>
                      k.startsWith('degraded'),
                    )
                  : Object.keys(category.omittedReasonCounts).length > 0 &&
                    category.selected === 0,
              preview: omitPreview,
            };
          }),
        );
        setEstimatedInputTokens(result.trace.totalInputTokens);
        // Spec §9 / §10.3: preview must surface Writer style injection, not only Planner.
        const plannerMsgs = compilePlannerMessages(result.snapshot);
        const writerMsgs = compileWriterMessages(result.snapshot, {
          schemaVersion: 1,
          chapterGoal: '（预览用占位规划）',
          centralConflict: '',
          beats: [],
          participatingCharacterIds: [],
          characterActions: [],
          plotAdvances: [],
          foreshadowingActions: [],
          proposedStateChanges: [],
          risks: [],
        });
        setMessages([
          ...plannerMsgs.map(m => ({
            ...m,
            content: `【规划 Planner】\n${m.content}`,
          })),
          ...writerMsgs.map(m => ({
            ...m,
            content: `【正文 Writer】\n${m.content}`,
          })),
        ]);
        return;
      }
      setContinuationPreview(false);
      const config = await db.getContextConfig();
      const presets = await db.getPresetsByProject(chapter.project_id);
      const result = await buildContext(
        chapter,
        config,
        chapter.project_id,
        presets[0],
        { storyMemoryMode: 'preview' },
      );
      setTrace(result.trace);
      setEstimatedInputTokens(result.estimatedInputTokens);
      setMessages(result.messages);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '构建上下文失败', text2: e?.message });
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
        <Header title="上下文预览" action={<Button label="关闭" variant="ghost" onPress={onClose} />} />
        <LoadingState label="正在构建上下文..." />
      </Screen>
    );
  }

  if (notFound) {
    return (
      <Screen>
        <Header title="上下文预览" action={<Button label="关闭" variant="ghost" onPress={onClose} />} />
        <EmptyState title="章节不存在或已被删除" />
      </Screen>
    );
  }

  const renderTraceItem = ({ item }: { item: ContextTraceItem }) => {
    const Icon = KIND_ICON[item.kind];
    return (
      <Card style={styles.traceCard}>
        <View style={styles.traceRow}>
          <View style={[styles.traceIconWrap, { backgroundColor: theme.colors.accentSoft }]}>
            <Icon size={16} color={theme.colors.accent} />
          </View>
          <View style={styles.traceInfo}>
            <Text style={[styles.traceTitle, { color: theme.colors.textPrimary }]} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={[styles.traceReason, { color: theme.colors.textSecondary }]} numberOfLines={1}>
              {item.reason}
            </Text>
          </View>
          <View style={styles.traceMeta}>
            <Text style={[styles.traceTokens, { color: theme.colors.textSecondary }]}>
              {item.estimatedTokens} tok
            </Text>
            {statusBadge(item)}
          </View>
        </View>
      </Card>
    );
  };

  const renderMessageItem = ({ item, index }: { item: ChatMessage; index: number }) => {
    const expanded = expandedMsg === index;
    const roleLabel = item.role === 'system' ? '系统' : item.role === 'user' ? '用户' : '助手';
    const roleColor = item.role === 'system' ? '#8b5cf6' : item.role === 'user' ? theme.colors.accent : '#f59e0b';

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
          <Text style={[styles.msgRole, { color: roleColor }]}>{roleLabel}</Text>
          <Text style={[styles.msgPreview, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {item.content.slice(0, 80)}
          </Text>
        </TouchableOpacity>
        {expanded ? (
          <Text style={[styles.msgContent, { color: theme.colors.textPrimary, borderColor: theme.colors.border }]}>
            {item.content}
          </Text>
        ) : null}
      </Card>
    );
  };

  return (
    <Screen>
      <Header
        title="上下文预览"
        subtitle={`${continuationPreview ? '续写 Planner+Writer · ' : ''}预估 ${estimatedInputTokens.toLocaleString()} tokens`}
        action={<Button label="关闭" variant="ghost" icon={X} onPress={onClose} compact />}
      />
      <View style={[styles.toggleRow, { borderBottomColor: theme.colors.border }]}>
        <Button
          label={showMessages ? '查看资料分配' : '查看实际请求'}
          variant="secondary"
          compact
          onPress={() => {
            setShowMessages(!showMessages);
            setExpandedMsg(null);
          }}
        />
        <Text style={[styles.tokenSummary, { color: theme.colors.textSecondary }]}>
          {showMessages
            ? `${messages.length} 条实际发送消息`
            : `${trace.length} 项资料分配`}
        </Text>
      </View>
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
          keyExtractor={(item) => `${item.kind}-${item.sourceId ?? 'none'}-${item.title}`}
          renderItem={renderTraceItem}
          contentContainerStyle={styles.listContent}
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
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
});
