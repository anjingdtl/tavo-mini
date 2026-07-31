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
  activateSnapshotAndStyleProfile,
  getAnalysisOverview,
  getAnalysisWorkItems,
  ANALYSIS_MATERIAL_LABELS,
  cancelAnalysis,
  getHistoricalDigestCoverage,
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
import {
  getActiveStyleProfileId,
  listStyleProfilesForProject,
  updateStyleProfileReviewStatus,
  type ContinuationStyleProfileRow,
} from '../../../services/continuation/styleProfile/styleProfileRepository';
import { retryStyleAnalysis } from '../../../services/continuation/styleProfile/styleAnalysisService';
import { STYLE_ANALYZER_VERSION } from '../../../services/continuation/styleProfile/styleAnalysisPrompt';
import type { OriginalStyleProfileV2 } from '../../../services/continuation/styleProfile/styleProfileV2Schema';
import { runStatusLabel } from './runStatusLabel';
import { PipelineForeground } from '../../../native/PipelineForegroundModule';
import { requestNotificationPermission } from '../../../utils/notificationPermission';

type StyleUiState =
  | 'none'
  | 'analyzing'
  | 'failed'
  | 'ready'
  | 'outdated'
  | 'ignored';

const STYLE_UI_LABELS: Record<StyleUiState, string> = {
  none: '未分析',
  analyzing: '分析中',
  failed: '失败',
  ready: '就绪',
  outdated: '过期',
  ignored: '已忽略',
};

function pickStyleProfile(
  profiles: ContinuationStyleProfileRow[],
  latestRun: AnalysisRun | null,
  activeSnapshotId: string | null,
): ContinuationStyleProfileRow | null {
  if (!profiles.length) return null;
  if (latestRun?.canonSnapshotId) {
    const match = profiles.find(
      p => p.canonSnapshotId === latestRun.canonSnapshotId,
    );
    if (match) return match;
  }
  if (activeSnapshotId) {
    const match = profiles.find(p => p.canonSnapshotId === activeSnapshotId);
    if (match) return match;
  }
  return profiles[0] ?? null;
}

function resolveStyleUiState(
  row: ContinuationStyleProfileRow | null,
  latestRun: AnalysisRun | null,
): StyleUiState {
  if (row?.reviewStatus === 'ignored') return 'ignored';
  if (row) {
    if (row.state === 'queued' || row.state === 'running') return 'analyzing';
    if (
      row.state === 'failed' ||
      row.state === 'interrupted' ||
      row.state === 'cancelled'
    ) {
      return 'failed';
    }
    if (
      row.state === 'outdated' ||
      row.analyzerVersion !== STYLE_ANALYZER_VERSION
    ) {
      return 'outdated';
    }
    if (row.state === 'ready') return 'ready';
  }
  if (
    latestRun &&
    ['queued', 'running'].includes(latestRun.state) &&
    (latestRun.stage === 'style_analysis' ||
      latestRun.stage === 'style_validation')
  ) {
    return 'analyzing';
  }
  if (
    latestRun?.state === 'failed' &&
    (latestRun.stage === 'style_analysis' ||
      latestRun.stage === 'style_validation')
  ) {
    return 'failed';
  }
  return 'none';
}

function asV2Profile(
  json: Record<string, unknown> | null | undefined,
): OriginalStyleProfileV2 | null {
  if (!json || typeof json !== 'object') return null;
  if ((json as { schemaVersion?: number }).schemaVersion !== 2) return null;
  return json as unknown as OriginalStyleProfileV2;
}

const RUN_STATE_LABELS: Record<AnalysisRun['state'], string> = {
  queued: '排队中',
  running: '分析中',
  awaiting_review: '待审核激活',
  paused: '已暂停',
  failed: '失败',
  cancelled: '已取消',
  completed: '已完成',
  outdated: '已失效',
};

const RUN_STAGE_LABELS: Record<AnalysisRun['stage'], string> = {
  snapshot: '读取原著',
  chapter_extraction: '章节提取',
  entity_resolution: '资料归并',
  temporal_merge: '时序归并',
  global_synthesis: '全局归纳',
  evidence_validation: '证据校验',
  indexing: '建立索引',
  finalizing: '结果整理',
  style_analysis: '原著风格分析',
  style_validation: '风格校验',
};

