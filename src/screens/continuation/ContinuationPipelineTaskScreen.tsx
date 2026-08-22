import React, { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import {
  Button,
  Card,
  EmptyState,
  Header,
  LoadingState,
  Screen,
  spacing,
} from '../../components/ui';
import { useProjectStore } from '../../store/projectStore';
import { useThemeStore } from '../../store/themeStore';
import * as db from '../../services/database';
import { cancelContinuationRun } from '../../services/writing/persist/continuationAdoption';
import {
  listRunsForProject,
  type ContinuationGenerationRun,
} from '../../services/continuation/generation';
import {
  CONTINUATION_RUN_STATE_LABEL,
  CONTINUATION_STAGE_LABEL,
  isUnfinishedContinuationRun,
} from '../../services/continuation/generation/runStatus';

const LIVE_STATES = new Set<ContinuationGenerationRun['state']>([
  'queued',
  'running',
]);

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '更新时间未知';
  return `更新于 ${new Date(timestamp).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function currentStageLabel(run: ContinuationGenerationRun): string {
  if (run.workflowVersion !== 5) {
    return CONTINUATION_STAGE_LABEL[run.stage];
  }
  switch (run.stage) {
    case 'round1':
    case 'writer':
    case 'draft_writer':
      return '生成';
    case 'round2':
      return '检查';
    case 'revision_writer':
    case 'round3':
    case 'round4':
      return '修订';
    case 'final_validate':
      return '校验';
    case 'awaiting_user':
      return '保存 / 等待采纳';
    default:
      return '共享 Writing Kernel';
  }
}

/** Continuation counterpart of the outline-mode PipelineTaskScreen. */
export const ContinuationPipelineTaskScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const navigation = useNavigation<any>();
  const [runs, setRuns] = useState<ContinuationGenerationRun[]>([]);
  const [chapterTitles, setChapterTitles] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentProject || currentProject.mode !== 'continuation') {
      setRuns([]);
      setChapterTitles({});
      setLoading(false);
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const [allRuns, chapters] = await Promise.all([
        listRunsForProject(currentProject.id, 100),
        db.getChaptersByProject(currentProject.id),
      ]);
      const nextTitles: Record<number, string> = {};
      for (const chapter of chapters) {
        nextTitles[chapter.id] = chapter.title;
      }
      setChapterTitles(nextTitles);
      setRuns(allRuns.filter(isUnfinishedContinuationRun));
    } catch (loadError: any) {
      setError(String(loadError?.message || '无法读取续写流水线执行情况'));
    } finally {
      setLoading(false);
    }
  }, [currentProject]);

  // Durable continuation runs are updated by the background runner. Refresh
  // while this page is focused so a running/failed row stays useful without
  // requiring the user to leave and re-enter Settings.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const refresh = () => {
        if (active) load().catch(() => undefined);
      };
      refresh();
      const timer = setInterval(refresh, 2000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [load]),
  );

  const openRun = (run: ContinuationGenerationRun) => {
    navigation.navigate('ContinuationResult', { runId: run.id });
  };

  const requestCancel = (run: ContinuationGenerationRun) => {
    Alert.alert(
      '终止续写流水线',
      '将停止当前运行并保留已保存的执行记录。这个操作不会删除已有章节内容，确定终止吗？',
      [
        { text: '继续运行', style: 'cancel' },
        {
          text: '终止任务',
          style: 'destructive',
          onPress: () => {
            setCancellingId(run.id);
            cancelContinuationRun(run.id)
              .then(() => {
                Toast.show({ type: 'info', text1: '已终止续写流水线' });
                return load();
              })
              .catch((cancelError: any) => {
                Toast.show({
                  type: 'error',
                  text1: '终止失败',
                  text2: String(cancelError?.message || '请稍后重试'),
                });
              })
              .finally(() => setCancellingId(null));
          },
        },
      ],
    );
  };

  if (!currentProject || currentProject.mode !== 'continuation') {
    return (
      <Screen>
        <Header testID="continuation-pipeline-tasks" title="流水线执行情况" />
        <EmptyState
          title="请先选择原著续写项目"
          description="切换到原著续写项目后，这里会显示该项目未完成的续写流水线。"
        />
      </Screen>
    );
  }

  const liveCount = runs.filter(run => LIVE_STATES.has(run.state)).length;

  return (
    <Screen>
      <Header
        testID="continuation-pipeline-tasks"
        title="流水线执行情况"
        subtitle={
          liveCount > 0
            ? `运行中 ${liveCount} 项 · 未完成 ${runs.length} 项`
            : `未完成 ${runs.length} 项`
        }
        action={
          <Button
            label="刷新"
            variant="ghost"
            compact
            onPress={() => load().catch(() => undefined)}
          />
        }
      />
      {error ? (
        <Text style={[styles.error, { color: theme.colors.danger }]}>
          {error}
        </Text>
      ) : null}
      {loading && runs.length === 0 ? (
        <LoadingState label="正在读取续写流水线…" />
      ) : runs.length === 0 ? (
        <EmptyState
          title="没有未完成的续写流水线"
          description="新建续写章节并开始生成后，运行中、等待确认、中断或失败的任务会显示在这里。"
        />
      ) : (
        <FlatList
          data={runs}
          keyExtractor={run => run.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const live = LIVE_STATES.has(item.state);
            const title =
              chapterTitles[item.chapterId] || `续写章节 #${item.chapterId}`;
            const stateLabel = CONTINUATION_RUN_STATE_LABEL[item.state];
            const stageLabel = currentStageLabel(item);
            return (
              <Card>
                <View style={styles.row}>
                  <View
                    style={[
                      styles.statusPill,
                      { borderColor: live ? theme.colors.accent : theme.colors.border },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusPillText,
                        { color: live ? theme.colors.accent : theme.colors.textSecondary },
                      ]}
                    >
                      {live ? '进行中' : '待处理'}
                    </Text>
                  </View>
                  <View style={styles.info}>
                    <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
                      {title}
                    </Text>
                    <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
                      {stateLabel} · 当前阶段：{stageLabel}
                    </Text>
                    <Text style={[styles.meta, { color: theme.colors.textMuted }]}>
                      {formatUpdatedAt(item.updatedAt)}
                    </Text>
                    {item.errorMessage ? (
                      <Text
                        style={[styles.error, { color: theme.colors.danger }]}
                        numberOfLines={3}
                      >
                        {item.errorMessage}
                      </Text>
                    ) : null}
                  </View>
                </View>
                <View style={styles.actions}>
                  <Button
                    label={
                      item.state === 'awaiting_user'
                        ? '查看并处理'
                        : item.state === 'interrupted' || item.state === 'failed'
                          ? '查看并恢复'
                          : '查看执行详情'
                    }
                    onPress={() => openRun(item)}
                  />
                  {live ? (
                    <Button
                      label={cancellingId === item.id ? '终止中…' : '终止任务'}
                      variant="danger"
                      disabled={cancellingId === item.id}
                      onPress={() => requestCancel(item)}
                    />
                  ) : null}
                </View>
              </Card>
            );
          }}
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.md, gap: spacing.sm, paddingBottom: 96 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  statusPill: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusPillText: { fontSize: 12, fontWeight: '700' },
  info: { flex: 1 },
  title: { fontSize: 16, fontWeight: '800' },
  meta: { fontSize: 12, lineHeight: 18, marginTop: 4 },
  error: { fontSize: 12, lineHeight: 18, margin: spacing.md },
  actions: { marginTop: spacing.md, gap: spacing.sm },
});
