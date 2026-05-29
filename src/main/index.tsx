import React from 'react';
import { Alert, AppState, ImageBackground, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../components/ThemeProvider';
import { TabNavigator } from '../navigation/TabNavigator';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import Toast from 'react-native-toast-message';

const splashImage = require('../assets/splash.png');
const SPLASH_VISIBLE_MS = 1200;

export const App: React.FC = () => {
  const [showSplash, setShowSplash] = React.useState(true);

  React.useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), SPLASH_VISIBLE_MS);
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

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        {showSplash ? (
          <ImageBackground
            source={splashImage}
            style={styles.splash}
            resizeMode="cover"
          />
        ) : (
          <NavigationContainer>
            <TabNavigator />
          </NavigationContainer>
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
