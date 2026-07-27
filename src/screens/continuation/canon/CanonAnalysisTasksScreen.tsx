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
  processAnalysisRun,
  resumeAnalysis,
  type AnalysisRun,
} from '../../../services/continuation/canon';

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
        action={<Button label="返回" variant="ghost" onPress={() => navigation.goBack()} />}
      />
      <FlatList
        data={runs}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
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
            {(item.state === 'paused' || item.state === 'failed') && (
              <Button
                label="继续 / 重试"
                onPress={async () => {
                  try {
                    await resumeAnalysis(item.id);
                    Toast.show({ type: 'success', text1: '已继续' });
                    await reload();
                  } catch (e: any) {
                    Toast.show({ type: 'error', text1: '失败', text2: e?.message });
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
                      await processAnalysisRun(item.id);
                      await reload();
                    } catch (e: any) {
                      Toast.show({ type: 'error', text1: '处理失败', text2: e?.message });
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
          <Text style={{ color: theme.colors.textSecondary, padding: spacing.lg }}>
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
