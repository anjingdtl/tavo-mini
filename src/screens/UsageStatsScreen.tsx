import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Header, LoadingState, Screen, SegmentedControl, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { useProjectStore } from '../store/projectStore';
import { getLLMUsageStats, getLLMUsageSummary } from '../services/database';

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
  const [loading, setLoading] = useState(true);

  const projectId = scope === 'current' && currentProject ? currentProject.id : null;

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [s, d] = await Promise.all([
        getLLMUsageSummary(projectId),
        getLLMUsageStats(projectId),
      ]);
      setSummary(s);
      setDailyStats(d);
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
          </Card>
          <FlatList
            data={dailyStats}
            keyExtractor={item => item.date}
            contentContainerStyle={styles.list}
            renderItem={renderItem}
          />
        </>
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
});
