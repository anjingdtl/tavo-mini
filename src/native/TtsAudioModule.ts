import { NativeModules } from 'react-native';

interface TtsAudioNative {
  playAudioFile(path: string): Promise<void>;
  stopAudio(): Promise<void>;
}

export const TtsAudio: TtsAudioNative = NativeModules.TtsAudio;
