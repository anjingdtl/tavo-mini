import {
  useCallback,
  useEffect,
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

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event: any) => {
      if (!autoSaveRef.current.pending()) return;
      event.preventDefault();
      autoSaveRef.current
        .flush()
        .then(() => navigation.dispatch(event.data.action))
        .catch(() => {
          setSaveStatus('failed');
        });
    });
    return unsubscribe;
  }, [autoSaveRef, navigation, setSaveStatus]);

  const flushAndClose = useCallback(async () => {
    if (!autoSaveRef.current.pending()) {
      onClose();
      return;
    }
    try {
      await autoSaveRef.current.flush();
      onClose();
    } catch {
      setSaveStatus('failed');
      Alert.alert('保存失败', '内容尚未保存，是否仍然退出？', [
        { text: '重试保存', onPress: () => flushAndClose().catch(() => {}) },
        { text: '仍然退出', style: 'destructive', onPress: onClose },
      ]);
    }
  }, [autoSaveRef, onClose, setSaveStatus]);

  return { flushAndClose };
}
