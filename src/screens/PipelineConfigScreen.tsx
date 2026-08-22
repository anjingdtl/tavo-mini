import React, { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, EmptyState, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useNavigation } from '@react-navigation/native';
import { useThemeStore } from '../store/themeStore';
import { useProjectStore } from '../store/projectStore';
import * as db from '../services/database';
import type { Preset } from '../types/novel';
import type { PipelineConfig } from '../types/pipeline';
import {
  DEFAULT_PIPELINE_REASONING_EFFORT,
  PIPELINE_ONE_SHOT_TIER_PRESET,
  PIPELINE_REASONING_EFFORT_OPTIONS,
  type PipelineReasoningTier,
  type PipelineThinkingPresetValue,
} from '../services/pipeline/reasoningPolicy';

const DEFAULT_CONFIG: PipelineConfig = {
  pipelineMode: 'full',
  reasoningEffort: DEFAULT_PIPELINE_REASONING_EFFORT,
  reasoningProfileVersion: 5,
  activeWriterStyleId: null,
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
  const navigation = useNavigation<any>();
  const isContinuation = currentProject?.mode === 'continuation';
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
          db.getPipelineConfig({ projectId: currentProject.id }),
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
    if (saving || !currentProject) return;
    setSaving(true);
    try {
      await db.setPipelineConfig(config, currentProject.id);
      Alert.alert('保存成功', '流水线配置已更新。');
    } catch (e: any) {
      Alert.alert('保存失败', e?.message || '未知错误');
    } finally {
      setSaving(false);
    }
  };

  if (!currentProject) {
    return (
      <Screen>
        <Header testID="pipeline-config" title="流水线配置" />
        <EmptyState
          title="没有当前项目"
          description="请先选择一个项目，再配置流水线与当前作家风格。"
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header testID="pipeline-config" title="流水线配置" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
          <Text style={[styles.stageTitle, { color: theme.colors.textPrimary }]}>思考档位</Text>
          <SegmentedControl
            value={(() => {
              if (config.executionProfile === 'one_shot') return 'one_shot';
              return (
                config.reasoningEffort === 'medium'
                  ? DEFAULT_PIPELINE_REASONING_EFFORT
                  : config.reasoningEffort || DEFAULT_PIPELINE_REASONING_EFFORT
              ) as PipelineReasoningTier;
            })() as PipelineThinkingPresetValue}
            options={[
              {
                value: PIPELINE_ONE_SHOT_TIER_PRESET.value,
                label: PIPELINE_ONE_SHOT_TIER_PRESET.label,
              },
              ...PIPELINE_REASONING_EFFORT_OPTIONS.map(option => ({
                value: option.value,
                label: option.label,
              })),
            ]}
            onChange={(preset: PipelineThinkingPresetValue) => {
              if (preset === 'one_shot') {
                // 极速 = One-Shot Execution Profile（非 reasoningEffort），
                // 单次 Draft 请求固定搭配 low 档思考预算。
                setConfig({
                  ...config,
                  executionProfile: 'one_shot',
                  reasoningEffort:
                    PIPELINE_ONE_SHOT_TIER_PRESET.reasoningEffort,
                });
              } else {
                setConfig({
                  ...config,
                  executionProfile: 'standard',
                  reasoningEffort: preset as PipelineReasoningTier,
                });
              }
            }}
          />
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
            {config.executionProfile === 'one_shot'
              ? PIPELINE_ONE_SHOT_TIER_PRESET.description
              : PIPELINE_REASONING_EFFORT_OPTIONS.find(
                  option =>
                    option.value ===
                    (config.reasoningEffort || DEFAULT_PIPELINE_REASONING_EFFORT),
                )?.description}
            {config.executionProfile === 'one_shot'
              ? `\n${PIPELINE_ONE_SHOT_TIER_PRESET.subLabel}`
              : ' 生成、检查、修订、校验跟随用户档位；具体启用环节由冻结 Policy 决定。'}
          </Text>
          <Text
            style={[styles.hint, { color: theme.colors.textSecondary }]}
          >
            {config.executionProfile === 'one_shot'
              ? 'One-Shot 仍使用同一套阶段视图：Draft 执行一次，QA/Revision 正式跳过，随后进入 FinalValidate → Persist；Formatter、Retry、Fallback 均不启用。'
              : 'Standard 统一执行 Freeze → Draft → ONE QA → Conditional Revision → FinalValidate → Persist；PostWriting 与 ONE Memory 由同一闭环接续。'}
          </Text>
        </View>

        <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
          {isContinuation
            ? '续写模式只在 Freeze 前补充 Canon、接缝、状态和原著文风资料；Freeze 后与大纲共用同一 Writer、QA、Context、Final Candidate、PostWriting 与 ONE Memory。'
            : '新任务只绑定一个项目级当前作家风格；任务启动时冻结统一 Context Projection，历史任务继续使用自己的旧快照。'}
        </Text>
        <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
          <Text style={[styles.stageTitle, { color: theme.colors.textPrimary }]}>当前作家风格</Text>
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>统一用于生成、检查、修订与校验的共享 Context Projection；Sampler 中的 max_tokens 不会覆盖冻结阶段输出预算。</Text>
          <View style={styles.presetList}>
            <Button
              testID="pipeline-writer-style-baseline"
              label="Writer Baseline（默认）"
              variant={config.activeWriterStyleId === null ? 'primary' : 'secondary'}
              onPress={() => setConfig({ ...config, activeWriterStyleId: null })}
              compact
            />
            {presets.map(preset => (
              <Button
                key={preset.id}
                testID={`pipeline-writer-style-${preset.id}`}
                label={preset.name}
                variant={config.activeWriterStyleId === preset.id ? 'primary' : 'secondary'}
                onPress={() => setConfig({ ...config, activeWriterStyleId: preset.id })}
                compact
              />
            ))}
          </View>
        </View>
        <Button testID="pipeline-config-save" label={saving ? '保存中...' : '保存配置'} onPress={save} disabled={saving} />
        {isContinuation ? (
          <Button
            label="续写资料（Freeze 前）"
            variant="secondary"
            onPress={() => navigation.navigate('ContinuationGenerationConfig')}
          />
        ) : null}
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
