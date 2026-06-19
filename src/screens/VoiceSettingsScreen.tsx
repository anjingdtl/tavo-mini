import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Save, Volume2 } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { useVoiceStore } from '../store/voiceStore';
import { VOICE_PRESETS, DEFAULT_VOICE_CONFIG } from '../constants/voice';
import type { VoiceConfig, TtsModel, TtsAudioFormat, TtsSampleRate, TtsBitrate } from '../types/tts';

const SAMPLE_TEXT = '这是 Tavo Mini 的语音测试，Hello world，一二三四五。';

const MODEL_OPTIONS: { value: TtsModel; label: string }[] = [
  { value: 'speech-2.8-hd', label: '高清' },
  { value: 'speech-2.8-turbo', label: '极速' },
];

const FORMAT_OPTIONS: { value: TtsAudioFormat; label: string }[] = [
  { value: 'mp3', label: 'MP3' },
  { value: 'wav', label: 'WAV' },
  { value: 'flac', label: 'FLAC' },
];

const SAMPLE_RATE_OPTIONS: { value: TtsSampleRate; label: string }[] = [
  { value: 16000, label: '16k' },
  { value: 24000, label: '24k' },
  { value: 32000, label: '32k' },
  { value: 44100, label: '44.1k' },
];

const BITRATE_OPTIONS: { value: TtsBitrate; label: string }[] = [
  { value: 32000, label: '32k' },
  { value: 64000, label: '64k' },
  { value: 128000, label: '128k' },
];

export const VoiceSettingsScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const { config: savedConfig, apiKey: savedApiKey, loadVoiceConfig, saveVoiceConfig, setMiniMaxApiKey, playChapter } = useVoiceStore();
  const [draft, setDraft] = useState<VoiceConfig>(DEFAULT_VOICE_CONFIG);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    loadVoiceConfig();
  }, [loadVoiceConfig]);

  useEffect(() => {
    setDraft(savedConfig);
    setApiKeyDraft(savedApiKey);
  }, [savedConfig, savedApiKey]);

  const updateDraft = (fields: Partial<VoiceConfig>) => {
    setDraft((current) => ({ ...current, ...fields }));
  };

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const save = async () => {
    try {
      await Promise.all([saveVoiceConfig(draft), setMiniMaxApiKey(apiKeyDraft)]);
      Toast.show({ type: 'success', text1: '语音设置已保存' });
    } catch (error: any) {
      Alert.alert('保存失败', error?.message || '请重试');
    }
  };

  const testVoice = async () => {
    if (!apiKeyDraft.trim()) {
      Alert.alert('缺少 API Key', '请先填写 MiniMax API Key。');
      return;
    }
    setTesting(true);
    try {
      await setMiniMaxApiKey(apiKeyDraft);
      await saveVoiceConfig(draft);
      await playChapter(SAMPLE_TEXT);
    } catch (error: any) {
      Alert.alert('测试失败', error?.message || '请检查 API Key 和网络。');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Screen>
      <Header title="语音设置" subtitle="MiniMax 语音合成" />
      <ScrollView contentContainerStyle={styles.content}>
        <Field
          label="MiniMax API Key"
          value={apiKeyDraft}
          onChangeText={setApiKeyDraft}
          placeholder="在 MiniMax 控制台获取 API Key"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>模型</Text>
        <SegmentedControl value={draft.model} options={MODEL_OPTIONS} onChange={(value) => updateDraft({ model: value })} />

        <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>音色</Text>
        <Field
          label="音色 ID"
          value={draft.voiceId}
          onChangeText={(value) => updateDraft({ voiceId: value })}
          placeholder="选择预设或输入自定义 voice_id"
          autoCapitalize="none"
        />
        <View style={styles.presetList}>
          {VOICE_PRESETS.map((preset) => {
            const active = preset.id === draft.voiceId;
            return (
              <TouchableOpacity
                key={preset.id}
                onPress={() => updateDraft({ voiceId: preset.id })}
                style={[
                  styles.presetChip,
                  { borderColor: theme.colors.border, backgroundColor: active ? theme.colors.accentSoft : theme.colors.card },
                ]}
              >
                <Text style={[styles.presetText, { color: active ? theme.colors.accent : theme.colors.textPrimary }]}>
                  {preset.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.numericRow}>
          <View style={styles.numericField}>
            <Field
              label="语速"
              value={String(draft.speed)}
              onChangeText={(value) => updateDraft({ speed: clamp(Number(value) || 1, 0.5, 2) })}
              keyboardType="numeric"
            />
          </View>
          <View style={styles.numericField}>
            <Field
              label="音量"
              value={String(draft.vol)}
              onChangeText={(value) => updateDraft({ vol: clamp(Number(value) || 1, 0.1, 10) })}
              keyboardType="numeric"
            />
          </View>
          <View style={styles.numericField}>
            <Field
              label="音调"
              value={String(draft.pitch)}
              onChangeText={(value) => updateDraft({ pitch: Math.round(clamp(Number(value) || 0, -12, 12)) })}
              keyboardType="numeric"
            />
          </View>
        </View>

        <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>音频格式</Text>
        <SegmentedControl value={draft.format} options={FORMAT_OPTIONS} onChange={(value) => updateDraft({ format: value })} />

        <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>采样率</Text>
        <SegmentedControl value={draft.sampleRate} options={SAMPLE_RATE_OPTIONS} onChange={(value) => updateDraft({ sampleRate: value })} />

        <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>比特率</Text>
        <SegmentedControl value={draft.bitrate} options={BITRATE_OPTIONS} onChange={(value) => updateDraft({ bitrate: value })} />

        <View style={styles.actions}>
          <Button label={testing ? '测试中…' : '测试朗读'} icon={Volume2} onPress={testVoice} disabled={testing} />
          <Button label="保存" icon={Save} variant="secondary" onPress={save} />
        </View>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 120 },
  sectionLabel: { fontSize: 12, fontWeight: '700', marginTop: spacing.md, marginBottom: spacing.sm },
  presetList: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  presetChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  presetText: { fontSize: 13, fontWeight: '600' },
  numericRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  numericField: { flex: 1 },
  actions: { gap: spacing.md, marginTop: spacing.xl },
});
