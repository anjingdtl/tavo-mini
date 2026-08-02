import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { spacing } from './ui';
import { useThemeStore } from '../store/themeStore';
import type { PipelineStageName } from '../types/pipeline';

export interface PipelineProgressProps {
  stage: PipelineStageName | 'idle';
  startedAt: number;
  visible: boolean;
  taskId?: string;
  queued?: boolean;
  continuationStage?: ContinuationPipelineStage;
}

export type ContinuationPipelineStage =
  | 'context'
  | 'writer'
  | 'checker'
  | 'repair';

export const CONTINUATION_STAGE_LABELS: Record<
  ContinuationPipelineStage,
  string
> = {
  context: '正在准备续写上下文…',
  writer: '正在生成章节草稿…',
  checker: '正在进行一致性检查…',
  repair: '正在修复冲突并生成终稿…',
};

export const CONTINUATION_STAGE_PROGRESS: Record<
  ContinuationPipelineStage,
  number
> = {
  context: 10,
  writer: 30,
  checker: 60,
  repair: 85,
};

const STAGE_LABELS: Record<PipelineStageName | 'idle', string> = {
  idle: '准备中...',
  draft: '草稿中...',
  review: '点评中...',
  factCheck: '事实检查中...',
  proof: '打磨中...',
};

export const PipelineProgress: React.FC<PipelineProgressProps> = ({
  stage,
  startedAt,
  visible,
  queued = false,
  continuationStage,
}) => {
  const { theme } = useThemeStore();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!visible) return;
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [visible, startedAt]);

  if (!visible) return null;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surface,
          borderBottomColor: theme.colors.border,
        },
      ]}
    >
      <View style={styles.row}>
        <ActivityIndicator size="small" color={theme.colors.accent} />
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
          {queued
            ? '排队中，等待可用的模型请求槽位...'
            : continuationStage
              ? CONTINUATION_STAGE_LABELS[continuationStage]
            : STAGE_LABELS[stage] || stage}
        </Text>
        <Text style={[styles.timer, { color: theme.colors.textMuted }]}>
          {elapsed}s
        </Text>
      </View>
    </View>
  );
};

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
});
