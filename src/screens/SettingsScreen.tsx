import React, { useEffect } from 'react';
import {
  ScrollView,
  StyleSheet,
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
import { useProjectStore } from '../store/projectStore';
import * as db from '../services/database';
import type { ThemeMode } from '../types/theme';
import appVersionJson from '../constants/version.json';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: '明亮' },
  { value: 'dark', label: '深色' },
  { value: 'eyecare', label: '护眼' },
];

export const SettingsScreen: React.FC = () => {
  const navigation = useNavigation<any>();
  const { theme, mode, setMode } = useThemeStore();
  const { workspaceMode } = useProjectStore();
  const unresolvedCount = usePipelineTaskStore(s => s.getUnresolvedCount());
  const loadFromDB = usePipelineTaskStore(s => s.loadFromDB);

  useEffect(() => {
    loadFromDB();
  }, [loadFromDB]);

  const changeTheme = async (next: ThemeMode) => {
    setMode(next);
    await db.setSetting('theme_mode', next);
    Toast.show({ type: 'success', text1: '主题已切换' });
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
                : '统一完整协作写作流水线：初稿 → 审阅/事实核查 → Brief → 终稿；失败节点可精确重试。'}
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
});
