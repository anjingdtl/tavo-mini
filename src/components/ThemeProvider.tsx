import React, { useEffect } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import * as db from '../services/database';
import { useThemeStore } from '../store/themeStore';
import type { ThemeMode } from '../types/theme';

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { theme, setMode } = useThemeStore();
  const barStyle = theme.mode === 'dark' ? 'light-content' : 'dark-content';

  useEffect(() => {
    // 8.18 修复：db.getSetting 无 .catch，失败时 unhandled rejection
    db.getSetting('theme_mode').then((value) => {
      if (value === 'light' || value === 'dark' || value === 'eyecare') {
        setMode(value as ThemeMode);
      }
    }).catch((error) => {
      console.warn('[ThemeProvider] 读取主题模式失败:', error);
    });
  }, [setMode]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StatusBar barStyle={barStyle} backgroundColor={theme.colors.background} />
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
});
