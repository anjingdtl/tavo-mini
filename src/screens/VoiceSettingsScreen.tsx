import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Alert } from 'react-native';
import { RefreshCw, Save, Settings, Volume2 } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { useVoiceStore } from '../store/voiceStore';
import {
  ENABLE_BUILTIN_TTS,
  VOICE_PRESETS,
  DEFAULT_VOICE_CONFIG,
  DEFAULT_SYSTEM_TTS_CONFIG,
  VOICE_API_URL_EXAMPLE,
  SYSTEM_TTS_LANGUAGE_OPTIONS,
  getSystemTtsErrorMessage,
} from '../constants/voice';
import { TtsAudio } from '../native/TtsAudioModule';
import type {
  VoiceConfig,
  TtsAudioFormat,
  TtsSampleRate,
  TtsBitrate,
  TtsEngine,
  SystemTtsConfig,
  SystemTtsEngineInfo,
  SystemTtsVoiceInfo,
  SystemTtsDiagnostics,
  SystemTtsLanguageStatus,
} from '../types/tts';
import type { AppTheme } from '../types/theme';

const SAMPLE_TEXT = '这是 ShineWriter 的语音测试，Hello world，一二三四五。';

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

function buildEngineOptions(): { value: TtsEngine; label: string }[] {
  const options: { value: TtsEngine; label: string }[] = [
    { value: 'system', label: '系统 TTS' },
    { value: 'cloud', label: '云端 API' },
  ];
  if (ENABLE_BUILTIN_TTS) {
    options.push({ value: 'builtin', label: '内置离线' });
  }
  return options;
}

type TtsDetectionState = 'idle' | 'detecting' | 'ready' | 'warning' | 'error';

type Theme = AppTheme;

function formatLanguageStatus(status: SystemTtsLanguageStatus): string {
  switch (status) {
    case 'available':
      return '可用';
    case 'country_available':
      return '国家/地区可用';
    case 'variant_available':
      return '变体可用';
    case 'missing_data':
      return '缺少语音数据';
    case 'not_supported':
      return '不支持所选语言';
    default:
      return '未知';
  }
}

