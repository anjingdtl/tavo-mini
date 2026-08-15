import React, { useEffect, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import Toast from 'react-native-toast-message';
import { Button, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { useNavigation } from '@react-navigation/native';
import type { PipelineTask } from '../types/pipeline';
import { cancelPipeline } from '../services/pipelineRunner';
import {
  createOutlineResumeWritingKernelExecution,
  createOutlineWritingKernelExecution,
  runWritingKernel,
} from '../services/writing';
import { isReconcileActive } from '../services/pipeline';
import * as db from '../services/database';
import {
  resetFailedStageCheckpointsForResume,
} from '../data/repositories/pipelineStageCheckpointRepository';
import { getPipelineStageOrder } from '../utils/stages';
import {
  CURRENT_OUTLINE_WORKFLOW_VERSION,
  isCurrentOutlinePipelineContextBudgetVersion,
  PHASE2_CONTEXT_BUDGET_VERSION,
} from '../services/pipeline/outlineWorkflowVersion';

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
  interrupted: '中断',
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
  interrupted: '已中断（可继续）',
};

function isRecoverable(task: PipelineTask): boolean {
  if (
    Number(task.outlineWorkflowVersion) !== CURRENT_OUTLINE_WORKFLOW_VERSION ||
    !isCurrentOutlinePipelineContextBudgetVersion(task.contextBudgetVersion)
  ) {
    return false;
  }
  if (task.status === 'interrupted' && task.recoverable !== false) {
    return true;
  }
  // A failed required checkpoint is resumable from that exact node. The
  // result page uses the same rule; keeping it here makes the task center a
  // reliable recovery entry point after a cold start.
  return (
    task.status === 'failed' &&
    task.stageResults.some(stage => stage.status === 'failed')
  );
}

function isLegacyIncomplete(task: PipelineTask): boolean {
  return (
    (Number(task.outlineWorkflowVersion) !== CURRENT_OUTLINE_WORKFLOW_VERSION ||
      !isCurrentOutlinePipelineContextBudgetVersion(
        task.contextBudgetVersion,
      )) &&
    ['failed', 'interrupted'].includes(task.status)
  );
}

function resolveTaskMode(task: PipelineTask): string {
  try {
    const raw = task.pipelineContextJson
      ? JSON.parse(task.pipelineContextJson)
      : null;
    const mode = raw?.execution?.pipelineMode;
    if (
      mode === 'noReview' ||
      mode === 'twoStage' ||
      mode === 'conditional' ||
      mode === 'full'
    ) {
      return mode;
    }
  } catch {
    // Fall through to the stage projection for legacy rows.
  }
  const stages = new Set(task.stageResults.map(stage => stage.stage));
  if (stages.has('review') && stages.has('factCheck')) return 'full';
  if (stages.has('factCheck')) return 'conditional';
  if (stages.has('review')) return 'twoStage';
  return 'twoStage';
}

export const PipelineTaskScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const navigation = useNavigation();
  const { tasks, clearResolved, resolveTask, loadFromDB } =
    usePipelineTaskStore();
  /** Task ids with an in-flight continue click (CAS / reconcile). */
  const [resumingIds, setResumingIds] = useState<Record<string, boolean>>({});

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

  const continueTask = async (task: PipelineTask) => {
    if (resumingIds[task.id] || isReconcileActive(task.id)) {
      Toast.show({
        type: 'info',
        text1: '任务已在运行',
        text2: '请勿重复点击继续',
      });
      return;
    }
    if (task.targetType !== 'chapter') {
      Toast.show({
        type: 'error',
        text1: '无法继续',
        text2: '仅支持章节流水线恢复',
      });
      return;
    }
    const proceed = await new Promise<boolean>(resolve => {
      Alert.alert(
        '从失败节点重试',
        '将只重试失败节点及尚未成功的下游节点；已成功的 checkpoint 会直接复用。该操作可能产生新的 API 费用，是否继续？',
        [
          { text: '取消', style: 'cancel', onPress: () => resolve(false) },
          { text: '确认重试', onPress: () => resolve(true) },
        ],
      );
    });
    if (!proceed) return;
    setResumingIds(prev => ({ ...prev, [task.id]: true }));
    try {
      const chapter = await db.getChapterById(task.targetId);
      if (!chapter) {
        Toast.show({
          type: 'error',
          text1: '无法继续',
          text2: '目标章节不存在，请重新开始生成',
        });
        return;
      }
      await resetFailedStageCheckpointsForResume(task.id);
      const resumedAt = Date.now();
      await db.updatePipelineTaskResumeState(task.id, resumedAt);
      usePipelineTaskStore.getState().registerPersistedTask({
        ...task,
        status: 'interrupted',
        error: null,
        updatedAt: resumedAt,
        resolvedAt: null,
        resolvedAction: null,
      });
      Toast.show({ type: 'info', text1: '正在继续任务…' });
      // @ts-ignore
      navigation.navigate('PipelineResult', { taskId: task.id });
      runWritingKernel(
        createOutlineResumeWritingKernelExecution({
          taskId: task.id,
          chapter,
        }),
      ).catch((error: any) => {
        const already =
          error?.code === 'TASK_ALREADY_RUNNING' ||
          /已在运行/.test(String(error?.message || ''));
        Toast.show({
          type: already ? 'info' : 'error',
          text1: already ? '任务已在运行' : '继续失败',
          text2: already
            ? '请勿重复点击继续'
            : error?.message || '请重新开始生成',
        });
      });
    } catch (e: any) {
      Toast.show({
        type: 'error',
        text1: '继续失败',
        text2: e?.message || '未知错误',
      });
    } finally {
      // Keep disabled briefly; reconcile lock is the real guard.
      setTimeout(() => {
        setResumingIds(prev => {
          const next = { ...prev };
          delete next[task.id];
          return next;
        });
      }, 1500);
    }
  };

  const restartLegacyTask = async (task: PipelineTask) => {
    const proceed = await new Promise<boolean>(resolve => {
      Alert.alert(
        '按新版重新生成',
        '将创建一条新的完整流水线任务。旧任务、旧尝试记录和已完成阶段会保留，不会继续调用旧版流程。',
        [
          { text: '取消', style: 'cancel', onPress: () => resolve(false) },
          { text: '创建新版任务', onPress: () => resolve(true) },
        ],
      );
    });
    if (!proceed) return;
    try {
      const chapter = await db.getChapterById(task.targetId);
      if (!chapter) throw new Error('目标章节不存在');
      const newTaskId = await usePipelineTaskStore.getState().createTask(
        'chapter',
        task.targetId,
        {
          outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
          contextBudgetVersion: PHASE2_CONTEXT_BUDGET_VERSION,
        },
      );
      Toast.show({ type: 'info', text1: '新版任务已创建', text2: '正在执行完整流水线' });
      // @ts-ignore
      navigation.navigate('PipelineResult', { taskId: newTaskId });
      runWritingKernel(
        createOutlineWritingKernelExecution({
          taskId: newTaskId,
          chapter,
        }),
      ).catch(error => {
        Toast.show({ type: 'error', text1: '新版任务失败', text2: error?.message || '请查看任务详情' });
      });
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '创建新版任务失败', text2: error?.message || '请重试' });
    }
  };

  const renderItem = ({ item }: { item: PipelineTask }) => {
    const isRunning = ACTIVE_STATUSES.has(item.status);
    const recoverable = isRecoverable(item);
    const legacyIncomplete = isLegacyIncomplete(item);
    const stageCount = item.stageResults.length;
    const skippedCount = item.stageResults.filter(
      stage => stage.status === 'skipped',
    ).length;
    const totalStages = getPipelineStageOrder(resolveTaskMode(item), {
      outlineWorkflowVersion: item.outlineWorkflowVersion,
      contextBudgetVersion: item.contextBudgetVersion,
    }).length;
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
              {STATUS_LABEL[item.status] || item.status} · {stageCount}/
              {totalStages} 阶段 · 跳过 {skippedCount} · {durationText}
            </Text>
            {item.error ? (
              <Text
                style={[styles.error, { color: theme.colors.danger }]}
                numberOfLines={2}
              >
                {item.error}
              </Text>
            ) : null}
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
            {legacyIncomplete ? (
              <Button
                label="按新版重新生成"
                onPress={() => restartLegacyTask(item).catch(() => undefined)}
              />
            ) : null}
            {recoverable ? (
              <Button
                label={resumingIds[item.id]
                  ? '重试中…'
                  : item.status === 'failed'
                    ? '从失败节点重试'
                    : '继续任务'}
                disabled={Boolean(resumingIds[item.id]) || isReconcileActive(item.id)}
                onPress={() => {
                  continueTask(item).catch(() => undefined);
                }}
              />
            ) : null}
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
              label={recoverable ? '放弃' : '从列表移除'}
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
        testID="pipeline-task-list"
        title="流水线任务"
        subtitle={
          activeTasks.length
            ? `运行中 ${activeTasks.length} 项`
            : '可管理已完成、失败、中断或已取消的任务'
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
  list: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  card: {
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  statusPill: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusPillText: {
    fontSize: 12,
    fontWeight: '600',
  },
  info: {
    flex: 1,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  meta: {
    fontSize: 12,
    marginTop: 4,
  },
  error: {
    fontSize: 12,
    marginTop: 4,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  emptyText: {
    fontSize: 14,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
});
