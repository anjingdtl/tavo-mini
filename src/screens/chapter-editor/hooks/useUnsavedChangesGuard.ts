import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { Alert, AppState } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { EditorStackParamList } from '../../../navigation/TabNavigator';
import type { DebouncedAsync } from '../../../utils/debounce';
import type { SaveStatus } from './useChapterAutoSave';

type ChapterNavigation = NativeStackNavigationProp<
  EditorStackParamList,
  'ChapterEditor'
>;

interface Params {
  autoSaveRef: MutableRefObject<DebouncedAsync<[]>>;
  navigation: ChapterNavigation;
  onClose: () => void;
  setSaveStatus: Dispatch<SetStateAction<SaveStatus>>;
}

export function useUnsavedChangesGuard({
  autoSaveRef,
  navigation,
  onClose,
  setSaveStatus,
}: Params) {
  const allowNextRemovalRef = useRef(false);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background' || state === 'inactive') {
        autoSaveRef.current.flush().catch(() => {});
      }
    });
    return () => subscription.remove();
  }, [autoSaveRef]);

  useEffect(() => {
    const autoSave = autoSaveRef.current;
    return () => {
      autoSave.flush().catch(() => {});
    };
  }, [autoSaveRef]);

  const saveBeforeExit = useCallback(
    async (onSaved: () => void, onForceExit: () => void) => {
      if (!autoSaveRef.current.pending()) {
        onSaved();
        return;
      }
      try {
        await autoSaveRef.current.flush();
        onSaved();
      } catch {
        setSaveStatus('failed');
        Alert.alert('保存失败', '内容尚未保存，是否仍然退出？', [
          {
            text: '重试保存',
            onPress: () => saveBeforeExit(onSaved, onForceExit).catch(() => {}),
          },
          { text: '仍然退出', style: 'destructive', onPress: onForceExit },
        ]);
      }
    },
    [autoSaveRef, setSaveStatus],
  );

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event: any) => {
      if (allowNextRemovalRef.current) {
        allowNextRemovalRef.current = false;
        return;
      }
      if (!autoSaveRef.current.pending()) return;
      event.preventDefault();
      const dispatch = () => navigation.dispatch(event.data.action);
      saveBeforeExit(dispatch, () => {
        allowNextRemovalRef.current = true;
        dispatch();
      }).catch(() => {});
    });
    return unsubscribe;
  }, [autoSaveRef, navigation, saveBeforeExit]);

  const flushAndClose = useCallback(async () => {
    await saveBeforeExit(onClose, onClose);
  }, [onClose, saveBeforeExit]);

  return { flushAndClose };
}