const ANALYSIS_PROFILE_LABELS: Record<AnalysisRun['profile'], string> = {
  quick: '快速分析',
  standard: '标准分析',
  deep: '深度分析',
};

function coverageReasonLabel(reason: string): string {
  if (reason === 'partial_chapter_coverage') return '本次仅分析了部分章节';
  return '仍有部分原著章节未覆盖';
}

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
  const [historicalCoverage, setHistoricalCoverage] = useState({
    readyDigestCount: 0,
    readyChapterCount: 0,
    ranges: [] as Array<{ startPosition: number; endPosition: number }>,
  });
  const [historicalProgress, setHistoricalProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [styleProfile, setStyleProfile] =
    useState<ContinuationStyleProfileRow | null>(null);
  const [activeStyleProfileId, setActiveStyleProfileId] = useState<
    string | null
  >(null);

  const reload = useCallback(async () => {
    if (!currentProject) {
      setLoading(false);
      return;
    }
    try {
      const [overview, ready, historyCoverage, styleProfiles, activeStyleId] =
        await Promise.all([
          getAnalysisOverview(currentProject.id),
          isBoundaryReady(currentProject.id),
          getHistoricalDigestCoverage(currentProject.id),
          listStyleProfilesForProject(currentProject.id).catch(() => []),
          getActiveStyleProfileId(currentProject.id).catch(() => null),
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
      const run = overview.latestRun
        ? { ...overview.latestRun, progressCurrent: completedCount }
        : null;
      setLatestRun(run);
      setWorkItems(items);
      setBoundaryOk(ready);
      setHistoricalCoverage(historyCoverage);
      setActiveStyleProfileId(activeStyleId);
      setStyleProfile(
        pickStyleProfile(
          styleProfiles,
          run,
          overview.activeSnapshot?.id ?? null,
        ),
      );
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
      fast ? '开始快速续写分析' : '开始完整原著分析',
      fast
        ? '将调用当前模型精读续写起点前最后 30 章，生成带原文证据的结构化原著资料。每个章节批次会生成「人物与状态」及「世界观与剧情」两组资料；更早章节可由历史概览补充。\n\n分析过程可暂停或取消。'
        : '将调用当前模型分析续写起点之前的全部原著章节，生成带原文证据的结构化原著资料。完整分析耗时与用量更高。\n\n分析过程可暂停或取消。',
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
                  const suffix = update.llmActive ? ' · 正在生成…' : '';
                  void PipelineForeground.updateProgress(
                    runId,
                    `第 ${(update.batchIndex ?? 0) + 1} 批 · ${material}${suffix}`,
                    percent,
                  );
                  // Heartbeat updates carry no new DB state — skip the reload
                  // so the 1s polling timer stays the only source of truth for
                  // progress numbers.
                  if (!update.llmActive) {
                    void reload();
                  }
                },
              });
              await PipelineForeground.stop(runId);
              if (run.state !== 'completed') {
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
                '原著资料已自动启用，可按需删除或调整个别资料。',
              );
              Toast.show({
                type: 'success',
                text1: '分析完成',
                text2: '原著资料已自动启用',
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
  const needsActivation =
    !!latestRun &&
    ['awaiting_review', 'completed'].includes(latestRun.state) &&
    active?.id !== latestRun.canonSnapshotId;
  const displayedRunStatus =
    latestRun && active?.id === latestRun.canonSnapshotId
      ? '分析完成，已启用为当前原著资料'
      : latestRun
      ? runStatusLabel(latestRun, workItems)
      : '';
  const historicalTargetChapterCount = active
    ? Math.max(
        0,
        active.coverage.sourceChapterCount -
          active.coverage.analyzedChapterCount,
      )
    : 0;
  const historicalCoverageComplete =
    historicalTargetChapterCount > 0 &&
    historicalCoverage.readyChapterCount >= historicalTargetChapterCount;
  const formatRange = (range: { startPosition: number; endPosition: number }) =>
    `第 ${range.startPosition + 1}–${range.endPosition} 章`;
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
      if (run.state === 'completed') {
        await PipelineForeground.notifyComplete(
          `ca:${latestRun.id}`,
          '原著分析完成',
          '原著资料已自动启用。',
        );
      }
      await reload();
    } catch (e: any) {
      await PipelineForeground.stop(latestRun.id);
      Toast.show({ type: 'error', text1: '继续失败', text2: e?.message });
    }
  };

  const styleUiState = resolveStyleUiState(styleProfile, latestRun);
  const styleV2 = asV2Profile(styleProfile?.profileJson);
  const injectableStyleId =
    styleProfile &&
    styleProfile.state === 'ready' &&
    styleProfile.reviewStatus !== 'ignored'
      ? styleProfile.id
      : null;

  const handleActivate = async () => {
    if (!currentProject || !latestRun) return;
    const styleProfileId = injectableStyleId;
    if (!styleProfileId) {
      Alert.alert(
        '风格画像未就绪',
        '原著续写必须启用有效的原著风格画像。请先完成或单独重试风格分析，再启用原著资料。',
      );
      return;
    }
    setBusy(true);
    try {
      await activateSnapshotAndStyleProfile({
        projectId: currentProject.id,
        analysisRunId: latestRun.id,
        canonSnapshotId: latestRun.canonSnapshotId,
        styleProfileId,
        allowStyleSkip: false,
      });
      Toast.show({
        type: 'success',
        text1: '原著资料与风格已启用',
      });
      await reload();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '激活失败', text2: e?.message });
    } finally {
      setBusy(false);
    }
  };

  const handleRetryStyle = () => {
    if (!currentProject) return;
    Alert.alert(
      '单独重试风格分析',
      '将基于当前原著边界重新分析写作风格，并保留你已保存的用户修正。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '开始',
          onPress: async () => {
            setBusy(true);
            try {
              await retryStyleAnalysis(currentProject.id);
              Toast.show({ type: 'success', text1: '风格分析已完成' });
              await reload();
            } catch (e: any) {
              Toast.show({
                type: 'error',
                text1: '风格分析失败',
                text2: e?.message,
              });
              await reload();
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const handleRestoreStyle = async () => {
    if (!styleProfile) return;
    try {
      await updateStyleProfileReviewStatus(styleProfile.id, 'confirmed');
      Toast.show({ type: 'success', text1: '已恢复使用风格画像' });
      await reload();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const buildHistoricalDigests = () => {
    if (!currentProject || !active) return;
    Alert.alert(
      '生成历史概览',
      '将为未进入近端原著分析的早期章节建立本地候选索引，并按当前模型的上下文容量自动分组生成历史概览。历史概览仅供参考，不能替代原文证据。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '开始生成',
          onPress: async () => {
            setBusy(true);
            const taskId = `history:${currentProject.id}:${Date.now()}`;
            let foregroundStarted = false;
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
              setHistoricalProgress({
                current: 0,
                total: queued.digestIds.length,
              });
              await requestNotificationPermission().catch(() => false);
              await PipelineForeground.start(
                taskId,
                '历史概览生成中',
                `0/${queued.digestIds.length} 组历史概览`,
                0,
              );
              foregroundStarted = true;
              for (const [index, digestId] of queued.digestIds.entries()) {
                await processHistoricalDigest(digestId);
                const current = index + 1;
                const percent = Math.round(
                  (current / queued.digestIds.length) * 100,
                );
                setHistoricalProgress({
                  current,
                  total: queued.digestIds.length,
                });
                await PipelineForeground.updateProgress(
                  taskId,
                  `第 ${current}/${queued.digestIds.length} 组历史概览`,
                  percent,
                );
              }
              await PipelineForeground.notifyComplete(
                taskId,
                '历史概览已生成',
                `已索引 ${queued.indexedChapterCount} 个早期章节。`,
              );
              Toast.show({
                type: 'success',
                text1: '历史概览已生成',
                text2: '已索引 ' + queued.indexedChapterCount + ' 个早期章节',
              });
            } catch (e: any) {
              if (foregroundStarted) {
                await PipelineForeground.notifyFailed(
                  taskId,
                  '历史概览生成失败',
                  '请检查模型配置后重新生成。',
                );
              }
              Toast.show({
                type: 'error',
                text1: '历史概览生成失败',
                text2: e?.message,
              });
            } finally {
              if (foregroundStarted) await PipelineForeground.stop(taskId);
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
                当前启用的原著资料
              </Text>
              {active ? (
                <>
                  <Text style={{ color: theme.colors.textSecondary }}>
                    快照 {active.id.slice(0, 8)}… · 版本 {active.revision} ·{' '}
                    {ANALYSIS_PROFILE_LABELS[active.profile]}
                  </Text>
                  <Text style={{ color: theme.colors.textSecondary }}>
                    分析边界：第 {active.boundaryPosition + 1} 章
                  </Text>
                  <Text style={{ color: theme.colors.textSecondary }}>
                    精读原著资料：覆盖 {active.coverage.analyzedChapterCount}/
                    {active.coverage.sourceChapterCount} 章
                  </Text>
                  {historicalTargetChapterCount > 0 && (
                    <Text style={{ color: theme.colors.warning || '#b45309' }}>
                      历史概览：已覆盖 {historicalCoverage.readyChapterCount}/
                      {historicalTargetChapterCount} 个未精读章节
                      {historicalCoverage.ranges.length
                        ? `（${historicalCoverage.ranges
                            .map(formatRange)
                            .join('、')}，仅作参考）`
                        : '（尚未生成）'}
                    </Text>
                  )}
                  {historicalTargetChapterCount > 0 &&
                    !historicalCoverageComplete && (
                      <Button
                        label={
                          historicalCoverage.readyChapterCount > 0
                            ? '补生成历史概览'
                            : '生成历史概览'
                        }
                        variant="ghost"
                        onPress={buildHistoricalDigests}
                        disabled={busy}
                      />
                    )}
                  {historicalProgress && (
                    <View style={styles.historicalProgress}>
                      <Text style={{ color: theme.colors.textSecondary }}>
                        历史概览进度 {historicalProgress.current}/
                        {historicalProgress.total} 组
                      </Text>
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
                              width: `${Math.round(
                                (historicalProgress.current /
                                  historicalProgress.total) *
                                  100,
                              )}%`,
                            },
                          ]}
                        />
                      </View>
                    </View>
                  )}
                  {active.profile === 'quick' && (
                    <Text style={{ color: theme.colors.warning || '#b45309' }}>
                      旧版快速离线预览不能用于续写；请重新进行模型分析。
                    </Text>
                  )}
                  {active.coverage.incompleteReasons.length > 0 &&
                    !historicalCoverageComplete && (
                      <Text
                        style={{ color: theme.colors.warning || '#b45309' }}
                      >
                        覆盖说明：
                        {active.coverage.incompleteReasons
                          .map(coverageReasonLabel)
                          .join('；')}
                      </Text>
                    )}
                </>
              ) : (
                <Text style={{ color: theme.colors.textSecondary }}>
                  尚未启用原著资料。请在分析完成后于下方审核并启用。
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
                    状态 {RUN_STATE_LABELS[latestRun.state]} · 阶段{' '}
                    {RUN_STAGE_LABELS[latestRun.stage]}
                  </Text>
                  <Text style={{ color: theme.colors.textSecondary }}>
                    进度 {displayedProgressCurrent}/{latestRun.progressTotal} ·{' '}
                    {ANALYSIS_PROFILE_LABELS[latestRun.profile]}
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
                        {progressPercent}% · {displayedRunStatus}
                      </Text>
                    </>
                  )}
                  {needsActivation && (
                    <Button
                      label="审核并启用原著资料"
                      onPress={() => {
                        void handleActivate();
                      }}
                      disabled={busy}
                    />
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
                两种模式都会调用当前模型，并产出带原文证据、可审核的原著资料。
                快速续写只精读最后 30 章；完整原著分析覆盖全部 边界内原著。
              </Text>
              <View style={styles.row}>
                <Button
                  label="快速续写分析"
                  onPress={() => runAnalysis('fast_continuation')}
                  disabled={busy || !boundaryOk}
                />
                <Button
                  label="完整原著分析"
                  onPress={() => runAnalysis('full_canon')}
                  disabled={busy || !boundaryOk}
                />
              </View>
            </Card>

            <Card style={styles.card}>
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
                原著写作风格
              </Text>
              <Text style={{ color: theme.colors.textSecondary }}>
                状态：{STYLE_UI_LABELS[styleUiState]}
              </Text>
              {styleProfile ? (
                <>
                  <Text style={{ color: theme.colors.textSecondary }}>
                    分析范围：第 1–{styleProfile.boundaryPosition + 1}{' '}
                    章（边界内）
                  </Text>
                  {styleV2?.coverage?.sampledChapterCount != null ? (
                    <Text style={{ color: theme.colors.textSecondary }}>
                      抽样章节：{styleV2.coverage.sampledChapterCount}
                      {styleV2.coverage.sourceChapterCount
                        ? ` / ${styleV2.coverage.sourceChapterCount}`
                        : ''}
                      章
                    </Text>
                  ) : null}
                  <Text style={{ color: theme.colors.textSecondary }}>
                    置信度 {Math.round((styleProfile.confidence || 0) * 100)}%
                  </Text>
                  {styleV2?.summary ? (
                    <Text
                      style={{
                        color: theme.colors.textPrimary,
                        lineHeight: 20,
                      }}
                      numberOfLines={3}
                    >
                      {styleV2.summary}
                    </Text>
                  ) : null}
                  {styleV2?.boundaryLocalDelta ? (
                    <Text style={{ color: theme.colors.textSecondary }}>
                      边界附近：
                      {[
                        styleV2.boundaryLocalDelta.tone,
                        styleV2.boundaryLocalDelta.pacing,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '无显著增量'}
                    </Text>
                  ) : null}
                  {styleV2?.characterVoices?.length ? (
                    <Text style={{ color: theme.colors.textSecondary }}>
                      人物口吻：{styleV2.characterVoices.length} 个
                    </Text>
                  ) : null}
                  <Text style={{ color: theme.colors.textSecondary }}>
                    分析器 {styleProfile.analyzerVersion}
                    {styleProfile.completedAt || styleProfile.updatedAt
                      ? ` · ${
                          styleProfile.completedAt || styleProfile.updatedAt
                        }`
                      : ''}
                  </Text>
                  {styleProfile.errorMessage ? (
                    <Text style={{ color: theme.colors.danger }}>
                      {styleProfile.errorMessage}
                    </Text>
                  ) : null}
                </>
              ) : (
                <Text style={{ color: theme.colors.textSecondary }}>
                  {styleUiState === 'analyzing'
                    ? '正在分析原著写作风格…'
                    : '尚未生成风格画像。Canon 分析完成后会自动运行；也可单独重试。'}
                </Text>
              )}
              <View style={styles.row}>
                {styleProfile ? (
                  <Button
                    label="查看详情"
                    variant="ghost"
                    onPress={() =>
                      navigation.navigate('StyleProfileDetail', {
                        profileId: styleProfile.id,
                      })
                    }
                  />
                ) : null}
                {styleProfile ? (
                  <Button
                    label="编辑修正"
                    variant="ghost"
                    onPress={() =>
                      navigation.navigate('StyleProfileDetail', {
                        profileId: styleProfile.id,
                      })
                    }
                  />
                ) : null}
                {(styleUiState === 'failed' ||
                  styleUiState === 'none' ||
                  styleUiState === 'outdated') && (
                  <Button
                    label="单独重试"
                    variant="ghost"
                    onPress={handleRetryStyle}
                    disabled={busy}
                  />
                )}
                {styleUiState === 'ready' &&
                  injectableStyleId !== activeStyleProfileId && (
                    <Button
                      label="启用原著风格"
                      variant="ghost"
                      onPress={() => {
                        void handleActivate();
                      }}
                      disabled={busy}
                    />
                  )}
                {styleUiState === 'ignored' && (
                  <Button
                    label="恢复"
                    variant="ghost"
                    onPress={() => {
                      void handleRestoreStyle();
                    }}
                    disabled={busy}
                  />
                )}
              </View>
            </Card>

            <Card style={styles.card}>
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
                原著资料
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
  historicalProgress: { gap: 4, marginTop: spacing.xs },
  materialProgressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
});
