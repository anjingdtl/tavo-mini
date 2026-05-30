import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, EmptyState, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { useProjectStore } from '../store/projectStore';
import * as db from '../services/database';
import type { Preset } from '../types/novel';
import type { PipelineConfig, PipelineMode } from '../types/pipeline';

const MODE_OPTIONS: { value: PipelineMode; label: string }[] = [
  { value: 'twoStage', label: '两段式' },
  { value: 'conditional', label: '条件式' },
  { value: 'full', label: '完整' },
];

const MODE_HELP: Record<PipelineMode, string> = {
  twoStage: '草稿生成后直接轻量终审，跳过独立审阅和事实核查，默认更快。',
  conditional: '草稿生成后先短评估；问题少则直接完成，问题明显时再终审。',
  full: '保留草稿、审阅、事实核查、终审四阶段，质量优先但耗时最长。',
};

const STAGE_LABELS = [
  { key: 'draft', name: '初稿作者', maxKey: 'draftMaxTokens' as const, presetKey: 'draftPresetId' as const },
  { key: 'review', name: '审阅/评估', maxKey: 'reviewMaxTokens' as const, presetKey: 'reviewPresetId' as const },
  { key: 'factCheck', name: '事实核查员', maxKey: 'factCheckMaxTokens' as const, presetKey: 'factCheckPresetId' as const },
  { key: 'proof', name: '终审校对员', maxKey: 'proofMaxTokens' as const, presetKey: 'proofPresetId' as const },
];

const DEFAULT_CONFIG: PipelineConfig = {
  pipelineMode: 'twoStage',
  draftPresetId: null,
  reviewPresetId: null,
  factCheckPresetId: null,
  proofPresetId: null,
  draftMaxTokens: 4000,
  reviewMaxTokens: 1500,
  factCheckMaxTokens: 1500,
  proofMaxTokens: 4000,
};

export const PipelineConfigScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [config, setConfig] = useState<PipelineConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    const loadData = async () => {
      if (!currentProject) return;
      const [savedConfig, projectPresets] = await Promise.all([
        db.getPipelineConfig(),
        db.getPresetsByProject(currentProject.id),
      ]);
      setConfig(savedConfig);
      setPresets(projectPresets as Preset[]);
    };
    loadData();
  }, [currentProject]);

  const save = async () => {
    await db.setPipelineConfig(config);
    Alert.alert('保存成功', '流水线配置已更新。');
  };

  const renderPresetPicker = (
    presetKey: 'draftPresetId' | 'reviewPresetId' | 'factCheckPresetId' | 'proofPresetId',
    label: string,
  ) => {
    const selectedId = config[presetKey];
    return (
      <View style={styles.row}>
        <Text style={[styles.label, { color: theme.colors.textPrimary }]}>{label}</Text>
        <View style={styles.presetList}>
          {presets.map((preset) => (
            <Button
              key={preset.id}
              label={preset.name}
              variant={selectedId === preset.id ? 'primary' : 'secondary'}
              onPress={() => setConfig({ ...config, [presetKey]: preset.id })}
              compact
            />
          ))}
          <Button
            label="不绑定"
            variant={selectedId === null ? 'primary' : 'ghost'}
            onPress={() => setConfig({ ...config, [presetKey]: null })}
            compact
          />
        </View>
      </View>
    );
  };

  if (!currentProject) {
    return (
      <Screen>
        <Header title="流水线配置" />
        <EmptyState
          title="没有当前项目"
          description="请先选择一个项目，再配置流水线预设。"
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="流水线配置" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
          <Text style={[styles.stageTitle, { color: theme.colors.textPrimary }]}>生成模式</Text>
          <SegmentedControl
            value={config.pipelineMode}
            options={MODE_OPTIONS}
            onChange={(pipelineMode) => setConfig({ ...config, pipelineMode })}
          />
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
            {MODE_HELP[config.pipelineMode]}
          </Text>
        </View>

        <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
          为每个阶段绑定一个写作预设。未绑定时将使用项目默认预设。
        </Text>
        {STAGE_LABELS.map((stage) => (
          <View key={stage.key} style={[styles.card, { backgroundColor: theme.colors.card }]}>
            <Text style={[styles.stageTitle, { color: theme.colors.textPrimary }]}>{stage.name}</Text>
            {renderPresetPicker(stage.presetKey, '绑定预设')}
            <Field
              label="Max Tokens"
              value={String(config[stage.maxKey])}
              onChangeText={(value) => {
                const num = parseInt(value, 10);
                if (!Number.isNaN(num)) setConfig({ ...config, [stage.maxKey]: num });
              }}
              keyboardType="numeric"
            />
          </View>
        ))}
        <Button label="保存配置" onPress={save} />
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 120, gap: spacing.md },
  hint: { fontSize: 13, lineHeight: 20 },
  card: { borderRadius: 8, padding: spacing.md, gap: spacing.sm },
  stageTitle: { fontSize: 16, fontWeight: '800' },
  row: { gap: spacing.xs },
  label: { fontSize: 14, fontWeight: '700' },
  presetList: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
