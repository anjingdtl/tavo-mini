import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Button, Card, EmptyState, Header, LoadingState, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { getDrafts, removeDraft, clearDrafts } from '../services/draftService';
import { createRevision } from '../services/revisionService';
import * as db from '../services/database';
import { canStartAdopt } from '../utils/draftAdoptGuard';
import type { GenerationDraft, DraftSource } from '../types/draft';

interface Props {
  targetType: 'chapter' | 'freeform';
  targetId: number;
  projectId: number;
  onClose: () => void;
}

const SOURCE_LABELS: Record<DraftSource, string> = {
  pipeline: '流水线',
  continuation: '续写',
  manual: '手动',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  // 10.9: 校验 Invalid Date，避免渲染"NaN-NaN-NaN"
  if (isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const DraftPreviewScreen: React.FC<Props> = ({ targetType, targetId, projectId, onClose }) => {
  const { theme } = useThemeStore();
  const [drafts, setDrafts] = useState<GenerationDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [adopting, setAdopting] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const adoptingRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!isMountedRef.current) return;
    setLoading(true);
    try {
      const list = await getDrafts(targetType, targetId);
      if (!isMountedRef.current) return;
      setDrafts(list);
    } catch (e: any) {
      if (isMountedRef.current) setErrorMessage(e?.message || '加载草稿失败');
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [targetType, targetId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!errorMessage) return;
    const t = setTimeout(() => {
      if (isMountedRef.current) setErrorMessage(null);
    }, 4000);
    return () => clearTimeout(t);
  }, [errorMessage]);

  const toggleExpand = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runAdopt = useCallback(async (draft: GenerationDraft) => {
    if (!canStartAdopt(adoptingRef.current, draft.id)) return;
    if (!isMountedRef.current) return;
    adoptingRef.current = draft.id;
    setAdopting(draft.id);
    try {
      const currentContent =
        targetType === 'chapter'
          ? (await db.getChapterById(targetId))?.content ?? ''
          : await db.getFreeformDocument(projectId);

      await createRevision({
        projectId,
        targetType,
        targetId,
        title: `采纳前快照 - ${SOURCE_LABELS[draft.source]}`,
        content: currentContent,
        source: 'before_pipeline_accept',
        sourceRef: `draft-${draft.id}`,
      });

      if (targetType === 'chapter') {
        await db.updateChapter(targetId, { content: draft.content } as any);
      } else {
        await db.setFreeformDocument(projectId, draft.content);
      }

      await removeDraft(draft.id);
      await load();
    } catch (e: any) {
      if (isMountedRef.current) setErrorMessage(e?.message || '采纳失败');
    } finally {
      adoptingRef.current = null;
      if (isMountedRef.current) setAdopting(null);
    }
  }, [targetType, targetId, projectId, load]);

  const handleAdopt = useCallback((draft: GenerationDraft) => {
    Alert.alert('采纳确认', '采纳后将覆盖当前内容（采纳前会自动保存版本快照），确定采纳？', [
      { text: '取消', style: 'cancel' },
      { text: '采纳', style: 'destructive', onPress: () => { runAdopt(draft); } },
    ]);
  }, [runAdopt]);

  const runDelete = useCallback(async (draft: GenerationDraft) => {
    if (!isMountedRef.current) return;
    try {
      await removeDraft(draft.id);
      await load();
    } catch (e: any) {
      if (isMountedRef.current) setErrorMessage(e?.message || '删除失败');
    }
  }, [load]);

  const handleDelete = useCallback((draft: GenerationDraft) => {
    Alert.alert('删除确认', '确定删除此草稿？', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => { runDelete(draft); } },
    ]);
  }, [runDelete]);

  const handleAdoptLatest = useCallback(() => {
    if (drafts.length === 0) return;
    const latest = drafts[drafts.length - 1];
    Alert.alert('采纳最近草稿', '将采纳最近一份草稿并覆盖当前内容，确定继续？', [
      { text: '取消', style: 'cancel' },
      { text: '采纳', style: 'destructive', onPress: () => { runAdopt(latest); } },
    ]);
  }, [drafts, runAdopt]);

  const runClear = useCallback(async () => {
    if (!isMountedRef.current) return;
    try {
      await clearDrafts(targetType, targetId);
      await load();
    } catch (e: any) {
      if (isMountedRef.current) setErrorMessage(e?.message || '清空失败');
    }
  }, [targetType, targetId, load]);

  const handleClearAll = useCallback(() => {
    Alert.alert('清空确认', '确定清空所有草稿？此操作不可恢复。', [
      { text: '取消', style: 'cancel' },
      { text: '清空', style: 'destructive', onPress: () => { runClear(); } },
    ]);
  }, [runClear]);

  const renderItem = ({ item }: { item: GenerationDraft }) => {
    const isExpanded = expandedIds.has(item.id);
    const isAdopting = adopting === item.id;
    const previewText = item.content.replace(/\n/g, ' ').trim();
    const displayContent = isExpanded ? item.content : previewText.length > 200 ? previewText.slice(0, 200) + '…' : previewText;

    return (
      <Card>
        <View style={styles.row}>
          <Text style={[styles.source, { color: theme.colors.accent }]}>{SOURCE_LABELS[item.source]}</Text>
          <Text style={[styles.time, { color: theme.colors.textSecondary }]}>{formatTime(item.createdAt)}</Text>
        </View>
        <Text style={[styles.tokenCount, { color: theme.colors.textMuted }]}>{item.tokenCount.toLocaleString()} tokens</Text>
        <TouchableOpacity onPress={() => toggleExpand(item.id)} activeOpacity={0.7}>
          <Text style={[styles.preview, { color: theme.colors.textSecondary }]} numberOfLines={isExpanded ? undefined : 4}>
            {displayContent}
          </Text>
          {!isExpanded && previewText.length > 200 && (
            <Text style={[styles.expandHint, { color: theme.colors.accent }]}>展开全文</Text>
          )}
          {isExpanded && (
            <Text style={[styles.expandHint, { color: theme.colors.accent }]}>收起</Text>
          )}
        </TouchableOpacity>
        <View style={styles.actionRow}>
          <Button
            label="采纳"
            variant="primary"
            compact
            onPress={() => handleAdopt(item)}
            disabled={adopting !== null}
          />
          <Button
            label="删除"
            variant="danger"
            compact
            onPress={() => handleDelete(item)}
            disabled={adopting !== null}
          />
          {isAdopting && <Text style={[styles.statusHint, { color: theme.colors.textMuted }]}>采纳中…</Text>}
        </View>
      </Card>
    );
  };

  return (
    <Screen>
      <Header
        title="草稿预览"
        subtitle={targetType === 'chapter' ? '章节' : '自由文档'}
        action={
          <View style={styles.headerActions}>
            {drafts.length > 0 && (
              <>
                <Button label="全部采纳" variant="ghost" compact onPress={handleAdoptLatest} disabled={adopting !== null} />
                <Button label="清空草稿" variant="ghost" compact onPress={handleClearAll} disabled={adopting !== null} />
              </>
            )}
            <Button label="关闭" variant="ghost" compact onPress={onClose} />
          </View>
        }
      />
      {errorMessage ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="关闭错误"
          onPress={() => setErrorMessage(null)}
          style={[styles.errorBar, { backgroundColor: theme.colors.danger + '22', borderColor: theme.colors.danger }]}
        >
          <Text style={[styles.errorText, { color: theme.colors.danger }]} numberOfLines={2}>
            {errorMessage}
          </Text>
        </TouchableOpacity>
      ) : null}
      {loading ? (
        <LoadingState />
      ) : drafts.length === 0 ? (
        <EmptyState title="暂无草稿" description="AI 生成的内容会暂存为草稿" />
      ) : (
        <FlatList
          data={drafts}
          keyExtractor={item => String(item.id)}
          contentContainerStyle={styles.list}
          renderItem={renderItem}
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.lg },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  source: { fontSize: 13, fontWeight: '700' },
  time: { fontSize: 12 },
  tokenCount: { fontSize: 12, marginTop: spacing.xs },
  preview: { fontSize: 13, lineHeight: 18, marginTop: spacing.sm },
  expandHint: { fontSize: 12, fontWeight: '700', marginTop: spacing.xs },
  actionRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, gap: spacing.sm },
  statusHint: { fontSize: 12 },
  headerActions: { flexDirection: 'row', gap: spacing.xs, alignItems: 'center' },
  errorBar: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
  },
});