export const VoiceSettingsScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const {
    engine: savedEngine,
    config: savedConfig,
    apiKey: savedApiKey,
    systemConfig: savedSystemConfig,
    loadVoiceConfig,
    saveVoiceConfig,
    saveSystemTtsConfig,
    setEngine,
    setVoiceApiKey,
    playChapter,
  } = useVoiceStore();

  const [engineDraft, setEngineDraft] = useState<TtsEngine>(savedEngine);
  const [draft, setDraft] = useState<VoiceConfig>(DEFAULT_VOICE_CONFIG);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [systemDraft, setSystemDraft] = useState<SystemTtsConfig>(DEFAULT_SYSTEM_TTS_CONFIG);
  const [testing, setTesting] = useState(false);
  const [voiceDropdownOpen, setVoiceDropdownOpen] = useState(false);
  const [engines, setEngines] = useState<SystemTtsEngineInfo[]>([]);
  const [voices, setVoices] = useState<SystemTtsVoiceInfo[]>([]);
  const [engineDropdownOpen, setEngineDropdownOpen] = useState(false);
  const [voiceListDropdownOpen, setVoiceListDropdownOpen] = useState(false);

  const [detectionState, setDetectionState] = useState<TtsDetectionState>('idle');
  const [diagnostics, setDiagnostics] = useState<SystemTtsDiagnostics | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  const isXiaomiUnavailable =
    diagnostics?.manufacturer.toLowerCase() === 'xiaomi' &&
    (!diagnostics.initialized || diagnostics.languageStatus === 'missing_data' || diagnostics.languageStatus === 'not_supported');

  useEffect(() => {
    loadVoiceConfig();
  }, [loadVoiceConfig]);

  useEffect(() => {
    setEngineDraft(savedEngine);
    setDraft(savedConfig);
    setApiKeyDraft(savedApiKey);
    setSystemDraft(savedSystemConfig);
  }, [savedEngine, savedConfig, savedApiKey, savedSystemConfig]);

  const detectSystemTts = useCallback(async () => {
    if (engineDraft !== 'system') return;
    setDetectionState('detecting');
    setDiagnosticsError(null);
    try {
      const result = await TtsAudio.getDiagnostics(
        systemDraft.enginePackage || undefined,
        systemDraft.language,
      );
      setDiagnostics(result);
      if (!result.initialized) {
        setDetectionState('error');
        setDiagnosticsError(getSystemTtsErrorMessage(result.errorCode));
      } else if (
        result.languageStatus === 'missing_data' ||
        result.languageStatus === 'not_supported' ||
        result.voiceCount === 0
      ) {
        setDetectionState('warning');
      } else {
        setDetectionState('ready');
      }

      const engineList = await TtsAudio.getEngines();
      setEngines(engineList);

      const voiceList = await TtsAudio.getVoices(systemDraft.enginePackage || undefined);
      const langBase = systemDraft.language.split('-')[0].toLowerCase();
      const filtered = voiceList.filter((v) => v.locale.toLowerCase().startsWith(langBase));
      setVoices(filtered.length > 0 ? filtered : voiceList);
    } catch (error: any) {
      setDetectionState('error');
      setDiagnosticsError(error?.message || '检测失败');
      setEngines([]);
      setVoices([]);
    }
  }, [engineDraft, systemDraft.enginePackage, systemDraft.language]);

  useEffect(() => {
    detectSystemTts();
  }, [detectSystemTts]);

  const updateDraft = (fields: Partial<VoiceConfig>) => {
    setDraft((current) => ({ ...current, ...fields }));
  };

  const updateSystemDraft = (fields: Partial<SystemTtsConfig>) => {
    setSystemDraft((current) => ({ ...current, ...fields }));
  };

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const onEngineChange = async (value: TtsEngine) => {
    setEngineDraft(value);
    try {
      await setEngine(value);
      const label = buildEngineOptions().find((o) => o.value === value)?.label ?? value;
      Toast.show({
        type: 'success',
        text1: `已切换到${label}`,
      });
    } catch {
      // ignore
    }
  };

  const selectedVoicePreset = VOICE_PRESETS.find((preset) => preset.id === draft.voiceId);
  const voiceLabel = selectedVoicePreset?.name || '自定义音色 ID';
  const selectedEngineLabel =
    engines.find((e) => e.name === systemDraft.enginePackage)?.label ||
    (systemDraft.enginePackage ? systemDraft.enginePackage : '系统默认引擎');
  const selectedVoiceLabel =
    voices.find((v) => v.key === systemDraft.voiceKey)?.name ||
    (systemDraft.voiceKey ? systemDraft.voiceKey : '引擎默认声线');

  const normalizedDraft = (): VoiceConfig => ({
    ...draft,
    apiUrl: draft.apiUrl.trim(),
    model: draft.model.trim(),
    voiceId: draft.voiceId.trim(),
  });

  const save = async () => {
    try {
      await Promise.all([
        saveVoiceConfig(normalizedDraft()),
        setVoiceApiKey(apiKeyDraft),
        saveSystemTtsConfig(systemDraft),
      ]);
      Toast.show({ type: 'success', text1: '语音设置已保存' });
    } catch (error: any) {
      Alert.alert('保存失败', error?.message || '请重试');
    }
  };

  const testVoice = async () => {
    if (engineDraft === 'cloud' && !apiKeyDraft.trim()) {
      Alert.alert('缺少 API Key', '请先填写语音 API Key。');
      return;
    }
    setTesting(true);
    try {
      await Promise.all([
        setVoiceApiKey(apiKeyDraft),
        saveVoiceConfig(normalizedDraft()),
        saveSystemTtsConfig(systemDraft),
      ]);
      await playChapter(SAMPLE_TEXT);
    } catch (error: any) {
      Alert.alert('测试失败', error?.message || '请检查语音配置。');
    } finally {
      setTesting(false);
    }
  };

  const openSystemTtsSettings = async () => {
    const ok = await TtsAudio.openTtsSettings();
    if (!ok) {
      Toast.show({ type: 'error', text1: '无法打开系统语音设置' });
    }
  };

  const installTtsData = async () => {
    const ok = await TtsAudio.installTtsData();
    if (!ok) {
      Toast.show({
        type: 'error',
        text1: '无法启动语音数据安装',
        text2: '请手动打开系统语音设置安装语音数据',
      });
    }
  };

  return (
    <Screen>
      <Header title="语音设置" subtitle="朗读引擎 / 语音 API" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>朗读引擎</Text>
        <SegmentedControl value={engineDraft} options={buildEngineOptions()} onChange={(value) => onEngineChange(value)} />

        {engineDraft === 'system' ? (
          <SystemTtsFields
            theme={theme}
            systemDraft={systemDraft}
            engines={engines}
            voices={voices}
            diagnostics={diagnostics}
            detectionState={detectionState}
            diagnosticsError={diagnosticsError}
            isXiaomiUnavailable={isXiaomiUnavailable}
            selectedEngineLabel={selectedEngineLabel}
            selectedVoiceLabel={selectedVoiceLabel}
            engineDropdownOpen={engineDropdownOpen}
            voiceListDropdownOpen={voiceListDropdownOpen}
            updateSystemDraft={updateSystemDraft}
            setEngineDropdownOpen={setEngineDropdownOpen}
            setVoiceListDropdownOpen={setVoiceListDropdownOpen}
            clamp={clamp}
            onRefresh={detectSystemTts}
            onOpenSettings={openSystemTtsSettings}
            onInstallData={installTtsData}
          />
        ) : engineDraft === 'builtin' ? (
          <BuiltinTtsPlaceholder theme={theme} />
        ) : (
          <CloudTtsFields
            theme={theme}
            draft={draft}
            apiKeyDraft={apiKeyDraft}
            setApiKeyDraft={setApiKeyDraft}
            updateDraft={updateDraft}
            selectedVoicePreset={selectedVoicePreset}
            voiceLabel={voiceLabel}
            voiceDropdownOpen={voiceDropdownOpen}
            setVoiceDropdownOpen={setVoiceDropdownOpen}
            clamp={clamp}
          />
        )}

        <View style={styles.actions}>
          <Button label={testing ? '测试中…' : '测试朗读'} icon={Volume2} onPress={testVoice} disabled={testing} />
          <Button label="保存" icon={Save} variant="secondary" onPress={save} />
        </View>
      </ScrollView>
    </Screen>
  );
};

