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
import { RotateCcw, Sparkles } from 'lucide-react-native';
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
  getContextAutoLastApplied,
  ensureContextAutomationPolicyV3,
  type ContextAutoAppliedRecord,
} from '../data/repositories/contextAutoRepository';
import {
  cloneDefaultContextAutomationPolicyV3,
  hashContextAutomationPolicyV3,
} from '../services/contextAutomationPolicy';
import * as db from '../services/database';

const QUICK_PRESETS: { label: string; value: number }[] = [
  { label: '128K', value: 128000 },
  { label: '200K', value: 200000 },
  { label: '512K', value: 512000 },
  { label: '1M', value: 1000000 },
];

const DEFAULT_INPUT_VALUE = DEFAULT_CONTEXT_AUTO_SIMULATION_WINDOW;
const WARNING_THRESHOLD = 8000;

// 数字格式化：1000 → "1,000"
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export const ContextAutoConfigScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const route =
    useRoute<RouteProp<SettingsStackParamList, 'ContextAutoConfig'>>();
  const preferredLlmConfigId = route.params?.llmConfigId;
  const referenceContextWindow = route.params?.referenceContextWindow;
  const isUnsavedDraft =
    preferredLlmConfigId == null || Number(preferredLlmConfigId) <= 0;
  const [inputText, setInputText] = useState<string>(String(DEFAULT_INPUT_VALUE));
  const [lastApplied, setLastApplied] = useState<ContextAutoAppliedRecord | null>(
    null,
  );
  const [policyV3, setPolicyV3] = useState(
    cloneDefaultContextAutomationPolicyV3(),
  );
  const [llmConfigs, setLlmConfigs] = useState<any[]>([]);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // 初次加载
  useEffect(() => {
    (async () => {
      try {
        const [savedInput, applied] = await Promise.all([
          getContextAutoInput(),
          getContextAutoLastApplied(),
        ]);
        const [loadedPolicyV3, configs] = await Promise.all([
          ensureContextAutomationPolicyV3(),
          db.getLLMConfigs(),
        ]);
        setInputText(
          String(
            resolveContextAutoSimulationDefault({
              savedInput,
              preferredConfigId: preferredLlmConfigId,
              configs,
              referenceContextWindow,
            }),
          ),
        );
        setLastApplied(applied);
        setPolicyV3(loadedPolicyV3);
        setLlmConfigs(configs);
      } catch (e: any) {
        Toast.show({ type: 'error', text1: '加载失败', text2: e?.message });
      }
    })();
  }, [preferredLlmConfigId, referenceContextWindow]);

  const numericInput = useMemo(() => {
    const v = Number(inputText);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }, [inputText]);

  const isWarning = numericInput > 0 && numericInput < WARNING_THRESHOLD;

  const handleQuickPreset = (value: number) => {
    setInputText(String(value));
  };

  const handleApply = () => {
    if (numericInput <= 0) {
      Toast.show({ type: 'error', text1: '请输入有效的上下文大小' });
      return;
    }
    const runApply = async () => {
      setApplying(true);
      try {
        const v3Record = await applyContextAutoAllocationV3(numericInput);
        setLastApplied({
          maxContextTokens: v3Record.maxContextTokens,
          appliedAt: v3Record.appliedAt,
          allocation: undefined as any,
          policySchemaVersion: 3,
          policyVersion: v3Record.policy.allocatorVersion,
          policyHash: v3Record.policyHash,
          syncedContextWindow: null,
          affectedCounts: {
            llmConfigs: v3Record.affectedCounts.llmConfigs,
            presets: v3Record.affectedCounts.presets,
            characters: 0,
            notes: 0,
            worldbookEntries: 0,
            worldbookCollections: 0,
          },
        });
        setPolicyV3(v3Record.policy);
        setLlmConfigs(await db.getLLMConfigs());
        Toast.show({
          type: 'success',
          text1: `已保存 ${formatNumber(numericInput)} tokens 的 V3 模拟窗口`,
        });
      } catch (e: any) {
        Toast.show({
          type: 'error',
          text1: '应用失败',
          text2: e?.message,
        });
      } finally {
        setApplying(false);
      }
    };
    Alert.alert(
      '确认保存 V3 预算模拟窗口',
      `将保存 ${formatNumber(
        numericInput,
      )} tokens 作为预算模拟窗口（用于 Preview / 预览）。\n\n` +
        '本操作只写入 V3 策略、模式和模拟窗口；不会修改任何 LLM 的真实 context_window / max_output_tokens，也不会把模拟值伪装成模型能力。',
      [
        { text: '取消', style: 'cancel' },
        { text: '保存模拟', onPress: () => { void runApply(); } },
      ],
    );
  };

  const handleRestoreDefaults = () => {
    Alert.alert(
      '恢复默认配置',
      '将恢复 V3 策略与预算模拟窗口默认值。\n\n' +
        '不会改变任何 LLM 的 context_window / max_output_tokens，也不会重置作家风格、旧版流水线字段或资源级 max_tokens。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '恢复',
          style: 'destructive',
          onPress: async () => {
            setRestoring(true);
            try {
              await restoreContextAutoDefaults();
              const restoredPolicy = cloneDefaultContextAutomationPolicyV3();
              setPolicyV3(restoredPolicy);
              Toast.show({ type: 'success', text1: '已恢复默认配置' });
              setInputText(String(DEFAULT_INPUT_VALUE));
              setLastApplied(null);
              setLlmConfigs(await db.getLLMConfigs());
            } catch (e: any) {
              Toast.show({
                type: 'error',
                text1: '恢复失败',
                text2: e?.message,
              });
            } finally {
              setRestoring(false);
            }
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <Header
        testID="context-auto-screen"
        title="上下文自动化配置"
        subtitle="V3 策略与预算模拟（不修改模型真实能力）"
      />
      <ScrollView contentContainerStyle={styles.content}>
        {isUnsavedDraft ? (
          <Card testID="context-auto-unsaved-notice">
            <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
              新配置尚未保存
            </Text>
            <Text style={[styles.cardMeta, { color: theme.colors.textSecondary }]}>
              当前从尚未保存的 LLM 配置进入。本页只做预算模拟，不会写入任何已保存模型的
              context_window / max_output_tokens。
            </Text>
          </Card>
        ) : null}

        {/* 上次应用记录 */}
        {lastApplied ? (
          <Card>
            <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
              上次应用记录
            </Text>
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
              模拟窗口：{formatNumber(lastApplied.maxContextTokens)} tokens
            </Text>
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
              时间：{new Date(lastApplied.appliedAt).toLocaleString('zh-CN')}
            </Text>
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
              {lastApplied.policySchemaVersion === 3
                ? 'V3 模式：只写入策略、模式与模拟窗口；模型真实能力与资料上限保持不变'
                : '历史兼容记录：不参与新 V3 任务，也不会覆盖当前模型真实能力'}
            </Text>
            {lastApplied.syncedContextWindow ? (
              <Text style={[styles.metaText, { color: theme.colors.accent }]}>
                历史记录曾同步模型真实能力：配置 #{lastApplied.syncedContextWindow.configId} →{' '}
                {formatNumber(lastApplied.syncedContextWindow.contextWindow)} /{' '}
                {formatNumber(
                  lastApplied.syncedContextWindow.maxOutputTokens ??
                    lastApplied.syncedContextWindow.contextWindow * 0.2,
                )}{' '}
                tokens（context_window / max_output_tokens）
              </Text>
            ) : null}
            {lastApplied.policyVersion ? (
              <Text
                style={[styles.metaText, { color: theme.colors.textSecondary }]}
              >
                历史策略记录：{lastApplied.policyVersion} · hash{' '}
                {(lastApplied.policyHash || '').slice(0, 12)}
              </Text>
            ) : null}
          </Card>
        ) : null}

        <Card testID="context-auto-capability-card">
          <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
            当前模型真实能力
          </Text>
          {llmConfigs.length > 0 ? (
            llmConfigs.map(config => {
              const isPreferred =
                preferredLlmConfigId != null &&
                Number(config.id) === Number(preferredLlmConfigId);
              return (
                <View
                  key={String(config.id)}
                  style={[styles.stagePreviewRow, { borderBottomColor: theme.colors.border }]}
                >
                  <View style={styles.stagePreviewLabel}>
                    <Text style={[styles.stageTitle, { color: theme.colors.textPrimary }]}>
                      {config.name || config.model_name || `LLM #${config.id}`}
                      {Number(config.is_active) === 1 ? ' · 当前' : ''}
                      {isPreferred ? ' · 参考' : ''}
                    </Text>
                    <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                      {config.model_name || '未命名模型'}
                    </Text>
                  </View>
                  <Text style={[styles.stagePreviewValue, { color: theme.colors.accent }]}>
                    {formatNumber(Number(config.context_window) || 0)} /{' '}
                    {formatNumber(Number(config.max_output_tokens) || 0)}
                  </Text>
                </View>
              );
            })
          ) : (
            <Text style={[styles.metaText, { color: theme.colors.textMuted }]}>
              暂无已保存的 LLM 配置。模拟窗口可先填写，但不会反向创建或改写模型能力。
            </Text>
          )}
          <Text style={[styles.footnote, { color: theme.colors.textMuted }]}>
            右侧依次为模型真实 context_window / max_output_tokens；0 表示未配置，运行时会依据当前模型 context_window 弹性派生输出。此页只读展示，不写回模型能力。
          </Text>
        </Card>

        {/* New tasks use V3; V2 remains an internal historical compatibility path. */}
        <Card>
          <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
            V3 分层弹性预算
          </Text>
          <Text style={[styles.cardMeta, { color: theme.colors.textSecondary }]}>
            新任务统一按模型真实 context_window、max_output_tokens 与本次实际需求计算
            Story State、Recent Bridge、Resources、Episodic 四个 Board；空闲容量可跨 Board
            借调。历史 V2 任务仍按原冻结版本恢复。
          </Text>
          <Text style={[styles.footnote, { color: theme.colors.textMuted }]}>
            当前页面的数字只用于预算模拟和 Preview，不会改写模型真实能力或资源 max_tokens。
            当前 V3 Policy：{policyV3.allocatorVersion} · hash{' '}
            {hashContextAutomationPolicyV3(policyV3).slice(0, 12)}
          </Text>
        </Card>

        {/* 预算模拟窗口 */}
        <Card>
          <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
            预算模拟窗口
          </Text>
          <Text style={[styles.cardMeta, { color: theme.colors.textSecondary }]}>
            这是 Preview / 预算模拟值，默认读取上方参考模型的 context_window（若已配置）。
            它不会改变模型真实能力；新任务仍以各阶段冻结的模型能力为准。
          </Text>
          <View style={styles.quickRow}>
            {QUICK_PRESETS.map((p) => {
              const active = numericInput === p.value;
              return (
                <TouchableOpacity
                  key={p.value}
                  testID={`context-auto-preset-${p.value}`}
                  onPress={() => handleQuickPreset(p.value)}
                  style={[
                    styles.quickChip,
                    {
                      borderColor: active ? theme.colors.accent : theme.colors.border,
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
                    {p.label}
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
              onChangeText={setInputText}
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
          {isWarning ? (
            <Text style={[styles.warning, { color: theme.colors.warning }]}>
              ⚠️ 模拟窗口过小，可能让 Preview 看起来偏紧，但不会改写模型真实能力
            </Text>
          ) : null}
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
            label={applying ? '应用中...' : '一键应用'}
            icon={Sparkles}
            flex
            disabled={applying || restoring || numericInput <= 0}
            onPress={handleApply}
          />
        </View>

        <Text style={[styles.footnote, { color: theme.colors.textMuted }]}>
          新大纲任务按冻结的模型真实能力分配五个阶段的弹性 reservation，不读取本页模拟窗口，也不读取旧版四阶段 Max Tokens。
        </Text>
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
  warning: { fontSize: 12, marginTop: spacing.xs },
  groupTitle: {
    fontSize: 13,
    fontWeight: '800',
    marginBottom: spacing.xs,
    letterSpacing: 0.3,
  },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  footnote: { fontSize: 11, lineHeight: 17, marginTop: spacing.sm },
  stagePreviewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  stagePreviewLabel: { flex: 1, marginRight: spacing.sm },
  stageTitle: { fontSize: 13, fontWeight: '700' },
  stagePreviewValue: { fontSize: 13, fontWeight: '800' },
});
