import { create } from 'zustand';
import Toast from 'react-native-toast-message';
import * as db from '../services/database';
import { synthesizeToFile, cancelTts, isTtsTextTooLong } from '../services/tts';
import {
  getSecureVoiceApiKey,
  setSecureVoiceApiKey,
} from '../services/secureStorage';
import { TtsAudio } from '../native/TtsAudioModule';
import { DEFAULT_VOICE_CONFIG } from '../constants/voice';
import type { VoiceConfig } from '../types/tts';
import RNFS from 'react-native-fs';

interface VoiceState {
  config: VoiceConfig;
  apiKey: string;
  isSynthesizing: boolean;
  isPlaying: boolean;
  loadVoiceConfig: () => Promise<void>;
  saveVoiceConfig: (config: VoiceConfig) => Promise<void>;
  setVoiceApiKey: (key: string) => Promise<void>;
  setMiniMaxApiKey: (key: string) => Promise<void>;
  playChapter: (text: string) => Promise<void>;
  stop: () => Promise<void>;
}

async function deleteIfExists(path: string): Promise<void> {
  try {
    if (await RNFS.exists(path)) {
      await RNFS.unlink(path);
    }
  } catch {
    // ignore cleanup errors
  }
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  config: DEFAULT_VOICE_CONFIG,
  apiKey: '',
  isSynthesizing: false,
  isPlaying: false,

  loadVoiceConfig: async () => {
    const [config, apiKey] = await Promise.all([
      db.getVoiceConfig(),
      getSecureVoiceApiKey(),
    ]);
    set({ config, apiKey });
  },

  saveVoiceConfig: async (config) => {
    await db.setVoiceConfig(config);
    set({ config });
  },

  setVoiceApiKey: async (key) => {
    await setSecureVoiceApiKey(key);
    set({ apiKey: key.trim() });
  },

  setMiniMaxApiKey: async (key) => {
    await get().setVoiceApiKey(key);
  },

  playChapter: async (text) => {
    const { config, apiKey, isSynthesizing: alreadyRunning } = get();
    if (alreadyRunning || get().isPlaying) {
      return;
    }
    if (!apiKey.trim()) {
      Toast.show({ type: 'error', text1: '请先配置语音 API Key' });
      return;
    }
    if (!text.trim()) {
      Toast.show({ type: 'error', text1: '当前章节没有正文内容' });
      return;
    }
    if (isTtsTextTooLong(text)) {
      Toast.show({ type: 'info', text1: '正文超过 10000 字，将只朗读前 10000 字' });
    }

    set({ isSynthesizing: true });
    let audioPath: string | null = null;
    try {
      audioPath = await synthesizeToFile(text, config, apiKey);
      set({ isSynthesizing: false, isPlaying: true });
      try {
        await TtsAudio.playAudioFile(audioPath);
      } finally {
        set({ isPlaying: false });
        if (audioPath) {
          await deleteIfExists(audioPath);
        }
      }
    } catch (error: any) {
      set({ isSynthesizing: false, isPlaying: false });
      if (audioPath) {
        await deleteIfExists(audioPath);
      }
      const message = error?.message || '朗读失败';
      if (!message.includes('取消') && !message.includes('停止')) {
        Toast.show({ type: 'error', text1: message });
      }
    }
  },

  stop: async () => {
    const { isSynthesizing, isPlaying } = get();
    if (!isSynthesizing && !isPlaying) return;
    set({ isSynthesizing: false, isPlaying: false });
    if (isSynthesizing) {
      await cancelTts();
    }
    if (isPlaying) {
      try {
        await TtsAudio.stopAudio();
      } catch {
        // ignore
      }
    }
  },
}));
