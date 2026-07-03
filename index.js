import { AppRegistry, LogBox } from 'react-native';
import { App } from './src/main/index';
import { name as appName } from './app.json';

// BUG-5 修复：debug 构建下 LogBox 警告条会浮在屏幕底部 y=2168-2295 完全覆盖 Tab 栏
// (y=2215-2361)，拦截所有 Tab 点击。debug 包上手测时直接屏蔽 LogBox，让 UI 不被遮挡。
// 生产包本来就不会有 LogBox，所以这是纯 debug 期改善。
if (__DEV__) {
  LogBox.ignoreAllLogs(true);
}

AppRegistry.registerComponent(appName, () => App);
