import React, { useCallback, useState } from 'react';
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
  processAnalysisRun,
  resumeAnalysis,
  type AnalysisRun,
} from '../../../services/continuation/canon';
import { PipelineForeground } from '../../../native/PipelineForegroundModule';
import { requestNotificationPermission } from '../../../utils/notificationPermission';

export const CanonAnalysisTasksScreen: React.FC<{
  navigation: { goBack: () => void };
}> = ({ navigation }) => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [runs, setRuns] = useState<AnalysisRun[]>([]);

  const reload = useCallback(async () => {
    if (!currentProject) return;
    try {
      const overview = await getAnalysisOverview(currentProject.id);
      setRuns(overview.runs);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '加载任务失败', text2: e?.message });
    }
  }, [currentProject]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

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
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <Text
              style={{ color: theme.colors.textPrimary, fontWeight: '600' }}
            >
              {item.profile} · {item.state}
            </Text>
            <Text style={{ color: theme.colors.textSecondary }}>
              {item.stage} · {item.progressCurrent}/{item.progressTotal}
            </Text>
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
                    await resumeAnalysis(item.id);
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
                    await resumeAnalysis(item.id);
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
                      await requestNotificationPermission().catch(() => false);
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
        )}
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
