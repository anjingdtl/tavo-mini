import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { RotateCcw, Save } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import {
  Button,
  Field,
  Header,
  Screen,
  SegmentedControl,
  spacing,
} from '../components/ui';
import { DEFAULT_CONTEXT_CONFIG } from '../constants/defaults';
import { useSettingsStore } from '../store/settingsStore';
import { useThemeStore } from '../store/themeStore';
import type { ContextConfig, ContextStrategy } from '../types/novel';

const STRATEGIES: { value: ContextStrategy; label: string }[] = [
  { value: 'sliding', label: '滑动窗口' },
  { value: 'full', label: '完整前文' },
  { value: 'custom', label: '自定义' },
];

const STRATEGY_HELP: Record<ContextStrategy, string> = {
  sliding:
    '读取最近若干章，并按 token 预算截取末尾正文，适合日常续写和长篇连载。',
  full: '尽量读取所有前文，再按预算裁剪，适合短篇或上下文窗口较大的模型。',
  custom: '只读取指定章节序号范围，适合重写某段、跳章或指定参考范围。',
};

export const ContextConfigScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const { contextConfig, loadSettings, setContextConfig } = useSettingsStore();
  const [draft, setDraft] = useState<ContextConfig>(contextConfig);
  // 10.5: 编辑态 ref，用户主动编辑后 store 变化不再覆盖本地草稿
  const isEditingRef = useRef(false);
  const updateDraft = (next: ContextConfig) => {
    isEditingRef.current = true;
    setDraft(next);
  };

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    // 10.5: 用户主动编辑过 draft 后，store 变更（如别处保存）不再覆盖本地草稿
    if (isEditingRef.current) return;
    setDraft(contextConfig);
  }, [contextConfig]);

  const save = async () => {
    // Phase9-BUG#13: 包裹 try-catch，失败时不显示成功 Toast 误导用户
    try {
      await setContextConfig(draft);
      Toast.show({ type: 'success', text1: '上下文配置已保存' });
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const handleReset = () => {
    Alert.alert(
      '恢复默认配置',
      '将把所有上下文参数重置为初始推荐值。此操作只更新当前表单，需点击「保存配置」才会生效。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '恢复默认',
          style: 'destructive',
          onPress: () => {
            updateDraft({ ...DEFAULT_CONTEXT_CONFIG });
            Toast.show({ type: 'info', text1: '已恢复默认值，请点击保存生效' });
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <Header title="上下文配置" subtitle="控制 AI 读取多少前文、摘要和资料" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
          前文策略
        </Text>
        <SegmentedControl
          value={draft.strategy}
          options={STRATEGIES}
          onChange={strategy => updateDraft({ ...draft, strategy })}
        />
        <View
          style={[
            styles.helpBox,
            {
              backgroundColor: theme.colors.card,
              borderColor: theme.colors.border,
            },
          ]}
        >
          {STRATEGIES.map(strategy => {
            const active = strategy.value === draft.strategy;
            return (
              <View key={strategy.value} style={styles.helpItem}>
                <Text
                  style={[
                    styles.helpTitle,
                    {
                      color: active
                        ? theme.colors.accent
                        : theme.colors.textPrimary,
                    },
                  ]}
                >
                  {strategy.label}
                </Text>
                <Text
                  style={[
                    styles.helpText,
                    {
                      color: active
                        ? theme.colors.textPrimary
                        : theme.colors.textSecondary,
                    },
                  ]}
                >
                  {STRATEGY_HELP[strategy.value]}
                </Text>
              </View>
            );
          })}
        </View>
        <Field
          label="前文预算 tokens"
          value={String(draft.slidingWindowSize)}
          onChangeText={value =>
            updateDraft({ ...draft, slidingWindowSize: Number(value) ?? 0 })
          }
          keyboardType="number-pad"
        />
        {draft.strategy === 'sliding' ? (
          <Field
            label="最近正文章数（1–10 章）"
            value={
              draft.recentChapterCount == null
                ? ''
                : String(draft.recentChapterCount)
            }
            onChangeText={value => {
              const trimmed = value.trim();
              updateDraft({
                ...draft,
                recentChapterCount:
                  trimmed === ''
                    ? undefined
                    : Math.min(10, Math.max(1, Number(trimmed) || 1)),
              });
            }}
            keyboardType="number-pad"
          />
        ) : null}
        <Field
          label="记忆摘要预算 tokens"
          value={String(draft.summaryBudgetTokens ?? 20000)}
          onChangeText={value =>
            updateDraft({
              ...draft,
              summaryBudgetTokens: Number(value) ?? 20000,
            })
          }
          keyboardType="number-pad"
        />
        <Field
          label="记忆摘要 Top K"
          value={String(draft.memoryTopK ?? 10)}
          onChangeText={value =>
            updateDraft({ ...draft, memoryTopK: Number(value) ?? 10 })
          }
          keyboardType="number-pad"
        />
        <Field
          label="资料预算 tokens"
          value={String(draft.resourceBudget)}
          onChangeText={value =>
            updateDraft({ ...draft, resourceBudget: Number(value) ?? 0 })
          }
          keyboardType="number-pad"
        />
        <Field
          label="世界书扫描深度"
          value={String(draft.worldbookScanDepth ?? 4)}
          onChangeText={value =>
            updateDraft({ ...draft, worldbookScanDepth: Number(value) ?? 4 })
          }
          keyboardType="number-pad"
        />
        {draft.strategy === 'custom' ? (
          <>
            <Field
              label="自定义开始章节序号"
              value={String(draft.customRangeStart)}
              onChangeText={value =>
                updateDraft({ ...draft, customRangeStart: Number(value) ?? 0 })
              }
              keyboardType="number-pad"
            />
            <Field
              label="自定义结束章节序号（-1 表示最后）"
              value={String(draft.customRangeEnd)}
              onChangeText={value =>
                updateDraft({ ...draft, customRangeEnd: Number(value) ?? -1 })
              }
              keyboardType="numbers-and-punctuation"
            />
          </>
        ) : null}
        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text
              style={[styles.switchTitle, { color: theme.colors.textPrimary }]}
            >
              注入角色、世界书和笔记
            </Text>
            <Text
              style={[styles.switchHint, { color: theme.colors.textSecondary }]}
            >
              关闭后角色 / 世界书 / 笔记不进入新任务。写作预设仍生效。
            </Text>
          </View>
          <Switch
            value={draft.includeResources}
            onValueChange={includeResources =>
              updateDraft({ ...draft, includeResources })
            }
          />
        </View>
        <Text
          style={[styles.switchTitle, { color: theme.colors.textPrimary }]}
        >
          资料详情强度
        </Text>
        <Text
          style={[styles.switchHint, { color: theme.colors.textSecondary }]}
        >
          只影响角色 / 世界书详情展开，不会丢掉全局感知骨架。
        </Text>
        <SegmentedControl
          value={draft.resourceDetailIntensity || 'balanced'}
          options={[
            { value: 'save', label: '节省' },
            { value: 'balanced', label: '均衡' },
            { value: 'rich', label: '丰富' },
          ]}
          onChange={resourceDetailIntensity =>
            updateDraft({
              ...draft,
              resourceDetailIntensity: resourceDetailIntensity as
                | 'save'
                | 'balanced'
                | 'rich',
            })
          }
        />
        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text
              style={[styles.switchTitle, { color: theme.colors.textPrimary }]}
            >
              世界书递归触发
            </Text>
            <Text
              style={[styles.switchHint, { color: theme.colors.textSecondary }]}
            >
              启用后，已命中的世界书内容可再触发一轮相关条目。
            </Text>
          </View>
          <Switch
            value={draft.worldbookRecursive !== false}
            onValueChange={worldbookRecursive =>
              updateDraft({ ...draft, worldbookRecursive })
            }
          />
        </View>
        <View style={styles.buttonRow}>
          <Button
            label="恢复默认"
            icon={RotateCcw}
            variant="ghost"
            flex
            onPress={handleReset}
          />
          <Button label="保存配置" icon={Save} flex onPress={save} />
        </View>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 96, gap: spacing.md },
  label: { fontSize: 12, fontWeight: '800' },
  helpBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: spacing.md,
    gap: spacing.sm,
  },
  helpItem: { gap: 2 },
  helpTitle: { fontSize: 13, fontWeight: '800' },
  helpText: { fontSize: 12, lineHeight: 18 },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  switchText: { flex: 1 },
  switchTitle: { fontSize: 15, fontWeight: '800' },
  switchHint: { fontSize: 12, marginTop: 2 },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
});
