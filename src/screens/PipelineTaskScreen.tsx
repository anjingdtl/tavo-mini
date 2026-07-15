import React, { useEffect } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import Toast from 'react-native-toast-message';
import { Button, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { useNavigation } from '@react-navigation/native';
import type { PipelineTask } from '../types/pipeline';
import { cancelPipeline } from '../services/pipelineRunner';

const ACTIVE_STATUSES = new Set([
  'idle',
  'queued',
  'drafting',
  'reviewing',
  'factChecking',
  'proofing',
]);

const STATUS_MARK: Record<string, string> = {
  idle: '等待',
  queued: '排队',
  drafting: '初稿',
  reviewing: '审阅',
  factChecking: '核查',
  proofing: '终审',
  completed: '完成',
  cancelled: '取消',
  failed: '失败',
};

const STATUS_LABEL: Record<string, string> = {
  idle: '等待中',
  queued: '排队中',
  drafting: '创作初稿',
  reviewing: '审阅/评估',
  factChecking: '事实核查',
  proofing: '终审校对',
  completed: '已完成',
  cancelled: '已取消',
  failed: '已失败',
};

export const PipelineTaskScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const navigation = useNavigation();
  const { tasks, clearResolved, resolveTask, loadFromDB } =
    usePipelineTaskStore();

  useEffect(() => {
    loadFromDB();
  }, [loadFromDB]);

  const unresolvedTasks = tasks.filter(t => t.resolvedAt === null);
  const activeTasks = unresolvedTasks.filter(task =>
    ACTIVE_STATUSES.has(task.status),
  );

  const stopTask = (task: PipelineTask) => {
    cancelPipeline(task.id);
    Toast.show({
      type: 'info',
      text1: '已请求终止任务',
      text2: '正在停止当前生成并保存已完成内容',
    });
  };

  const stopAllTasks = () => {
    activeTasks.forEach(task => cancelPipeline(task.id));
    Toast.show({
      type: 'info',
      text1: activeTasks.length
        ? `已请求终止 ${activeTasks.length} 个任务`
        : '没有需要终止的任务',
      text2: activeTasks.length
        ? '已停止的任务不会在重启后继续执行'
        : undefined,
    });
  };

  const removeTask = async (taskId: string) => {
    try {
      await resolveTask(taskId, 'reject');
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const renderItem = ({ item }: { item: PipelineTask }) => {
    const isRunning = ACTIVE_STATUSES.has(item.status);
    const stageCount = item.stageResults.length;
    const skippedCount = item.stageResults.filter(
      stage => stage.status === 'skipped',
    ).length;
    const totalStages = 4;
    const duration = item.updatedAt - item.createdAt;
    const durationText =
      duration > 60000
        ? `${Math.round(duration / 60000)}m`
        : `${Math.round(duration / 1000)}s`;

    return (
      <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <View style={styles.row}>
          <View
            style={[styles.statusPill, { borderColor: theme.colors.border }]}
          >
            <Text
              style={[styles.statusPillText, { color: theme.colors.accent }]}
            >
              {STATUS_MARK[item.status] || '-'}
            </Text>
          </View>
          <View style={styles.info}>
            <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
              {item.targetType === 'chapter'
                ? `章节 #${item.targetId}`
                : '自由写作'}
            </Text>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
              {STATUS_LABEL[item.status]} · {stageCount}/{totalStages} 阶段 ·
              跳过 {skippedCount} · {durationText}
            </Text>
          </View>
        </View>
        {isRunning ? (
          <View style={styles.actions}>
            <Button
              label="终止任务"
              variant="danger"
              onPress={() => stopTask(item)}
            />
          </View>
        ) : (
          <View style={styles.actions}>
            {item.status !== 'cancelled' ? (
              <Button
                label="查看结果"
                variant="secondary"
                onPress={() => {
                  // @ts-ignore
                  navigation.navigate('PipelineResult', { taskId: item.id });
                }}
              />
            ) : null}
            <Button
              label="从列表移除"
              variant="ghost"
              onPress={() => removeTask(item.id)}
            />
          </View>
        )}
      </View>
    );
  };

  return (
    <Screen>
      <Header
        title="流水线任务"
        subtitle={
          activeTasks.length
            ? `运行中 ${activeTasks.length} 项`
            : '可管理已完成、失败或已取消的任务'
        }
        action={
          <Button
            label="终止全部"
            variant="danger"
            compact
            disabled={activeTasks.length === 0}
            onPress={stopAllTasks}
          />
        }
      />
      {unresolvedTasks.length === 0 ? (
        <View style={styles.empty}>
          <Text
            style={[styles.emptyText, { color: theme.colors.textSecondary }]}
          >
            没有进行中的流水线任务
          </Text>
        </View>
      ) : (
        <FlatList
          data={unresolvedTasks}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.list}
          renderItem={renderItem}
        />
      )}
      <View style={[styles.footer, { borderTopColor: theme.colors.border }]}>
        <Button
          label="清理已移除记录"
          variant="ghost"
          onPress={clearResolved}
        />
      </View>
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.lg, gap: spacing.md, paddingBottom: 100 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 16 },
  card: { borderRadius: 8, padding: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  info: { flex: 1 },
  title: { fontSize: 15, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 2 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  footer: { padding: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth },
  statusPill: {
    minWidth: 44,
    minHeight: 32,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusPillText: { fontSize: 12, fontWeight: '800' },
});
