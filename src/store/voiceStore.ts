import { create } from 'zustand';
import Toast from 'react-native-toast-message';
import * as db from '../services/database';
import { synthesizeToFile, cancelTts, isTtsTextTooLong } from '../services/tts';
import {
  getSecureVoiceApiKey,
  setSecureVoiceApiKey,
} from '../services/secureStorage';
import { TtsAudio, TtsAudioEmitter } from '../native/TtsAudioModule';
import {
  DEFAULT_VOICE_CONFIG,
  DEFAULT_SYSTEM_TTS_CONFIG,
  DEFAULT_TTS_ENGINE,
  getSystemTtsErrorMessage,
} from '../constants/voice';
import type {
  VoiceConfig,
  TtsEngine,
  SystemTtsConfig,
  TtsErrorEvent,
  TtsSessionEvent,
} from '../types/tts';
import RNFS from 'react-native-fs';

type PlaybackState = 'idle' | 'synthesizing' | 'playing';

interface VoiceState {
  engine: TtsEngine;
  config: VoiceConfig;
  apiKey: string;
  systemConfig: SystemTtsConfig;
  isSynthesizing: boolean;
  isPlaying: boolean;
  playbackState: PlaybackState;
  lastPlayEndedAt: number | null;
  activeTtsSessionId: string | null;
  ttsProgress: { chunkIndex: number; chunkCount: number } | null;
  lastTtsError: TtsErrorEvent | null;
  loadVoiceConfig: () => Promise<void>;
  saveVoiceConfig: (config: VoiceConfig) => Promise<void>;
  saveSystemTtsConfig: (config: SystemTtsConfig) => Promise<void>;
  setEngine: (engine: TtsEngine) => Promise<void>;
  setVoiceApiKey: (key: string) => Promise<void>;
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

function isCurrentSession(state: VoiceState, event: TtsSessionEvent): boolean {
  return state.activeTtsSessionId === event.sessionId;
}

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  engine: DEFAULT_TTS_ENGINE,
  config: DEFAULT_VOICE_CONFIG,
  apiKey: '',
  systemConfig: DEFAULT_SYSTEM_TTS_CONFIG,
  isSynthesizing: false,
  isPlaying: false,
  activeTtsSessionId: null,
  ttsProgress: null,
  lastTtsError: null,

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
      const sessionId = generateSessionId();
      set({
        isSynthesizing: true,
        isPlaying: false,
        playbackState: 'synthesizing',
        activeTtsSessionId: sessionId,
        ttsProgress: null,
        lastTtsError: null,
      });
      try {
        // 原生 speak 在首段入队成功时 resolve；
        // 朗读实际开始/完成/错误/停止通过事件通知。
        await TtsAudio.speak(text, { ...state.systemConfig, sessionId });
        set({ isSynthesizing: false, isPlaying: true, playbackState: 'playing' });
      } catch (error: any) {
        set({
          isSynthesizing: false,
          isPlaying: false,
          playbackState: 'idle',
          activeTtsSessionId: null,
          lastTtsError: error,
        });
        const code = error?.code;
        const message = getSystemTtsErrorMessage(code);
        if (code !== 'TTS_CANCELLED') {
          Toast.show({ type: 'error', text1: message });
        }
      }
      return;
    }

    if (state.engine === 'builtin') {
      // Milestone B：实际内置 TTS 播放 deferred，点击时提示用户。
      Toast.show({
        type: 'info',
        text1: '内置离线 TTS 即将上线',
        text2: '请先使用系统 TTS 或云端 API',
      });
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

    set({ isSynthesizing: true, playbackState: 'synthesizing' });
    let audioPath: string | null = null;
    try {
      audioPath = await synthesizeToFile(text, state.config, state.apiKey);
      set({ isSynthesizing: false, isPlaying: true, playbackState: 'playing' });
      try {
        await TtsAudio.playAudioFile(audioPath);
      } finally {
        set({ isPlaying: false, playbackState: 'idle', lastPlayEndedAt: Date.now() });
        if (audioPath) {
          await deleteIfExists(audioPath);
        }
      }
    } catch (error: any) {
      set({ isSynthesizing: false, isPlaying: false, playbackState: 'idle', lastPlayEndedAt: Date.now() });
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
      // 即使在合成/初始化阶段也要调用 stopSpeak，取消待处理请求。
      try {
        await TtsAudio.stopSpeak();
      } catch {
        // ignore
      }
    } else {
      // 8.4 修复：cancelTts 未 try-catch，抛错后 stopAudio 不执行，原生音频泄漏
      if (isSynthesizing) {
        try {
          await cancelTts();
        } catch {
          // ignore cancel errors
        }
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

// 模块级单例保护：防止热重载或测试环境重复注册监听器。
let ttsListenersInitialized = false;

export function initializeTtsListeners(): void {
  if (ttsListenersInitialized) return;
  ttsListenersInitialized = true;

  TtsAudioEmitter.addListener('ttsStart', (event: TtsSessionEvent) => {
    const state = useVoiceStore.getState();
    if (!isCurrentSession(state, event)) return;
    useVoiceStore.setState({ isPlaying: true, playbackState: 'playing' });
  });

  TtsAudioEmitter.addListener('ttsProgress', (event: TtsSessionEvent) => {
    const state = useVoiceStore.getState();
    if (!isCurrentSession(state, event)) return;
    useVoiceStore.setState({
      ttsProgress: { chunkIndex: event.chunkIndex, chunkCount: event.chunkCount },
    });
  });

  TtsAudioEmitter.addListener('ttsDone', (event: TtsSessionEvent) => {
    const state = useVoiceStore.getState();
    if (!isCurrentSession(state, event)) return;
    useVoiceStore.setState({
      isSynthesizing: false,
      isPlaying: false,
      playbackState: 'idle',
      lastPlayEndedAt: Date.now(),
      activeTtsSessionId: null,
      ttsProgress: null,
    });
  });

  TtsAudioEmitter.addListener('ttsError', (event: TtsErrorEvent) => {
    const state = useVoiceStore.getState();
    if (!isCurrentSession(state, event)) return;
    useVoiceStore.setState({
      isSynthesizing: false,
      isPlaying: false,
      playbackState: 'idle',
      lastPlayEndedAt: Date.now(),
      activeTtsSessionId: null,
      ttsProgress: null,
      lastTtsError: event,
    });
    const message = getSystemTtsErrorMessage(event.errorCode);
    Toast.show({ type: 'error', text1: message });
  });

  TtsAudioEmitter.addListener('ttsStopped', (event: TtsSessionEvent) => {
    const state = useVoiceStore.getState();
    if (!isCurrentSession(state, event)) return;
    useVoiceStore.setState({
      isSynthesizing: false,
      isPlaying: false,
      activeTtsSessionId: null,
      ttsProgress: null,
    });
  });
}

initializeTtsListeners();
