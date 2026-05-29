import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Button, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { useNavigation } from '@react-navigation/native';
import type { PipelineTask } from '../types/pipeline';

const STATUS_EMOJI: Record<string, string> = {
  idle: '⏳',
  drafting: '✍️',
  reviewing: '🔍',
  proofing: '✒️',
  completed: '✅',
  cancelled: '🚫',
  failed: '❌',
};

const STATUS_LABEL: Record<string, string> = {
  idle: '等待中',
  drafting: '创作初稿',
  reviewing: '审阅核查',
  proofing: '终审校对',
  completed: '已完成',
  cancelled: '已取消',
  failed: '已失败',
};

export const PipelineTaskScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const navigation = useNavigation();
  const { tasks, clearResolved, resolveTask } = usePipelineTaskStore();

  const unresolvedTasks = tasks.filter((t) => t.resolvedAt === null);

  const renderItem = ({ item }: { item: PipelineTask }) => {
    const isRunning = ['idle', 'drafting', 'reviewing', 'proofing'].includes(item.status);
    const stageCount = item.stageResults.length;
    const totalStages = 4;
    const duration = item.updatedAt - item.createdAt;
    const durationText = duration > 60000 ? `${Math.round(duration / 60000)}m` : `${Math.round(duration / 1000)}s`;

    return (
      <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <View style={styles.row}>
          <Text style={{ fontSize: 20 }}>{STATUS_EMOJI[item.status] || '•'}</Text>
          <View style={styles.info}>
            <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
              {item.targetType === 'chapter' ? `章节 #${item.targetId}` : '自由写作'}
            </Text>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
              {STATUS_LABEL[item.status]} · {stageCount}/{totalStages} 阶段 · {durationText}
            </Text>
          </View>
        </View>
        {!isRunning && item.status !== 'cancelled' && (
          <View style={styles.actions}>
            <Button
              label="查看结果"
              variant="secondary"
              onPress={() => {
                // @ts-ignore
                navigation.navigate('PipelineResult', { taskId: item.id });
              }}
            />
            <Button
              label="删除"
              variant="ghost"
              onPress={() => resolveTask(item.id, 'reject')}
            />
          </View>
        )}
      </View>
    );
  };

  return (
    <Screen>
      <Header title="流水线任务" />
      {unresolvedTasks.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>没有进行中的流水线任务</Text>
        </View>
      ) : (
        <FlatList
          data={unresolvedTasks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={renderItem}
        />
      )}
      <View style={styles.footer}>
        <Button label="清空已完成" variant="ghost" onPress={clearResolved} />
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
});
