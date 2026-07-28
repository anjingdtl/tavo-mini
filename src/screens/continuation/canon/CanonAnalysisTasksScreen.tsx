import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text } from 'react-native';
import Toast from 'react-native-toast-message';
import { useFocusEffect } from '@react-navigation/native';
import { Button, Card, Header, Screen, spacing } from '../../../components/ui';
import { useProjectStore } from '../../../store/projectStore';
import { useThemeStore } from '../../../store/themeStore';
import {
  cancelAnalysis,
  getAnalysisOverview,
  ANALYSIS_MATERIAL_LABELS,
  getAnalysisWorkItems,
  processAnalysisRun,
  resumeAnalysis,
  type AnalysisMaterialType,
  type AnalysisRun,
  type AnalysisWorkItem,
} from '../../../services/continuation/canon';
import { PipelineForeground } from '../../../native/PipelineForegroundModule';
import { requestNotificationPermission } from '../../../utils/notificationPermission';

export const CanonAnalysisTasksScreen: React.FC<{
  navigation: { goBack: () => void };
}> = ({ navigation }) => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [runs, setRuns] = useState<AnalysisRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [workItems, setWorkItems] = useState<AnalysisWorkItem[]>([]);

  const reload = useCallback(async () => {
    if (!currentProject) return;
    try {
      const overview = await getAnalysisOverview(currentProject.id);
      setRuns(overview.runs);
      const targetRunId =
        selectedRunId && overview.runs.some(run => run.id === selectedRunId)
          ? selectedRunId
          : overview.runs[0]?.id ?? null;
      setSelectedRunId(targetRunId);
      setWorkItems(targetRunId ? await getAnalysisWorkItems(targetRunId) : []);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '加载任务失败', text2: e?.message });
    }
  }, [currentProject, selectedRunId]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  useEffect(() => {
    if (!runs.some(run => run.state === 'queued' || run.state === 'running')) {
      return;
    }
    const timer = setInterval(() => {
      void reload();
    }, 1000);
    return () => clearInterval(timer);
  }, [reload, runs]);

  const selectRun = async (runId: string) => {
    setSelectedRunId(runId);
    try {
      setWorkItems(await getAnalysisWorkItems(runId));
    } catch (e: any) {
      Toast.show({
        type: 'error',
        text1: '加载任务进度失败',
        text2: e?.message,
      });
    }
  };

  return (
    <Screen>
      <Header
        title="分析任务"
        action={
          <Button
            label="返回"
            variant="ghost"
            onPress={() => navigation.goBack()}
          />
        }
      />
      <FlatList
        data={runs}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          const isSelected = item.id === selectedRunId;
          const selectedItems = isSelected ? workItems : [];
          const completed = selectedItems.filter(
            workItem => workItem.state === 'completed',
          ).length;
          const failed = selectedItems.filter(
            workItem => workItem.state === 'failed',
          ).length;
          const queued = selectedItems.filter(
            workItem =>
              workItem.state === 'queued' || workItem.state === 'running',
          ).length;
          return (
            <Card style={styles.card}>
              <Text
                style={{ color: theme.colors.textPrimary, fontWeight: '600' }}
              >
                {item.profile} · {item.state}
              </Text>
              <Text style={{ color: theme.colors.textSecondary }}>
                {item.stage} · {item.progressCurrent}/{item.progressTotal}
              </Text>
              <Button
                label={isSelected ? '刷新已完成进度' : '查看已完成进度'}
                variant="ghost"
                onPress={() => {
                  if (isSelected) {
                    void reload();
                  } else {
                    void selectRun(item.id);
                  }
                }}
              />
              {isSelected && (
                <>
                  <Text style={{ color: theme.colors.textSecondary }}>
                    已持久化：完成 {completed}/{selectedItems.length} · 待处理{' '}
                    {queued} · 失败 {failed}
                  </Text>
                  {(
                    [
                      'world_rules',
                      'characters',
                      'relationships',
                      'plot_threads',
                      'experiences',
                    ] as const
                  ).map(materialType => {
                    const materialItems = selectedItems.filter(
                      workItem => workItem.materialType === materialType,
                    );
                    const materialCompleted = materialItems.filter(
                      workItem => workItem.state === 'completed',
                    ).length;
                    const materialFailed = materialItems.filter(
                      workItem => workItem.state === 'failed',
                    ).length;
                    return (
                      <Text
                        key={materialType}
                        style={{
                          color:
                            materialFailed > 0
                              ? theme.colors.danger
                              : theme.colors.textSecondary,
                        }}
                      >
                        {ANALYSIS_MATERIAL_LABELS[materialType]}：完成{' '}
                        {materialCompleted}/{materialItems.length}
                        {materialFailed > 0 ? ` · 失败 ${materialFailed}` : ''}
                      </Text>
                    );
                  })}
                  {selectedItems.map(workItem => (
                    <Text
                      key={`${workItem.batchIndex}-${workItem.materialType}`}
                      style={{
                        color:
                          workItem.state === 'failed'
                            ? theme.colors.danger
                            : theme.colors.textSecondary,
                        fontSize: 12,
                      }}
                    >
                      第 {workItem.batchIndex + 1} 批 ·{' '}
                      {
                        ANALYSIS_MATERIAL_LABELS[
                          workItem.materialType as AnalysisMaterialType
                        ]
                      }{' '}
                      · {workItem.state}
                      {workItem.attemptCount > 0
                        ? ` · 已尝试 ${workItem.attemptCount} 次`
                        : ''}
                      {workItem.errorMessage
                        ? `\n${workItem.errorMessage}`
                        : ''}
                    </Text>
                  ))}
                </>
              )}
              {item.errorMessage ? (
                <Text style={{ color: theme.colors.danger }}>
                  {item.errorMessage}
                </Text>
              ) : null}
              {item.state === 'paused' && (
                <Button
                  label="继续"
                  onPress={async () => {
                    try {
                      await PipelineForeground.start(
                        item.id,
                        '原著分析进行中',
                        '正在继续分析…',
                        item.progressTotal
                          ? Math.round(
                              (item.progressCurrent / item.progressTotal) * 100,
                            )
                          : 0,
                      );
                      await resumeAnalysis(item.id, {
                        onProgress: () => {
                          void reload();
                        },
                      });
                      await PipelineForeground.stop(item.id);
                      Toast.show({ type: 'success', text1: '已继续' });
                      await reload();
                    } catch (e: any) {
                      await PipelineForeground.stop(item.id);
                      Toast.show({
                        type: 'error',
                        text1: '失败',
                        text2: e?.message,
                      });
                    }
                  }}
                />
              )}
              {item.state === 'failed' && (
                <Button
                  label="重试未完成项"
                  onPress={async () => {
                    try {
                      await PipelineForeground.start(
                        item.id,
                        '原著分析进行中',
                        '正在重试未完成项…',
                        item.progressTotal
                          ? Math.round(
                              (item.progressCurrent / item.progressTotal) * 100,
                            )
                          : 0,
                      );
                      await resumeAnalysis(item.id, {
                        onProgress: () => {
                          void reload();
                        },
                      });
                      await PipelineForeground.stop(item.id);
                      Toast.show({ type: 'success', text1: '已开始重试' });
                      await reload();
                    } catch (e: any) {
                      await PipelineForeground.stop(item.id);
                      Toast.show({
                        type: 'error',
                        text1: '重试失败',
                        text2: e?.message,
                      });
                    }
                  }}
                />
              )}
              {(item.state === 'queued' || item.state === 'running') && (
                <>
                  <Button
                    label="立即处理"
                    onPress={async () => {
                      try {
                        await requestNotificationPermission().catch(
                          () => false,
                        );
                        await PipelineForeground.start(
                          item.id,
                          '原著分析进行中',
                          '正在继续分析…',
                          item.progressTotal
                            ? Math.round(
                                (item.progressCurrent / item.progressTotal) *
                                  100,
                              )
                            : 0,
                        );
                        await processAnalysisRun(item.id, {
                          onProgress: update => {
                            const percent = update.progressTotal
                              ? Math.round(
                                  (update.progressCurrent /
                                    update.progressTotal) *
                                    100,
                                )
                              : 0;
                            const material = update.materialType
                              ? ANALYSIS_MATERIAL_LABELS[update.materialType]
                              : '原著分析';
                            void PipelineForeground.updateProgress(
                              item.id,
                              `第 ${
                                (update.batchIndex ?? 0) + 1
                              } 批 · ${material}`,
                              percent,
                            );
                            void reload();
                          },
                        });
                        await PipelineForeground.stop(item.id);
                        await reload();
                      } catch (e: any) {
                        await PipelineForeground.stop(item.id);
                        Toast.show({
                          type: 'error',
                          text1: '处理失败',
                          text2: e?.message,
                        });
                      }
                    }}
                  />
                  <Button
                    label="取消"
                    variant="ghost"
                    onPress={async () => {
                      await cancelAnalysis(item.id);
                      await reload();
                    }}
                  />
                </>
              )}
            </Card>
          );
        }}
        ListEmptyComponent={
          <Text
            style={{ color: theme.colors.textSecondary, padding: spacing.lg }}
          >
            暂无分析任务
          </Text>
        }
      />
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.md },
  card: { marginBottom: spacing.sm, gap: 4 },
});
