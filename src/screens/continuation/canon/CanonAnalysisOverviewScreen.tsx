/**
 * 分析概览 — Phase 2 UI entry (Spec §11.1).
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { useFocusEffect } from '@react-navigation/native';
import { Button, Card, Header, Screen, spacing } from '../../../components/ui';
import { useProjectStore } from '../../../store/projectStore';
import { useThemeStore } from '../../../store/themeStore';
import {
  activateSnapshot,
  getAnalysisOverview,
  processAnalysisRun,
  startAnalysis,
  type AnalysisRun,
  type CanonSnapshot,
} from '../../../services/continuation/canon';
import type { AnalysisProfile } from '../../../services/continuation/canon/types';
import { isBoundaryReady } from '../../../services/continuation/continuationSettingsService';

export const CanonAnalysisOverviewScreen: React.FC<{
  navigation: { navigate: (screen: string, params?: any) => void; goBack: () => void };
}> = ({ navigation }) => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<CanonSnapshot | null>(null);
  const [latestRun, setLatestRun] = useState<AnalysisRun | null>(null);
  const [boundaryOk, setBoundaryOk] = useState(false);

  const reload = useCallback(async () => {
    if (!currentProject) {
      setLoading(false);
      return;
    }
    try {
      const [overview, ready] = await Promise.all([
        getAnalysisOverview(currentProject.id),
        isBoundaryReady(currentProject.id),
      ]);
      setActive(overview.activeSnapshot);
      setLatestRun(overview.latestRun);
      setBoundaryOk(ready);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '加载分析概览失败', text2: e?.message });
    } finally {
      setLoading(false);
    }
  }, [currentProject]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      reload();
    }, [reload]),
  );

  const runAnalysis = (profile: AnalysisProfile) => {
    if (!currentProject) return;
    if (!boundaryOk) {
      Alert.alert('请先设置续写起点', '导入原著并设置续写边界后再分析。');
      return;
    }
    const onlineNote =
      profile === 'deep'
        ? '\n\nDeep 档位耗时与 Token 更高，建议确认模型额度。'
        : '';
    Alert.alert(
      `开始 ${profile} 分析`,
      `将仅读取续写起点之前的原著章节。离线确定性提取默认可用；若配置了在线模型可在后续批次中使用。\n\n分析过程可暂停/取消。${onlineNote}`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '开始',
          onPress: async () => {
            setBusy(true);
            try {
              const { runId, snapshotId } = await startAnalysis({
                projectId: currentProject.id,
                profile,
                extractorMode: 'deterministic',
              });
              Toast.show({ type: 'info', text1: '分析已启动', text2: `批次处理中…` });
              await processAnalysisRun(runId);
              Toast.show({
                type: 'success',
                text1: '分析完成',
                text2: '请审核后激活快照',
              });
              void snapshotId;
              await reload();
            } catch (e: any) {
              Toast.show({ type: 'error', text1: '分析失败', text2: e?.message });
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const handleActivate = async () => {
    if (!currentProject || !latestRun) return;
    setBusy(true);
    try {
      await activateSnapshot(currentProject.id, latestRun.canonSnapshotId);
      Toast.show({ type: 'success', text1: 'Canon 快照已激活' });
      await reload();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '激活失败', text2: e?.message });
    } finally {
      setBusy(false);
    }
  };

  if (!currentProject) {
    return (
      <Screen>
        <Header
          title="分析概览"
          action={<Button label="返回" variant="ghost" onPress={() => navigation.goBack()} />}
        />
        <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
          请先选择项目
        </Text>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header
        title="分析概览"
        subtitle={currentProject.name}
        action={<Button label="返回" variant="ghost" onPress={() => navigation.goBack()} />}
      />
      <ScrollView contentContainerStyle={styles.body}>
        {loading ? (
          <ActivityIndicator color={theme.colors.accent} />
        ) : (
          <>
            <Card style={styles.card}>
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
                当前 Active Canon
              </Text>
              {active ? (
                <>
                  <Text style={{ color: theme.colors.textSecondary }}>
                    快照 {active.id.slice(0, 8)}… · rev {active.revision} ·{' '}
                    {active.profile}
                  </Text>
                  <Text style={{ color: theme.colors.textSecondary }}>
                    边界章节 pos={active.boundaryPosition} · offset=
                    {active.boundaryCharOffsetExclusive}
                  </Text>
                  <Text style={{ color: theme.colors.textSecondary }}>
                    覆盖 {active.coverage.analyzedChapterCount}/
                    {active.coverage.sourceChapterCount} 章
                  </Text>
                  {active.coverage.incompleteReasons.length > 0 && (
                    <Text style={{ color: theme.colors.warning || '#b45309' }}>
                      不完整：{active.coverage.incompleteReasons.join('；')}
                    </Text>
                  )}
                </>
              ) : (
                <Text style={{ color: theme.colors.textSecondary }}>
                  尚未激活 Canon 快照。Phase 3 在此之前无法查询原著事实。
                </Text>
              )}
            </Card>

            <Card style={styles.card}>
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
                最近分析任务
              </Text>
              {latestRun ? (
                <>
                  <Text style={{ color: theme.colors.textSecondary }}>
                    状态 {latestRun.state} · 阶段 {latestRun.stage}
                  </Text>
                  <Text style={{ color: theme.colors.textSecondary }}>
                    进度 {latestRun.progressCurrent}/{latestRun.progressTotal} ·{' '}
                    {latestRun.profile}
                  </Text>
                  {latestRun.errorMessage ? (
                    <Text style={{ color: theme.colors.danger }}>
                      {latestRun.errorMessage}
                    </Text>
                  ) : null}
                  {latestRun.state === 'awaiting_review' && (
                    <Button
                      label="审核通过并激活"
                      onPress={handleActivate}
                      disabled={busy}
                    />
                  )}
                </>
              ) : (
                <Text style={{ color: theme.colors.textSecondary }}>暂无分析任务</Text>
              )}
            </Card>

            <Card style={styles.card}>
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
                发起分析
              </Text>
              <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
                分析只读取续写边界内的原著。Quick 不含完整关系/知识/时间线；Strict
                生成请用 Standard/Deep。
              </Text>
              <View style={styles.row}>
                <Button
                  label="Quick"
                  onPress={() => runAnalysis('quick')}
                  disabled={busy || !boundaryOk}
                />
                <Button
                  label="Standard"
                  onPress={() => runAnalysis('standard')}
                  disabled={busy || !boundaryOk}
                />
                <Button
                  label="Deep"
                  onPress={() => runAnalysis('deep')}
                  disabled={busy || !boundaryOk}
                />
              </View>
            </Card>

            <Card style={styles.card}>
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
                五类资料
              </Text>
              {(
                [
                  ['CanonWorldRules', '世界观'],
                  ['CanonCharacters', '人物画像'],
                  ['CanonRelationships', '人物关系'],
                  ['CanonPlotThreads', '主线剧情'],
                  ['CanonExperiences', '人物经历'],
                  ['CanonAnalysisTasks', '分析任务'],
                ] as const
              ).map(([screen, label]) => (
                <Button
                  key={screen}
                  label={label}
                  variant="ghost"
                  onPress={() => navigation.navigate(screen)}
                />
              ))}
            </Card>
          </>
        )}
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  body: { padding: spacing.md, paddingBottom: spacing.xl * 2 },
  card: { marginBottom: spacing.md, gap: spacing.xs },
  title: { fontSize: 16, fontWeight: '600', marginBottom: spacing.xs },
  hint: { fontSize: 13, lineHeight: 18, marginBottom: spacing.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
});
