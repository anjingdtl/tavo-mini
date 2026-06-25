import { AppState, AppStateStatus } from 'react-native';

/**
 * 全局 AppState 跟踪单例。
 *
 * 用于在流水线终态时判断：App 是否在前台。
 * 前台时复用 PipelineResultPrompt 弹窗（不打扰），
 * 后台时才发系统通知。
 *
 * 不放在 store 里，因为这是平台运行时状态，不需要持久化或订阅式 UI。
 */
class AppStateTracker {
  private current: AppStateStatus = AppState.currentState;

  constructor() {
    AppState.addEventListener('change', (next) => {
      this.current = next;
    });
  }

  /** App 当前是否处于前台（active 状态）。 */
  isForeground(): boolean {
    return this.current === 'active';
  }

  /** 当前原始状态值（主要用于测试）。 */
  getStatus(): AppStateStatus {
    return this.current;
  }

  /** 仅供测试使用：强制设置内部状态。 */
  _setStatusForTest(status: AppStateStatus): void {
    this.current = status;
  }
}

export const appStateTracker = new AppStateTracker();
