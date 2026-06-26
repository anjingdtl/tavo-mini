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
    // 11.18 修复：冷启动时 AppState.currentState 可能不可靠（部分设备首帧返回
    // 'unknown' 或 undefined）。延迟 500ms 主动读一次校正：仅当当前值不在
    // 已知可靠集合内时才覆盖，避免覆盖事件/测试已设置的 active/background/inactive。
    // 用可选链读取：测试环境或模块卸载后 AppState 绑定可能失效，避免抛错。
    setTimeout(() => {
      if (
        this.current === 'active' ||
        this.current === 'background' ||
        this.current === 'inactive'
      ) {
        return;
      }
      const latest = AppState?.currentState;
      if (latest && latest !== 'unknown') {
        this.current = latest;
      }
    }, 500);
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
