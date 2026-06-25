import { create } from 'zustand';
import Toast from 'react-native-toast-message';
import * as db from '../services/database';
import { synthesizeToFile, cancelTts, isTtsTextTooLong } from '../services/tts';
import {
  getSecureVoiceApiKey,
  setSecureVoiceApiKey,
} from '../services/secureStorage';
import { TtsAudio } from '../native/TtsAudioModule';
import {
  DEFAULT_VOICE_CONFIG,
  DEFAULT_SYSTEM_TTS_CONFIG,
  DEFAULT_TTS_ENGINE,
} from '../constants/voice';
import type { VoiceConfig, TtsEngine, SystemTtsConfig } from '../types/tts';
import RNFS from 'react-native-fs';

interface VoiceState {
  engine: TtsEngine;
  config: VoiceConfig;
  apiKey: string;
  systemConfig: SystemTtsConfig;
  isSynthesizing: boolean;
  isPlaying: boolean;
  loadVoiceConfig: () => Promise<void>;
  saveVoiceConfig: (config: VoiceConfig) => Promise<void>;
  saveSystemTtsConfig: (config: SystemTtsConfig) => Promise<void>;
  setEngine: (engine: TtsEngine) => Promise<void>;
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
  engine: DEFAULT_TTS_ENGINE,
  config: DEFAULT_VOICE_CONFIG,
  apiKey: '',
  systemConfig: DEFAULT_SYSTEM_TTS_CONFIG,
  isSynthesizing: false,
  isPlaying: false,

  loadVoiceConfig: async () => {
    const [config, apiKey, engine, systemConfig] = await Promise.all([
      db.getVoiceConfig(),
      getSecureVoiceApiKey(),
      db.getTtsEngine(),
      db.getSystemTtsConfig(),
    ]);
    set({ config, apiKey, engine, systemConfig });
  },

  saveVoiceConfig: async (config) => {
    await db.setVoiceConfig(config);
    set({ config });
  },

  saveSystemTtsConfig: async (systemConfig) => {
    await db.setSystemTtsConfig(systemConfig);
    set({ systemConfig });
  },

  setEngine: async (engine) => {
    await get().stop();
    await db.setTtsEngine(engine);
    set({ engine });
  },

  setVoiceApiKey: async (key) => {
    await setSecureVoiceApiKey(key);
    set({ apiKey: key.trim() });
  },

  setMiniMaxApiKey: async (key) => {
    await get().setVoiceApiKey(key);
  },

  playChapter: async (text) => {
    const state = get();
    if (state.isSynthesizing || state.isPlaying) {
      return;
    }
    if (!text.trim()) {
      Toast.show({ type: 'error', text1: '当前章节没有正文内容' });
      return;
    }

    if (state.engine === 'system') {
      set({ isSynthesizing: true });
      try {
        // 约定：原生 speak 在入队成功时 resolve；isPlaying=true 表示「朗读已启动」，
        // 由 stop() 或 App 退出置回 false（详见 spec 5.3 完成回调约定）。
        await TtsAudio.speak(text, state.systemConfig);
        set({ isSynthesizing: false, isPlaying: true });
      } catch (error: any) {
        set({ isSynthesizing: false, isPlaying: false });
        const message = error?.message || '朗读失败';
        if (!message.includes('取消') && !message.includes('停止')) {
          Toast.show({ type: 'error', text1: message });
        }
      }
      return;
    }

    // 云端路径（保持不变）
    if (!state.apiKey.trim()) {
      Toast.show({ type: 'error', text1: '请先配置语音 API Key' });
      return;
    }
    if (isTtsTextTooLong(text)) {
      Toast.show({ type: 'info', text1: '正文超过 10000 字，将只朗读前 10000 字' });
    }

    set({ isSynthesizing: true });
    let audioPath: string | null = null;
    try {
      audioPath = await synthesizeToFile(text, state.config, state.apiKey);
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
    const { engine, isSynthesizing, isPlaying } = get();
    if (!isSynthesizing && !isPlaying) return;
    set({ isSynthesizing: false, isPlaying: false });
    if (engine === 'system') {
      try {
        await TtsAudio.stopSpeak();
      } catch {
        // ignore
      }
    } else {
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
    }
  },
}));
