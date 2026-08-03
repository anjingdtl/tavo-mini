import React, { useEffect, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Save } from 'lucide-react-native';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Header,
  LoadingState,
  Screen,
  SegmentedControl,
  spacing,
} from '../../components/ui';
import { useProjectStore } from '../../store/projectStore';
import { useThemeStore } from '../../store/themeStore';
import * as db from '../../services/database';
import {
  ensureGenerationSettings,
  updateGenerationSettings,
} from '../../services/continuation/generation';
import type { ContinuationGenerationSettings } from '../../services/continuation/generation/types';

const STRICTNESS_OPTIONS = [
  { value: 'loose', label: '宽松' },
  { value: 'balanced', label: '平衡' },
  { value: 'strict', label: '严格' },
] as const;

const CHECK_LEVEL_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: 'balanced', label: '平衡' },
  { value: 'strict', label: '严格' },
] as const;

/**
 * 校验严格度预设展开为各子项；原著文风始终严格遵循已启用的画风画像，
 * 因而不属于用户可调节项。
 */
type StrictnessPresetKey = 'loose' | 'balanced' | 'strict';

const STRICTNESS_PRESET: Record<
  StrictnessPresetKey,
  Pick<
    ContinuationGenerationSettings,
    | 'worldRuleLevel'
    | 'characterLevel'
    | 'relationshipLevel'
    | 'plotLevel'
    | 'experienceLevel'
    | 'knowledgeLevel'
  >
> = {
  loose: {
    worldRuleLevel: 'balanced',
    characterLevel: 'balanced',
    relationshipLevel: 'balanced',
    plotLevel: 'balanced',
    experienceLevel: 'balanced',
    knowledgeLevel: 'balanced',
  },
  balanced: {
    worldRuleLevel: 'strict',
    characterLevel: 'strict',
    relationshipLevel: 'strict',
    plotLevel: 'balanced',
    experienceLevel: 'strict',
    knowledgeLevel: 'strict',
  },
  strict: {
    worldRuleLevel: 'strict',
    characterLevel: 'strict',
    relationshipLevel: 'strict',
    plotLevel: 'strict',
    experienceLevel: 'strict',
    knowledgeLevel: 'strict',
  },
};

const SUB_LEVEL_FIELDS: Array<{
  key: keyof (typeof STRICTNESS_PRESET)['balanced'];
  label: string;
}> = [
  { key: 'worldRuleLevel', label: '世界规则' },
  { key: 'characterLevel', label: '人物设定' },
  { key: 'relationshipLevel', label: '人物关系' },
  { key: 'plotLevel', label: '剧情主线' },
  { key: 'experienceLevel', label: '人物经历' },
  { key: 'knowledgeLevel', label: '知识边界' },
];

type ModelStage =
  | 'writerLlmConfigId'
  | 'checkerLlmConfigId'
  | 'controlLlmConfigId'
  | 'repairLlmConfigId'
  | 'stateExtractionLlmConfigId';

const MODEL_STAGES: Array<{ key: ModelStage; label: string }> = [
  { key: 'writerLlmConfigId', label: '正文生成' },
  { key: 'checkerLlmConfigId', label: '一致性检查' },
  { key: 'controlLlmConfigId', label: '篇幅与结构控制' },
  { key: 'repairLlmConfigId', label: '自动修复' },
  { key: 'stateExtractionLlmConfigId', label: '采纳后状态提取（不计入四请求）' },
];

