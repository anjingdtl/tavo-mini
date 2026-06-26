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
import { openDatabase, lastInstallInfo } from '../services/database';
import { hasBreakingMigration } from '../services/migrations';
import { UpgradeScreen } from '../screens/UpgradeScreen';
import { PipelineForeground } from '../native/PipelineForegroundModule';
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
      await openDatabase();
      const info = lastInstallInfo;

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
      usePipelineTaskStore.getState().tasks.forEach((t) => {
        if (t.resolvedAt === null && (t.status === 'completed' || t.status === 'failed')) {
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

    // 回前台时：1) 把僵尸任务（被系统挂起导致 fetch 永不返回）标 failed；
    // 2) 重新 seed prompted，避免刚刚被 mark 的任务立即弹窗（因为是自愈触发，
    //    不是用户当前会话感知到的失败，应当静默）。
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
    const consume = async () => {
      const taskId = await PipelineForeground.consumeDeepLinkTaskId();
      if (cancelled || !taskId) return;
      // 等待导航容器就绪后再跳转
      setTimeout(() => navigateToPipelineResult(taskId), 100);
    };
    consume();
    return () => { cancelled = true; };
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
