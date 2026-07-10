import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { CheckCircle2, Plus, Save, Trash2 } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { LocalModelSelector } from '../components/LocalModelSelector';
import { useSettingsStore } from '../store/settingsStore';
import { useThemeStore } from '../store/themeStore';
import { testLLMConnection } from '../services/llm';
import type { LLMConfig } from '../types/novel';
import type { SettingsStackParamList } from '../navigation/TabNavigator';
import { LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS } from '../constants/llmDefaults';

const emptyDraft: LLMConfig = {
  id: 0,
  name: '新配置',
  base_url: '',
  api_key: '',
  model_name: '',
  is_active: 0,
  provider_type: 'openai_compatible',
  local_model_id: null,
  local_backend: null,
  context_window: 4096,
  max_output_tokens: 4000,
};

export const LLMSettingsScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const navigation = useNavigation<NativeStackNavigationProp<SettingsStackParamList>>();
  const {
    llmConfig,
    llmConfigs,
    loadSettings,
    saveLLMConfig,
    setActiveLLMConfig,
    deleteLLMConfig,
  } = useSettingsStore();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<LLMConfig>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // 10.6: 编辑态 ref，用户主动编辑后 store 变化不再覆盖本地 draft
  const isEditingRef = useRef(false);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (selectedId === 0) return;
    const selected = (selectedId != null ? llmConfigs.find((config) => config.id === selectedId) : undefined)
      || llmConfigs.find((config) => config.is_active === 1)
      || llmConfigs.find((config) => config.id === llmConfig.id)
      || llmConfigs[0]
      || emptyDraft;
    setSelectedId(selected.id);
    // 10.6: 用户主动编辑过 draft 后，store 变化（如 activate 触发 llmConfigs 更新）不再覆盖本地草稿
    if (!isEditingRef.current) setDraft(selected);
  }, [llmConfig, llmConfigs, selectedId]);

  const activeName = useMemo(() => llmConfigs.find((config) => config.is_active === 1)?.name || '未选择', [llmConfigs]);
  const activeProvider = useMemo(
    () => llmConfigs.find((config) => config.is_active === 1)?.provider_type || 'openai_compatible',
    [llmConfigs],
  );

  const validate = () => {
    const missing: string[] = [];
    if (!draft.name.trim()) missing.push('配置名称');
    if (draft.provider_type === 'openai_compatible') {
      if (!draft.base_url.trim()) missing.push('API 地址');
      if (!draft.api_key.trim()) missing.push('API Key');
      if (!draft.model_name.trim()) missing.push('模型名称');
    } else {
      if (!draft.local_model_id) missing.push('已导入且可用的本地模型');
    }
    if (missing.length > 0) {
      Alert.alert('配置不完整', `请填写以下必填项：\n\n• ${missing.join('\n• ')}`);
      return false;
    }
    return true;
  };

  const updateDraft = (fields: Partial<LLMConfig>) => {
    isEditingRef.current = true;
    setDraft((current) => ({ ...current, ...fields }));
  };

  const startNewConfig = () => {
    setSelectedId(0);
    setDraft({ ...emptyDraft, name: `配置 ${llmConfigs.length + 1}` });
  };

  const save = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const id = await saveLLMConfig(draft);
      setSelectedId(id);
      // V2.2.1 双保险：立即更新 draft.id，不依赖 useEffect 的 selectedId !== 0 判断
      // （selectedId=0 时 useEffect 会提前 return，导致 draft.id 永远停留在 0）
      setDraft((current) => ({ ...current, id }));
      // 修复#B: 保存成功后重置 isEditingRef，让 useEffect 能从 store 同步最新 draft
      // （包括 setActiveLLMConfig 后变化的 is_active 字段），避免 draft.is_active 过时
      isEditingRef.current = false;
      Toast.show({ type: 'success', text1: 'LLM 配置已保存' });
    } catch (error: any) {
      Alert.alert('保存失败', error?.message || '配置写入失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  const saveAndTest = async () => {
    if (!validate()) return;
    setTesting(true);
    try {
      const id = await saveLLMConfig(draft);
      setSelectedId(id);
      setDraft((current) => ({ ...current, id }));
      isEditingRef.current = false;
      const message = await testLLMConnection(
        draft.base_url,
        draft.api_key,
        draft.model_name,
        draft.provider_type,
        draft.local_model_id || undefined,
      );
      // V2.2.2 修复：原代码 title="连接成功" + message="连接成功" 重复显示。
      // 现在 title 改为"测试通过"，message 显示真实 LLM 回复（最多 120 字符），
      // 并附带模型名称，让用户看到是哪个模型测试的。
      const modelLabel = draft.provider_type === 'llama_cpp'
        ? draft.name || '本地模型'
        : draft.model_name || '当前模型';
      const reply = message && message.length > 0 ? message.slice(0, 120) : '（模型未返回内容）';
      Alert.alert('测试通过', `模型 ${modelLabel} 已连通。\n\n回复：${reply}`);
    } catch (error: any) {
      Alert.alert('连接失败', error?.message || '请检查 API 地址、API Key、模型名称和手机网络。');
    } finally {
      setTesting(false);
    }
  };

  const activate = async () => {
    if (draft.id <= 0) {
      Alert.alert('请先保存', '新配置保存后才能设为当前启用。');
      return;
    }
    // Phase9-BUG#17: 包裹 try-catch，失败时不显示"已切换"成功 Toast 误导用户
    try {
      await setActiveLLMConfig(draft.id);
      // 修复#B: 切换后重置 isEditingRef，让 useEffect 把 draft.is_active 同步为 1，
      // 否则 draft 还停留在 is_active=0 的过时状态，"设为当前"按钮 disabled 条件错乱
      isEditingRef.current = false;
      Toast.show({ type: 'success', text1: '已切换当前 LLM 配置' });
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const remove = () => {
    if (draft.id <= 0) {
      startNewConfig();
      return;
    }
    if (llmConfigs.length <= 1) {
      Alert.alert('无法删除', '至少需要保留一个 LLM 配置。');
      return;
    }
    Alert.alert('删除配置', `确定删除「${draft.name}」？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        // Phase9-BUG#17: 包裹 try-catch，失败时不显示"已删除"成功 Toast
        onPress: async () => {
          try {
            await deleteLLMConfig(draft.id);
            Toast.show({ type: 'success', text1: 'LLM 配置已删除' });
          } catch (e: any) {
            Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
          }
        },
      },
    ]);
  };

  return (
    <Screen>
      <Header
        title="LLM 设置"
        subtitle={`${activeProvider === 'llama_cpp' ? '本地 GGUF 离线模型' : 'OpenAI 兼容 API'} · 当前：${activeName}`}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.configList}>
          {llmConfigs.map((config) => {
            const selected = config.id === draft.id;
            const active = config.is_active === 1;
            return (
              <TouchableOpacity
                key={config.id}
                style={[
                  styles.configChip,
                  {
                    backgroundColor: selected ? theme.colors.accentSoft : theme.colors.card,
                    borderColor: active ? theme.colors.accent : theme.colors.border,
                  },
                ]}
                onPress={() => setSelectedId(config.id)}
              >
                <Text style={[styles.configName, { color: selected ? theme.colors.accent : theme.colors.textPrimary }]}>
                  {config.name || '未命名配置'}
                </Text>
                {active ? <CheckCircle2 size={14} color={theme.colors.accent} /> : null}
              </TouchableOpacity>
            );
          })}
          <Button label="新增" icon={Plus} variant="secondary" onPress={startNewConfig} compact />
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>模型来源</Text>
          <SegmentedControl
            value={draft.provider_type}
            options={[
              { value: 'openai_compatible', label: '在线 API' },
              { value: 'llama_cpp', label: '本地 GGUF' },
            ]}
            onChange={(provider_type) =>
              updateDraft({
                provider_type,
                // 切到 llama_cpp 时锁定 cpu 后端；切回在线 API 时清空
                local_backend: provider_type === 'llama_cpp' ? 'cpu' : null,
                max_output_tokens: provider_type === 'llama_cpp'
                  ? Math.min(
                    draft.max_output_tokens || LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
                    LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
                  )
                  : draft.max_output_tokens,
              })
            }
          />
        </View>

        <Field label="配置名称" value={draft.name} onChangeText={(name) => updateDraft({ name })} placeholder="例如：OpenAI / 本地模型 / DeepSeek" />

        {draft.provider_type === 'openai_compatible' ? (
          <>
            <Field label="Base URL" value={draft.base_url} onChangeText={(base_url) => updateDraft({ base_url })} placeholder="https://api.openai.com" autoCapitalize="none" autoCorrect={false} />
            <Field label="API Key" value={draft.api_key} onChangeText={(api_key) => updateDraft({ api_key })} placeholder="sk-..." autoCapitalize="none" autoCorrect={false} secureTextEntry />
            <Field label="模型名称" value={draft.model_name} onChangeText={(model_name) => updateDraft({ model_name })} placeholder="gpt-4.1 或兼容模型名称" autoCapitalize="none" autoCorrect={false} />
          </>
        ) : (
          <>
            <LocalModelSelector
              selectedId={draft.local_model_id}
              onSelect={(local_model_id) => updateDraft({ local_model_id })}
            />
            <Field
              label="上下文长度"
              value={String(draft.context_window)}
              onChangeText={(text) => {
                const value = parseInt(text.replace(/[^0-9]/g, ''), 10);
                updateDraft({ context_window: Number.isFinite(value) ? value : 0 });
              }}
              placeholder="4096"
              keyboardType="numeric"
            />
            <Field
              label="最大输出 Token"
              value={String(draft.max_output_tokens)}
              onChangeText={(text) => {
                const value = parseInt(text.replace(/[^0-9]/g, ''), 10);
                updateDraft({ max_output_tokens: Number.isFinite(value) ? value : 0 });
              }}
              placeholder={String(LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS)}
              keyboardType="numeric"
            />
            <Button
              label="管理本地模型"
              variant="secondary"
              onPress={() => navigation.navigate('LocalModelManager')}
            />
          </>
        )}

        <View style={styles.actionRow}>
          <Button label={saving ? '保存中...' : '保存配置'} icon={Save} onPress={save} disabled={saving || testing} flex />
          <Button label="设为当前" icon={CheckCircle2} variant="secondary" onPress={activate} disabled={saving || testing || draft.is_active === 1} flex />
        </View>
        <View style={styles.actionRow}>
          <Button label={testing ? '测试中...' : '保存并测试'} variant="secondary" onPress={saveAndTest} disabled={saving || testing} flex />
          <Button label="删除" icon={Trash2} variant="ghost" onPress={remove} disabled={saving || testing} flex />
        </View>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 96 },
  configList: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  configChip: {
    minHeight: 34,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  configName: { fontSize: 13, fontWeight: '800' },
  section: { marginBottom: spacing.md },
  sectionTitle: { fontSize: 12, fontWeight: '700', marginBottom: spacing.sm },
  actionRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
});
