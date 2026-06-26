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
  character: Users,
  note: StickyNote,
  worldbook: Globe,
  instruction: MessageSquare,
};

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

  const loadContext = useCallback(async () => {
    setLoading(true);
    try {
      const chapter = await db.getChapterById(chapterId);
      if (!chapter) {
        setNotFound(true);
        return;
      }
      setNotFound(false);
      const config = await db.getContextConfig();
      const presets = await db.getPresetsByProject(chapter.project_id);
      const result = await buildContext(chapter, config, chapter.project_id, presets[0]);
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
        <EmptyState label="章节不存在或已被删除" />
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
        subtitle={`预估 ${estimatedInputTokens.toLocaleString()} tokens`}
        action={<Button label="关闭" variant="ghost" icon={X} onPress={onClose} compact />}
      />
      <View style={[styles.toggleRow, { borderBottomColor: theme.colors.border }]}>
        <Button
          label={showMessages ? '查看追踪' : '查看消息'}
          variant="secondary"
          compact
          onPress={() => {
            setShowMessages(!showMessages);
            setExpandedMsg(null);
          }}
        />
        <Text style={[styles.tokenSummary, { color: theme.colors.textSecondary }]}>
          {showMessages
            ? `${messages.length} 条消息`
            : `${trace.length} 项追踪`}
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
