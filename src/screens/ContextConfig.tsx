import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Save } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useSettingsStore } from '../store/settingsStore';
import { useThemeStore } from '../store/themeStore';
import type { ContextConfig, ContextStrategy } from '../types/novel';

const STRATEGIES: { value: ContextStrategy; label: string }[] = [
  { value: 'sliding', label: '滑动窗口' },
  { value: 'full', label: '完整前文' },
  { value: 'custom', label: '自定义' },
];

export const ContextConfigScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const { contextConfig, loadSettings, setContextConfig } = useSettingsStore();
  const [draft, setDraft] = useState<ContextConfig>(contextConfig);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setDraft(contextConfig);
  }, [contextConfig]);

  const save = async () => {
    await setContextConfig(draft);
    Toast.show({ type: 'success', text1: '上下文配置已保存' });
  };

  return (
    <Screen>
      <Header title="上下文配置" subtitle="控制 AI 读取多少前文、摘要和资料" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>前文策略</Text>
        <SegmentedControl value={draft.strategy} options={STRATEGIES} onChange={(strategy) => setDraft({ ...draft, strategy })} />
        <Field label="最近正文窗口 tokens" value={String(draft.slidingWindowSize)} onChangeText={(value) => setDraft({ ...draft, slidingWindowSize: Number(value) || 0 })} keyboardType="number-pad" />
        <Field label="最近正文章数" value={String(draft.recentChapterCount ?? 3)} onChangeText={(value) => setDraft({ ...draft, recentChapterCount: Number(value) || 3 })} keyboardType="number-pad" />
        <Field label="记忆摘要预算 tokens" value={String(draft.summaryBudgetTokens ?? 20000)} onChangeText={(value) => setDraft({ ...draft, summaryBudgetTokens: Number(value) || 20000 })} keyboardType="number-pad" />
        <Field label="记忆摘要 Top K" value={String(draft.memoryTopK ?? 10)} onChangeText={(value) => setDraft({ ...draft, memoryTopK: Number(value) || 10 })} keyboardType="number-pad" />
        <Field label="资料预算 tokens" value={String(draft.resourceBudget)} onChangeText={(value) => setDraft({ ...draft, resourceBudget: Number(value) || 0 })} keyboardType="number-pad" />
        <Field label="自定义开始章节序号" value={String(draft.customRangeStart)} onChangeText={(value) => setDraft({ ...draft, customRangeStart: Number(value) || 0 })} keyboardType="number-pad" />
        <Field label="自定义结束章节序号（-1 表示最后）" value={String(draft.customRangeEnd)} onChangeText={(value) => setDraft({ ...draft, customRangeEnd: Number(value) || -1 })} keyboardType="number-pad" />
        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={[styles.switchTitle, { color: theme.colors.textPrimary }]}>注入角色、世界书和笔记</Text>
            <Text style={[styles.switchHint, { color: theme.colors.textSecondary }]}>关闭后只使用章节前文和记忆摘要。</Text>
          </View>
          <Switch value={draft.includeResources} onValueChange={(includeResources) => setDraft({ ...draft, includeResources })} />
        </View>
        <Button label="保存配置" icon={Save} onPress={save} />
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 96, gap: spacing.md },
  label: { fontSize: 12, fontWeight: '800' },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md },
  switchText: { flex: 1 },
  switchTitle: { fontSize: 15, fontWeight: '800' },
  switchHint: { fontSize: 12, marginTop: 2 },
});
