import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, EmptyState, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { useProjectStore } from '../store/projectStore';
import * as db from '../services/database';
import type { Preset } from '../types/novel';
import type { PipelineConfig, PipelineMode } from '../types/pipeline';

const MODE_OPTIONS: { value: PipelineMode; label: string }[] = [
  { value: 'noReview', label: '无审核' },
  { value: 'twoStage', label: '仅评估' },
  { value: 'conditional', label: '仅核查' },
  { value: 'full', label: '完整' },
];

const MODE_HELP: Record<PipelineMode, string> = {
  noReview: '仅生成初稿，不运行任何评估、核查或终审，速度最快。',
  twoStage: '草稿生成后只运行审阅/评估，再由终审根据评估意见修订完稿。',
  conditional: '草稿生成后只运行事实核查员，再由终审根据核查结果修订完稿。',
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

const STAGES_FOR_MODE: Record<PipelineMode, typeof STAGE_LABELS> = {
  noReview: STAGE_LABELS.filter((s) => s.key === 'draft'),
  twoStage: STAGE_LABELS.filter((s) => s.key !== 'factCheck'),
  conditional: STAGE_LABELS.filter((s) => s.key !== 'review'),
  full: STAGE_LABELS,
};

export const PipelineConfigScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [config, setConfig] = useState<PipelineConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const loadData = async () => {
      if (!currentProject) return;
      try {
        const [savedConfig, projectPresets] = await Promise.all([
          db.getPipelineConfig(),
          db.getPresetsByProject(currentProject.id),
        ]);
        setConfig(savedConfig);
        setPresets(projectPresets as Preset[]);
      } catch (e: any) {
        Alert.alert('加载配置失败', e?.message || '未知错误');
      }
    };
    loadData();
  }, [currentProject]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await db.setPipelineConfig(config);
      Alert.alert('保存成功', '流水线配置已更新。');
    } catch (e: any) {
      Alert.alert('保存失败', e?.message || '未知错误');
    } finally {
      setSaving(false);
    }
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
        {STAGES_FOR_MODE[config.pipelineMode].map((stage) => (
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
        <Button label={saving ? '保存中...' : '保存配置'} onPress={save} disabled={saving} />
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
