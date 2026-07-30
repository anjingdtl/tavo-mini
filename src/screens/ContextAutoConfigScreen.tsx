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
import { useThemeStore } from '../store/themeStore';
import { useSettingsStore } from '../store/settingsStore';
import {
  allocateContextBudget,
  applyContextAutoAllocation,
  countAllResources,
  type AllocationResult,
  type ResourceCounts,
} from '../services/contextAutoAllocator';
import {
  getContextAutoInput,
  getContextAutoLastApplied,
  setContextAutoInput,
  type ContextAutoAppliedRecord,
} from '../data/repositories/contextAutoRepository';
import {
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_MAX_TOKENS,
} from '../constants/defaults';
import * as db from '../services/database';

const QUICK_PRESETS: { label: string; value: number }[] = [
  { label: '128K', value: 128000 },
  { label: '200K', value: 200000 },
  { label: '512K', value: 512000 },
  { label: '1M', value: 1000000 },
];

const DEFAULT_INPUT_VALUE = 200000;
const WARNING_THRESHOLD = 8000;

// 数字格式化：1000 → "1,000"
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

const PreviewRow: React.FC<{
  label: string;
  value: number;
  color: string;
  dimmed?: boolean;
}> = ({ label, value, color, dimmed }) => {
  const rowColor = dimmed ? '#999' : color;
  return (
    <View style={previewStyles.row}>
      <Text style={[previewStyles.label, { color: rowColor }]}>{label}</Text>
      <Text style={[previewStyles.value, { color: rowColor }]}>
        {formatNumber(value)}
      </Text>
    </View>
  );
};

