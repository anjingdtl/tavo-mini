import { NativeModules } from 'react-native';
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
}

export const TtsAudio: TtsAudioNative = NativeModules.TtsAudio;
