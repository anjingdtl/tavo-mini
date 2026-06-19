export type TtsModel = 'speech-2.8-hd' | 'speech-2.8-turbo';

export type TtsAudioFormat = 'mp3' | 'wav' | 'flac';

export type TtsSampleRate = 16000 | 24000 | 32000 | 44100;

export type TtsBitrate = 32000 | 64000 | 128000;

export interface VoiceConfig {
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
