import { useCallback, useEffect, useState } from 'react';
import Toast from 'react-native-toast-message';
import * as db from '../../../services/database';
import type { Chapter } from '../../../types/novel';
import type { ChapterReadingRange } from '../../../data/repositories/projectRepository';
import { useVoiceStore } from '../../../store/voiceStore';

const JUST_FINISHED_WINDOW_MS = 2500;

export function useChapterTts(chapter: Chapter | null) {
  const {
    isSynthesizing,
    isPlaying,
    lastPlayEndedAt,
    loadVoiceConfig,
    playChapter,
    stop,
  } = useVoiceStore();
  const [rangePickerVisible, setRangePickerVisible] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    loadVoiceConfig().catch(() => {});
  }, [loadVoiceConfig]);

  useEffect(() => {
    if (!lastPlayEndedAt) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 300);
    return () => clearInterval(interval);
  }, [lastPlayEndedAt]);

  const isJustFinished =
    !isSynthesizing &&
    !isPlaying &&
    lastPlayEndedAt !== null &&
    now - lastPlayEndedAt < JUST_FINISHED_WINDOW_MS;

  const toggleTts = useCallback(async () => {
    if (!chapter) return;
    try {
      if (isSynthesizing || isPlaying) {
        await stop();
        return;
      }
      const { lastPlayEndedAt: endedAt } = useVoiceStore.getState();
      if (endedAt != null && Date.now() - endedAt < JUST_FINISHED_WINDOW_MS) {
        Toast.show({
          type: 'info',
          text1: '朗读已结束',
          text2: '稍等片刻或重新选择范围',
        });
        return;
      }
      setRangePickerVisible(true);
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: error?.message });
    }
  }, [chapter, isPlaying, isSynthesizing, stop]);

  const playReadingRange = useCallback(
    async (range: ChapterReadingRange) => {
      if (!chapter) return;
      try {
        const text = await db.buildChapterReadingText(
          chapter.project_id,
          chapter.id,
          range,
        );
        if (!text.trim()) {
          Toast.show({ type: 'error', text1: '没有可朗读的正文内容' });
          return;
        }
        await playChapter(text);
      } catch (error: any) {
        Toast.show({ type: 'error', text1: '朗读失败', text2: error?.message });
      }
    },
    [chapter, playChapter],
  );

  const handleRangeSelected = useCallback(
    (range: ChapterReadingRange) => {
      setRangePickerVisible(false);
      playReadingRange(range).catch(() => {});
    },
    [playReadingRange],
  );

  return {
    handleRangeSelected,
    isJustFinished,
    isPlaying,
    isSynthesizing,
    playReadingRange,
    rangePickerVisible,
    setRangePickerVisible,
    toggleTts,
  };
}
