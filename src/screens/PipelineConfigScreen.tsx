import React, { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, EmptyState, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { useProjectStore } from '../store/projectStore';
import * as db from '../services/database';
import type { Preset } from '../types/novel';
import type { PipelineConfig } from '../types/pipeline';
import {
  DEFAULT_PIPELINE_REASONING_EFFORT,
  PIPELINE_REASONING_EFFORT_OPTIONS,
  type PipelineReasoningTier,
} from '../services/pipeline/reasoningPolicy';

const STAGE_LABELS = [
  { key: 'draft', name: '初稿作者', maxKey: 'draftMaxTokens' as const, presetKey: 'draftPresetId' as const },
  { key: 'review', name: '审阅/评估', maxKey: 'reviewMaxTokens' as const, presetKey: 'reviewPresetId' as const },
  { key: 'factCheck', name: '事实核查员', maxKey: 'factCheckMaxTokens' as const, presetKey: 'factCheckPresetId' as const },
  { key: 'proof', name: '终审校对员', maxKey: 'proofMaxTokens' as const, presetKey: 'proofPresetId' as const },
];

const DEFAULT_CONFIG: PipelineConfig = {
  pipelineMode: 'full',
  reasoningEffort: DEFAULT_PIPELINE_REASONING_EFFORT,
  reasoningProfileVersion: 5,
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
  const [saving, setSaving] = useState(false);
  // 10.8: isMountedRef 守卫异步 loadData，避免卸载后 setState
  const isMountedRef = useRef(true);

  // 10.8: cleanup 标记卸载，loadData 后续 setState 受守卫
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const loadData = async () => {
      if (!currentProject) return;
      try {
        const [savedConfig, projectPresets] = await Promise.all([
          db.getPipelineConfig(),
          db.getPresetsByProject(currentProject.id),
        ]);
        if (!isMountedRef.current) return;
        setConfig(savedConfig);
        setPresets(projectPresets as Preset[]);
      } catch (e: any) {
        if (!isMountedRef.current) return;
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
          <Text style={[styles.stageTitle, { color: theme.colors.textPrimary }]}>思考强度</Text>
          <SegmentedControl
            value={(config.reasoningEffort === 'medium'
              ? DEFAULT_PIPELINE_REASONING_EFFORT
              : config.reasoningEffort || DEFAULT_PIPELINE_REASONING_EFFORT) as PipelineReasoningTier}
            options={PIPELINE_REASONING_EFFORT_OPTIONS.map(option => ({
              value: option.value,
              label: option.label,
            }))}
            onChange={(reasoningEffort: PipelineReasoningTier) =>
              setConfig({ ...config, reasoningEffort })
            }
          />
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
            {PIPELINE_REASONING_EFFORT_OPTIONS.find(
              option => option.value === (config.reasoningEffort || DEFAULT_PIPELINE_REASONING_EFFORT),
            )?.description}
            {' '}Draft、Brief、Final 跟随用户档位；Review/FactCheck 固定使用 low Thinking。
          </Text>
          <Text
            style={[styles.hint, { color: theme.colors.textSecondary }]}
          >
            新任务统一执行 Draft → Review 与 FactCheck → Brief → Final；历史已完成任务仍可查看，旧未完成任务需按新版重新生成。
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
