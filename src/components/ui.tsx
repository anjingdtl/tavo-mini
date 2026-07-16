import React from 'react';
import {
  ActivityIndicator,
  GestureResponderEvent,
  ImageBackground,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TouchableOpacity,
  View,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LucideIcon } from 'lucide-react-native';
import { useThemeStore } from '../store/themeStore';

const bookishPaperBackground = require('../assets/bookish-paper-bg.png');
const bookishDarkBackground = require('../assets/bookish-dark-bg.png');
const bookishEyecareBackground = require('../assets/bookish-eyecare-bg.png');

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

export function Screen({
  children,
  padded = false,
  showPaperBackdrop = true,
}: {
  children: React.ReactNode;
  padded?: boolean;
  showPaperBackdrop?: boolean;
}) {
  const { theme } = useThemeStore();
  const insets = useSafeAreaInsets();
  const topPadding = insets.top + (padded ? spacing.lg : 0);
  const useBackdrop = showPaperBackdrop;
  const backdropSource =
    theme.mode === 'dark'
      ? bookishDarkBackground
      : theme.mode === 'eyecare'
        ? bookishEyecareBackground
        : bookishPaperBackground;
  const content = (
    <View
      style={[
        styles.screen,
        { paddingTop: topPadding },
        padded && styles.padded,
      ]}
    >
      {children}
    </View>
  );

  if (useBackdrop) {
    return (
      <ImageBackground
        source={backdropSource}
        resizeMode="cover"
        imageStyle={styles.backdropImage}
        style={styles.screen}
      >
        {content}
      </ImageBackground>
    );
  }

  return content;
}

export function Header({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  const { theme } = useThemeStore();
  return (
    <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: theme.colors.textPrimary }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  );
}

export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  const { theme } = useThemeStore();
  return (
    <View style={styles.section}>
      {title ? <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { theme } = useThemeStore();
  return <View style={[styles.card, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }, style]}>{children}</View>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  icon: Icon,
  compact = false,
  flex = false,
  minWidth = 0,
}: {
  label: string;
  onPress?: (event: GestureResponderEvent) => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  icon?: LucideIcon;
  compact?: boolean;
  flex?: boolean;
  minWidth?: number;
}) {
  const { theme } = useThemeStore();
  const background =
    variant === 'primary'
      ? theme.colors.accent
      : variant === 'danger'
        ? theme.colors.danger
        : variant === 'secondary'
          ? theme.colors.accentSoft
          : 'transparent';
  const foreground = variant === 'primary' || variant === 'danger' ? '#FFFCF5' : theme.colors.accent;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.button,
        { backgroundColor: background, borderColor: theme.colors.border },
        disabled && styles.buttonDisabled,
        variant === 'ghost' && { borderColor: theme.colors.accent },
        compact && styles.buttonCompact,
        flex && styles.buttonFlex,
        minWidth > 0 && { minWidth },
      ]}
    >
      {Icon ? <Icon size={compact ? 14 : 16} color={foreground} /> : null}
      <Text style={[styles.buttonText, { color: foreground }, compact && styles.buttonTextCompact]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

export function IconButton({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  onPress?: () => void;
}) {
  const { theme } = useThemeStore();
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={[styles.iconButton, { borderColor: theme.colors.border }]}>
      <Icon size={18} color={theme.colors.textSecondary} />
    </TouchableOpacity>
  );
}

export function Field({
  label,
  inputStyle,
  ...props
}: TextInputProps & {
  label?: string;
  inputStyle?: ViewStyle;
}) {
  const { theme } = useThemeStore();
  return (
    <View style={styles.field}>
      {label ? <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{label}</Text> : null}
      <TextInput
        {...props}
        placeholderTextColor={theme.colors.textMuted}
        style={[
          styles.input,
          {
            backgroundColor: theme.colors.card,
            borderColor: theme.colors.border,
            color: theme.colors.textPrimary,
          },
          inputStyle,
        ]}
      />
    </View>
  );
}

export function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const { theme } = useThemeStore();
  return (
    <View style={[styles.segmented, { backgroundColor: theme.colors.accentSoft }]}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <TouchableOpacity
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.segment, active && { backgroundColor: theme.colors.card }]}
          >
            <Text style={[styles.segmentText, { color: active ? theme.colors.accent : theme.colors.textSecondary }]}>{option.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  const { theme } = useThemeStore();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: theme.colors.textPrimary }]}>{title}</Text>
      {description ? <Text style={[styles.emptyDesc, { color: theme.colors.textSecondary }]}>{description}</Text> : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

export function LoadingState({ label = '加载中...' }: { label?: string }) {
  const { theme } = useThemeStore();
  return (
    <View style={styles.empty}>
      <ActivityIndicator color={theme.colors.accent} />
      <Text style={[styles.emptyDesc, { color: theme.colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  backdropImage: { opacity: 0.78 },
  padded: { padding: spacing.lg },
  header: {
    minHeight: 64,
    backgroundColor: 'transparent',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  headerText: { flex: 1 },
  title: { fontSize: 22, fontFamily: 'serif', fontWeight: '700', letterSpacing: 0.2 },
  subtitle: { fontSize: 13, marginTop: 3, letterSpacing: 0.2 },
  section: { marginBottom: spacing.lg },
  sectionTitle: { fontSize: 14, fontFamily: 'serif', fontWeight: '700', marginBottom: spacing.sm, letterSpacing: 0.6 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: spacing.md,
    marginBottom: spacing.md,
    shadowColor: '#8A7B65',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  button: {
    minHeight: 42,
    paddingHorizontal: spacing.md,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonCompact: {
    minHeight: 34,
    paddingHorizontal: spacing.sm,
    gap: 4,
  },
  buttonTextCompact: {
    fontSize: 12,
  },
  buttonFlex: {
    flex: 1,
  },
  ghostButton: { borderWidth: StyleSheet.hairlineWidth },
  buttonText: { fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },
  iconButton: { width: 40, height: 40, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  field: { marginBottom: spacing.md },
  label: { fontSize: 12, fontWeight: '700', marginBottom: spacing.xs },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 15, lineHeight: 21 },
  segmented: { flexDirection: 'row', padding: 4, borderRadius: 7, gap: 4 },
  segment: { flex: 1, minHeight: 38, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontSize: 13, fontWeight: '700', letterSpacing: 0.2 },
  empty: { flex: 1, minHeight: 180, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  emptyDesc: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: spacing.sm },
  emptyAction: { marginTop: spacing.lg },
});
