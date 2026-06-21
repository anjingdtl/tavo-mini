import RNFS from 'react-native-fs';
import type { VoiceConfig } from '../types/tts';
import { MAX_TTS_CHARS } from '../constants/voice';

interface MiniMaxTtsResponse {
  data?: {
    audio?: string;
    status?: number;
  } | null;
  base_resp: {
    status_code: number;
    status_msg: string;
  };
  trace_id?: string;
}

let currentAbortController: AbortController | null = null;
let currentTempFile: string | null = null;

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  const len = normalized.length;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = parseInt(normalized.substring(i, i + 2), 16);
  }
  return bytes;
}

/* eslint-disable no-bitwise */
function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let base64 = '';
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    const b2 = i < bytes.length ? bytes[i++] : NaN;
    const b3 = i < bytes.length ? bytes[i++] : NaN;
    const bitmap = (b1 << 16) | ((Number.isNaN(b2) ? 0 : b2) << 8) | (Number.isNaN(b3) ? 0 : b3);
    base64 += chars.charAt((bitmap >> 18) & 63);
    base64 += chars.charAt((bitmap >> 12) & 63);
    base64 += Number.isNaN(b2) ? '=' : chars.charAt((bitmap >> 6) & 63);
    base64 += Number.isNaN(b3) ? '=' : chars.charAt(bitmap & 63);
  }
  return base64;
}
/* eslint-enable no-bitwise */

export function hexAudioToBase64(hex: string): string {
  return bytesToBase64(hexToBytes(hex));
}

export function truncateTtsText(text: string): string {
  if (text.length <= MAX_TTS_CHARS) return text;
  return text.slice(0, MAX_TTS_CHARS);
}

export function isTtsTextTooLong(text: string): boolean {
  return text.length > MAX_TTS_CHARS;
}

export async function synthesizeToFile(
  text: string,
  voiceConfig: VoiceConfig,
  apiKey: string,
): Promise<string> {
  if (!apiKey.trim()) {
    throw new Error('请先配置语音 API Key。');
  }
  if (!text.trim()) {
    throw new Error('没有可朗读的内容。');
  }
  const apiUrl = voiceConfig.apiUrl?.trim();
  if (!apiUrl) {
    throw new Error('请先填写语音 API URL。');
  }

  currentAbortController = new AbortController();
  const fileName = `tts_${Date.now()}.${voiceConfig.format}`;
  const filePath = `${RNFS.CachesDirectoryPath}/${fileName}`;
  currentTempFile = filePath;

  const body = {
    model: voiceConfig.model,
    text: truncateTtsText(text),
    stream: false,
    output_format: 'hex',
    voice_setting: {
      voice_id: voiceConfig.voiceId,
      speed: voiceConfig.speed,
      vol: voiceConfig.vol,
      pitch: voiceConfig.pitch,
    },
    audio_setting: {
      sample_rate: voiceConfig.sampleRate,
      bitrate: voiceConfig.bitrate,
      format: voiceConfig.format,
      channel: 1,
    },
  };

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal: currentAbortController.signal,
    });
  } catch (error: any) {
    cleanup();
    if (error?.name === 'AbortError') {
      throw new Error('朗读已取消。');
    }
    throw new Error(`网络请求失败：${error?.message || '请检查网络连接。'}`);
  }

  let json: MiniMaxTtsResponse;
  try {
    json = await response.json();
  } catch {
    cleanup();
    throw new Error('解析语音响应失败，请稍后重试。');
  }

  if (!response.ok || json.base_resp.status_code !== 0) {
    cleanup();
    const providerCode = json.base_resp?.status_code;
    const providerMsg = json.base_resp?.status_msg?.trim();
    const msg = providerCode
      ? `${providerCode} ${providerMsg || `HTTP ${response.status}`}`
      : providerMsg || `HTTP ${response.status}`;
    throw new Error(`语音合成失败：${msg}`);
  }

  const audioHex = json.data?.audio;
  if (!audioHex) {
    cleanup();
    throw new Error('语音合成未返回音频数据。');
  }

  try {
    await RNFS.writeFile(filePath, hexAudioToBase64(audioHex), 'base64');
  } catch (error: any) {
    cleanup();
    throw new Error(`音频文件写入失败：${error?.message || '未知错误'}`);
  }

  currentAbortController = null;
  currentTempFile = null;
  return filePath;
}

export async function cancelTts(): Promise<void> {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  await cleanup();
}

async function cleanup(): Promise<void> {
  if (currentTempFile) {
    try {
      const exists = await RNFS.exists(currentTempFile);
      if (exists) {
        await RNFS.unlink(currentTempFile);
      }
    } catch {
      // ignore cleanup errors
    }
    currentTempFile = null;
  }
}
