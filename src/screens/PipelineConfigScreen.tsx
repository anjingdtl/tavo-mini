import React, { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, EmptyState, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useNavigation } from '@react-navigation/native';
import { useThemeStore } from '../store/themeStore';
import { useProjectStore } from '../store/projectStore';
import * as db from '../services/database';
import type { Preset } from '../types/novel';
import type { PipelineConfig } from '../types/pipeline';
import { DEFAULT_PIPELINE_REASONING_EFFORT } from '../services/pipeline/reasoningPolicy';
import {
  GENERATION_QUALITY_PROFILE_OPTIONS,
  deriveGenerationQualityProfile,
  mapGenerationQualityProfile,
  type GenerationQualityProfile,
} from '../services/writing/contracts/generationQualityProfile';

const DEFAULT_CONFIG: PipelineConfig = {
  pipelineMode: 'full',
  reasoningEffort: DEFAULT_PIPELINE_REASONING_EFFORT,
  executionProfile: 'standard',
  generationQualityProfile: 'standard',
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
          <Text style={[styles.stageTitle, { color: theme.colors.textPrimary }]}>生成质量</Text>
          <SegmentedControl
            testIDPrefix="pipeline-generation-quality"
            value={deriveGenerationQualityProfile({
              qualityProfile: config.generationQualityProfile,
              executionProfile: config.executionProfile,
              reasoningEffort: config.reasoningEffort,
            })}
            options={GENERATION_QUALITY_PROFILE_OPTIONS.map(option => ({
              value: option.value,
              label: option.label,
            }))}
            onChange={(preset: GenerationQualityProfile) => {
              const mapped = mapGenerationQualityProfile(preset);
              setConfig({
                ...config,
                generationQualityProfile: preset,
                executionProfile: mapped.executionProfile,
                reasoningEffort: mapped.reasoningEffort,
              });
            }}
          />
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
            {GENERATION_QUALITY_PROFILE_OPTIONS.find(
              option =>
                option.value ===
                deriveGenerationQualityProfile({
                  qualityProfile: config.generationQualityProfile,
                  executionProfile: config.executionProfile,
                  reasoningEffort: config.reasoningEffort,
                }),
            )?.description}
            {`\n${
              GENERATION_QUALITY_PROFILE_OPTIONS.find(
                option =>
                  option.value ===
                  deriveGenerationQualityProfile({
                    qualityProfile: config.generationQualityProfile,
                    executionProfile: config.executionProfile,
                    reasoningEffort: config.reasoningEffort,
                  }),
              )?.subLabel || ''
            }`}
          </Text>
          <Text
            style={[styles.hint, { color: theme.colors.textSecondary }]}
          >
            {deriveGenerationQualityProfile({
              qualityProfile: config.generationQualityProfile,
              executionProfile: config.executionProfile,
              reasoningEffort: config.reasoningEffort,
            }) === 'fast'
              ? '极速仍使用同一套阶段视图：Draft 执行一次，QA/Revision 正式跳过，随后进入 FinalValidate → Persist；Formatter、Retry、Fallback 均不启用。'
              : '标准与质量都执行 Freeze → Draft → ONE QA → Conditional Revision → FinalValidate → Persist；质量档不增加新 Stage，只提高思考预算。PostWriting 与 ONE Memory 由同一闭环接续。'}
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
