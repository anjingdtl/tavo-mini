import React from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Download, KeyRound, Moon, Palette, Sun, TreePine } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import { Button, Card, Header, Section, SegmentedControl, spacing } from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import { exportTavoNovelJSON, exportToMarkdown, exportToText } from '../services/exportService';
import type { ThemeMode } from '../types/theme';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: '明亮' },
  { value: 'dark', label: '深色' },
  { value: 'eyecare', label: '护眼' },
];

export const SettingsScreen: React.FC = () => {
  const navigation = useNavigation<any>();
  const { theme, mode, setMode } = useThemeStore();
  const { currentProject } = useProjectStore();

  const changeTheme = async (next: ThemeMode) => {
    setMode(next);
    await db.setSetting('theme_mode', next);
    Toast.show({ type: 'success', text1: '主题已切换' });
  };

  const exportProject = async (type: 'md' | 'txt' | 'json') => {
    if (!currentProject) {
      Toast.show({ type: 'error', text1: '请先选择项目' });
      return;
    }
    try {
      const path =
        type === 'md'
          ? await exportToMarkdown(currentProject.id)
          : type === 'txt'
            ? await exportToText(currentProject.id)
            : await exportTavoNovelJSON(currentProject.id);
      Alert.alert('导出成功', path);
    } catch (error: any) {
      Alert.alert('导出失败', error.message);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Header title="设置" subtitle="模型、主题、导出和诊断" />
      <ScrollView contentContainerStyle={styles.content}>
        <Section title="AI">
          <Card>
            <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>OpenAI 兼容接口</Text>
            <Text style={[styles.cardMeta, { color: theme.colors.textSecondary }]}>配置 API 地址、Key 和模型名称后，可用于续写、摘要和情节线生成。</Text>
            <Button label="LLM 设置" icon={KeyRound} onPress={() => navigation.navigate('LLMSettings')} />
          </Card>
        </Section>
        <Section title="主题">
          <SegmentedControl value={mode} options={THEME_OPTIONS} onChange={changeTheme} />
          <View style={styles.themeHints}>
            <Sun size={18} color={theme.colors.textSecondary} />
            <Moon size={18} color={theme.colors.textSecondary} />
            <TreePine size={18} color={theme.colors.textSecondary} />
            <Palette size={18} color={theme.colors.textSecondary} />
          </View>
        </Section>
        <Section title="导出">
          <View style={styles.exportGrid}>
            <Button label="Markdown" icon={Download} onPress={() => exportProject('md')} />
            <Button label="TXT" icon={Download} variant="secondary" onPress={() => exportProject('txt')} />
            <Button label="项目 JSON" icon={Download} variant="secondary" onPress={() => exportProject('json')} />
          </View>
        </Section>
        <Section title="关于">
          <Card>
            <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>Tavo Mini</Text>
            <Text style={[styles.cardMeta, { color: theme.colors.textSecondary }]}>Android 手机小说工作台 · v1.0.0</Text>
          </Card>
        </Section>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 96 },
  cardTitle: { fontSize: 16, fontWeight: '800', marginBottom: 4 },
  cardMeta: { fontSize: 13, lineHeight: 20, marginBottom: spacing.md },
  exportGrid: { gap: spacing.sm },
  themeHints: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
});
