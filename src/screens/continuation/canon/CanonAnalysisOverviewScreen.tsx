/**
 * 分析概览 — Phase 2 UI entry (Spec §11.1).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  getAnalysisWorkItems,
  ANALYSIS_MATERIAL_LABELS,
  cancelAnalysis,
  pauseAnalysis,
  processAnalysisRun,
  resumeAnalysis,
  queueHistoricalDigests,
  processHistoricalDigest,
  startAnalysis,
  type AnalysisRun,
  type CanonSnapshot,
  type AnalysisWorkItem,
  type ContinuationAnalysisMode,
} from '../../../services/continuation/canon';
import { isBoundaryReady } from '../../../services/continuation/continuationSettingsService';
import { runStatusLabel } from './runStatusLabel';
import { PipelineForeground } from '../../../native/PipelineForegroundModule';
import { requestNotificationPermission } from '../../../utils/notificationPermission';

export const CanonAnalysisOverviewScreen: React.FC<{
  navigation: {
    navigate: (screen: string, params?: any) => void;
    goBack: () => void;
  };
}> = ({ navigation }) => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<CanonSnapshot | null>(null);
  const [latestRun, setLatestRun] = useState<AnalysisRun | null>(null);
  const [workItems, setWorkItems] = useState<AnalysisWorkItem[]>([]);
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
      const items = overview.latestRun
        ? await getAnalysisWorkItems(overview.latestRun.id)
        : [];
      // 同批请求组会几乎同时回写；以工作项实际终态数渲染进度，
      // 避免 run 表最后一次异步写入暂时落后于屏幕上的“已完成”明细。
      const completedCount = items.filter(
        item => item.state === 'completed',
      ).length;
      setLatestRun(
        overview.latestRun
          ? { ...overview.latestRun, progressCurrent: completedCount }
          : null,
      );
      setWorkItems(items);
      setBoundaryOk(ready);
    } catch (e: any) {
      Toast.show({
        type: 'error',
        text1: '加载分析概览失败',
        text2: e?.message,
      });
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

  useEffect(() => {
    if (!latestRun || !['queued', 'running'].includes(latestRun.state)) return;
    const timer = setInterval(() => {
      void reload();
    }, 1000);
    return () => clearInterval(timer);
  }, [latestRun, reload]);

  const runAnalysis = (mode: ContinuationAnalysisMode) => {
    if (!currentProject) return;
    if (!boundaryOk) {
      Alert.alert('请先设置续写起点', '导入原著并设置续写边界后再分析。');
      return;
    }
    const fast = mode === 'fast_continuation';
    Alert.alert(
      fast ? '开始快速续写分析' : '开始完整 Canon 分析',
      fast
        ? '将调用当前 LLM 精读续写起点前最后 30 章，生成带原文证据的结构化 Canon。每个章节批次会请求「人物与状态」及「世界观与剧情」两组资料；更早章节尚未覆盖，可稍后补全。\n\n分析过程可暂停/取消。'
        : '将调用当前 LLM 分析续写起点之前的全部原著章节，生成带原文证据的结构化 Canon。每个章节批次会请求两组资料；完整分析耗时与 Token 更高。\n\n分析过程可暂停/取消。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '开始',
          onPress: async () => {
            setBusy(true);
            try {
              const { runId, snapshotId } = await startAnalysis({
                projectId: currentProject.id,
                mode,
              });
              Toast.show({
                type: 'info',
                text1: '分析已启动',
                text2: `批次处理中…`,
              });
              // 先把刚创建的 run 写回页面状态，再开始等待长耗时的分析。
              // 否则 processAnalysisRun 尚未返回时 latestRun 仍为空，轮询与
              // 可视进度条都不会启动，用户只能看到一组禁用按钮。
              await reload();
              await requestNotificationPermission().catch(() => false);
              await PipelineForeground.start(
                runId,
                '原著分析进行中',
                fast ? '正在准备最近章节资料…' : '正在准备全书资料…',
                0,
              );
              const run = await processAnalysisRun(runId, {
                onProgress: update => {
                  const percent = update.progressTotal
                    ? Math.round(
                        (update.progressCurrent / update.progressTotal) * 100,
                      )
                    : 0;
                  const material = update.materialType
                    ? ANALYSIS_MATERIAL_LABELS[update.materialType]
                    : '原著分析';
                  void PipelineForeground.updateProgress(
                    runId,
                    `第 ${(update.batchIndex ?? 0) + 1} 批 · ${material}`,
                    percent,
                  );
                  void reload();
                },
              });
              await PipelineForeground.stop(runId);
              if (run.state !== 'awaiting_review') {
                await PipelineForeground.notifyFailed(
                  `ca:${runId}`,
                  '原著分析未完成',
                  run.errorMessage || '可在分析任务中继续或重试。',
                );
                throw new Error(
                  run.errorMessage ?? '分析未完成，请检查模型配置后重试。',
                );
              }
              await PipelineForeground.notifyComplete(
                `ca:${runId}`,
                '原著分析完成',
                '两组 Canon 资料已生成，等待您审核并激活。',
              );
              Toast.show({
                type: 'success',
                text1: '分析完成',
                text2: '请审核后激活快照',
              });
              void snapshotId;
              await reload();
            } catch (e: any) {
              Toast.show({
                type: 'error',
                text1: '分析失败',
                text2: e?.message,
              });
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const completedWorkItems = useMemo(
    () => workItems.filter(item => item.state === 'completed').length,
    [workItems],
  );
  const displayedProgressCurrent =
    workItems.length > 0 ? completedWorkItems : latestRun?.progressCurrent ?? 0;
  const progressPercent = latestRun?.progressTotal
    ? Math.round((displayedProgressCurrent / latestRun.progressTotal) * 100)
    : 0;
  const materialProgress = useMemo(
    () =>
      Array.from(new Set(workItems.map(item => item.materialType))).map(
        materialType => {
          const items = workItems.filter(
            item => item.materialType === materialType,
          );
          const completed = items.filter(
            item => item.state === 'completed',
          ).length;
          const failed = items.find(item => item.state === 'failed');
          const active = items.find(
            item => item.state === 'running' || item.state === 'queued',
          );
          const cancelled = items.find(item => item.state === 'cancelled');
          return {
            materialType,
            completed,
            total: items.length,
            state: failed
              ? 'failed'
              : active?.state ??
                (cancelled
                  ? 'cancelled'
                  : items.length
                  ? 'completed'
                  : 'queued'),
            errorMessage: failed?.errorMessage,
          };
        },
      ),
    [workItems],
  );

  const stopRun = async (action: 'pause' | 'cancel') => {
    if (!latestRun) return;
    try {
      if (action === 'pause') await pauseAnalysis(latestRun.id);
      else await cancelAnalysis(latestRun.id);
      await PipelineForeground.stop(latestRun.id);
      Toast.show({
        type: 'info',
        text1: action === 'pause' ? '分析已暂停' : '分析已取消',
      });
      await reload();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const continueRun = async () => {
    if (!latestRun) return;
    try {
      await PipelineForeground.start(
        latestRun.id,
        '原著分析进行中',
        '正在继续分析…',
        progressPercent,
      );
      const run = await resumeAnalysis(latestRun.id, {
        onProgress: update => {
          const percent = update.progressTotal
            ? Math.round((update.progressCurrent / update.progressTotal) * 100)
            : 0;
          const material = update.materialType
            ? ANALYSIS_MATERIAL_LABELS[update.materialType]
            : '原著分析';
          void PipelineForeground.updateProgress(
            latestRun.id,
            `第 ${(update.batchIndex ?? 0) + 1} 批 · ${material}`,
            percent,
          );
          void reload();
        },
      });
      await PipelineForeground.stop(latestRun.id);
      if (run.state === 'awaiting_review') {
        await PipelineForeground.notifyComplete(
          `ca:${latestRun.id}`,
          '原著分析完成',
          'Canon 请求组已生成，等待审核。',
        );
      }
      await reload();
    } catch (e: any) {
      await PipelineForeground.stop(latestRun.id);
      Toast.show({ type: 'error', text1: '继续失败', text2: e?.message });
    }
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

  const buildHistoricalDigests = () => {
    if (!currentProject || !active) return;
    Alert.alert(
      '生成历史概览',
      '将为未进入近端 Canon 的早期章节建立本地候选索引，并按每组约 30 章调用 LLM 生成历史概览。历史概览不是 Canon，也不能替代原文证据。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '开始生成',
          onPress: async () => {
            setBusy(true);
            try {
              const queued = await queueHistoricalDigests({
                projectId: currentProject.id,
              });
              if (!queued.digestIds.length) {
                Toast.show({
                  type: 'info',
                  text1: '无需生成历史概览',
                  text2: '当前 Canon 已覆盖边界前的全部章节。',
                });
                return;
              }
              for (const digestId of queued.digestIds) {
                await processHistoricalDigest(digestId);
              }
              Toast.show({
                type: 'success',
                text1: '历史概览已生成',
                text2: '已索引 ' + queued.indexedChapterCount + ' 个早期章节',
              });
            } catch (e: any) {
              Toast.show({
                type: 'error',
                text1: '历史概览生成失败',
                text2: e?.message,
              });
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  if (!currentProject) {
    return (
      <Screen>
        <Header
          title="分析概览"
          action={
            <Button
              label="返回"
              variant="ghost"
              onPress={() => navigation.goBack()}
            />
          }
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
        action={
          <Button
            label="返回"
            variant="ghost"
            onPress={() => navigation.goBack()}
          />
        }
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
                  {active.coverage.analyzedChapterCount <
                    active.coverage.sourceChapterCount && (
                    <Text style={{ color: theme.colors.warning || '#b45309' }}>
                      当前为近端 Canon 分析；较早原著尚未覆盖，可生成历史概览作为弱参考。
                    </Text>
                  )}
                  {active.coverage.analyzedChapterCount <
                    active.coverage.sourceChapterCount && (
                    <Button
                      label="生成历史概览"
                      variant="ghost"
                      onPress={buildHistoricalDigests}
                      disabled={busy}
                    />
                  )}
                  {active.profile === 'quick' && (
                    <Text style={{ color: theme.colors.warning || '#b45309' }}>
                      旧版 Quick 离线预览已退役，不能用于续写；请重新进行 LLM
                      分析。
                    </Text>
                  )}
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
                    进度 {displayedProgressCurrent}/{latestRun.progressTotal} ·{' '}
                    {latestRun.profile}
                  </Text>
                  {latestRun.progressTotal > 0 && (
                    <>
                      <View
                        style={[
                          styles.progressTrack,
                          { backgroundColor: theme.colors.border },
                        ]}
                      >
                        <View
                          style={[
                            styles.progressFill,
                            {
                              backgroundColor: theme.colors.accent,
                              width: `${progressPercent}%`,
                            },
                          ]}
                        />
                      </View>
                      <Text
                        style={{
                          color: theme.colors.accent,
                          fontWeight: '700',
                        }}
                      >
                        {progressPercent}% · {runStatusLabel(latestRun, workItems)}
                      </Text>
                    </>
                  )}
                  {(latestRun.state === 'queued' ||
                    latestRun.state === 'running') && (
                    <View style={styles.row}>
                      <Button
                        label="暂停"
                        variant="ghost"
                        onPress={() => {
                          void stopRun('pause');
                        }}
                      />
                      <Button
                        label="取消"
                        variant="ghost"
                        onPress={() => {
                          void stopRun('cancel');
                        }}
                      />
                    </View>
                  )}
                  {latestRun.state === 'paused' && (
                    <Button
                      label="继续"
                      onPress={() => {
                        void continueRun();
                      }}
                    />
                  )}
                  {latestRun.state === 'failed' && (
                    <Button
                      label="重试未完成项"
                      onPress={() => {
                        void continueRun();
                      }}
                    />
                  )}
                  {latestRun.state === 'cancelled' && (
                    <Button
                      label="从已取消进度继续"
                      onPress={() => {
                        void continueRun();
                      }}
                    />
                  )}
                  {materialProgress.map(item => {
                    const percent = item.total
                      ? Math.round((item.completed / item.total) * 100)
                      : 0;
                    const color =
                      item.state === 'failed'
                        ? theme.colors.danger
                        : item.state === 'cancelled'
                        ? theme.colors.textSecondary
                        : theme.colors.accent;
                    const status =
                      item.state === 'failed'
                        ? '待重试'
                        : item.state === 'running'
                        ? '分析中'
                        : item.state === 'queued'
                        ? '排队中'
                        : item.state === 'cancelled'
                        ? '已取消，可继续'
                        : '已完成';
                    return (
                      <View
                        key={item.materialType}
                        style={styles.materialProgress}
                      >
                        <View style={styles.materialProgressHeader}>
                          <Text style={{ color: theme.colors.textPrimary }}>
                            {ANALYSIS_MATERIAL_LABELS[item.materialType]}
                          </Text>
                          <Text style={{ color }}>
                            {item.completed}/{item.total} · {status}
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.progressTrack,
                            { backgroundColor: theme.colors.border },
                          ]}
                        >
                          <View
                            style={[
                              styles.progressFill,
                              { backgroundColor: color, width: `${percent}%` },
                            ]}
                          />
                        </View>
                        {item.state === 'failed' && item.errorMessage ? (
                          <Text
                            style={{ color: theme.colors.danger, fontSize: 12 }}
                          >
                            {item.errorMessage}
                          </Text>
                        ) : null}
                      </View>
                    );
                  })}
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
                <Text style={{ color: theme.colors.textSecondary }}>
                  暂无分析任务
                </Text>
              )}
            </Card>

            <Card style={styles.card}>
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
                发起分析
              </Text>
              <Text
                style={[styles.hint, { color: theme.colors.textSecondary }]}
              >
                两种模式都会调用当前 LLM，并产出带原文证据、可审核的 Canon
                资料。快速续写只精读最后 30 章；完整 Canon 分析覆盖全部
                边界内原著。
              </Text>
              <View style={styles.row}>
                <Button
                  label="快速续写分析"
                  onPress={() => runAnalysis('fast_continuation')}
                  disabled={busy || !boundaryOk}
                />
                <Button
                  label="完整 Canon 分析"
                  onPress={() => runAnalysis('full_canon')}
                  disabled={busy || !boundaryOk}
                />
              </View>
            </Card>

            <Card style={styles.card}>
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
                Canon 资料
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
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    marginTop: spacing.xs,
  },
  progressFill: { height: '100%', borderRadius: 4 },
  materialProgress: { gap: 4, marginTop: spacing.xs },
  materialProgressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
});
