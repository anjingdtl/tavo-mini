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

function isChapterFinalized(chapter: Chapter): boolean {
  return (
    String(chapter.status) === 'final' ||
    String(chapter.status) === 'finalized' ||
    chapter.finalized_at != null
  );
}

export function useChapterAutoSave(
  chapter: Chapter | null,
  setChapter: Dispatch<SetStateAction<Chapter | null>>,
) {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [saveError, setSaveError] = useState<unknown>(null);
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
        setSaveError(null);
        setSaveStatus('saved');
      } catch (error) {
        pendingFieldsRef.current = { ...fields, ...pendingFieldsRef.current };
        setSaveError(error);
        setSaveStatus('failed');
        throw error;
      }
    }, 900),
  );

  const changeField = useCallback(
    (field: keyof Chapter, value: string) => {
      if (!chapter) return;
      setChapter(current => {
        const nextChapter = current || chapter;
        if (!nextChapter) return current;
        const bodyChanged =
          field === 'content' && value !== String(nextChapter.content ?? '');
        return bodyChanged && isChapterFinalized(nextChapter)
          ? {
              ...nextChapter,
              [field]: value,
              status: 'draft',
              finalized_at: null,
            }
          : { ...nextChapter, [field]: value };
      });
      setSaveError(null);
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

  return {
    autoSaveRef,
    changeField,
    saveError,
    saveStatus,
    setSaveStatus,
  };
}
