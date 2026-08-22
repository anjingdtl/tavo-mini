import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, Card, spacing } from './ui';
import { useThemeStore } from '../store/themeStore';

export type UnifiedPipelineStageId =
  | 'freeze'
  | 'draft'
  | 'qa'
  | 'revision'
  | 'finalValidate'
  | 'persist'
  | 'postWriting'
  | 'memory';

export type UnifiedPipelineStageStatus =
  | 'success'
  | 'skipped'
  | 'failed'
  | 'pending'
  | 'running';

export interface UnifiedPipelineStageItem {
  id: UnifiedPipelineStageId;
  status: UnifiedPipelineStageStatus;
  detail?: string;
  meta?: string;
  body?: string;
}

export const UNIFIED_PIPELINE_STAGE_LABELS: Record<
  UnifiedPipelineStageId,
  string
> = {
  freeze: 'Freeze',
  draft: '生成',
  qa: '检查',
  revision: '修订',
  finalValidate: '校验',
  persist: '保存',
  postWriting: 'PostWriting',
  memory: 'ONE Memory',
};

const STATUS_LABELS: Record<UnifiedPipelineStageStatus, string> = {
  success: '成功',
  skipped: '正式跳过',
  failed: '失败',
  pending: '等待',
  running: '进行中',
};

export interface UnifiedPipelineStageViewProps {
  profile: 'standard' | 'one_shot';
  items: UnifiedPipelineStageItem[];
  summary?: string;
  /** Use single-line stage strips on result pages so the final action stays visible. */
  compact?: boolean;
  testID?: string;
}

/**
 * One result surface for every current Writing Kernel scenario.
 *
 * The execution profile changes a stage's status (for example, formal skip),
 * never the visual topology. Legacy historical tasks intentionally keep their
 * old audit cards in their callers and do not enter this view.
 */
export const UnifiedPipelineStageView: React.FC<
  UnifiedPipelineStageViewProps
> = ({
  profile,
  items,
  summary,
  compact = true,
  testID = 'unified-pipeline-stage-view',
}) => {
  const { theme } = useThemeStore();
  const [expanded, setExpanded] = useState<Set<UnifiedPipelineStageId>>(
    new Set(),
  );

  const toggle = (id: UnifiedPipelineStageId) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const statusColor = (status: UnifiedPipelineStageStatus) => {
    if (status === 'failed') return theme.colors.danger;
    if (status === 'skipped' || status === 'pending') {
      return theme.colors.textMuted;
    }
    if (status === 'running') return theme.colors.warning;
    return theme.colors.accent;
  };

  return (
    <View testID={testID}>
      <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
        共享 Writing Kernel · {profile === 'one_shot' ? 'One-Shot' : 'Standard'}
      </Text>
      <Text
        numberOfLines={compact ? 1 : undefined}
        style={[styles.dag, compact && styles.compactDag, { color: theme.colors.textSecondary }]}
      >
        Freeze → 生成 → 检查 → 修订 → 校验 → 保存 → PostWriting → ONE Memory
      </Text>
      {summary ? (
        <Text
          numberOfLines={compact ? 1 : undefined}
          style={[styles.summary, compact && styles.compactSummary, { color: theme.colors.textSecondary }]}
        >
          {summary}
        </Text>
      ) : null}
      {items.map(item => {
        const label = UNIFIED_PIPELINE_STAGE_LABELS[item.id];
        const statusLabel = STATUS_LABELS[item.status];
        const isExpanded = expanded.has(item.id);
        return (
          <Card
            key={item.id}
            testID={`${testID}-${item.id}`}
            style={compact ? styles.compactCard : styles.card}
          >
            <Button
              compact={compact}
              dense={compact}
              label={`${label} · ${statusLabel}`}
              variant="ghost"
              onPress={() => toggle(item.id)}
            />
            {!compact && item.meta ? (
              <Text style={[styles.meta, { color: statusColor(item.status) }]}>
                {item.meta}
              </Text>
            ) : null}
            {!compact && item.detail ? (
              <Text style={[styles.detail, { color: theme.colors.textSecondary }]}>
                {item.detail}
              </Text>
            ) : null}
            {isExpanded ? (
              <>
                {compact && item.meta ? (
                  <Text style={[styles.compactMeta, { color: statusColor(item.status) }]}>
                    {item.meta}
                  </Text>
                ) : null}
                {compact && item.detail ? (
                  <Text style={[styles.detail, { color: theme.colors.textSecondary }]}>
                    {item.detail}
                  </Text>
                ) : null}
                {item.body ? (
                  <Text
                    selectable
                    style={[styles.body, { color: theme.colors.textPrimary }]}
                  >
                    {item.body}
                  </Text>
                ) : null}
              </>
            ) : null}
          </Card>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '800', marginBottom: spacing.xs },
  dag: { fontSize: 12, lineHeight: 18, marginBottom: spacing.xs },
  summary: { fontSize: 13, lineHeight: 19, marginBottom: spacing.sm },
  compactDag: { fontSize: 10, lineHeight: 14, marginBottom: 2 },
  compactSummary: { fontSize: 11, lineHeight: 14, marginBottom: 4 },
  card: { marginBottom: spacing.sm, gap: spacing.xs },
  compactCard: {
    padding: 2,
    marginBottom: 2,
    borderRadius: 7,
    gap: 0,
  },
  compactMeta: { fontSize: 10, lineHeight: 13, marginTop: 2 },
  meta: { fontSize: 12, lineHeight: 18 },
  detail: { fontSize: 12, lineHeight: 18 },
  body: { fontSize: 13, lineHeight: 20, marginTop: spacing.xs },
});
