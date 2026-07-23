import { NativeModules } from 'react-native';
import { PipelineForeground } from '../src/native/PipelineForegroundModule';
import { appStateTracker } from '../src/utils/appState';

describe('PipelineForegroundBridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    PipelineForeground.setEnabled(true);
    appStateTracker._setStatusForTest('background');
  });

  it('enabled=false 时 start/updateProgress 静默 no-op', async () => {
    PipelineForeground.setEnabled(false);
    await PipelineForeground.start('t1', '标题', '草稿中');
    await PipelineForeground.updateProgress('t1', '审阅中', 50);
    expect(NativeModules.PipelineForeground.start).not.toHaveBeenCalled();
    expect(NativeModules.PipelineForeground.updateProgress).not.toHaveBeenCalled();
  });

  it('start 调用原生 start（默认进度 0）', async () => {
    await PipelineForeground.start('t1', '第1章', '草稿中');
    expect(NativeModules.PipelineForeground.start).toHaveBeenCalledWith('t1', '第1章', '草稿中', 0);
  });

  it('start 可指定初始进度', async () => {
    await PipelineForeground.start('t1', '第1章', '草稿中', 25);
    expect(NativeModules.PipelineForeground.start).toHaveBeenCalledWith('t1', '第1章', '草稿中', 25);
  });

  it('updateProgress 调用原生 updateProgress 并透传进度', async () => {
    await PipelineForeground.updateProgress('t1', '审阅中', 50);
    expect(NativeModules.PipelineForeground.updateProgress).toHaveBeenCalledWith('t1', '审阅中', 50);
  });

  it('前台时 notifyComplete 不发系统通知（复用现有弹窗）', async () => {
    appStateTracker._setStatusForTest('active');
    await PipelineForeground.notifyComplete('t1', '第1章', '已完成');
    expect(NativeModules.PipelineForeground.notifyComplete).not.toHaveBeenCalled();
  });

  it('后台时 notifyComplete 发系统通知', async () => {
    appStateTracker._setStatusForTest('background');
    await PipelineForeground.notifyComplete('t1', '第1章', '已完成');
    expect(NativeModules.PipelineForeground.notifyComplete).toHaveBeenCalledWith('t1', '第1章', '已完成');
  });

  it('inactive 状态也视为后台，notifyFailed 发系统通知', async () => {
    appStateTracker._setStatusForTest('inactive');
    await PipelineForeground.notifyFailed('t1', '第1章', '失败');
    expect(NativeModules.PipelineForeground.notifyFailed).toHaveBeenCalledWith('t1', '第1章', '失败');
  });

  it('stop 无论 enabled 与否都调用原生 stop（清理资源）', async () => {
    PipelineForeground.setEnabled(false);
    await PipelineForeground.stop('t1');
    expect(NativeModules.PipelineForeground.stop).toHaveBeenCalledWith('t1');
  });

  it('原生抛错时方法静默不抛出', async () => {
    (NativeModules.PipelineForeground.start as any).mockRejectedValueOnce(new Error('boom'));
    await expect(PipelineForeground.start('t1', 't', 's')).resolves.toBeUndefined();
  });

  it('one parallel task finishing does not stop the shared foreground service', async () => {
    await PipelineForeground.start('task-a', '第1章', '草稿中');
    await PipelineForeground.start('task-b', '第2章', '草稿中');

    await PipelineForeground.stop('task-a');
    expect(NativeModules.PipelineForeground.stop).not.toHaveBeenCalled();

    await PipelineForeground.stop('task-b');
    expect(NativeModules.PipelineForeground.stop).toHaveBeenCalledWith('task-b');
  });

  it('isAvailable 在原生可用时返回 true', async () => {
    await expect(PipelineForeground.isAvailable()).resolves.toBe(true);
  });
});
