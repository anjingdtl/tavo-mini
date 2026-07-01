import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { spacing } from './ui';
import { useThemeStore } from '../store/themeStore';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import type { PipelineStageName } from '../types/pipeline';

export interface PipelineProgressProps {
  stage: PipelineStageName | 'idle';
  startedAt: number;
  visible: boolean;
  /** V2.2.0：可选 taskId。指定时实时显示该 task 的流式草稿预览文本。 */
  taskId?: string;
}

const STAGE_LABELS: Record<PipelineStageName | 'idle', string> = {
  idle: '准备中...',
  draft: '草稿中...',
  review: '点评中...',
  factCheck: '事实检查中...',
  proof: '打磨中...',
};

const PREVIEW_MAX_CHARS = 2000; // 草稿预览最多显示字符数（避免大对象卡 UI）

export const PipelineProgress: React.FC<PipelineProgressProps> = ({ stage, startedAt, visible, taskId }) => {
  const { theme } = useThemeStore();
  const [elapsed, setElapsed] = useState(0);
  // V2.2.0：从 store 订阅流式草稿预览（只在 draft 阶段且指定 taskId 时有用）
  const draftPreview = usePipelineDraftPreview(taskId);

  useEffect(() => {
    if (!visible) return;
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [visible, startedAt]);

  if (!visible) return null;

  const showPreview = stage === 'draft' && Boolean(taskId) && draftPreview.length > 0;
  const previewSlice = draftPreview.length > PREVIEW_MAX_CHARS
    ? `…${draftPreview.slice(-PREVIEW_MAX_CHARS)}`
    : draftPreview;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.border }]}>
      <View style={styles.row}>
        <ActivityIndicator size="small" color={theme.colors.accent} />
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
          {STAGE_LABELS[stage] || stage}
        </Text>
        <Text style={[styles.timer, { color: theme.colors.textMuted }]}>
          {elapsed}s
        </Text>
      </View>
      {showPreview ? (
        <ScrollView
          style={styles.previewScroll}
          contentContainerStyle={styles.previewContent}
          nestedScrollEnabled
        >
          <Text style={[styles.previewText, { color: theme.colors.textPrimary }]} numberOfLines={12}>
            {previewSlice}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
};

/** 订阅 store.draftPreviews[taskId]，store 内容更新时组件重渲染。 */
function usePipelineDraftPreview(taskId: string | undefined): string {
  const [text, setText] = useState(() =>
    taskId ? usePipelineTaskStore.getState().draftPreviews[taskId] || '' : '',
  );
  useEffect(() => {
    if (!taskId) {
      setText('');
      return undefined;
    }
    const sync = () => setText(usePipelineTaskStore.getState().draftPreviews[taskId] || '');
    // zustand v5：subscribe(selector, callback)
    const unsubSelector = usePipelineTaskStore.subscribe(
      (s) => s.draftPreviews?.[taskId],
      sync,
    );
    return unsubSelector;
  }, [taskId]);
  return text;
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
  },
  timer: {
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 'auto',
  },
  previewScroll: {
    marginTop: spacing.xs,
    maxHeight: 120,
  },
  previewContent: {
    paddingVertical: spacing.xs,
  },
  previewText: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: 'monospace',
  },
});
