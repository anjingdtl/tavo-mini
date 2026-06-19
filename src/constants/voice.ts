import type { VoiceConfig, VoicePreset } from '../types/tts';

export const MAX_TTS_CHARS = 10000;

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
  model: 'speech-2.8-hd',
  voiceId: 'male-qn-qingse',
  speed: 1,
  vol: 1,
  pitch: 0,
  sampleRate: 32000,
  bitrate: 128000,
  format: 'mp3',
};
