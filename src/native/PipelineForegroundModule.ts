import { NativeModules } from 'react-native';
import { appStateTracker } from '../utils/appState';

interface PipelineForegroundNative {
  start(taskId: string, title: string, stageLabel: string, progress: number): Promise<void>;
  updateProgress(taskId: string, stageLabel: string, progress: number): Promise<void>;
  notifyComplete(taskId: string, title: string, message: string): Promise<void>;
  notifyFailed(taskId: string, title: string, message: string): Promise<void>;
  stop(taskId: string): Promise<void>;
  isAvailable(): Promise<boolean>;
  consumeDeepLinkTaskId(): Promise<string | null>;
}

const native: PipelineForegroundNative | undefined = NativeModules.PipelineForeground;

/**
 * 流水线保活/通知桥接单例。
 *
 * 设计原则：
 *  1. 所有方法 try/catch + 静默降级——原生缺失或抛错绝不阻塞流水线。
 *  2. 终态通知（notifyComplete/notifyFailed）内部判断 App 前后台：
 *     前台时不发系统通知（让现有 PipelineResultPrompt 处理）。
 *  3. 通过 setEnabled 控制：用户在设置中关闭后台运行时，所有方法变 no-op。
 */
class PipelineForegroundBridge {
  private enabled = false;

  /** 由 settingsStore 在加载/切换时调用。 */
  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 流水线入口：启动前台服务。progress 为初始进度百分比 0-100。 */
  async start(taskId: string, title: string, stageLabel: string, progress = 0): Promise<void> {
    if (!this.enabled || !native) return;
    try {
      await native.start(taskId, title, stageLabel, Math.round(progress));
    } catch (e) {
      console.warn('[PipelineForeground] start failed', e);
    }
  }

  /** 阶段切换：更新常驻通知文本与进度条。progress 为百分比 0-100。 */
  async updateProgress(taskId: string, stageLabel: string, progress: number): Promise<void> {
    if (!this.enabled || !native) return;
    try {
      await native.updateProgress(taskId, stageLabel, Math.round(progress));
    } catch (e) {
      console.warn('[PipelineForeground] updateProgress failed', e);
    }
  }

  /**
   * 流水线成功完成：发系统通知（仅当 App 在后台）。
   * 前台时不发——由现有 PipelineResultPrompt 弹窗负责提示。
   */
  async notifyComplete(taskId: string, title: string, message: string): Promise<void> {
    if (!native) return;
    if (appStateTracker.isForeground()) return; // 前台复用现有弹窗
    try {
      await native.notifyComplete(taskId, title, message);
    } catch (e) {
      console.warn('[PipelineForeground] notifyComplete failed', e);
    }
  }

  /**
   * 流水线失败或取消：发系统通知（仅当 App 在后台）。
   */
  async notifyFailed(taskId: string, title: string, message: string): Promise<void> {
    if (!native) return;
    if (appStateTracker.isForeground()) return;
    try {
      await native.notifyFailed(taskId, title, message);
    } catch (e) {
      console.warn('[PipelineForeground] notifyFailed failed', e);
    }
  }

  /** 流水线结束：停止前台服务。无论 enabled 与否都尝试停止（清理资源）。 */
  async stop(taskId: string): Promise<void> {
    if (!native) return;
    try {
      await native.stop(taskId);
    } catch (e) {
      console.warn('[PipelineForeground] stop failed', e);
    }
  }

  /** 供 JS 判断当前原生能力是否可用。 */
  async isAvailable(): Promise<boolean> {
    if (!native) return false;
    try {
      return await native.isAvailable();
    } catch {
      return false;
    }
  }

  /**
   * 读取并清除通知点击暂存的 taskId（App 冷启动或从后台恢复时调用）。
   * 返回非 null 时，调用方应导航到对应任务的 PipelineResult。
   */
  async consumeDeepLinkTaskId(): Promise<string | null> {
    if (!native) return null;
    try {
      return await native.consumeDeepLinkTaskId();
    } catch {
      return null;
    }
  }
}

export const PipelineForeground = new PipelineForegroundBridge();
