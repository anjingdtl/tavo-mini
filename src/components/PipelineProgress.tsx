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
  // Durable continuation records keep these internal node ids; the live UI
  // projects them onto the same shared stage vocabulary as Outline.
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
  writer: '正在生成…',
  auditing: '正在检查…',
  checker: '正在检查…',
  repair: '正在修订…',
  draft_writer: '正在生成…',
  narrative_architect: '正在生成…',
  revision_writer: '正在修订…',
  adversarial_auditor: '正在检查…',
  final_reviser: '正在校验…',
  final_validate: '正在校验…',
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

// Phase 6 (§6.3): compact Standard user semantics —
// 准备上下文 / 生成 / 检查 / 修订 / 校验 / 保存. Kept out of the shared
// `PipelineStageName` union (which legacy exhaustive maps rely on); resolved
// here for the compact kernel stages only.
const COMPACT_STAGE_LABELS: Record<string, string> = {
  revision: '修订中...',
  finalValidate: '校验终稿中...',
  persist: '保存中...',
};

function stageLabel(stage: PipelineStageName | 'idle'): string {
  return STAGE_LABELS[stage] || COMPACT_STAGE_LABELS[stage] || String(stage);
}

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
            : stageLabel(stage)}
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
