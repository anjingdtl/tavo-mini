import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Header, LoadingState, Screen, SegmentedControl, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { useProjectStore } from '../store/projectStore';
import { getLLMUsageByConfig, getLLMUsageStats, getLLMUsageSummary } from '../services/database';

type ScopeOption = 'all' | 'current';

const SCOPE_OPTIONS: { value: ScopeOption; label: string }[] = [
  { value: 'all', label: '全部项目' },
  { value: 'current', label: '当前项目' },
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface Props {
  onClose?: () => void;
}

export const UsageStatsScreen: React.FC<Props> = ({ onClose }) => {
  const navigation = useNavigation();
  const handleClose = onClose || (() => navigation.goBack());
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();

  const [scope, setScope] = useState<ScopeOption>('all');
  const [summary, setSummary] = useState<any>(null);
  const [dailyStats, setDailyStats] = useState<any[]>([]);
  // V2.2.0 (schema 10): 按 LLM 配置分组，多 LLM 切换可识别来源
  const [byConfig, setByConfig] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const projectId = scope === 'current' && currentProject ? currentProject.id : null;

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [s, d, byCfg] = await Promise.all([
        getLLMUsageSummary(projectId),
        getLLMUsageStats(projectId),
        getLLMUsageByConfig(projectId),
      ]);
      setSummary(s);
      setDailyStats(d);
      setByConfig(byCfg);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '加载用量数据失败', text2: e?.message });
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const renderItem = ({ item }: { item: any }) => (
    <Card>
      <View style={styles.dateRow}>
        <Text style={[styles.dateText, { color: theme.colors.textPrimary }]}>{item.date}</Text>
        <Text style={[styles.callCount, { color: theme.colors.accent }]}>{item.call_count} 次调用</Text>
      </View>
      <View style={styles.tokenRow}>
        <View style={styles.tokenItem}>
          <Text style={[styles.tokenLabel, { color: theme.colors.textSecondary }]}>输入</Text>
          <Text style={[styles.tokenValue, { color: theme.colors.textPrimary }]}>{formatTokens(item.total_input_tokens || 0)}</Text>
        </View>
        <View style={styles.tokenItem}>
          <Text style={[styles.tokenLabel, { color: theme.colors.textSecondary }]}>输出</Text>
          <Text style={[styles.tokenValue, { color: theme.colors.textPrimary }]}>{formatTokens(item.total_output_tokens || 0)}</Text>
        </View>
        <View style={styles.tokenItem}>
          <Text style={[styles.tokenLabel, { color: theme.colors.textSecondary }]}>合计</Text>
          <Text style={[styles.tokenValue, { color: theme.colors.textPrimary }]}>{formatTokens(item.total_tokens || 0)}</Text>
        </View>
      </View>
      {item.models ? (
        <Text style={[styles.modelsText, { color: theme.colors.textMuted }]} numberOfLines={1}>
          模型: {item.models}
        </Text>
      ) : null}
    </Card>
  );

  // ListHeaderComponent：总览卡片 + 按 LLM 配置分组卡片。
  // 把它们放进 FlatList 头部，与按日期列表一起滚动，避免嵌套滚动冲突。
  const renderHeader = () => (
    <>
      <Card style={styles.summaryCard}>
        <Text style={[styles.summaryTitle, { color: theme.colors.textPrimary }]}>总览</Text>
        <View style={styles.summaryRow}>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryNumber, { color: theme.colors.accent }]}>{summary.total_calls}</Text>
            <Text style={[styles.summaryLabel, { color: theme.colors.textSecondary }]}>调用次数</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryNumber, { color: theme.colors.accent }]}>{formatTokens(summary.total_input_tokens)}</Text>
            <Text style={[styles.summaryLabel, { color: theme.colors.textSecondary }]}>输入 Token</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryNumber, { color: theme.colors.accent }]}>{formatTokens(summary.total_output_tokens)}</Text>
            <Text style={[styles.summaryLabel, { color: theme.colors.textSecondary }]}>输出 Token</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryNumber, { color: theme.colors.accent }]}>{formatTokens(summary.total_tokens)}</Text>
            <Text style={[styles.summaryLabel, { color: theme.colors.textSecondary }]}>合计 Token</Text>
          </View>
        </View>
        <Text style={[styles.v4Hint, { color: theme.colors.textSecondary }]}>
          原著续写 V4：Writer、Checker、Control、Repair 最多各占 1 次物理请求；Control 的本地汉字计数不产生请求，采纳后的 State Extraction 也不计入四请求上限。
        </Text>
      </Card>
      {byConfig.length > 0 ? (
        <Card style={styles.byConfigCard}>
          <Text style={[styles.summaryTitle, { color: theme.colors.textPrimary }]}>按 LLM 配置</Text>
          <Text style={[styles.byConfigHint, { color: theme.colors.textSecondary }]}>
            共 {byConfig.length} 个配置，按调用量降序
          </Text>
          {byConfig.map((cfg, idx) => (
            <View
              key={`cfg-${cfg.llm_config_id ?? 0}-${idx}`}
              style={[styles.configItem, idx > 0 ? styles.configItemBorder : null, { borderColor: theme.colors.border }]}
            >
              <View style={styles.configHeader}>
                <Text style={[styles.configName, { color: theme.colors.textPrimary }]} numberOfLines={1}>
                  {cfg.llm_config_name || '未命名配置'}
                </Text>
                <Text style={[styles.configCalls, { color: theme.colors.accent }]}>
                  {cfg.call_count} 次
                </Text>
              </View>
              <View style={styles.tokenRow}>
                <View style={styles.tokenItem}>
                  <Text style={[styles.tokenLabel, { color: theme.colors.textSecondary }]}>输入</Text>
                  <Text style={[styles.tokenValue, { color: theme.colors.textPrimary }]}>{formatTokens(cfg.total_input_tokens || 0)}</Text>
                </View>
                <View style={styles.tokenItem}>
                  <Text style={[styles.tokenLabel, { color: theme.colors.textSecondary }]}>输出</Text>
                  <Text style={[styles.tokenValue, { color: theme.colors.textPrimary }]}>{formatTokens(cfg.total_output_tokens || 0)}</Text>
                </View>
                <View style={styles.tokenItem}>
                  <Text style={[styles.tokenLabel, { color: theme.colors.textSecondary }]}>合计</Text>
                  <Text style={[styles.tokenValue, { color: theme.colors.textPrimary }]}>{formatTokens(cfg.total_tokens || 0)}</Text>
                </View>
              </View>
              {cfg.models ? (
                <Text style={[styles.modelsText, { color: theme.colors.textMuted }]} numberOfLines={1}>
                  模型: {cfg.models}
                </Text>
              ) : null}
            </View>
          ))}
        </Card>
      ) : null}
    </>
  );

  return (
    <Screen>
      <Header
        title="用量统计"
        subtitle="LLM 调用与 Token 消耗"
        action={<Button label="关闭" variant="ghost" compact onPress={handleClose} />}
      />
      <View style={styles.scopeRow}>
        <SegmentedControl value={scope} options={SCOPE_OPTIONS} onChange={setScope} />
      </View>
      {loading ? (
        <LoadingState label="加载统计数据..." />
      ) : !summary || summary.total_calls === 0 ? (
        <EmptyState
          title="暂无用量数据"
          description="使用 AI 功能后，这里将显示调用统计"
        />
      ) : (
        <FlatList
          data={dailyStats}
          keyExtractor={item => item.date}
          contentContainerStyle={styles.list}
          ListHeaderComponent={renderHeader}
          renderItem={renderItem}
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  scopeRow: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  summaryCard: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  summaryTitle: {
    fontSize: 16,
    fontWeight: '800',
    marginBottom: spacing.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  summaryItem: {
    alignItems: 'center',
    flex: 1,
  },
  summaryNumber: {
    fontSize: 18,
    fontWeight: '700',
  },
  summaryLabel: {
    fontSize: 11,
    marginTop: 2,
  },
  v4Hint: {
    fontSize: 11,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  list: {
    padding: spacing.lg,
    paddingBottom: 96,
  },
  dateRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dateText: {
    fontSize: 14,
    fontWeight: '700',
  },
  callCount: {
    fontSize: 12,
    fontWeight: '600',
  },
  tokenRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginTop: spacing.sm,
  },
  tokenItem: {
    alignItems: 'center',
  },
  tokenLabel: {
    fontSize: 11,
  },
  tokenValue: {
    fontSize: 13,
    fontWeight: '600',
  },
  modelsText: {
    fontSize: 11,
    marginTop: spacing.xs,
  },
  // V2.2.0 (schema 10): 按 LLM 配置分组卡片样式
  byConfigCard: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  byConfigHint: {
    fontSize: 11,
    marginBottom: spacing.sm,
  },
  configItem: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  configItemBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  configHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  configName: {
    fontSize: 13,
    fontWeight: '700',
    flex: 1,
    marginRight: spacing.sm,
  },
  configCalls: {
    fontSize: 12,
    fontWeight: '600',
  },
});