export const ContextAutoConfigScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const loadSettings = useSettingsStore(state => state.loadSettings);
  const [inputText, setInputText] = useState<string>(String(DEFAULT_INPUT_VALUE));
  const [resourceCounts, setResourceCounts] = useState<ResourceCounts>({
    characters: 0,
    notes: 0,
    worldbookEntries: 0,
    worldbookCollections: 0,
  });
  const [lastApplied, setLastApplied] = useState<ContextAutoAppliedRecord | null>(
    null,
  );
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // 初次加载
  useEffect(() => {
    (async () => {
      try {
        const [savedInput, counts, applied] = await Promise.all([
          getContextAutoInput(),
          countAllResources(),
          getContextAutoLastApplied(),
        ]);
        if (savedInput != null) setInputText(String(savedInput));
        setResourceCounts(counts);
        setLastApplied(applied);
      } catch (e: any) {
        Toast.show({ type: 'error', text1: '加载失败', text2: e?.message });
      }
    })();
  }, []);

  const numericInput = useMemo(() => {
    const v = Number(inputText);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }, [inputText]);

  const preview: AllocationResult | null = useMemo(() => {
    if (numericInput <= 0) return null;
    try {
      return allocateContextBudget(numericInput, resourceCounts);
    } catch {
      return null;
    }
  }, [numericInput, resourceCounts]);

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
      '确认应用',
      `将以 ${formatNumber(numericInput)} tokens 为基准，覆写：\n\n` +
        '• 所有 LLM 配置的 context_window 与 max_output_tokens\n' +
        '• 所有预设的 max_tokens\n' +
        '• 当前项目的上下文与流水线配置\n' +
        '• 所有项目的角色、笔记、世界书 max_tokens\n\n' +
        '此操作不可撤销。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '应用',
          style: 'destructive',
          onPress: async () => {
            setApplying(true);
            try {
              await setContextAutoInput(numericInput);
              const record = await applyContextAutoAllocation(numericInput);
              // The allocation updates llm_config directly inside SQLite. Keep
              // the long-lived LLM Settings screen in sync immediately rather
              // than leaving its Zustand snapshot (and form fields) stale
              // until an app restart.
              await loadSettings();
              setLastApplied(record);
              Toast.show({
                type: 'success',
                text1: `已应用 ${formatNumber(numericInput)} tokens 的分配方案`,
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
      '将把 ContextConfig、PipelineConfig 的 token 字段恢复到出厂默认值。\n\n' +
        '注意：LLM 配置、预设、资源级 max_tokens 不会被重置。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '恢复',
          style: 'destructive',
          onPress: async () => {
            setRestoring(true);
            try {
              const pipelineConfig = await db.getPipelineConfig();
              await db.setContextConfig({
                ...DEFAULT_CONTEXT_CONFIG,
              });
              await db.setPipelineConfig({
                ...pipelineConfig,
                draftMaxTokens: DEFAULT_MAX_TOKENS,
                reviewMaxTokens: 1500,
                factCheckMaxTokens: 1500,
                proofMaxTokens: DEFAULT_MAX_TOKENS,
              });
              Toast.show({ type: 'success', text1: '已恢复默认配置' });
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
        subtitle="填一个数字，自动分配所有 token 预算"
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
              已覆盖：
              {lastApplied.affectedCounts.llmConfigs} 个 LLM 配置 ·{' '}
              {lastApplied.affectedCounts.presets} 个预设 ·{' '}
              {lastApplied.affectedCounts.characters +
                lastApplied.affectedCounts.notes +
                lastApplied.affectedCounts.worldbookEntries +
                lastApplied.affectedCounts.worldbookCollections}{' '}
              个资源
            </Text>
          </Card>
        ) : null}

        {/* 输入最大上下文 */}
        <Card>
          <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
            模型支持的最大上下文
          </Text>
          <Text style={[styles.cardMeta, { color: theme.colors.textSecondary }]}>
            查看你的模型文档（如 Claude/Gemini/DeepSeek），填入它支持的最大 tokens 数。
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
              placeholder="例：200000"
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

        {/* 分配预览 */}
        {preview ? (
          <Card>
            <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
              分配预览
            </Text>

            <Text style={[styles.groupTitle, { color: theme.colors.accent }]}>
              📥 输入侧（80% = {formatNumber(preview.inputBudget)}）
            </Text>
            <PreviewRow
              label="滑动窗口"
              value={preview.slidingWindowSize}
              color={theme.colors.textPrimary}
            />
            <PreviewRow
              label="资料预算"
              value={preview.resourceBudget}
              color={theme.colors.textPrimary}
            />
            <PreviewRow
              label="全局故事状态"
              value={preview.storyStateBudgetTokens}
              color={theme.colors.textPrimary}
            />
            <PreviewRow
              label="历史章节事件"
              value={preview.episodicMemoryBudgetTokens}
              color={theme.colors.textPrimary}
            />
            <PreviewRow
              label="每章记忆补丁输出上限"
              value={preview.memoryPatchMaxTokens}
              color={theme.colors.textPrimary}
            />

            <Text
              style={[
                styles.groupTitle,
                { color: theme.colors.accent, marginTop: spacing.md },
              ]}
            >
              📤 输出侧（20% = {formatNumber(preview.outputBudget)}）
            </Text>
            <PreviewRow
              label="草稿"
              value={preview.draftMaxTokens}
              color={theme.colors.textPrimary}
            />
            <PreviewRow
              label="审阅"
              value={preview.reviewMaxTokens}
              color={theme.colors.textPrimary}
            />
            <PreviewRow
              label="事实核查"
              value={preview.factCheckMaxTokens}
              color={theme.colors.textPrimary}
            />
            <PreviewRow
              label="校对"
              value={preview.proofMaxTokens}
              color={theme.colors.textPrimary}
            />

            <Text
              style={[
                styles.groupTitle,
                { color: theme.colors.accent, marginTop: spacing.md },
              ]}
            >
              📊 资源级（按实际数量分摊）
            </Text>
            <PreviewRow
              label={`角色（${resourceCounts.characters} 个，单项）`}
              value={preview.characterMaxTokens}
              color={theme.colors.textPrimary}
              dimmed={resourceCounts.characters === 0}
            />
            <PreviewRow
              label={`笔记（${resourceCounts.notes} 个，单项）`}
              value={preview.noteMaxTokens}
              color={theme.colors.textPrimary}
              dimmed={resourceCounts.notes === 0}
            />
            <PreviewRow
              label={`世界书条目（${resourceCounts.worldbookEntries} 个，单项）`}
              value={preview.worldbookEntryMaxTokens}
              color={theme.colors.textPrimary}
              dimmed={resourceCounts.worldbookEntries === 0}
            />
            <PreviewRow
              label={`世界书合集（${resourceCounts.worldbookCollections} 个，单项）`}
              value={preview.worldbookCollectionMaxTokens}
              color={theme.colors.textPrimary}
              dimmed={resourceCounts.worldbookCollections === 0}
            />

            <Text
              style={[
                styles.groupTitle,
                { color: theme.colors.accent, marginTop: spacing.md },
              ]}
            >
              🔗 同步写入
            </Text>
            <PreviewRow
              label="LLM context_window（非本地）"
              value={preview.llmContextWindow}
              color={theme.colors.textPrimary}
            />
            <PreviewRow
              label="LLM max_output_tokens（非本地）"
              value={preview.llmMaxOutputTokens}
              color={theme.colors.textPrimary}
            />
            <PreviewRow
              label="Presets max_tokens（全部）"
              value={preview.presetMaxTokens}
              color={theme.colors.textPrimary}
            />
          </Card>
        ) : null}

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
          默认输出 token 上限：{DEFAULT_MAX_TOKENS}。
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
});

const previewStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  label: { fontSize: 13 },
  value: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
