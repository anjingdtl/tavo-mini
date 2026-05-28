import { create } from 'zustand';
import type { AppTheme, ThemeColors, ThemeMode } from '../types/theme';

const lightColors: ThemeColors = {
  background: '#F6F8FA',
  surface: '#FFFFFF',
  card: '#FFFFFF',
  textPrimary: '#172026',
  textSecondary: '#52616B',
  textMuted: '#84919A',
  accent: '#2563EB',
  accentSoft: '#DBEAFE',
  danger: '#DC2626',
  success: '#059669',
  warning: '#D97706',
  border: '#D8E0E7',
};

const darkColors: ThemeColors = {
  background: '#101418',
  surface: '#171D22',
  card: '#1E252B',
  textPrimary: '#F3F6F8',
  textSecondary: '#B4C0C8',
  textMuted: '#7F8B94',
  accent: '#60A5FA',
  accentSoft: '#1E3A5F',
  danger: '#F87171',
  success: '#34D399',
  warning: '#FBBF24',
  border: '#2C3740',
};

const eyecareColors: ThemeColors = {
  background: '#F3F6EF',
  surface: '#FCFDF8',
  card: '#FFFFFF',
  textPrimary: '#263229',
  textSecondary: '#61705F',
  textMuted: '#899681',
  accent: '#2F7D62',
  accentSoft: '#DDECE4',
  danger: '#B42318',
  success: '#2F7D62',
  warning: '#A15C07',
  border: '#D8E4D4',
};

function getThemeColors(mode: ThemeMode): ThemeColors {
  if (mode === 'dark') return darkColors;
  if (mode === 'eyecare') return eyecareColors;
  return lightColors;
}

interface ThemeState {
  mode: ThemeMode;
  theme: AppTheme;
  setMode: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: 'light',
  theme: { mode: 'light', colors: lightColors },
  setMode: (mode) => set({ mode, theme: { mode, colors: getThemeColors(mode) } }),
}));
