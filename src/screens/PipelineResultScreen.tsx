import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import {
  CommonActions,
  NavigationRouteContext,
  useNavigation,
  type NavigationProp,
  type ParamListBase,
  type RouteProp,
} from '@react-navigation/native';
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

export function closePipelineResult(
  navigation: Pick<NavigationProp<ParamListBase>, 'dispatch' | 'getState' | 'goBack'>,
  onClose?: () => void,
): void {
  if (onClose) {
    onClose();
    return;
  }

  const state = navigation.getState();
  if (state.index > 0) {
    navigation.goBack();
    return;
  }

  const fallbackRoute = state.routeNames.includes('SettingsMain')
    ? 'SettingsMain'
    : state.routeNames.includes('EditorMain')
      ? 'EditorMain'
      : null;
  if (fallbackRoute) {
    navigation.dispatch(CommonActions.reset({
      index: 0,
      routes: [{ name: fallbackRoute }],
    }));
    return;
  }

  navigation.goBack();
}

export const PipelineResultScreen: React.FC<PipelineResultScreenProps> = ({ taskId: propTaskId, onClose, onAdopted }) => {
  const { theme } = useThemeStore();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  // Hook 必须在顶层调用：直接读取 NavigationRouteContext，避免 useRoute 在
  // 非导航上下文（Modal 模式）中抛错。用可选链安全访问 params。
  const route = useContext(NavigationRouteContext) as ResultRouteProp | undefined;
  const routeTaskId: string | undefined = route?.params?.taskId;
  const taskId = propTaskId ?? routeTaskId;
  const { tasks, resolveTask } = usePipelineTaskStore();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 10.2: 采纳进行中状态，disable 采纳/放弃按钮防止重复点击触发多次 updateChapter
  const [adopting, setAdopting] = useState(false);
  // 标记是否已被 handleAccept 标记为 accept，避免 unmount cleanup 的
  // setTimeout 与 handleAccept 的 resolveTask('accept') 竞态重复 resolve。
  const acceptedRef = useRef(false);

  const handleClose = useCallback(
    () => closePipelineResult(navigation, onClose),
    [navigation, onClose],
  );

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      handleClose();
      return true;
    });
    return () => subscription.remove();
  }, [handleClose]);

  const task = tasks.find((t) => t.id === taskId);

  // Mark the task as resolved when the result screen is dismissed without an
  // explicit accept/reject. Otherwise the ChapterEditor's pipeline
  // subscription would re-open this same modal every time the user enters
  // the chapter editor for the same chapter. We capture the latest task
  // snapshot in a ref so the unmount-time check does not need a fresh
  // `getState` call (which would race with cleanup elsewhere in the stack).
  const taskRef = useRef(task);
  taskRef.current = task;
  useEffect(() => {
    return () => {
      setTimeout(() => {
        const current = taskRef.current;
        // 已 accept 则不再 reject，避免与 handleAccept 竞态
        if (acceptedRef.current) return;
        if (taskId && current && current.resolvedAt === null) {
          // Phase9-BUG#20: cleanup 兜底。resolveTask 返回 void（内部 DB 调用已
          // .catch 静默吞错），此处用 try-catch 做最后兜底，避免 cleanup 抛错中断。
          try {
            resolveTask(taskId, 'reject');
          } catch {
            // 静默兜底，cleanup 不应抛错
          }
        }
      }, 0);
    };
  }, [taskId, resolveTask]);

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
    // 10.2: 防止按钮被重复点击触发多次 updateChapter
    if (adopting) return;
    if (!task.finalText || task.targetType !== 'chapter') {
      Alert.alert('无法采纳', '该任务不支持直接采纳，请手动复制文本。');
      return;
    }
    setAdopting(true);
    try {
      const chapter = await db.getChapterById(task.targetId);
      if (!chapter) {
        Alert.alert('章节不存在');
        return;
      }
      await db.updateChapter(chapter.id, { content: task.finalText });
      resolveTask(task.id, 'accept');
      acceptedRef.current = true; // 标记已 accept，阻止 unmount cleanup 重复 resolve
      Alert.alert('已采纳', '流水线正文已覆盖到章节并保存。');
      onAdopted?.(task.finalText);
      handleClose();
    } catch (error: any) {
      Alert.alert('采纳失败', error.message);
      setAdopting(false);
    }
  };

  const handleReject = () => {
    // 10.2: 采纳进行中时禁止 reject，避免竞态
    if (adopting) return;
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
            <Button label="放弃" variant="ghost" onPress={handleReject} disabled={adopting} />
            <Button label={adopting ? '采纳中…' : '采纳'} onPress={handleAccept} disabled={adopting} />
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
