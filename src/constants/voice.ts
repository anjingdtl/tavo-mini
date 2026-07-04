import type {
  VoiceConfig,
  VoicePreset,
  TtsEngine,
  SystemTtsConfig,
  BuiltinTtsConfig,
} from '../types/tts';

export const MAX_TTS_CHARS = 10000;
export const VOICE_API_URL_EXAMPLE = 'https://api.minimaxi.com/v1/t2a_v2';
export const DEFAULT_VOICE_API_URL = '';

// Milestone B 功能开关：开启后设置页显示“内置离线 TTS”入口。
// 实际 ONNX 模型集成 deferred，关闭开关可隐藏入口而不影响系统/云端 TTS。
export const ENABLE_BUILTIN_TTS = true;

export const VOICE_PRESETS: VoicePreset[] = [
  { id: 'male-qn-qingse', name: '青涩青年' },
  { id: 'male-qn-jingying', name: '精英青年' },
  { id: 'male-qn-badao', name: '霸道青年' },
  { id: 'male-qn-daxuesheng', name: '青年大学生' },
  { id: 'female-shaonv', name: '少女' },
  { id: 'female-yujie', name: '御姐' },
  { id: 'female-chengshu', name: '成熟女性' },
  { id: 'female-tianmei', name: '甜美女性' },
  { id: 'audiobook_male_1', name: '男性有声书 1' },
  { id: 'audiobook_male_2', name: '男性有声书 2' },
  { id: 'audiobook_female_1', name: '女性有声书 1' },
  { id: 'audiobook_female_2', name: '女性有声书 2' },
  { id: 'English_expressive_narrator', name: '英文叙事男声' },
];

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  apiUrl: DEFAULT_VOICE_API_URL,
  model: 'speech-2.8-hd',
  voiceId: 'male-qn-qingse',
  speed: 1,
  vol: 1,
  pitch: 0,
  sampleRate: 32000,
  bitrate: 128000,
  format: 'mp3',
};

export const DEFAULT_TTS_ENGINE: TtsEngine = 'system';

export const DEFAULT_SYSTEM_TTS_CONFIG: SystemTtsConfig = {
  enginePackage: '',
  voiceKey: '',
  language: 'zh-CN',
  speed: 1.0,
  pitch: 1.0,
  volume: 1.0,
};

export const DEFAULT_BUILTIN_TTS_CONFIG: BuiltinTtsConfig = {
  modelId: 'zh-default-v1',
  speakerId: 0,
  speed: 1.0,
  volume: 1.0,
  autoDownload: false,
};

export const SYSTEM_TTS_LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English (US)' },
];

export const SYSTEM_TTS_ERROR_MESSAGES: Record<string, string> = {
  TTS_NO_ENGINE: '未检测到可用的系统语音引擎',
  TTS_ENGINE_INIT_TIMEOUT: '系统语音引擎响应超时，请重新检测',
  TTS_ENGINE_INIT_FAILED: '语音引擎初始化失败',
  TTS_LANGUAGE_DATA_MISSING: '当前引擎缺少中文语音数据',
  TTS_LANGUAGE_NOT_SUPPORTED: '当前引擎不支持所选语言',
  TTS_VOICE_NOT_FOUND: '已保存的声线不存在，请重新选择',
  TTS_VOICE_REQUIRES_NETWORK: '所选声线需要联网，不符合离线设置',
  TTS_SPEAK_FAILED: '系统未能开始朗读',
  TTS_CANCELLED: '朗读已取消',
};

export function getSystemTtsErrorMessage(code: string | undefined): string {
  if (!code) return '朗读失败';
  return SYSTEM_TTS_ERROR_MESSAGES[code] || '朗读失败';
}
