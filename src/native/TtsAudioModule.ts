import { NativeEventEmitter, NativeModules } from 'react-native';
import type {
  SpeakConfig,
  SystemTtsEngineInfo,
  SystemTtsVoiceInfo,
} from '../types/tts';

interface TtsAudioNative {
  playAudioFile(path: string): Promise<void>;
  stopAudio(): Promise<void>;
  speak(text: string, config: SpeakConfig): Promise<void>;
  stopSpeak(): Promise<void>;
  isTtsReady(): Promise<boolean>;
  getEngines(): Promise<SystemTtsEngineInfo[]>;
  getVoices(enginePackage?: string): Promise<SystemTtsVoiceInfo[]>;
  openTtsSettings(): Promise<boolean>;
}

export const TtsAudio: TtsAudioNative = NativeModules.TtsAudio;

// 原生层通过 RCTDeviceEventEmitter 发送 ttsDone / ttsError 事件，
// JS 侧用 NativeEventEmitter 监听，用于自动重置 isPlaying 状态。
export const TtsAudioEmitter = new NativeEventEmitter(NativeModules.TtsAudio);