/** Dedicated configuration for the independent continuation runner. */
export const ContinuationGenerationConfigScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [settings, setSettings] =
    useState<ContinuationGenerationSettings | null>(null);
  const [models, setModels] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!currentProject || currentProject.mode !== 'continuation')
      return undefined;
    Promise.all([
      ensureGenerationSettings(currentProject.id),
      db.getLLMConfigs(),
    ])
      .then(([loaded, configs]) => {
        if (!alive) return;
        setSettings(loaded);
        setModels(configs);
      })
      .catch(error => {
        if (alive)
          Alert.alert(
            '加载配置失败',
            error?.message || '无法读取续写生成配置。',
          );
      });
    return () => {
      alive = false;
    };
  }, [currentProject]);

  const patch = (value: Partial<ContinuationGenerationSettings>) => {
    setSettings(current => (current ? { ...current, ...value } : current));
  };

  const save = async () => {
    if (!currentProject || !settings || saving) return;
    setSaving(true);
    try {
      const saved = await updateGenerationSettings(currentProject.id, {
        ...settings,
        // New runs always use the standard checker and one possible Repair.
        // The legacy columns remain in the row for old snapshots/backups.
        checkerEnabled: true,
        maxRepairRounds: 1,
        plannerConfirmationPolicy: 'never',
      });
      setSettings(saved);
      Alert.alert('保存成功', '续写生成流水线配置已更新。');
    } catch (error: any) {
      Alert.alert('保存失败', error?.message || '无法保存续写生成配置。');
    } finally {
      setSaving(false);
    }
  };

  if (!currentProject || currentProject.mode !== 'continuation') {
    return (
      <Screen>
        <Header title="续写生成配置" />
        <EmptyState
          title="请先选择原著续写项目"
          description="在「项目」中切换到原著续写项目后，再配置续写生成流水线。"
        />
      </Screen>
    );
  }

  if (!settings) {
    return (
      <Screen>
        <Header title="续写生成配置" />
        <LoadingState label="加载续写生成配置..." />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header
        title="续写生成配置"
        subtitle={`${currentProject.name} · 独立于大纲创作流水线`}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
            生成与一致性
          </Text>
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
            续写会基于
            Canon、接缝和状态事件生成；此处不会修改大纲创作的四阶段流水线。
            V4 固定最多 4 次物理请求：Writer →（Checker 与 Control 并行）→ Repair，最后只做本地 Final Gate。
            不自动重试，不提供额外 Repair；每个阶段按照上下文自动化策略、所选模型能力和本次正文实测需求动态计算预算。
          </Text>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
            校验严格度（预设）
          </Text>
          <SegmentedControl
            value={settings.strictnessProfile}
            options={[...STRICTNESS_OPTIONS]}
            onChange={strictnessProfile => {
              const preset =
                STRICTNESS_PRESET[strictnessProfile as StrictnessPresetKey];
              patch(
                preset
                  ? { strictnessProfile, ...preset }
                  : { strictnessProfile },
              );
            }}
          />
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
            切换预设会展开下列事实校验项；原著文风始终严格遵循已启用的画风画像。
          </Text>
          {SUB_LEVEL_FIELDS.map(field => (
            <View key={field.key} style={styles.subLevelBlock}>
              <Text
                style={[styles.label, { color: theme.colors.textSecondary }]}
              >
                {field.label}
              </Text>
              <SegmentedControl
                value={settings[field.key]}
                options={[...CHECK_LEVEL_OPTIONS]}
                onChange={value => patch({ [field.key]: value })}
              />
            </View>
          ))}
          <View style={styles.subLevelBlock}>
            <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
              原著文风
            </Text>
            <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
              始终严格遵循原著画风画像；未完成或未启用画像时，续写将被阻断。
            </Text>
          </View>
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>Control 的汉字数和段落指标由本地计算；Repair 输出完整终稿，之后不再调用第二次 LLM Checker。</Text>
          <Field
            label="目标章节字数"
            value={String(settings.targetChapterChars)}
            keyboardType="numeric"
            onChangeText={text =>
              patch({
                targetChapterChars: Math.max(
                  500,
                  Number(text.replace(/\D/g, '')) || 0,
                ),
              })
            }
          />
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
            目标和合法区间会进入 Writer/Control/Repair 的冻结上下文；最终是否可采纳由本地 Final Gate 决定，不会偷偷重试。
          </Text>
        </Card>

        <Card>
          <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
            阶段模型
          </Text>
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
            未指定时使用当前启用模型。Writer、Checker、Control、Repair 分别冻结自己的 context window/max output；预览页会展示模拟预算。
          </Text>
          {MODEL_STAGES.map(stage => (
            <View key={stage.key} style={styles.stageRow}>
              <Text
                style={[styles.stageLabel, { color: theme.colors.textPrimary }]}
              >
                {stage.label}
              </Text>
              <View style={styles.modelChoices}>
                <Button
                  label="当前模型"
                  compact
                  variant={
                    settings[stage.key] === null ? 'primary' : 'secondary'
                  }
                  onPress={() => patch({ [stage.key]: null })}
                />
                {models.map(model => (
                  <Button
                    key={model.id}
                    label={model.name || model.model_name || `配置 ${model.id}`}
                    compact
                    variant={
                      settings[stage.key] === model.id ? 'primary' : 'secondary'
                    }
                    onPress={() => patch({ [stage.key]: model.id })}
                  />
                ))}
              </View>
              {(() => {
                const selected =
                  settings[stage.key] == null
                    ? models.find(model => model.is_active || model.isActive)
                    : models.find(model => model.id === settings[stage.key]);
                const contextWindow = Number(selected?.context_window);
                const maxOutput = Number(selected?.max_output_tokens);
                return Number.isFinite(contextWindow) && contextWindow > 0
                  ? (
                      <Text style={[styles.capability, { color: theme.colors.textMuted }]}>
                        冻结能力：context {contextWindow.toLocaleString('zh-CN')} · max output{' '}
                        {Number.isFinite(maxOutput) && maxOutput > 0
                          ? maxOutput.toLocaleString('zh-CN')
                          : '由配置提供'}
                      </Text>
                    )
                  : null;
              })()}
            </View>
          ))}
        </Card>

        <Button
          label={saving ? '保存中...' : '保存续写配置'}
          icon={Save}
          onPress={save}
          disabled={saving}
        />
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 96 },
  title: { fontSize: 16, fontWeight: '800', marginBottom: spacing.xs },
  label: {
    fontSize: 12,
    fontWeight: '700',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  hint: { fontSize: 12, lineHeight: 18, marginBottom: spacing.sm },
  switchRow: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  switchText: { flex: 1 },
  switchTitle: { fontSize: 14, fontWeight: '800', marginBottom: 2 },
  stageRow: { marginTop: spacing.md },
  stageLabel: { fontSize: 14, fontWeight: '800', marginBottom: spacing.xs },
  modelChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  capability: { fontSize: 11, lineHeight: 16, marginTop: spacing.xs },
  subLevelBlock: { marginTop: spacing.xs },
});
