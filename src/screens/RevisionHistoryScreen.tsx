import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
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
import { getRevisions, restoreRevision } from '../services/revisionService';
import * as db from '../services/database';
import type { ContentRevision, RevisionSource } from '../types/revision';

interface Props {
  targetType: 'chapter' | 'freeform';
  targetId: number;
  projectId: number;
  onClose: () => void;
}

const SOURCE_LABELS: Record<RevisionSource, string> = {
  manual_checkpoint: '手动保存',
  before_clear: '清空前',
  before_ai_replace: 'AI替换前',
  before_pipeline_accept: '流水线采纳前',
  before_restore: '恢复前',
  before_batch_replace: '批量替换前',
  before_import_replace: '导入替换前',
  before_targeted_revision: '精准修订前',
  before_whole_chapter_rewrite: '整章重写前',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function wordCount(text: string): number {
  return text.replace(/\s/g, '').length;
}

function preview(text: string): string {
  const stripped = text.replace(/\n/g, ' ').trim();
  return stripped.length > 100 ? stripped.slice(0, 100) + '…' : stripped;
}

export const RevisionHistoryScreen: React.FC<Props> = ({
  targetType,
  targetId,
  projectId,
  onClose,
}) => {
  const { theme } = useThemeStore();
  const [revisions, setRevisions] = useState<ContentRevision[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<number | null>(null);
  // 10.7: 守卫 restore 异步流程，避免组件卸载后 setState
  const isMountedRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getRevisions(targetType, targetId);
      if (!isMountedRef.current) return;
      setRevisions(list);
    } catch (e: any) {
      if (!isMountedRef.current) return;
      Toast.show({
        type: 'error',
        text1: '加载历史版本失败',
        text2: e?.message,
      });
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [targetType, targetId]);

  useEffect(() => {
    load();
  }, [load]);

  // 10.7: cleanup 标记卸载，load / handleRestore 后续 setState 受守卫
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleRestore = (revision: ContentRevision) => {
    Alert.alert(
      '恢复确认',
      '确定要将内容恢复到此版本吗？当前内容会先自动保存为历史版本。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '恢复',
          style: 'destructive',
          onPress: async () => {
            setRestoring(revision.id);
            try {
              const updateFn =
                targetType === 'chapter'
                  ? (content: string) =>
                      db.updateChapter(targetId, { content } as any)
                  : (content: string) =>
                      db.setFreeformDocument(projectId, content);
              // Provide the current content so restoreRevision can snapshot it
              // (not the restore target) for an accurate "before_restore" entry.
              const getCurrentContent =
                targetType === 'chapter'
                  ? async () =>
                      (await db.getChapterById(targetId))?.content || ''
                  : async () => db.getFreeformDocument(projectId);
              await restoreRevision(revision, updateFn, getCurrentContent);
              // 10.7: 卸载后不再 setState，避免 React 警告与潜在内存泄漏
              if (!isMountedRef.current) return;
              await load();
            } catch (e: any) {
              if (!isMountedRef.current) return;
              Alert.alert('恢复失败', e?.message || '未知错误');
            } finally {
              if (isMountedRef.current) setRestoring(null);
            }
          },
        },
      ],
    );
  };

  const renderItem = ({ item }: { item: ContentRevision }) => {
    const isRestoring = restoring === item.id;
    return (
      <Card>
        <View style={styles.row}>
          <Text style={[styles.time, { color: theme.colors.textSecondary }]}>
            {formatTime(item.createdAt)}
          </Text>
          <Text style={[styles.source, { color: theme.colors.accent }]}>
            {SOURCE_LABELS[item.source]}
          </Text>
        </View>
        <Text style={[styles.wordCount, { color: theme.colors.textMuted }]}>
          {wordCount(item.content)} 字
        </Text>
        <Text
          style={[styles.preview, { color: theme.colors.textSecondary }]}
          numberOfLines={3}
        >
          {preview(item.content)}
        </Text>
        <View style={styles.actionRow}>
          <Button
            label="恢复"
            variant="secondary"
            compact
            onPress={() => handleRestore(item)}
            disabled={restoring !== null}
          />
          {isRestoring && (
            <Text style={[styles.restoring, { color: theme.colors.textMuted }]}>
              恢复中…
            </Text>
          )}
        </View>
      </Card>
    );
  };

  return (
    <Screen>
      <Header
        title="版本历史"
        subtitle={targetType === 'chapter' ? '章节' : '自由文档'}
        action={
          <Button label="关闭" variant="ghost" compact onPress={onClose} />
        }
      />
      {loading ? (
        <LoadingState />
      ) : revisions.length === 0 ? (
        <EmptyState
          title="暂无历史版本"
          description="编辑内容时会自动保存历史版本"
        />
      ) : (
        <FlatList
          data={revisions}
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
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  time: { fontSize: 13, fontWeight: '600' },
  source: { fontSize: 12, fontWeight: '700' },
  wordCount: { fontSize: 12, marginTop: spacing.xs },
  preview: { fontSize: 13, lineHeight: 18, marginTop: spacing.sm },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  restoring: { fontSize: 12 },
});
