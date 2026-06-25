export type TtsModel = string;

export type TtsAudioFormat = 'mp3' | 'wav' | 'flac';

export type TtsSampleRate = 16000 | 24000 | 32000 | 44100;

export type TtsBitrate = 32000 | 64000 | 128000;

export interface VoiceConfig {
  apiUrl: string;
  model: TtsModel;
  voiceId: string;
  speed: number;
  vol: number;
  pitch: number;
  sampleRate: TtsSampleRate;
  bitrate: TtsBitrate;
  format: TtsAudioFormat;
}

export interface VoicePreset {
  id: string;
  name: string;
}

export type TtsEngine = 'system' | 'cloud';

export interface SystemTtsConfig {
  enginePackage: string;
  voiceKey: string;
  language: string;
  speed: number;
  pitch: number;
  volume: number;
}

export interface SystemTtsEngineInfo {
  name: string;
  label: string;
  isDefault: boolean;
}

export interface SystemTtsVoiceInfo {
  key: string;
  name: string;
  locale: string;
}

export interface SpeakConfig {
  enginePackage: string;
  voiceKey: string;
  language: string;
  speed: number;
  pitch: number;
  volume: number;
}
