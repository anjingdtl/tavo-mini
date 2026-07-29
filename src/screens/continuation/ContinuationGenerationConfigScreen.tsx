import React, { useEffect, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
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

const CONFIRMATION_OPTIONS = [
  { value: 'never', label: '不确认' },
  { value: 'risk_only', label: '风险时确认' },
  { value: 'always', label: '始终确认' },
] as const;

type ModelStage =
  | 'plannerLlmConfigId'
  | 'writerLlmConfigId'
  | 'checkerLlmConfigId'
  | 'repairLlmConfigId'
  | 'stateExtractionLlmConfigId';

const MODEL_STAGES: Array<{ key: ModelStage; label: string }> = [
  { key: 'plannerLlmConfigId', label: '规划' },
  { key: 'writerLlmConfigId', label: '正文生成' },
  { key: 'checkerLlmConfigId', label: '一致性检查' },
  { key: 'repairLlmConfigId', label: '自动修复' },
  { key: 'stateExtractionLlmConfigId', label: '状态提取' },
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
      const saved = await updateGenerationSettings(currentProject.id, settings);
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
          </Text>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
            校验严格度
          </Text>
          <SegmentedControl
            value={settings.strictnessProfile}
            options={[...STRICTNESS_OPTIONS]}
            onChange={strictnessProfile => patch({ strictnessProfile })}
          />
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text
                style={[
                  styles.switchTitle,
                  { color: theme.colors.textPrimary },
                ]}
              >
                启用一致性检查
              </Text>
              <Text
                style={[styles.hint, { color: theme.colors.textSecondary }]}
              >
                生成后检查世界规则、人物状态、剧情与文风，并按需自动修复。
              </Text>
            </View>
            <Switch
              value={settings.checkerEnabled}
              onValueChange={checkerEnabled => patch({ checkerEnabled })}
            />
          </View>
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
          <Field
            label="最大自动修复轮次"
            value={String(settings.maxRepairRounds)}
            keyboardType="numeric"
            onChangeText={text =>
              patch({
                maxRepairRounds: Math.min(
                  3,
                  Math.max(0, Number(text.replace(/\D/g, '')) || 0),
                ),
              })
            }
          />
        </Card>

        <Card>
          <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
            规划与风险确认
          </Text>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
            章节规划确认方式
          </Text>
          <SegmentedControl
            value={settings.plannerConfirmationPolicy}
            options={[...CONFIRMATION_OPTIONS]}
            onChange={plannerConfirmationPolicy =>
              patch({ plannerConfirmationPolicy })
            }
          />
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
            “风险时确认”会在重大关系、能力、死亡或复活变化前等待你的决定。
          </Text>
        </Card>

        <Card>
          <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
            阶段模型
          </Text>
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
            未指定时使用当前启用模型。可为耗时的检查或状态提取单独指定模型。
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
});
