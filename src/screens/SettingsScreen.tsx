import React, { useEffect } from 'react';
import {
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import {
  Database,
  Factory,
  KeyRound,
  ListChecks,
  Moon,
  Palette,
  Sun,
  TreePine,
  BarChart3,
  Volume2,
} from 'lucide-react-native';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { useNavigation } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import {
  Button,
  Card,
  Header,
  Screen,
  Section,
  SegmentedControl,
  spacing,
} from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { useSettingsStore } from '../store/settingsStore';
import { useProjectStore } from '../store/projectStore';
import * as db from '../services/database';
import { requestNotificationPermission } from '../utils/notificationPermission';
import type { ThemeMode } from '../types/theme';
import appVersionJson from '../constants/version.json';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: '明亮' },
  { value: 'dark', label: '深色' },
  { value: 'eyecare', label: '护眼' },
];

import {
  isElasticBudgetV2Enabled,
  isMultiChapterBatchEnabled,
  setElasticBudgetV2Enabled,
  setMultiChapterBatchEnabled,
} from '../services/featureFlags';

export const SettingsScreen: React.FC = () => {
  const navigation = useNavigation<any>();
  const { theme, mode, setMode } = useThemeStore();
  const { backgroundPipelineEnabled, setBackgroundPipelineEnabled } =
    useSettingsStore();
  const { workspaceMode } = useProjectStore();
  const unresolvedCount = usePipelineTaskStore(s => s.getUnresolvedCount());
  const loadFromDB = usePipelineTaskStore(s => s.loadFromDB);

  // RB-17 fix (V2.11.34): experimental feature flags surface to release
  // users via Settings → 实验功能. Both flags default OFF; flipping them
  // here persists the choice into the settings table.
  const [multiChapterBatchEnabled, setMultiChapterBatchLocal] =
    React.useState(false);
  const [elasticBudgetV2Enabled, setElasticBudgetV2Local] =
    React.useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [batch, elastic] = await Promise.all([
          isMultiChapterBatchEnabled(),
          isElasticBudgetV2Enabled(),
        ]);
        if (!cancelled) {
          setMultiChapterBatchLocal(batch);
          setElasticBudgetV2Local(elastic);
        }
      } catch {
        // Flag reads are non-critical; keep defaults (OFF).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleMultiChapterBatch = async (value: boolean) => {
    setMultiChapterBatchLocal(value);
    try {
      await setMultiChapterBatchEnabled(value);
      Toast.show({
        type: value ? 'success' : 'info',
        text1: value ? 'AI 写 N 章已开启' : 'AI 写 N 章已关闭',
        text2: value
          ? '重启应用后生效。当前为实验功能，可能影响章节状态。'
          : '重启应用后生效。',
      });
    } catch (e: any) {
      setMultiChapterBatchLocal(!value);
      Toast.show({
        type: 'error',
        text1: '保存失败',
        text2: e?.message || '请稍后重试',
      });
    }
  };

  const toggleElasticBudgetV2 = async (value: boolean) => {
    setElasticBudgetV2Local(value);
    try {
      await setElasticBudgetV2Enabled(value);
      Toast.show({
        type: value ? 'success' : 'info',
        text1: value ? '弹性上下文预算已开启' : '弹性上下文预算已关闭',
        text2: '重启应用后生效。',
      });
    } catch (e: any) {
      setElasticBudgetV2Local(!value);
      Toast.show({
        type: 'error',
        text1: '保存失败',
        text2: e?.message || '请稍后重试',
      });
    }
  };

  useEffect(() => {
    loadFromDB();
  }, [loadFromDB]);

  const changeTheme = async (next: ThemeMode) => {
    setMode(next);
    await db.setSetting('theme_mode', next);
    Toast.show({ type: 'success', text1: '主题已切换' });
  };

  const toggleBackgroundPipeline = async (value: boolean) => {
    if (value) {
      // Android 13+ 可在此用户主动动作中直接请求通知权限；若用户此前拒绝或
      // 在系统层关闭通知，再退回设置页引导。
      const granted = await requestNotificationPermission();
      const {
        PipelineForeground,
      } = require('../native/PipelineForegroundModule');
      const ok = granted && (await PipelineForeground.isAvailable());
      if (!ok) {
        Alert.alert(
          '需要通知权限',
          '为保持后台写作并提醒任务完成，请前往系统设置授予 ShineWriter 通知权限。',
          [
            { text: '稍后', style: 'cancel' },
            { text: '去设置', onPress: () => Linking.openSettings() },
          ],
        );
        // 未授权时不能开启后台写作，否则用户会被误导为已生效
        return;
      }
    }
    await setBackgroundPipelineEnabled(value);
    Toast.show({
      type: 'success',
      text1: value ? '已开启后台写作' : '已关闭后台写作',
    });
  };

  return (
    <Screen>
      <Header title="设置" subtitle="模型、主题和诊断" />
      <ScrollView contentContainerStyle={styles.content}>
        <Section title="AI">
          <Card>
            <Text
              style={[styles.cardTitle, { color: theme.colors.textPrimary }]}
            >
              OpenAI 兼容接口
            </Text>
            <Text
              style={[styles.cardMeta, { color: theme.colors.textSecondary }]}
            >
              配置 API
              地址、Key、模型、上下文长度与自动化预算，可用于续写、摘要和情节线生成。
            </Text>
            <Button
              label="LLM 设置"
              icon={KeyRound}
              onPress={() => navigation.navigate('LLMSettings')}
            />
          </Card>
          <Card>
            <Text
              style={[styles.cardTitle, { color: theme.colors.textPrimary }]}
            >
              {workspaceMode === 'continuation'
                ? '续写生成流水线'
                : '多角色流水线'}
            </Text>
            <Text
              style={[styles.cardMeta, { color: theme.colors.textSecondary }]}
            >
              {workspaceMode === 'continuation'
                ? '配置续写的规划、生成、一致性检查、修复和状态提取规则。'
                : '4 阶段协作写作：初稿作者 → 审阅编辑 + 事实核查员 → 终审校对员。'}
            </Text>
            <Button
              label="流水线配置"
              icon={Factory}
              onPress={() =>
                navigation.navigate(
                  workspaceMode === 'continuation'
                    ? 'ContinuationGenerationConfig'
                    : 'PipelineConfig',
                )
              }
            />
            {workspaceMode === 'continuation' ? null : (
              <Button
                label={`流水线任务${
                  unresolvedCount > 0 ? ` (${unresolvedCount})` : ''
                }`}
                icon={ListChecks}
                variant="secondary"
                onPress={() => navigation.navigate('PipelineTask')}
              />
            )}
          </Card>
          <Card>
            <Text
              style={[styles.cardTitle, { color: theme.colors.textPrimary }]}
            >
              语音朗读
            </Text>
            <Text
              style={[styles.cardMeta, { color: theme.colors.textSecondary }]}
            >
              配置语音 API Key、URL、模型、音色与语速，在章节编辑页朗读正文。
            </Text>
            <Button
              label="语音设置"
              icon={Volume2}
              onPress={() => navigation.navigate('VoiceSettings')}
            />
          </Card>
          <Card>
            <Text
              style={[styles.cardTitle, { color: theme.colors.textPrimary }]}
            >
              后台写作
            </Text>
            <Text
              style={[styles.cardMeta, { color: theme.colors.textSecondary }]}
            >
              开启后，写作时以系统通知保持运行，切到其他 App
              或锁屏不会暂停流水线，完成后会通知你。
            </Text>
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text
                  style={[
                    styles.switchTitle,
                    { color: theme.colors.textPrimary },
                  ]}
                >
                  保持后台运行
                </Text>
                <Text
                  style={[
                    styles.switchHint,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  默认开启
                </Text>
              </View>
              <Switch
                value={backgroundPipelineEnabled}
                onValueChange={toggleBackgroundPipeline}
              />
            </View>
          </Card>
        </Section>
        <Section title="主题">
          <SegmentedControl
            value={mode}
            options={THEME_OPTIONS}
            onChange={changeTheme}
          />
          <View style={styles.themeHints}>
            <Sun size={18} color={theme.colors.textSecondary} />
            <Moon size={18} color={theme.colors.textSecondary} />
            <TreePine size={18} color={theme.colors.textSecondary} />
            <Palette size={18} color={theme.colors.textSecondary} />
          </View>
        </Section>
        <Section title="数据">
          <Card>
            <Text
              style={[styles.cardTitle, { color: theme.colors.textPrimary }]}
            >
              数据
            </Text>
            <Text
              style={[styles.cardMeta, { color: theme.colors.textSecondary }]}
            >
              管理备份恢复，并查看 LLM 调用次数和 Token
              消耗。恢复前会自动创建安全快照。
            </Text>
            <Button
              label="备份中心"
              icon={Database}
              onPress={() => navigation.navigate('BackupCenter')}
            />
            <Button
              label="用量统计"
              icon={BarChart3}
              variant="secondary"
              onPress={() => navigation.navigate('UsageStats')}
            />
          </Card>
        </Section>
        <Section title="实验功能">
          <Card>
            <Text
              style={[styles.cardTitle, { color: theme.colors.textPrimary }]}
            >
              实验功能
            </Text>
            <Text
              style={[styles.cardMeta, { color: theme.colors.textSecondary }]}
            >
              以下功能默认关闭。开启后需要重启应用生效；属于早期实验，
              可能影响章节状态、上下文分配或后台任务，请先在备份中心手动
              创建一份备份。
            </Text>
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text
                  style={[
                    styles.switchTitle,
                    { color: theme.colors.textPrimary },
                  ]}
                >
                  AI 写 N 章
                </Text>
                <Text
                  style={[
                    styles.switchHint,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  多章节批量写章（仅大纲模式）。
                </Text>
              </View>
              <Switch
                value={multiChapterBatchEnabled}
                onValueChange={toggleMultiChapterBatch}
              />
            </View>
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text
                  style={[
                    styles.switchTitle,
                    { color: theme.colors.textPrimary },
                  ]}
                >
                  弹性上下文预算
                </Text>
                <Text
                  style={[
                    styles.switchHint,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  流水线跨阶段 80% / 95% 双阈值预算池（实验）。
                </Text>
              </View>
              <Switch
                value={elasticBudgetV2Enabled}
                onValueChange={toggleElasticBudgetV2}
              />
            </View>
          </Card>
        </Section>
        <Section title="关于">
          <Card>
            <Text
              style={[styles.cardTitle, { color: theme.colors.textPrimary }]}
            >
              ShineWriter
            </Text>
            <Text
              style={[styles.cardMeta, { color: theme.colors.textSecondary }]}
            >
              Shine小说工作台 · {appVersionJson.versionName}
            </Text>
            <Text
              style={[styles.cardMeta, { color: theme.colors.textSecondary }]}
            >
              软件作者：ShineHe
            </Text>
          </Card>
        </Section>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 96 },
  cardTitle: {
    fontSize: 18,
    fontFamily: 'serif',
    fontWeight: '700',
    marginBottom: 5,
  },
  cardMeta: { fontSize: 13, lineHeight: 21, marginBottom: spacing.md },
  themeHints: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  switchText: { flex: 1 },
  switchTitle: { fontSize: 15, fontWeight: '800' },
  switchHint: { fontSize: 12, marginTop: 2 },
});