// ===== System TTS 字段子组件 =====
interface SystemTtsFieldsProps {
  theme: Theme;
  systemDraft: SystemTtsConfig;
  engines: SystemTtsEngineInfo[];
  voices: SystemTtsVoiceInfo[];
  diagnostics: SystemTtsDiagnostics | null;
  detectionState: TtsDetectionState;
  diagnosticsError: string | null;
  isXiaomiUnavailable: boolean;
  selectedEngineLabel: string;
  selectedVoiceLabel: string;
  engineDropdownOpen: boolean;
  voiceListDropdownOpen: boolean;
  updateSystemDraft: (fields: Partial<SystemTtsConfig>) => void;
  setEngineDropdownOpen: (open: boolean) => void;
  setVoiceListDropdownOpen: (open: boolean) => void;
  clamp: (value: number, min: number, max: number) => number;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onInstallData: () => void;
}

const SystemTtsFields: React.FC<SystemTtsFieldsProps> = ({
  theme,
  systemDraft,
  engines,
  voices,
  diagnostics,
  detectionState,
  diagnosticsError,
  isXiaomiUnavailable,
  selectedEngineLabel,
  selectedVoiceLabel,
  engineDropdownOpen,
  voiceListDropdownOpen,
  updateSystemDraft,
  setEngineDropdownOpen,
  setVoiceListDropdownOpen,
  clamp,
  onRefresh,
  onOpenSettings,
  onInstallData,
}) => {
  const detectionColor =
    detectionState === 'ready'
      ? theme.colors.success ?? theme.colors.accent
      : detectionState === 'error'
        ? theme.colors.danger ?? '#E53935'
        : theme.colors.warning ?? '#F57C00';

  const detectionText =
    detectionState === 'detecting'
      ? '正在检测系统 TTS…'
      : detectionState === 'ready'
        ? '系统 TTS 检测正常'
        : detectionState === 'warning'
          ? '系统 TTS 可用但存在警告'
          : diagnosticsError ?? '系统 TTS 检测失败';

  return (
    <View>
      <View style={[styles.diagnosticCard, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}>
        <View style={styles.diagnosticHeader}>
          <Text style={[styles.diagnosticTitle, { color: theme.colors.textPrimary }]}>TTS 诊断</Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={onRefresh}
            disabled={detectionState === 'detecting'}
            style={styles.iconButton}
          >
            <RefreshCw size={18} color={theme.colors.accent} />
            <Text style={[styles.iconButtonText, { color: theme.colors.accent }]}>重新检测</Text>
          </TouchableOpacity>
        </View>
        <Text style={[styles.diagnosticStatus, { color: detectionColor }]}>{detectionText}</Text>
        {diagnostics && (
          <View style={styles.diagnosticRows}>
            <DiagnosticRow label="默认引擎" value={diagnostics.defaultEngine || '未知'} />
            <DiagnosticRow label="已安装引擎" value={`${diagnostics.installedEngineCount} 个`} />
            <DiagnosticRow label="语言状态" value={formatLanguageStatus(diagnostics.languageStatus)} />
            <DiagnosticRow label="匹配声线" value={`${diagnostics.matchingVoiceCount} 个`} />
            <DiagnosticRow label="离线声线" value={`${diagnostics.offlineVoiceCount} 个`} />
            <DiagnosticRow label="最大单段" value={`${diagnostics.maxInputLength} 字符`} />
          </View>
        )}
        {isXiaomiUnavailable && (
          <Text style={[styles.xiaomiHint, { color: theme.colors.textSecondary }]}>
            小米系统可能未预装中文 TTS 引擎。可先打开系统语音设置安装语音数据，或切换到“内置离线 TTS”。
          </Text>
        )}
        <View style={styles.diagnosticActions}>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={onOpenSettings}
            style={[styles.smallButton, { borderColor: theme.colors.accent }]}
          >
            <Settings size={14} color={theme.colors.accent} />
            <Text style={[styles.smallButtonText, { color: theme.colors.accent }]}>打开系统语音设置</Text>
          </TouchableOpacity>
          {diagnostics?.languageStatus === 'missing_data' && (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={onInstallData}
              style={[styles.smallButton, { borderColor: theme.colors.accent }]}
            >
              <Text style={[styles.smallButtonText, { color: theme.colors.accent }]}>尝试安装语音数据</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {engines.length === 0 && detectionState !== 'detecting' ? (
        <View style={styles.engineHintContainer}>
          <Text style={[styles.hintText, { color: theme.colors.textSecondary }]}>
            未检测到 TTS 引擎，部分手机未预装语音引擎。请前往系统设置安装后重试。
          </Text>
        </View>
      ) : null}

      <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>TTS 引擎</Text>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={() => setEngineDropdownOpen(!engineDropdownOpen)}
        style={[styles.dropdownButton, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}
      >
        <Text style={[styles.dropdownText, { color: theme.colors.textPrimary }]}>{selectedEngineLabel}</Text>
        <Text style={[styles.dropdownHint, { color: theme.colors.textSecondary }]}>
          {engineDropdownOpen ? '收起' : '选择'}
        </Text>
      </TouchableOpacity>
      {engineDropdownOpen ? (
        <View style={[styles.dropdownList, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}>
          <TouchableOpacity
            onPress={() => {
              updateSystemDraft({ enginePackage: '', voiceKey: '' });
              setEngineDropdownOpen(false);
            }}
            style={[styles.dropdownOption, !systemDraft.enginePackage && { backgroundColor: theme.colors.accentSoft }]}
          >
            <Text
              style={[
                styles.dropdownOptionText,
                { color: !systemDraft.enginePackage ? theme.colors.accent : theme.colors.textPrimary },
              ]}
            >
              系统默认引擎
            </Text>
          </TouchableOpacity>
          {engines.map((engine) => {
            const active = engine.name === systemDraft.enginePackage;
            return (
              <TouchableOpacity
                key={engine.name}
                onPress={() => {
                  updateSystemDraft({ enginePackage: engine.name, voiceKey: '' });
                  setEngineDropdownOpen(false);
                }}
                style={[styles.dropdownOption, active && { backgroundColor: theme.colors.accentSoft }]}
              >
                <Text
                  style={[styles.dropdownOptionText, { color: active ? theme.colors.accent : theme.colors.textPrimary }]}
                >
                  {engine.label}
                  {engine.isDefault ? '（默认）' : ''}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>语言</Text>
      <SegmentedControl
        value={systemDraft.language}
        options={SYSTEM_TTS_LANGUAGE_OPTIONS}
        onChange={(value) => updateSystemDraft({ language: value, voiceKey: '' })}
      />

      <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>声线</Text>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={() => setVoiceListDropdownOpen(!voiceListDropdownOpen)}
        style={[styles.dropdownButton, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}
      >
        <Text style={[styles.dropdownText, { color: theme.colors.textPrimary }]}>{selectedVoiceLabel}</Text>
        <Text style={[styles.dropdownHint, { color: theme.colors.textSecondary }]}>
          {voiceListDropdownOpen ? '收起' : '选择'}
        </Text>
      </TouchableOpacity>
      {voiceListDropdownOpen ? (
        <View style={[styles.dropdownList, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}>
          <TouchableOpacity
            onPress={() => {
              updateSystemDraft({ voiceKey: '' });
              setVoiceListDropdownOpen(false);
            }}
            style={[styles.dropdownOption, !systemDraft.voiceKey && { backgroundColor: theme.colors.accentSoft }]}
          >
            <Text
              style={[
                styles.dropdownOptionText,
                { color: !systemDraft.voiceKey ? theme.colors.accent : theme.colors.textPrimary },
              ]}
            >
              引擎默认声线
            </Text>
          </TouchableOpacity>
          {voices.map((voice) => {
            const active = voice.key === systemDraft.voiceKey;
            return (
              <TouchableOpacity
                key={voice.key}
                onPress={() => {
                  updateSystemDraft({ voiceKey: voice.key });
                  setVoiceListDropdownOpen(false);
                }}
                style={[styles.dropdownOption, active && { backgroundColor: theme.colors.accentSoft }]}
              >
                <Text
                  style={[styles.dropdownOptionText, { color: active ? theme.colors.accent : theme.colors.textPrimary }]}
                >
                  {voice.name}（{voice.locale}）
                  {voice.requiresNetwork ? ' [联网]' : ''}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      <View style={styles.numericRow}>
        <View style={styles.numericField}>
          <Field
            label="语速"
            value={String(systemDraft.speed)}
            onChangeText={(value) => updateSystemDraft({ speed: clamp(Number(value) || 1, 0.1, 4.0) })}
            keyboardType="numeric"
          />
        </View>
        <View style={styles.numericField}>
          <Field
            label="音调"
            value={String(systemDraft.pitch)}
            onChangeText={(value) => updateSystemDraft({ pitch: clamp(Number(value) || 1, 0.1, 2.0) })}
            keyboardType="numeric"
          />
        </View>
        <View style={styles.numericField}>
          <Field
            label="音量"
            value={String(systemDraft.volume)}
            onChangeText={(value) => updateSystemDraft({ volume: clamp(Number(value) || 1, 0.0, 1.0) })}
            keyboardType="numeric"
          />
        </View>
      </View>
    </View>
  );
};

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.diagnosticRow}>
      <Text style={styles.diagnosticRowLabel}>{label}</Text>
      <Text style={styles.diagnosticRowValue}>{value}</Text>
    </View>
  );
}

// ===== 内置离线 TTS 占位 =====
function BuiltinTtsPlaceholder({ theme }: { theme: Theme }) {
  return (
    <View style={[styles.placeholderCard, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}>
      <Text style={[styles.placeholderTitle, { color: theme.colors.textPrimary }]}>内置离线 TTS</Text>
      <Text style={[styles.placeholderBody, { color: theme.colors.textSecondary }]}>
        内置离线 TTS 正在开发中，将支持 ONNX 模型推理与中文离线朗读，无需依赖系统语音引擎。
      </Text>
    </View>
  );
}

// ===== Cloud TTS 字段子组件（从原 UI 抽取，逻辑不变）=====
interface CloudTtsFieldsProps {
  theme: Theme;
  draft: VoiceConfig;
  apiKeyDraft: string;
  setApiKeyDraft: (value: string) => void;
  updateDraft: (fields: Partial<VoiceConfig>) => void;
  selectedVoicePreset?: { id: string; name: string };
  voiceLabel: string;
  voiceDropdownOpen: boolean;
  setVoiceDropdownOpen: (open: boolean) => void;
  clamp: (value: number, min: number, max: number) => number;
}

const CloudTtsFields: React.FC<CloudTtsFieldsProps> = ({
  theme,
  draft,
  apiKeyDraft,
  setApiKeyDraft,
  updateDraft,
  selectedVoicePreset,
  voiceLabel,
  voiceDropdownOpen,
  setVoiceDropdownOpen,
  clamp,
}) => (
  <View>
    <Field
      label="语音 API Key"
      value={apiKeyDraft}
      onChangeText={setApiKeyDraft}
      placeholder="填写语音服务 API Key"
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
    />
    <Field
      label="语音 API URL"
      value={draft.apiUrl}
      onChangeText={(value) => updateDraft({ apiUrl: value })}
      placeholder={VOICE_API_URL_EXAMPLE}
      autoCapitalize="none"
      autoCorrect={false}
    />
    <Field
      label="模型"
      value={draft.model}
      onChangeText={(value) => updateDraft({ model: value })}
      placeholder="例如 speech-2.8-hd"
      autoCapitalize="none"
      autoCorrect={false}
    />
    <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>音色</Text>
    <TouchableOpacity
      accessibilityRole="button"
      onPress={() => setVoiceDropdownOpen(!voiceDropdownOpen)}
      style={[styles.dropdownButton, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}
    >
      <Text style={[styles.dropdownText, { color: theme.colors.textPrimary }]}>{voiceLabel}</Text>
      <Text style={[styles.dropdownHint, { color: theme.colors.textSecondary }]}>
        {voiceDropdownOpen ? '收起' : '选择'}
      </Text>
    </TouchableOpacity>
    {voiceDropdownOpen ? (
      <View style={[styles.dropdownList, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}>
        {VOICE_PRESETS.map((preset) => {
          const active = preset.id === draft.voiceId;
          return (
            <TouchableOpacity
              key={preset.id}
              onPress={() => {
                updateDraft({ voiceId: preset.id });
                setVoiceDropdownOpen(false);
              }}
              style={[styles.dropdownOption, active && { backgroundColor: theme.colors.accentSoft }]}
            >
              <Text
                style={[styles.dropdownOptionText, { color: active ? theme.colors.accent : theme.colors.textPrimary }]}
              >
                {preset.name}
              </Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity
          onPress={() => {
            updateDraft({ voiceId: '' });
            setVoiceDropdownOpen(false);
          }}
          style={[styles.dropdownOption, !selectedVoicePreset && { backgroundColor: theme.colors.accentSoft }]}
        >
          <Text
            style={[
              styles.dropdownOptionText,
              { color: !selectedVoicePreset ? theme.colors.accent : theme.colors.textPrimary },
            ]}
          >
            自定义音色 ID
          </Text>
        </TouchableOpacity>
      </View>
    ) : null}
    {!selectedVoicePreset ? (
      <Field
        label="自定义音色 ID"
        value={draft.voiceId}
        onChangeText={(value) => updateDraft({ voiceId: value })}
        placeholder="输入语音服务的 voice_id"
        autoCapitalize="none"
        autoCorrect={false}
      />
    ) : null}
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
    <SegmentedControl
      value={draft.sampleRate}
      options={SAMPLE_RATE_OPTIONS}
      onChange={(value) => updateDraft({ sampleRate: value })}
    />
    <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>比特率</Text>
    <SegmentedControl value={draft.bitrate} options={BITRATE_OPTIONS} onChange={(value) => updateDraft({ bitrate: value })} />
  </View>
);

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 120 },
  sectionLabel: { fontSize: 12, fontWeight: '700', marginTop: spacing.md, marginBottom: spacing.sm },
  hintText: { fontSize: 12, marginTop: spacing.sm, marginBottom: spacing.sm },
  engineHintContainer: { marginTop: spacing.sm, marginBottom: spacing.sm },
  diagnosticCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  diagnosticHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  diagnosticTitle: { fontSize: 15, fontWeight: '700' },
  diagnosticStatus: { fontSize: 13, fontWeight: '600', marginTop: spacing.xs },
  diagnosticRows: { marginTop: spacing.sm },
  diagnosticRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
  diagnosticRowLabel: { fontSize: 12, color: '#888' },
  diagnosticRowValue: { fontSize: 12, fontWeight: '600' },
  diagnosticActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  xiaomiHint: { fontSize: 12, marginTop: spacing.sm, fontStyle: 'italic' },
  iconButton: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconButtonText: { fontSize: 12, fontWeight: '600' },
  smallButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: 4,
  },
  smallButtonText: { fontSize: 12, fontWeight: '600' },
  dropdownButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownText: { fontSize: 15, fontWeight: '700' },
  dropdownHint: { fontSize: 12, fontWeight: '700' },
  dropdownList: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, marginTop: spacing.xs, overflow: 'hidden' },
  dropdownOption: { minHeight: 40, justifyContent: 'center', paddingHorizontal: spacing.md },
  dropdownOptionText: { fontSize: 14, fontWeight: '600' },
  numericRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  numericField: { flex: 1 },
  actions: { gap: spacing.md, marginTop: spacing.xl },
  placeholderCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  placeholderTitle: { fontSize: 15, fontWeight: '700' },
  placeholderBody: { fontSize: 13, marginTop: spacing.xs, lineHeight: 20 },
});
