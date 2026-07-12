import { NativeEventEmitter, NativeModules } from 'react-native';
import type {
  SpeakConfig,
  SystemTtsDiagnostics,
  SystemTtsEngineInfo,
  SystemTtsVoiceInfo,
} from '../types/tts';

interface TtsAudioNative {
  beginBackgroundPlayback(): Promise<void>;
  endBackgroundPlayback(): Promise<void>;
  playAudioFile(path: string): Promise<void>;
  stopAudio(): Promise<void>;
  speak(text: string, config: SpeakConfig): Promise<void>;
  stopSpeak(): Promise<void>;
  isTtsReady(): Promise<boolean>;
  getEngines(): Promise<SystemTtsEngineInfo[]>;
  getVoices(enginePackage?: string): Promise<SystemTtsVoiceInfo[]>;
  getDiagnostics(
    enginePackage?: string,
    language?: string,
  ): Promise<SystemTtsDiagnostics>;
  installTtsData(): Promise<boolean>;
  openTtsSettings(): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export const TtsAudio: TtsAudioNative = NativeModules.TtsAudio;

/**
 * 原生层通过 RCTDeviceEventEmitter 发送 TTS 事件：
 * - ttsStart: 首段开始朗读
 * - ttsProgress: 每段开始朗读（含 chunkIndex / chunkCount / sessionId）
 * - ttsDone: 最后一段完成
 * - ttsError: 任意段失败
 * - ttsStopped: 用户主动停止
 *
 * speak() Promise 语义：首段成功入队后 resolve；播放完成/失败/停止通过事件通知。
 */
export const TtsAudioEmitter = new NativeEventEmitter(NativeModules.TtsAudio);
