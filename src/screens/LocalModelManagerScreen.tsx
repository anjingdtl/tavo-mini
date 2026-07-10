import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { pick, types, isCancel } from '@react-native-documents/picker';
import { ArrowLeft, Cpu, Play, Plus, Trash2 } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, Header, Screen, spacing } from '../components/ui';
import { useLocalModelStore } from '../store/localModelStore';
import { useSettingsStore } from '../store/settingsStore';
import { useThemeStore } from '../store/themeStore';
import type { SettingsStackParamList } from '../navigation/TabNavigator';
import type { LocalModel } from '../services/localModels';
import { LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS } from '../constants/llmDefaults';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatStatusLabel(status: LocalModel['status']): string {
  const labels: Record<LocalModel['status'], string> = {
    importing: '导入中',
    validating: '验证中',
    ready: '可用',
    incompatible: '不兼容',
    corrupted: '已损坏',
    missing: '文件缺失',
    error: '错误',
    unavailable: '不可用',
  };
  return labels[status] || status;
}

export const LocalModelManagerScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const navigation = useNavigation<NativeStackNavigationProp<SettingsStackParamList>>();
  const { models, import: importState, loadingModelId, refreshModels, startImport, cancelImport, loadModel, validateModel, deleteModel } = useLocalModelStore();
  const { saveLLMConfig, setActiveLLMConfig } = useSettingsStore();
  const [importing, setImporting] = useState(false);
  const [indeterminateLeft, setIndeterminateLeft] = useState(0);
  const indeterminateDirection = useRef(1);

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  // 不确定进度条动画：复制中但拿不到总大小时，让一个小条在轨道里来回跑。
  useEffect(() => {
    if (importState.state !== 'copying' || importState.totalBytes > 0) {
      setIndeterminateLeft(0);
      return;
    }
    const interval = setInterval(() => {
      setIndeterminateLeft((prev) => {
        const step = 2 * indeterminateDirection.current;
        const next = prev + step;
        if (next >= 75) indeterminateDirection.current = -1;
        if (next <= 0) indeterminateDirection.current = 1;
        return Math.max(0, Math.min(75, next));
      });
    }, 40);
    return () => clearInterval(interval);
  }, [importState.state, importState.totalBytes]);

  const handleImport = async () => {
    try {
      const [result] = await pick({
        mode: 'open',
        type: types.allFiles,
      });
      if (!result.name?.toLowerCase().endsWith('.gguf')) {
        Alert.alert('无法导入', '请选择扩展名为 .gguf 的模型文件。');
        return;
      }
      setImporting(true);
      await startImport(result.uri, result.name, undefined, result.size ?? undefined);
      Toast.show({ type: 'success', text1: '模型导入成功' });
    } catch (error: any) {
      if (isCancel(error)) return;
      Alert.alert('导入失败', error?.message || '请重试');
    } finally {
      setImporting(false);
    }
  };

  const handleTest = async (model: LocalModel) => {
    try {
      await loadModel(model.id);
      Toast.show({ type: 'success', text1: '模型加载成功' });
    } catch (error: any) {
      Alert.alert('加载失败', error?.message || '模型加载失败');
    }
  };

  const handleValidate = async (model: LocalModel) => {
    try {
      setImporting(true);
      await validateModel(model.id);
      Toast.show({ type: 'success', text1: '模型验证成功' });
    } catch (error: any) {
      Alert.alert('验证失败', error?.message || '模型验证失败');
    } finally {
      setImporting(false);
    }
  };

  const handleCreateConfig = async (model: LocalModel) => {
    try {
      const name = `本地：${model.display_name}`;
      const id = await saveLLMConfig({
        name,
        provider_type: 'llama_cpp',
        base_url: '',
        api_key: '',
        model_name: model.display_name,
        local_model_id: model.id,
        local_backend: 'cpu',
        // 本地模型在模拟器/低端机 CPU 上 prefill 慢，默认用 2048 上下文更友好。
        context_window: model.context_length ?? 2048,
        max_output_tokens: model.max_output_tokens ?? LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
      });
      // 修复#LM-create：创建本地模型配置后自动激活。
      // 旧逻辑只 saveLLMConfig 不传 is_active，导致 is_active 留 0、激活位仍是历史默认 OpenAI
      // 配置。用户写作时走 openAI provider → 没填 url/api_key → 误报"请先在设置中配置 API 地址"。
      await setActiveLLMConfig(id);
      Toast.show({ type: 'success', text1: '已创建并切换到该本地模型配置' });
      navigation.navigate('LLMSettings');
    } catch (error: any) {
      Alert.alert('创建配置失败', error?.message || '请重试');
    }
  };

  const handleDelete = (model: LocalModel) => {
    Alert.alert('删除模型', `确定删除「${model.display_name}」？模型文件将一并删除。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteModel(model.id);
            Toast.show({ type: 'success', text1: '模型已删除' });
          } catch (error: any) {
            Alert.alert('删除失败', error?.message || '请重试');
          }
        },
      },
    ]);
  };

  const progressPercent = importState.totalBytes > 0
    ? Math.min(100, Math.round((importState.bytesCopied / importState.totalBytes) * 100))
    : 0;
  const hasTotalBytes = importState.totalBytes > 0;

  return (
    <Screen>
      <Header
        title="本地模型管理"
        subtitle="导入并管理 GGUF 离线模型"
        action={
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
            <ArrowLeft size={20} color={theme.colors.textPrimary} />
          </TouchableOpacity>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Card style={styles.noticeCard}>
          <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
            支持 Qwen2.5 / Llama-3 / Mistral / Phi 等 GGUF 量化模型。推荐 Q4_K_M 量化，1-3B 参数模型约需 1.5-3GB 存储空间。模型文件保存在应用私有目录，卸载应用会删除这些文件，请自行保留原始模型文件。
          </Text>
        </Card>

        <Button
          label="导入 .gguf 模型"
          icon={Plus}
          onPress={handleImport}
          disabled={importing || importState.state !== 'idle'}
        />

        {models.length === 0 ? (
          <Card style={styles.emptyCard}>
            <Text style={[styles.emptyTitle, { color: theme.colors.textPrimary }]}>还没有本地模型</Text>
            <Text style={[styles.emptyDesc, { color: theme.colors.textSecondary }]}>
              点击上方按钮导入 GGUF 模型文件。
            </Text>
          </Card>
        ) : (
          <View style={styles.list}>
            {models.map((model) => (
              <Card key={model.id} style={styles.modelCard}>
                <View style={styles.modelHeader}>
                  <View style={styles.modelInfo}>
                    <Text style={[styles.modelName, { color: theme.colors.textPrimary }]} numberOfLines={1}>
                      {model.display_name}
                    </Text>
                    <Text style={[styles.modelFile, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                      {model.original_filename}
                    </Text>
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: theme.colors.accentSoft }]}>
                    <Text style={[styles.statusText, { color: theme.colors.accent }]}>{formatStatusLabel(model.status)}</Text>
                  </View>
                </View>

                <View style={styles.statsRow}>
                  <Stat label="大小" value={formatBytes(model.file_size)} theme={theme.colors.textSecondary} />
                  <Stat label="后端" value={model.validated_backend || model.actual_backend || model.backend_preference || 'cpu'} theme={theme.colors.textSecondary} />
                  <Stat label="模板" value={model.prompt_template || 'chatml'} theme={theme.colors.textSecondary} />
                  <Stat
                    label="加载耗时"
                    value={model.load_time_ms ? `${model.load_time_ms}ms` : '-'}
                    theme={theme.colors.textSecondary}
                  />
                </View>

                <View style={styles.actions}>
                  {model.status === 'ready' ? (
                    <Button
                      label="测试"
                      icon={Play}
                      variant="secondary"
                      compact
                      onPress={() => handleTest(model)}
                      disabled={loadingModelId === model.id}
                      flex
                    />
                  ) : (
                    <Button
                      label="验证"
                      icon={Play}
                      variant="secondary"
                      compact
                      onPress={() => handleValidate(model)}
                      disabled={importing || loadingModelId === model.id}
                      flex
                    />
                  )}
                  <Button
                    label="创建 AI 配置"
                    icon={Cpu}
                    variant="secondary"
                    compact
                    onPress={() => handleCreateConfig(model)}
                    disabled={model.status !== 'ready'}
                    flex
                  />
                  <Button
                    label="删除"
                    icon={Trash2}
                    variant="ghost"
                    compact
                    onPress={() => handleDelete(model)}
                    disabled={loadingModelId === model.id || importing}
                    flex
                  />
                </View>
              </Card>
            ))}
          </View>
        )}
      </ScrollView>

      <Modal
        transparent
        animationType="fade"
        visible={importState.state !== 'idle'}
        onRequestClose={cancelImport}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.colors.card }]}>
            <Text style={[styles.modalTitle, { color: theme.colors.textPrimary }]}>正在导入模型</Text>
            <Text style={[styles.modalState, { color: theme.colors.textSecondary }]}>
              {importState.state === 'preparing' && '正在准备模型文件…'}
              {importState.state === 'selecting' && '准备中…'}
              {importState.state === 'copying' && (
                hasTotalBytes
                  ? `复制中 ${progressPercent}%（${formatBytes(importState.bytesCopied)} / ${formatBytes(importState.totalBytes)}）`
                  : `复制中 ${formatBytes(importState.bytesCopied)}`
              )}
              {importState.state === 'hashing' && '计算文件哈希中…'}
              {importState.state === 'validating' && '验证模型中…'}
              {importState.state === 'ready' && '导入完成'}
              {importState.state === 'error' && `导入失败：${importState.errorMessage || importState.errorCode || '未知错误'}`}
            </Text>
            {importState.state === 'copying' && !hasTotalBytes ? (
              <View style={[styles.progressTrack, styles.progressTrackRelative, { backgroundColor: theme.colors.accentSoft }]}>
                <View
                  style={[
                    styles.indeterminateFill,
                    { backgroundColor: theme.colors.accent, left: `${indeterminateLeft}%` },
                  ]}
                />
              </View>
            ) : (
              <View style={[styles.progressTrack, { backgroundColor: theme.colors.accentSoft }]}>
                <View
                  style={[
                    styles.progressFill,
                    { backgroundColor: theme.colors.accent, width: `${progressPercent}%` },
                  ]}
                />
              </View>
            )}
            <Button
              label={importState.state === 'error' || importState.state === 'ready' ? '关闭' : '取消'}
              variant="secondary"
              onPress={cancelImport}
            />
          </View>
        </View>
      </Modal>
    </Screen>
  );
};

const Stat: React.FC<{ label: string; value: string; theme: string }> = ({ label, value, theme }) => (
  <View style={styles.stat}>
    <Text style={[styles.statLabel, { color: theme }]}>{label}</Text>
    <Text style={[styles.statValue, { color: theme }]}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 96 },
  backButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  noticeCard: { marginBottom: spacing.md },
  noticeText: { fontSize: 13, lineHeight: 20 },
  emptyCard: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xl, marginTop: spacing.lg },
  emptyTitle: { fontSize: 16, fontWeight: '700' },
  emptyDesc: { fontSize: 14, marginTop: spacing.sm, textAlign: 'center' },
  list: { marginTop: spacing.lg },
  modelCard: { marginBottom: spacing.md },
  modelHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, marginBottom: spacing.md },
  modelInfo: { flex: 1 },
  modelName: { fontSize: 16, fontWeight: '700' },
  modelFile: { fontSize: 12, marginTop: 2 },
  statusBadge: { borderRadius: 6, paddingHorizontal: spacing.sm, paddingVertical: 4, alignSelf: 'flex-start' },
  statusText: { fontSize: 12, fontWeight: '700' },
  statsRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  stat: { flex: 1 },
  statLabel: { fontSize: 11, marginBottom: 2 },
  statValue: { fontSize: 13, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: spacing.sm },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    borderRadius: 12,
    padding: spacing.lg,
    width: '100%',
    maxWidth: 360,
  },
  modalTitle: { fontSize: 17, fontWeight: '700', marginBottom: spacing.sm },
  modalState: { fontSize: 14, marginBottom: spacing.md },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: spacing.md },
  progressTrackRelative: { position: 'relative' },
  progressFill: { height: '100%' },
  indeterminateFill: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '25%', borderRadius: 4 },
});
