import { PermissionsAndroid, Platform } from 'react-native';

/**
 * Android 13+ 的通知权限只在用户主动开启后台能力或开始一项可见任务时申请。
 * 前台服务本身即使被拒绝也可以启动，但通知不会出现在抽屉中，用户也无法看到
 * 写作/朗读的运行状态，因此统一在这里请求并由调用方决定如何提示。
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;

  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (!permission) return true;

  try {
    if (await PermissionsAndroid.check(permission)) return true;
    const result = await PermissionsAndroid.request(permission, {
      title: '允许通知',
      message: '用于显示后台写作和语音朗读进度，并在任务完成后提醒你。',
      buttonPositive: '允许',
      buttonNegative: '暂不允许',
    });
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}
