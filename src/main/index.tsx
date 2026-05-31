import React from 'react';
import { Alert, AppState, ImageBackground, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../components/ThemeProvider';
import { TabNavigator } from '../navigation/TabNavigator';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import Toast from 'react-native-toast-message';
import { openDatabase, lastInstallInfo } from '../services/database';
import { hasBreakingMigration } from '../services/migrations';
import { UpgradeScreen } from '../screens/UpgradeScreen';
import appVersionJson from '../constants/version.json';

const splashImage = require('../assets/splash.png');
const SPLASH_VISIBLE_MS = 1200;

export const App: React.FC = () => {
  const [showSplash, setShowSplash] = React.useState(true);
  const [upgradeVisible, setUpgradeVisible] = React.useState(false);
  const [upgradeStatus, setUpgradeStatus] = React.useState<'waiting' | 'migrating' | 'success' | 'error'>('waiting');
  const [upgradeError, setUpgradeError] = React.useState('');
  const [ready, setReady] = React.useState(false);

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
            '检测到未完成的流水线任务。由于系统限制，切换应用可能导致任务中断。请检查任务中心确认状态。',
            [{ text: '知道了' }],
          );
        }
      }
    });
    return () => subscription.remove();
  }, []);

  const handleUpgradeConfirm = React.useCallback(async () => {
    setUpgradeStatus('migrating');
    try {
      const { runMigrations } = require('../services/migrations');
      const { createBackup } = require('../services/backupService');
      const database = await openDatabase();
      const fromSchema = lastInstallInfo?.schemaVersion || 1;
      await runMigrations(database, fromSchema, async () => {
        return createBackup(database, lastInstallInfo?.previousVersion || '', String(fromSchema));
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
              <NavigationContainer>
                <TabNavigator />
              </NavigationContainer>
            )}
          </>
        )}
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
