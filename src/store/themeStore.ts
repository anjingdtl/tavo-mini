import { create } from 'zustand';
import type { AppTheme, ThemeColors, ThemeMode } from '../types/theme';

const lightColors: ThemeColors = {
  background: '#F5F0E6',
  surface: '#FBF8F1',
  card: '#FFFCF5',
  textPrimary: '#2D2924',
  textSecondary: '#6C665E',
  textMuted: '#9B9488',
  accent: '#758B72',
  accentSoft: '#E5EBE1',
  danger: '#B84B3E',
  success: '#758B72',
  warning: '#A56F39',
  border: '#D9D0C2',
};

const darkColors: ThemeColors = {
  background: '#111916',
  surface: '#18201B',
  card: '#222A23',
  textPrimary: '#F3EAD7',
  textSecondary: '#C3BBA8',
  textMuted: '#9D9A8B',
  accent: '#C8AA72',
  accentSoft: '#39443A',
  danger: '#DE766B',
  success: '#A8BE9C',
  warning: '#D6A865',
  border: '#4C5448',
};

const eyecareColors: ThemeColors = {
  background: '#EDF2E7',
  surface: '#F7F8F0',
  card: '#FCFDF7',
  textPrimary: '#334033',
  textSecondary: '#687766',
  textMuted: '#8A9A87',
  accent: '#6E8D70',
  accentSoft: '#DDE8D9',
  danger: '#A93D36',
  success: '#6E8D70',
  warning: '#9D6B2F',
  border: '#CCDACA',
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
