import React from 'react';
import { Alert, AppState, ImageBackground, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../components/ThemeProvider';
import { TabNavigator } from '../navigation/TabNavigator';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import {
  navigateToPipelineResult,
  navigateToPipelineTaskCenter,
  navigationRef,
} from '../navigation/navigationRef';
import { PipelineResultPrompt } from '../components/PipelineResultPrompt';
import Toast from 'react-native-toast-message';
import { openDatabase, lastInstallInfo } from '../services/database';
import { hasBreakingMigration } from '../services/migrations';
import { UpgradeScreen } from '../screens/UpgradeScreen';
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

  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        const runningTasks = usePipelineTaskStore.getState().tasks.filter(
          (t) => t.status === 'idle' || t.status === 'drafting' || t.status === 'reviewing' || t.status === 'proofing'
        );
        if (runningTasks.length > 0) {
          Alert.alert(
            '流水线任务提醒',
            `检测到 ${runningTasks.length} 个未完成的流水线任务。由于系统限制，切换应用可能导致任务中断。点击下方按钮查看任务中心。`,
            [
              { text: '知道了' },
              {
                text: '查看任务中心',
                onPress: () => { navigateToPipelineTaskCenter(); },
              },
            ],
          );
        }
      }
    });
    return () => subscription.remove();
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

    // Seed the prompted set with anything that was already terminal before
    // this effect ran (loaded from DB on app start). Skip auto-resolved
    // tasks (e.g. batch sub-tasks that were already handled).
    usePipelineTaskStore.getState().tasks.forEach((t) => {
      if (t.resolvedAt === null && (t.status === 'completed' || t.status === 'failed')) {
        prompted.add(t.id);
      }
    });

    const unsubscribe = usePipelineTaskStore.subscribe((state, prevState) => {
      // Only react to changes in the `tasks` array; if a write did not touch
      // any task (e.g. an unrelated setState in some future code), no-op.
      if (state.tasks === prevState.tasks) return;
      const tasks = state.tasks;
      // Find the most recent task whose terminal state hasn't been prompted.
      // We sort by updatedAt descending so the user is always shown the
      // freshest finished work first.
      const finished = tasks
        .filter((t: PipelineTask) =>
          // A task is only eligible to be prompted if:
          //  1. we have not surfaced it before, AND
          //  2. it has reached a terminal status (completed or failed), AND
          //  3. it has not been auto-resolved by a batch / batch-runner.
          // The resolvedAt guard is critical for the batch case: the
          // batchChapterPipeline marks every sub-task as resolved right
          // after completeTask so the per-chapter summary alert in
          // OutlineEditor stays canonical, and we must not pop the
          // global prompt for those.
          !prompted.has(t.id)
          && t.resolvedAt === null
          && (t.status === 'completed' || t.status === 'failed'),
        )
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
    return unsubscribe;
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
