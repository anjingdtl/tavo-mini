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
import { useSettingsStore } from '../store/settingsStore';
import type { SettingsStackParamList } from '../navigation/TabNavigator';
import {
  applyContextAutoAllocationV3,
  deriveLLMCapabilityFromAutoWindow,
  syncLLMCapabilityAfterAutoApply,
} from '../services/contextAutoAllocator';
import {
  getContextAutoInput,
  getContextAutoLastApplied,
  ensureContextAutomationPolicyV3,
  setContextAutoMode,
  setContextAutoInput,
  setContextAutomationPolicy,
  setContextAutomationPolicyV3,
  type ContextAutoAppliedRecord,
} from '../data/repositories/contextAutoRepository';
import {
  cloneDefaultContextAutomationPolicy,
  cloneDefaultContextAutomationPolicyV3,
  hashContextAutomationPolicyV3,
} from '../services/contextAutomationPolicy';
import {
  DEFAULT_CONTEXT_CONFIG,
} from '../constants/defaults';
import * as db from '../services/database';

const QUICK_PRESETS: { label: string; value: number }[] = [
  { label: '128K', value: 128000 },
  { label: '200K', value: 200000 },
  { label: '512K', value: 512000 },
  { label: '1M', value: 1000000 },
];

const DEFAULT_INPUT_VALUE = 1000000;
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
  const loadSettings = useSettingsStore(state => state.loadSettings);
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
        if (savedInput != null) setInputText(String(savedInput));
        setLastApplied(applied);
        setPolicyV3(loadedPolicyV3);
        setLlmConfigs(configs);
      } catch (e: any) {
        Toast.show({ type: 'error', text1: '加载失败', text2: e?.message });
      }
    })();
  }, []);

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
    Alert.alert(
      '确认保存 V3 预算模拟窗口',
      `将保存 ${formatNumber(
        numericInput,
      )} tokens 作为预览模拟值，并按弹性预算 80/20 同步当前 LLM 的上下文长度与最大输出 Token（${formatNumber(
        deriveLLMCapabilityFromAutoWindow(numericInput).maxOutputTokens,
      )}）。不会批量改写其他模型、作家风格或资料额度。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '应用',
          style: 'destructive',
          onPress: async () => {
            setApplying(true);
            try {
              const v3Record = await applyContextAutoAllocationV3(numericInput);
              await syncLLMCapabilityAfterAutoApply(
                numericInput,
                preferredLlmConfigId,
              );
              await loadSettings();
              setLastApplied({
                maxContextTokens: v3Record.maxContextTokens,
                appliedAt: v3Record.appliedAt,
                allocation: undefined as any,
                policySchemaVersion: 3,
                policyVersion: v3Record.policy.allocatorVersion,
                policyHash: v3Record.policyHash,
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
          },
        },
      ],
    );
  };

  const handleRestoreDefaults = () => {
    Alert.alert(
      '恢复默认配置',
      '将恢复 V3 策略与预算模拟窗口默认值。\n\n' +
        '注意：LLM 配置、作家风格、旧版流水线字段和资源级 max_tokens 不会被重置。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '恢复',
          style: 'destructive',
          onPress: async () => {
            setRestoring(true);
            try {
              const defaultPolicy = cloneDefaultContextAutomationPolicy();
              const defaultPolicyV3 = cloneDefaultContextAutomationPolicyV3();
              await setContextAutomationPolicy(defaultPolicy);
              await setContextAutomationPolicyV3(defaultPolicyV3);
              setPolicyV3(defaultPolicyV3);
              await setContextAutoMode('v3');
              await setContextAutoInput(DEFAULT_INPUT_VALUE);
              await db.setContextConfig({
                ...DEFAULT_CONTEXT_CONFIG,
              });
              Toast.show({ type: 'success', text1: '已恢复默认配置' });
              setInputText(String(DEFAULT_INPUT_VALUE));
              setLastApplied(null);
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
        title="上下文自动化配置"
        subtitle="V3 策略与预算模拟（不修改模型真实能力）"
      />
      <ScrollView contentContainerStyle={styles.content}>
        {/* 上次应用记录 */}
        {lastApplied ? (
          <Card>
            <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
              上次应用记录
            </Text>
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
              上下文大小：{formatNumber(lastApplied.maxContextTokens)} tokens
            </Text>
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
              时间：{new Date(lastApplied.appliedAt).toLocaleString('zh-CN')}
            </Text>
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
              {lastApplied.policySchemaVersion === 3
                ? 'V3 模式：仅写入策略与模式标记，保留每个模型的真实上下文窗口与资料上限不变'
                : '历史兼容记录：不参与新 V3 任务，也不会覆盖当前模型真实能力'}
            </Text>
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

        <Card>
          <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
            当前模型真实能力
          </Text>
          {llmConfigs.length > 0 ? (
            llmConfigs.map(config => (
              <View
                key={String(config.id)}
                style={[styles.stagePreviewRow, { borderBottomColor: theme.colors.border }]}
              >
                <View style={styles.stagePreviewLabel}>
                  <Text style={[styles.stageTitle, { color: theme.colors.textPrimary }]}>
                    {config.name || config.model_name || `LLM #${config.id}`}
                    {Number(config.is_active) === 1 ? ' · 当前' : ''}
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
            ))
          ) : (
            <Text style={[styles.metaText, { color: theme.colors.textMuted }]}>
              暂无 LLM 配置；运行时会在发送前读取实际模型能力。
            </Text>
          )}
          <Text style={[styles.footnote, { color: theme.colors.textMuted }]}>
            右侧依次为 context_window / max_output_tokens。V3 不会用全局数字覆盖这些值。
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
            当前页面的数字用于预算模拟和 Preview，并按 80/20 弹性包络同步当前 LLM 的上下文长度与最大输出 Token。不会批量覆盖其他模型或资源 max_tokens。
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
            用于 Preview 查看不同窗口下的 Board 分配；真实模型能力来自当前 LLM 配置，
            不会被这个数字覆盖。
          </Text>
          <View style={styles.quickRow}>
            {QUICK_PRESETS.map((p) => {
              const active = numericInput === p.value;
              return (
                <TouchableOpacity
                  key={p.value}
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
              ⚠️ 上下文过小，可能影响生成质量
            </Text>
          ) : null}
        </Card>

        <View style={styles.buttonRow}>
          <Button
            label="恢复默认"
            icon={RotateCcw}
            variant="ghost"
            flex
            disabled={restoring || applying}
            onPress={handleRestoreDefaults}
          />
          <Button
            label={applying ? '应用中...' : '一键应用'}
            icon={Sparkles}
            flex
            disabled={applying || restoring || numericInput <= 0}
            onPress={handleApply}
          />
        </View>

        <Text style={[styles.footnote, { color: theme.colors.textMuted }]}>
          新大纲任务的五个阶段各自冻结弹性 reservation，不读取旧版四阶段 Max Tokens。
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
