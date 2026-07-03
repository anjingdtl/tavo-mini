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
}

const STAGE_LABELS: Record<PipelineStageName | 'idle', string> = {
  idle: '准备中...',
  draft: '草稿中...',
  review: '点评中...',
  factCheck: '事实检查中...',
  proof: '打磨中...',
};

export const PipelineProgress: React.FC<PipelineProgressProps> = ({ stage, startedAt, visible }) => {
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
