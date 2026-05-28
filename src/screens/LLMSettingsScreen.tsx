import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { Save } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Field, Header, Screen, spacing } from '../components/ui';
import { useSettingsStore } from '../store/settingsStore';
import { testLLMConnection } from '../services/llm';

export const LLMSettingsScreen: React.FC = () => {
  const { llmConfig, loadSettings, setLLMConfig } = useSettingsStore();
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setBaseUrl(llmConfig.base_url);
    setApiKey(llmConfig.api_key);
    setModelName(llmConfig.model_name);
  }, [llmConfig]);

  const validate = () => {
    if (!baseUrl.trim() || !apiKey.trim() || !modelName.trim()) {
      Alert.alert('配置不完整', '请填写 API 地址、API Key 和模型名称。');
      return false;
    }
    return true;
  };

  const save = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      await setLLMConfig(baseUrl, apiKey, modelName);
      Toast.show({ type: 'success', text1: 'LLM 配置已保存' });
    } catch (error: any) {
      Alert.alert('保存失败', error?.message || '配置写入失败，请重启应用后再试。');
    } finally {
      setSaving(false);
    }
  };

  const saveAndTest = async () => {
    if (!validate()) return;
    setTesting(true);
    try {
      await setLLMConfig(baseUrl, apiKey, modelName);
      const message = await testLLMConnection(baseUrl, apiKey, modelName);
      Alert.alert('连接成功', message.slice(0, 120));
    } catch (error: any) {
      Alert.alert('连接失败', error?.message || '请检查 API 地址、API Key、模型名称和手机网络。');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Screen>
      <Header title="LLM 设置" subtitle="OpenAI 兼容 API" />
      <ScrollView contentContainerStyle={styles.content}>
        <Field label="Base URL" value={baseUrl} onChangeText={setBaseUrl} placeholder="https://api.openai.com" autoCapitalize="none" autoCorrect={false} />
        <Field label="API Key" value={apiKey} onChangeText={setApiKey} placeholder="sk-..." autoCapitalize="none" autoCorrect={false} secureTextEntry />
        <Field label="模型名称" value={modelName} onChangeText={setModelName} placeholder="gpt-4.1 或兼容模型名称" autoCapitalize="none" autoCorrect={false} />
        <View style={styles.action}>
          <Button label={saving ? '保存中...' : '保存配置'} icon={Save} onPress={save} disabled={saving || testing} />
        </View>
        <View style={styles.action}>
          <Button label={testing ? '测试中...' : '保存并测试连接'} variant="secondary" onPress={saveAndTest} disabled={saving || testing} />
        </View>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 96 },
  action: { marginTop: spacing.md },
});
