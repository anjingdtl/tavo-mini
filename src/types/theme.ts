export type ThemeMode = 'light' | 'dark' | 'eyecare';

export interface ThemeColors {
  background: string;
  surface: string;
  card: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  danger: string;
  success: string;
  warning: string;
  border: string;
}

export interface AppTheme {
  mode: ThemeMode;
  colors: ThemeColors;
}
