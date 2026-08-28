import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { RotateCcw, Save } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, Header, Screen, spacing } from '../components/ui';
import { useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import { useThemeStore } from '../store/themeStore';
import type { SettingsStackParamList } from '../navigation/TabNavigator';
import {
  applyContextAutoAllocationV3,
  DEFAULT_CONTEXT_AUTO_SIMULATION_WINDOW,
  resolveContextAutoSimulationDefault,
  restoreContextAutoDefaults,
} from '../services/contextAutoAllocator';
import {
  getContextAutoInput,
  ensureContextAutomationPolicyV3,
} from '../data/repositories/contextAutoRepository';
import * as db from '../services/database';
import type { LLMConfig } from '../types/novel';

const QUICK_PRESETS: { label: string; value: number }[] = [
  { label: '128K', value: 128000 },
  { label: '200K', value: 200000 },
  { label: '512K', value: 512000 },
  { label: '1M', value: 1000000 },
];

const DEFAULT_INPUT_VALUE = DEFAULT_CONTEXT_AUTO_SIMULATION_WINDOW;

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function selectedConfigFor(
  configs: LLMConfig[],
  preferredConfigId?: number,
): LLMConfig | null {
  if (preferredConfigId != null && preferredConfigId > 0) {
    return configs.find(config => config.id === preferredConfigId) || null;
  }
  return configs.find(config => config.is_active === 1) || configs[0] || null;
}

export const ContextAutoConfigScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const route =
    useRoute<RouteProp<SettingsStackParamList, 'ContextAutoConfig'>>();
  const preferredLlmConfigId = route.params?.llmConfigId;
  const referenceContextWindow = route.params?.referenceContextWindow;
  const isUnsavedDraft =
    preferredLlmConfigId != null && Number(preferredLlmConfigId) <= 0;
  const [inputText, setInputText] = useState<string>(
    String(DEFAULT_INPUT_VALUE),
  );
  const [llmConfigs, setLlmConfigs] = useState<LLMConfig[]>([]);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const selectedConfig = useMemo(
    () => selectedConfigFor(llmConfigs, preferredLlmConfigId),
    [llmConfigs, preferredLlmConfigId],
  );

  const reload = async () => {
    const [savedInput, configs] = await Promise.all([
      getContextAutoInput(),
      db.getLLMConfigs(),
    ]);
    setLlmConfigs(configs);
    const selected = selectedConfigFor(configs, preferredLlmConfigId);
    setInputText(
      String(
        selected?.context_window && selected.context_window > 0
          ? selected.context_window
          : resolveContextAutoSimulationDefault({
              savedInput,
              preferredConfigId: preferredLlmConfigId,
              configs,
              referenceContextWindow,
            }),
      ),
    );
  };

  useEffect(() => {
    void ensureContextAutomationPolicyV3()
      .then(reload)
      .catch((e: any) => {
        Toast.show({ type: 'error', text1: '加载失败', text2: e?.message });
      });
    // This screen is scoped to the selected Settings model and route values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferredLlmConfigId, referenceContextWindow]);

  const numericInput = useMemo(() => {
    const value = Number(inputText);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }, [inputText]);

  const handleQuickPreset = (value: number) => {
    setInputText(String(value));
  };

  const handleApply = () => {
    if (isUnsavedDraft) {
      Toast.show({ type: 'error', text1: '请先保存当前 LLM 配置' });
      return;
    }
    if (numericInput <= 0) {
      Toast.show({ type: 'error', text1: '请输入有效的上下文长度' });
      return;
    }
    Alert.alert(
      '保存上下文长度',
      '将把 ' +
        formatNumber(numericInput) +
        ' tokens 写入' +
        (selectedConfig?.name || '当前模型') +
        '的真实 context_window。max_output_tokens 保持原值；填 0 仍表示 AUTO。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '保存',
          onPress: () => {
            void (async () => {
              setApplying(true);
              try {
                const record = await applyContextAutoAllocationV3(numericInput, {
                  llmConfigId: preferredLlmConfigId,
                });
                await reload();
                Toast.show({
                  type: 'success',
                  text1: '已保存 ' + formatNumber(record.maxContextTokens) + ' tokens',
                  text2: '当前模型能力已同步',
                });
              } catch (e: any) {
                Toast.show({
                  type: 'error',
                  text1: '保存失败',
                  text2: e?.message,
                });
              } finally {
                setApplying(false);
              }
            })();
          },
        },
      ],
    );
  };

  const handleRestoreDefaults = () => {
    Alert.alert(
      '恢复预算默认值',
      '只恢复后台预算策略，不改变当前模型已保存的真实能力。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '恢复',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setRestoring(true);
              try {
                await restoreContextAutoDefaults();
                await reload();
                Toast.show({ type: 'success', text1: '已恢复预算默认值' });
              } catch (e: any) {
                Toast.show({
                  type: 'error',
                  text1: '恢复失败',
                  text2: e?.message,
                });
              } finally {
                setRestoring(false);
              }
            })();
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <Header
        testID="context-auto-screen"
        title="上下文长度"
        subtitle="当前模型能力"
      />
      <ScrollView contentContainerStyle={styles.content}>
        {isUnsavedDraft ? (
          <Card testID="context-auto-unsaved-notice">
            <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
              当前配置尚未保存
            </Text>
            <Text style={[styles.cardMeta, { color: theme.colors.textSecondary }]}>
              请先保存 LLM 配置，再把上下文长度同步到该模型。不会改动其他已保存模型。
            </Text>
          </Card>
        ) : null}

        <Card testID="context-auto-capability-card">
          <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
            当前模型
          </Text>
          {selectedConfig ? (
            <>
              <Text style={[styles.modelName, { color: theme.colors.textPrimary }]}>
                {selectedConfig.name || selectedConfig.model_name || '未命名模型'}
                {selectedConfig.is_active === 1 ? ' · 当前启用' : ''}
              </Text>
              <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                {selectedConfig.model_name || '未命名模型'}
              </Text>
              <View style={styles.capabilityRow}>
                <Text
                  style={[
                    styles.capabilityLabel,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  context_window
                </Text>
                <Text
                  style={[
                    styles.capabilityValue,
                    { color: theme.colors.accent },
                  ]}
                >
                  {selectedConfig.context_window > 0
                    ? formatNumber(selectedConfig.context_window)
                    : '未配置'}
                </Text>
              </View>
              <View style={styles.capabilityRow}>
                <Text
                  style={[
                    styles.capabilityLabel,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  max_output_tokens
                </Text>
                <Text
                  style={[
                    styles.capabilityValue,
                    { color: theme.colors.accent },
                  ]}
                >
                  {selectedConfig.max_output_tokens > 0
                    ? formatNumber(selectedConfig.max_output_tokens)
                    : 'AUTO'}
                </Text>
              </View>
            </>
          ) : (
            <Text style={[styles.metaText, { color: theme.colors.textMuted }]}>
              暂无已保存的 LLM 配置。
            </Text>
          )}
          <Text style={[styles.footnote, { color: theme.colors.textMuted }]}>
            这里显示并保存模型的真实能力。最大输出为 AUTO 时，数据库保持 0，运行时才按当前模型窗口弹性计算。
          </Text>
        </Card>

        <Card>
          <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
            设置上下文长度
          </Text>
          <Text style={[styles.cardMeta, { color: theme.colors.textSecondary }]}>
            上下文越大，可供 AI 参考的小说资料越多。保存后会同步到上方模型，新的写作任务使用新值，正在运行的任务保持原冻结能力。
          </Text>
          <View style={styles.quickRow}>
            {QUICK_PRESETS.map(preset => {
              const active = numericInput === preset.value;
              return (
                <TouchableOpacity
                  key={preset.value}
                  testID={'context-auto-preset-' + preset.value}
                  onPress={() => handleQuickPreset(preset.value)}
                  style={[
                    styles.quickChip,
                    {
                      borderColor: active
                        ? theme.colors.accent
                        : theme.colors.border,
                      backgroundColor: active
                        ? theme.colors.accentSoft
                        : theme.colors.card,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.quickText,
                      {
                        color: active
                          ? theme.colors.accent
                          : theme.colors.textSecondary,
                      },
                    ]}
                  >
                    {preset.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View
            style={[
              styles.inputBox,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.card,
              },
            ]}
          >
            <TextInput
              testID="context-auto-simulation-input"
              value={inputText}
              onChangeText={text => setInputText(text.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              placeholder="例：1000000"
              placeholderTextColor={theme.colors.textMuted}
              style={[styles.input, { color: theme.colors.textPrimary }]}
            />
            <Text
              style={[styles.inputSuffix, { color: theme.colors.textSecondary }]}
            >
              tokens
            </Text>
          </View>
        </Card>

        <View style={styles.buttonRow}>
          <Button
            testID="context-auto-restore"
            label="恢复默认"
            icon={RotateCcw}
            variant="ghost"
            flex
            disabled={restoring || applying}
            onPress={handleRestoreDefaults}
          />
          <Button
            testID="context-auto-apply"
            label={applying ? '保存中...' : '保存'}
            icon={Save}
            flex
            disabled={
              applying || restoring || isUnsavedDraft || numericInput <= 0
            }
            onPress={handleApply}
          />
        </View>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 96, gap: spacing.md },
  cardTitle: {
    fontSize: 16,
    fontFamily: 'serif',
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  cardMeta: { fontSize: 12, lineHeight: 18, marginBottom: spacing.md },
  metaText: { fontSize: 13, lineHeight: 20 },
  modelName: { fontSize: 15, fontWeight: '800', marginBottom: spacing.xs },
  capabilityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  capabilityLabel: { fontSize: 12 },
  capabilityValue: { fontSize: 13, fontWeight: '800' },
  quickRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
    flexWrap: 'wrap',
  },
  quickChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  quickText: { fontSize: 13, fontWeight: '700' },
  inputBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 7,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  input: { flex: 1, paddingVertical: spacing.sm, fontSize: 16 },
  inputSuffix: { fontSize: 13 },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  footnote: { fontSize: 11, lineHeight: 17, marginTop: spacing.sm },
});
