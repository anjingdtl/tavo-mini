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

export type TtsEngine = 'system' | 'cloud' | 'builtin';

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
  isCurrent: boolean;
}

export interface SystemTtsVoiceInfo {
  key: string;
  name: string;
  locale: string;
  quality: number;
  latency: number;
  requiresNetwork: boolean;
  features: string[];
}

export type SystemTtsLanguageStatus =
  | 'available'
  | 'country_available'
  | 'variant_available'
  | 'missing_data'
  | 'not_supported'
  | 'unknown';

export interface SystemTtsDiagnostics {
  initialized: boolean;
  manufacturer: string;
  model: string;
  androidVersion: string;
  sdkInt: number;
  requestedEngine: string;
  currentEngine: string;
  defaultEngine: string;
  installedEngineCount: number;
  selectedEngineInstalled: boolean;
  language: string;
  languageStatus: SystemTtsLanguageStatus;
  voiceCount: number;
  matchingVoiceCount: number;
  offlineVoiceCount: number;
  maxInputLength: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface SpeakConfig {
  enginePackage: string;
  voiceKey: string;
  language: string;
  speed: number;
  pitch: number;
  volume: number;
  offlineOnly?: boolean;
  allowEngineFallback?: boolean;
  sessionId?: string;
}

export interface TtsSessionEvent {
  sessionId: string;
  enginePackage: string;
  chunkIndex: number;
  chunkCount: number;
}

export interface TtsErrorEvent extends TtsSessionEvent {
  errorCode: string;
  nativeErrorCode?: number;
  message: string;
}

export interface BuiltinTtsConfig {
  modelId: string;
  speakerId: number;
  speed: number;
  volume: number;
  autoDownload: boolean;
}

export interface BuiltinTtsModelManifest {
  id: string;
  displayName: string;
  version: string;
  language: string;
  engine: 'vits' | 'matcha';
  downloadUrl: string;
  archiveSize: number;
  installedSize: number;
  sha256: string;
  speakerCount: number;
  sampleRate: number;
  licenseName: string;
  licenseUrl: string;
  files: {
    model?: string;
    acousticModel?: string;
    vocoder?: string;
    tokens: string;
    lexicon?: string;
    ruleFsts?: string[];
    ruleFars?: string[];
    dataDir?: string;
  };
}
