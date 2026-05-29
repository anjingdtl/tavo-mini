import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { mergeChapterGenerationResult } from '../services/chapterGeneration';
import * as db from '../services/database';
import type { PipelineStageResult } from '../types/pipeline';

type ResultRouteProp = RouteProp<{ PipelineResult: { taskId: string } }, 'PipelineResult'>;

export const PipelineResultScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const navigation = useNavigation();
  const route = useRoute<ResultRouteProp>();
  const { tasks, resolveTask } = usePipelineTaskStore();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const task = tasks.find((t) => t.id === route.params.taskId);
  if (!task) {
    return (
      <Screen>
        <Header title="流水线结果" action={<Button label="返回" variant="ghost" onPress={() => navigation.goBack()} />} />
        <Text style={{ padding: spacing.lg, color: theme.colors.textSecondary }}>任务不存在或已被清除。</Text>
      </Screen>
    );
  }

  const totalTokens = task.stageResults.reduce(
    (sum, r) => sum + (r.tokens?.total || 0),
    0,
  );
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
      const merged = mergeChapterGenerationResult(chapter, task.finalText);
      await db.updateChapter(chapter.id, merged);
      resolveTask(task.id, 'accept');
      Alert.alert('已采纳', '文本已合并到章节并保存。');
      navigation.goBack();
    } catch (error: any) {
      Alert.alert('采纳失败', error.message);
    }
  };

  const handleReject = () => {
    resolveTask(task.id, 'reject');
    navigation.goBack();
  };

  const renderStageCard = (stage: PipelineStageResult) => {
    const isExpanded = expanded.has(stage.stage);
    const textLength = stage.text?.length || 0;
    const isJson = stage.stage === 'review' || stage.stage === 'factCheck';
    const stageLabel =
      stage.stage === 'draft'
        ? '初稿'
        : stage.stage === 'review'
          ? '审阅'
          : stage.stage === 'factCheck'
            ? '核查'
            : '终稿';

    return (
      <View key={stage.stage} style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <Button
          label={`${stageLabel} ${stage.status === 'success' ? '✅' : '⚠️'} (${textLength} 字)`}
          variant="ghost"
          onPress={() => toggleExpanded(stage.stage)}
        />
        {isExpanded && (
          <Text
            style={[styles.stageText, { color: theme.colors.textPrimary }]}
            selectable
          >
            {isJson ? JSON.stringify(stage.text, null, 2) : stage.text}
          </Text>
        )}
      </View>
    );
  };

  return (
    <Screen>
      <Header
        title="流水线结果"
        action={<Button label="返回" variant="ghost" onPress={() => navigation.goBack()} />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.summary, { color: theme.colors.textSecondary }]}>
          {task.status === 'completed' ? '✅ 已完成' : '❌ 异常终止'} · 耗时 {durationText} · {totalTokens.toLocaleString()} tokens
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
  card: { borderRadius: 8, padding: spacing.md },
  stageText: { fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md, marginTop: spacing.lg },
});
