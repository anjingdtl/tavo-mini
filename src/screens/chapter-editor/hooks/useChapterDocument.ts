import { useCallback, useState } from 'react';
import Toast from 'react-native-toast-message';
import * as db from '../../../services/database';
import type { Chapter } from '../../../types/novel';

export function useChapterDocument(chapterId: number) {
  const [chapter, setChapter] = useState<Chapter | null>(null);

  const loadChapter = useCallback(async () => {
    try {
      setChapter(await db.getChapterById(chapterId));
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: error?.message });
    }
  }, [chapterId]);

  return { chapter, setChapter, loadChapter };
}
