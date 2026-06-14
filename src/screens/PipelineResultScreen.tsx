import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import * as db from '../services/database';
import type { PipelineStageResult } from '../types/pipeline';

type ResultRouteProp = RouteProp<{ PipelineResult: { taskId: string } }, 'PipelineResult'>;

const STAGE_LABELS: Record<PipelineStageResult['stage'], string> = {
  draft: '初稿',
  review: '审阅/评估',
  factCheck: '事实核查',
  proof: '终稿',
};

const STATUS_LABELS: Record<PipelineStageResult['status'], string> = {
  success: '成功',
  failed: '失败',
  skipped: '已跳过',
};

function formatStageText(stage: PipelineStageResult): string {
  if (!stage.text) return stage.status === 'skipped' ? '该阶段已跳过。' : '';
  if (stage.stage !== 'review' && stage.stage !== 'factCheck') return stage.text;
  try {
    return JSON.stringify(JSON.parse(stage.text), null, 2);
  } catch {
    return stage.text;
  }
}

export function summarizePipelineTokens(stageResults: PipelineStageResult[]): { inputTokens: number; totalTokens: number } {
  return stageResults.reduce(
    (summary, stage) => ({
      inputTokens: summary.inputTokens + (stage.tokens?.input || 0),
      totalTokens: summary.totalTokens + (stage.tokens?.total || 0),
    }),
    { inputTokens: 0, totalTokens: 0 },
  );
}

export interface PipelineResultScreenProps {
  taskId?: string;
  onClose?: () => void;
  onAdopted?: (text: string) => void;
}

export const PipelineResultScreen: React.FC<PipelineResultScreenProps> = ({ taskId: propTaskId, onClose, onAdopted }) => {
  const { theme } = useThemeStore();
  const navigation = useNavigation();
  let routeTaskId: string | undefined;
  try {
    const route = useRoute<ResultRouteProp>();
    routeTaskId = route.params?.taskId;
  } catch {
    // Not inside a navigation route (Modal mode)
  }
  const taskId = propTaskId ?? routeTaskId;
  const { tasks, resolveTask } = usePipelineTaskStore();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const handleClose = onClose ?? (() => navigation.goBack());

  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return (
      <Screen>
        <Header title="流水线结果" action={<Button label="返回" variant="ghost" onPress={handleClose} />} />
        <Text style={{ padding: spacing.lg, color: theme.colors.textSecondary }}>任务不存在或已被清除。</Text>
      </Screen>
    );
  }

  const { inputTokens, totalTokens } = summarizePipelineTokens(task.stageResults);
  const skippedCount = task.stageResults.filter((stage) => stage.status === 'skipped').length;
  const duration = task.updatedAt - task.createdAt;
  const durationText = duration > 60000
    ? `${Math.floor(duration / 60000)}m ${Math.round((duration % 60000) / 1000)}s`
    : `${Math.round(duration / 1000)}s`;

  const toggleExpanded = (stage: string) => {
    const next = new Set(expanded);
    if (next.has(stage)) next.delete(stage);
    else next.add(stage);
    setExpanded(next);
  };

  const handleAccept = async () => {
    if (!task.finalText || task.targetType !== 'chapter') {
      Alert.alert('无法采纳', '该任务不支持直接采纳，请手动复制文本。');
      return;
    }
    try {
      const chapter = await db.getChapterById(task.targetId);
      if (!chapter) {
        Alert.alert('章节不存在');
        return;
      }
      await db.updateChapter(chapter.id, { content: task.finalText });
      resolveTask(task.id, 'accept');
      Alert.alert('已采纳', '流水线正文已覆盖到章节并保存。');
      onAdopted?.(task.finalText);
      handleClose();
    } catch (error: any) {
      Alert.alert('采纳失败', error.message);
    }
  };

  const handleReject = () => {
    resolveTask(task.id, 'reject');
    handleClose();
  };

  const renderStageCard = (stage: PipelineStageResult) => {
    const isExpanded = expanded.has(stage.stage);
    const textLength = stage.text?.length || 0;
    const statusColor = stage.status === 'failed'
      ? theme.colors.danger
      : stage.status === 'skipped'
        ? theme.colors.textMuted
        : theme.colors.accent;

    return (
      <View key={stage.stage} style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <Button
          label={`${STAGE_LABELS[stage.stage]} · ${STATUS_LABELS[stage.status]} (${textLength} 字)`}
          variant="ghost"
          onPress={() => toggleExpanded(stage.stage)}
        />
        <Text style={[styles.stageMeta, { color: statusColor }]}>
          耗时 {Math.round(stage.durationMs / 1000)}s
          {stage.tokens ? ` · ${stage.tokens.total.toLocaleString()} tokens` : ''}
          {stage.error ? ` · ${stage.error}` : ''}
        </Text>
        {isExpanded && (
          <Text
            style={[styles.stageText, { color: theme.colors.textPrimary }]}
            selectable
          >
            {formatStageText(stage)}
          </Text>
        )}
      </View>
    );
  };

  return (
    <Screen>
      <Header
        title="流水线结果"
        action={<Button label="返回" variant="ghost" onPress={handleClose} />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.summary, { color: theme.colors.textSecondary }]}>
          {task.status === 'completed' ? '已完成' : '异常终止'} · 耗时 {durationText} · {totalTokens.toLocaleString()} tokens · 跳过 {skippedCount} 阶段
        </Text>
        <Text style={[styles.summary, { color: theme.colors.textSecondary }]}>
          本次输入上下文 tokens：{inputTokens.toLocaleString()}
        </Text>
        {task.stageResults.map(renderStageCard)}
        {task.finalText && (
          <View style={styles.actions}>
            <Button label="放弃" variant="ghost" onPress={handleReject} />
            <Button label="采纳" onPress={handleAccept} />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: 120 },
  summary: { fontSize: 13, fontWeight: '700' },
  card: { borderRadius: 8, padding: spacing.md, gap: spacing.sm },
  stageMeta: { fontSize: 12, fontWeight: '700' },
  stageText: { fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md, marginTop: spacing.lg },
});
