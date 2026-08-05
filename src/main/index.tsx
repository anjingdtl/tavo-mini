import React from 'react';
import { AppState, ImageBackground, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../components/ThemeProvider';
import { TabNavigator } from '../navigation/TabNavigator';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import {
  navigateToPipelineResult,
  navigationRef,
} from '../navigation/navigationRef';
import { consumeSuppressedPipelinePrompt } from '../navigation/pipelinePromptSuppression';
import { PipelineResultPrompt } from '../components/PipelineResultPrompt';
import Toast from 'react-native-toast-message';
import { openDatabase, lastInstallInfo, lastSchemaRecovery } from '../services/database';
import { hasBreakingMigration } from '../services/migrations';
import { isSchemaRecoveryError } from '../data/schema/schemaRecoveryError';
import { useDatabaseRecoveryStore } from '../store/databaseRecoveryStore';
import { UpgradeScreen } from '../screens/UpgradeScreen';
import { PipelineForeground } from '../native/PipelineForegroundModule';
import { useSettingsStore } from '../store/settingsStore';
import appVersionJson from '../constants/version.json';
import type { PipelineTask } from '../types/pipeline';

const splashImage = require('../assets/splash.png');
const SPLASH_VISIBLE_MS = 1200;

export const App: React.FC = () => {
  const [showSplash, setShowSplash] = React.useState(true);
  const [upgradeVisible, setUpgradeVisible] = React.useState(false);
  const [upgradeStatus, setUpgradeStatus] = React.useState<'waiting' | 'migrating' | 'success' | 'error'>('waiting');
  const [upgradeError, setUpgradeError] = React.useState('');
  const [ready, setReady] = React.useState(false);
  // The most recent pipeline task we have surfaced to the user. Held in
  // state (not via Alert.alert) so we can dismiss it from the
  // navigateToPipelineResult call site and avoid the "prompt sticks
  // around after navigating" UX bug.
  const [pendingPrompt, setPendingPrompt] = React.useState<PipelineTask | null>(null);

  React.useEffect(() => {
    const init = async () => {
      // 8.2 修复：init 无 try-catch，openDatabase 抛错时 setReady 永不执行，App 永久卡白屏
      try {
        await openDatabase();
        // 必须在任何写作入口可用前同步后台开关。此前只有进入设置页时才调用
        // loadSettings，导致默认开启的前台服务桥接仍保持 false，流水线切后台即失去保活。
        await useSettingsStore.getState().loadSettings();
        // 流水线无法跨进程恢复执行：冷启动时任何 active 状态都属于上次已中断
        // 的运行，必须立即终态化，不能等 10 分钟 stale 窗口后继续卡住章节。
        await usePipelineTaskStore.getState().loadFromDB();
        const marked = usePipelineTaskStore.getState().markActiveTasksAsInterrupted();
        if (marked > 0) {
          console.log(
            `[App] cold-start cleanup: classified ${marked} interrupted pipeline task(s) (recoverable keep unresolved)`,
          );
        }
        // Continuation TXT import: a job left running/paused when the app was
        // killed must be terminally marked `interrupted` so the import UI can
        // surface a resume/cancel card and startContinuationImport won't
        // collide with the per-project unique index (Spec §14.2).
        try {
          const { recoverInterruptedJobs } = await import(
            '../services/continuation/continuationImportService'
          );
          const { recovered } = await recoverInterruptedJobs();
          if (recovered > 0) {
            console.log(`[App] cold-start cleanup: marked ${recovered} continuation import job(s) interrupted`);
          }
        } catch (e) {
          console.warn('[App] continuation import recovery skipped', e);
        }
        try {
          const {
            coldStartNormalizeContinuation,
            processContinuationOutbox,
          } = require('../services/continuation/generation');
          const ctMarked = await coldStartNormalizeContinuation();
          if (ctMarked > 0) {
            console.log(`[App] cold-start cleanup: marked ${ctMarked} continuation run/outbox item(s) interrupted`);
          }
          processContinuationOutbox({ limit: 10 }).catch((outboxError: unknown) => {
            console.warn('[App] continuation outbox processing skipped', outboxError);
          });
        } catch (e) {
          console.warn('[App] continuation cold-start normalize skipped', e);
        }
        try {
          const { pauseInterruptedRuns } = await import(
            '../services/continuation/canon'
          );
          const paused = await pauseInterruptedRuns();
          if (paused > 0) {
            await PipelineForeground.stop('canon-cold-start');
          }
        } catch (e) {
          console.warn('[App] Canon analysis cold-start normalize skipped', e);
        }
        const info = lastInstallInfo;

        // Surface the Schema 40 recovery state to resource screens.
        const recoveryState = lastSchemaRecovery;
        if (recoveryState) {
          useDatabaseRecoveryStore.getState().setRecovery(recoveryState);
          if (recoveryState.recallVerified && recoveryState.repaired) {
            const counts = recoveryState.afterCounts || {};
            Toast.show({
              type: 'success',
              text1: '本地资料已自动修复',
              text2: `角色卡 ${counts.characters ?? 0} · 世界书 ${counts.worldbook_entries ?? 0} · 章节 ${counts.chapters ?? 0}`,
              visibilityTime: 4000,
            });
          }
        }

        if (
          info?.installType === 'upgrade' &&
          info.previousVersion &&
          hasBreakingMigration(info.schemaVersion || 1)
        ) {
          setUpgradeVisible(true);
        } else {
          setReady(true);
          if (info?.installType === 'upgrade') {
            Toast.show({ type: 'info', text1: `已升级到 ${appVersionJson.versionName}`, visibilityTime: 1000 });
          }
        }
      } catch (error: any) {
        // Schema-recovery failures (backup failed, recall mismatch, repair
        // failed) must NOT silently show an empty UI. Surface the structured
        // error so the user knows their data is still in the DB / backup.
        if (isSchemaRecoveryError(error)) {
          useDatabaseRecoveryStore.getState().setError(error.code, error.message);
          Toast.show({
            type: 'error',
            text1: '本地资料数据库修复失败',
            text2: '原数据库和恢复备份已保留，请勿卸载或清除应用数据。',
            visibilityTime: 8000,
          });
          // Still mark ready so the user can see the error screen / export
          // the backup, but resource screens will read the error state and
          // show "资料暂时无法读取" instead of a fake empty list.
          setReady(true);
        } else {
          // 数据库初始化失败时仍标记 ready，让用户看到主界面（而非白屏），
          // 但通过 Toast 提示错误。后续 DB 操作会各自抛错。
          setReady(true);
          Toast.show({ type: 'error', text1: '数据库初始化失败', text2: error?.message });
        }
      }
    };

    const timer = setTimeout(() => {
      setShowSplash(false);
      init();
    }, SPLASH_VISIBLE_MS);

    return () => clearTimeout(timer);
  }, []);

  // Watch for newly-completed / failed pipeline tasks and surface a result
  // prompt. The original ChapterEditor-local `executeRunPipeline` only worked
  // when the user stayed on the screen; the navigation back from
  // ChapterEditor would unmount that closure and the result was lost in the
  // store. A root-level subscription makes the result reachable no matter
  // where the user is.
  React.useEffect(() => {
    // Track which taskIds have already been prompted in this session, so a
    // store reload (e.g. on app cold start) does not re-prompt historical
    // tasks.
    const prompted = new Set<string>();

    const seedPromptedFromCurrentState = () => {
      // BUG-10 强化：seed 时把已 batchResolved 的任务也加入 prompted，避免冷启动时再次弹出全局 prompt
      usePipelineTaskStore.getState().tasks.forEach((t) => {
        const isBatchResolved = t.resolvedAction === 'accept' || t.resolvedAction === 'reject';
        if (isBatchResolved) {
          prompted.add(t.id);
        } else if (t.resolvedAt === null && (t.status === 'completed' || t.status === 'failed')) {
          prompted.add(t.id);
        }
      });
    };
    seedPromptedFromCurrentState();

    const unsubscribe = usePipelineTaskStore.subscribe((state, prevState) => {
      // Only react to changes in the `tasks` array; if a write did not touch
      // any task (e.g. an unrelated setState in some future code), no-op.
      if (state.tasks === prevState.tasks) return;
      const tasks = state.tasks;
      // Find the most recent task whose terminal state hasn't been prompted.
      // We sort by updatedAt descending so the user is always shown the
      // freshest finished work first.
      const finished = tasks
        .filter((t: PipelineTask) => {
          // A task is only eligible to be prompted if:
          //  1. we have not surfaced it before, AND
          //  2. it has reached a terminal status (completed or failed), AND
          //  3. it has not been auto-resolved by a batch / batch-runner.
          // The resolvedAt guard is critical for the batch case: the
          // batchChapterPipeline marks every sub-task as resolved right
          // after completeTask so the per-chapter summary alert in
          // OutlineEditor stays canonical, and we must not pop the
          // global prompt for those.
          const isEligible = !prompted.has(t.id)
            && t.resolvedAt === null
            && (t.status === 'completed' || t.status === 'failed');
          if (!isEligible) return false;
          if (consumeSuppressedPipelinePrompt(t.id)) {
            prompted.add(t.id);
            return false;
          }
          return true;
        })
        .sort((a: PipelineTask, b: PipelineTask) => b.updatedAt - a.updatedAt);
      if (finished.length === 0) return;
      const task = finished[0];
      prompted.add(task.id);
      // Render via a controlled React Modal (see PipelineResultPrompt)
      // instead of Alert.alert. Native Alerts stick around on top of any
      // screen the user navigates to, which made the prompt feel like it
      // was re-firing on every navigation. A controlled modal can be
      // dismissed in lockstep with the result-screen navigation.
      setPendingPrompt(task);
    });

    // 回前台时的恢复策略：
    //  1. 若任务 updatedAt 在最近 10 分钟内（仍在合理运行窗口），不立即判死。
    //  2. 超过 10 分钟仍无更新的任务才视为真停滞，标 failed（自愈，静默不弹窗）。
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const marked = usePipelineTaskStore.getState().markStaleTasksAsFailed();
      if (marked > 0) {
        seedPromptedFromCurrentState();
        // 同时清空已经在 pending 的同类弹窗（如果有的话）
        setPendingPrompt((prev) => {
          if (!prev) return prev;
          if (prompted.has(prev.id)) return null;
          return prev;
        });
      }
    });

    return () => {
      unsubscribe();
      appStateSub.remove();
    };
  }, []);

  const handleUpgradeConfirm = React.useCallback(async () => {
    setUpgradeStatus('migrating');
    try {
      const { runMigrations } = require('../services/migrations');
      const { createBackup } = require('../services/backupService');
      const database = await openDatabase();
      const fromSchema = lastInstallInfo?.schemaVersion || 1;
      await runMigrations(database, fromSchema, async () => {
        return createBackup(database, lastInstallInfo?.previousVersion || '', fromSchema, 'automatic');
      });
      setUpgradeStatus('success');
      setTimeout(() => {
        setUpgradeVisible(false);
        setReady(true);
      }, 1000);
    } catch (err: any) {
      setUpgradeStatus('error');
      setUpgradeError(err?.message || '未知错误');
    }
  }, []);

  // 处理通知点击 deep link：App 启动或从后台恢复时，读取原生暂存的
  // taskId（由 MainActivity 从通知 intent extra 写入 PipelineForegroundModule），
  // 若存在则导航到对应任务的 PipelineResult。
  React.useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    // 8.17 修复：保存 timer id 在 cleanup 中 clearTimeout，避免 ready 变化时旧 timer 仍执行
    let navTimer: ReturnType<typeof setTimeout> | null = null;
    const consume = async () => {
      const taskId = await PipelineForeground.consumeDeepLinkTaskId();
      if (cancelled || !taskId) return;
      // 等待导航容器就绪后再跳转
      navTimer = setTimeout(() => navigateToPipelineResult(taskId), 100);
    };
    consume();
    return () => {
      cancelled = true;
      if (navTimer) clearTimeout(navTimer);
    };
  }, [ready]);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        {showSplash ? (
          <ImageBackground source={splashImage} style={styles.splash} resizeMode="cover" />
        ) : (
          <>
            <UpgradeScreen
              visible={upgradeVisible}
              fromVersion={lastInstallInfo?.previousVersion || ''}
              toVersion={appVersionJson.versionName.replace(/^V/, '')}
              onConfirm={handleUpgradeConfirm}
              status={upgradeStatus}
              errorMessage={upgradeError}
            />
            {ready && (
              <NavigationContainer ref={navigationRef}>
                <TabNavigator />
              </NavigationContainer>
            )}
          </>
        )}
        <PipelineResultPrompt
          task={pendingPrompt}
          onDismiss={() => { setPendingPrompt(null); }}
          onViewResult={(taskId) => {
            // Dismiss *before* navigation so the modal does not flash on
            // top of the result screen for a frame.
            setPendingPrompt(null);
            navigateToPipelineResult(taskId);
          }}
        />
        <Toast />
      </ThemeProvider>
    </SafeAreaProvider>
  );
};

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#071827',
  },
});
