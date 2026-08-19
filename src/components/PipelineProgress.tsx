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
  preparing?: boolean;
  continuationStage?: ContinuationPipelineStage;
}

export type ContinuationPipelineStage =
  | 'context'
  | 'writer'
  | 'auditing'
  | 'checker'
  | 'repair'
  // V5 physical + local nodes
  | 'draft_writer'
  | 'narrative_architect'
  | 'revision_writer'
  | 'adversarial_auditor'
  | 'final_reviser'
  | 'final_validate';

export const CONTINUATION_STAGE_LABELS: Record<
  ContinuationPipelineStage,
  string
> = {
  context: '正在准备续写上下文…',
  writer: '正在生成章节草稿…',
  auditing: '正在并行进行一致性审查与篇幅控制…',
  checker: '正在进行一致性检查…',
  repair: '正在修复冲突并生成终稿…',
  // V5
  draft_writer: '正在生成初稿 V1…',
  narrative_architect: '正在规划叙事架构 A1…',
  revision_writer: '正在扩写修订 V2…',
  adversarial_auditor: '正在审阅 V2 并生成润色任务…',
  final_reviser: '正在润色终稿 V3…',
  final_validate: '正在校验终稿…',
};

export const CONTINUATION_STAGE_PROGRESS: Record<
  ContinuationPipelineStage,
  number
> = {
  context: 10,
  writer: 30,
  auditing: 60,
  checker: 60,
  repair: 85,
  // V5
  draft_writer: 20,
  narrative_architect: 20,
  revision_writer: 45,
  adversarial_auditor: 65,
  final_reviser: 85,
  final_validate: 95,
};

const STAGE_LABELS: Record<PipelineStageName | 'idle', string> = {
  idle: '准备中...',
  draft: '草稿中...',
  // Phase 4 (§7.2): the unified qa stage replaces review/factCheck/audit for
  // compact Standard; legacy UI labels remain for historical topology.
  qa: '检查中...',
  review: '点评中...',
  factCheck: '事实检查中...',
  brief: '整理终稿 Brief 中...',
  proof: '打磨中...',
};

export const PipelineProgress: React.FC<PipelineProgressProps> = ({
  stage,
  startedAt,
  visible,
  queued = false,
  preparing = false,
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
          {preparing
            ? '正在整理上下文（不等待长期记忆）...'
            : queued
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
