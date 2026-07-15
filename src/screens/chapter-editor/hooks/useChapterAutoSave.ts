import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import * as db from '../../../services/database';
import { debounce, type DebouncedAsync } from '../../../utils/debounce';
import type { Chapter } from '../../../types/novel';

export type SaveStatus = 'saved' | 'saving' | 'failed';

export function useChapterAutoSave(
  chapter: Chapter | null,
  setChapter: Dispatch<SetStateAction<Chapter | null>>,
) {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const pendingFieldsRef = useRef<Partial<Chapter>>({});
  const pendingChapterIdRef = useRef<number | null>(null);
  const autoSaveRef = useRef<DebouncedAsync<[]>>(
    debounce(async () => {
      const id = pendingChapterIdRef.current;
      const fields = pendingFieldsRef.current;
      pendingFieldsRef.current = {};
      if (id == null) return;
      try {
        await db.updateChapter(id, fields);
        setSaveStatus('saved');
      } catch {
        pendingFieldsRef.current = { ...fields, ...pendingFieldsRef.current };
        setSaveStatus('failed');
      }
    }, 900),
  );

  const changeField = useCallback(
    (field: keyof Chapter, value: string) => {
      if (!chapter) return;
      setChapter(current =>
        current ? { ...current, [field]: value } : current,
      );
      setSaveStatus('saving');
      pendingFieldsRef.current = {
        ...pendingFieldsRef.current,
        [field]: value,
      };
      pendingChapterIdRef.current = chapter.id;
      autoSaveRef.current.call();
    },
    [chapter, setChapter],
  );

  return { autoSaveRef, changeField, saveStatus, setSaveStatus };
}
