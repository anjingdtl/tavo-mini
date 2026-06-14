import { createNavigationContainerRef } from '@react-navigation/native';
import type { EditorStackParamList, SettingsStackParamList } from './TabNavigator';

type RootStackParamList = EditorStackParamList & SettingsStackParamList;

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

export function navigateToPipelineResult(taskId: string): void {
  if (!navigationRef.isReady()) return;
  // The PipelineResult screen lives in both Editor and Settings stacks; pick
  // whichever the user is currently inside. Fall back to the Settings stack
  // task center when navigation state is still being initialized.
  try {
    navigationRef.navigate('PipelineResult' as never, { taskId } as never);
    return;
  } catch {
    // fall through
  }
  try {
    navigationRef.navigate('PipelineTask' as never);
  } catch {
    // last-resort: no-op
  }
}

export function navigateToPipelineTaskCenter(): void {
  if (!navigationRef.isReady()) return;
  try {
    navigationRef.navigate('PipelineTask' as never);
  } catch {
    // editor stack variant may also exist; ignore
  }
}
