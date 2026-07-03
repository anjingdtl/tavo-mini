import { CommonActions, createNavigationContainerRef } from '@react-navigation/native';
import type { EditorStackParamList, SettingsStackParamList } from './TabNavigator';

type RootStackParamList = EditorStackParamList & SettingsStackParamList;

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

// deeplink 等待队列：navigationRef 尚未就绪时缓存 taskId，就绪后重放。
let pendingTaskId: string | null = null;
let pendingTimer: ReturnType<typeof setInterval> | null = null;

// PipelineResult 同时注册在 EditorStack 和 SettingsStack 两个子 stack 里。
// 从根 navigationRef 直接 navigate('PipelineResult') 会触发
// "The action 'NAVIGATE' with payload {name:'PipelineResult'} was not handled
// by any navigator." 修复：用嵌套语法先切到 Settings Tab，再 push PipelineResult。
function doNavigateToPipelineResult(taskId: string): void {
  // 优先走 Settings → PipelineResult（更常见的入口：流水线任务中心 → 详情）
  try {
    navigationRef.dispatch(
      CommonActions.navigate({
        name: 'Settings',
        params: { screen: 'PipelineResult', params: { taskId } },
      } as never),
    );
    return;
  } catch {
    // fall through
  }
  // 退化：尝试 Editor → PipelineResult
  try {
    navigationRef.dispatch(
      CommonActions.navigate({
        name: 'Editor',
        params: { screen: 'PipelineResult', params: { taskId } },
      } as never),
    );
    return;
  } catch {
    // fall through
  }
  // last-resort: 跳到流水线任务中心
  navigateToPipelineTaskCenter();
}

function flushPendingTask(): void {
  if (pendingTaskId === null) return;
  if (!navigationRef.isReady()) return;
  const taskId = pendingTaskId;
  pendingTaskId = null;
  if (pendingTimer) {
    clearInterval(pendingTimer);
    pendingTimer = null;
  }
  doNavigateToPipelineResult(taskId);
}

export function navigateToPipelineResult(taskId: string): void {
  // 就绪则立即跳转
  if (navigationRef.isReady()) {
    doNavigateToPipelineResult(taskId);
    return;
  }
  // 未就绪：缓存 taskId 并轮询等待容器就绪。最多重试 25 次（200ms × 25 = 5s），
  // 超时则丢弃，避免内存泄漏与无限轮询。新的 taskId 会覆盖旧的 pending。
  pendingTaskId = taskId;
  if (pendingTimer) {
    clearInterval(pendingTimer);
  }
  let retries = 0;
  const MAX_RETRIES = 25;
  pendingTimer = setInterval(() => {
    retries += 1;
    if (navigationRef.isReady()) {
      flushPendingTask();
      return;
    }
    if (retries >= MAX_RETRIES) {
      // 超时清理
      if (pendingTimer) {
        clearInterval(pendingTimer);
        pendingTimer = null;
      }
      pendingTaskId = null;
    }
  }, 200);
}

export function navigateToPipelineTaskCenter(): void {
  if (!navigationRef.isReady()) return;
  // PipelineTask 在 SettingsStack 里，同样需要嵌套 navigate
  try {
    navigationRef.dispatch(
      CommonActions.navigate({
        name: 'Settings',
        params: { screen: 'PipelineTask' },
      } as never),
    );
  } catch {
    // ignore
  }
}
