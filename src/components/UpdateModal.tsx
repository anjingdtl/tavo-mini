import React from 'react';
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Download, ExternalLink, ShieldCheck } from 'lucide-react-native';
import { useThemeStore } from '../store/themeStore';
import {
  downloadAndVerifyUpdate,
  formatUpdateError,
  isUpdateServiceError,
  type DownloadProgress,
  type UpdateServiceError,
} from '../services/updateService';
import { AppUpdate } from '../native/AppUpdateModule';
import type { AvailableUpdate } from '../services/updateProtocol';
import { Button, Card, spacing } from './ui';

type UpdateModalStatus =
  | 'available'
  | 'downloading'
  | 'permission'
  | 'installing'
  | 'error';

export interface UpdateModalProps {
  visible: boolean;
  release: AvailableUpdate | null;
  currentVersionName: string;
  onClose: () => void;
}

function errorTitle(error: unknown): string {
  if (!isUpdateServiceError(error)) return '更新失败';
  const titles: Partial<Record<UpdateServiceError['code'], string>> = {
    HASH_MISMATCH: '安装包完整性校验失败',
    PACKAGE_MISMATCH: '安装包包名验证失败',
    SIGNER_MISMATCH: '安装包签名验证失败',
    VERSION_MISMATCH: '安装包版本验证失败',
    DOWNLOAD_FAILED: '下载失败',
  };
  return titles[error.code] || '更新失败';
}

function formatBytes(value: number | undefined): string | null {
  if (!value || value <= 0) return null;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export const UpdateModal: React.FC<UpdateModalProps> = ({
  visible,
  release,
  currentVersionName,
  onClose,
}) => {
  const { theme } = useThemeStore();
  const [status, setStatus] = React.useState<UpdateModalStatus>('available');
  const [progress, setProgress] = React.useState<DownloadProgress | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [downloadedPath, setDownloadedPath] = React.useState<string | null>(null);
  const aliveRef = React.useRef(true);
  const installAttemptedRef = React.useRef(false);

  React.useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (!visible) return undefined;
    setStatus('available');
    setProgress(null);
    setError(null);
    setDownloadedPath(null);
    installAttemptedRef.current = false;
    return undefined;
  }, [visible, release?.versionCode]);

  const installVerifiedApk = React.useCallback(async (path: string) => {
    if (!AppUpdate || installAttemptedRef.current) return;
    installAttemptedRef.current = true;
    try {
      const allowed = await AppUpdate.canInstallUnknownApps();
      if (!allowed) {
        if (aliveRef.current) setStatus('permission');
        installAttemptedRef.current = false;
        return;
      }
      await AppUpdate.installApk(path);
      if (aliveRef.current) setStatus('installing');
    } catch (nextError) {
      installAttemptedRef.current = false;
      if (aliveRef.current) {
        setError(nextError);
        setStatus('error');
      }
    }
  }, []);

  React.useEffect(() => {
    if (!visible || status !== 'permission' || !downloadedPath) return undefined;
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active') return;
      // Returning from Android settings is the only automatic continuation.
      // If permission is still denied, remain on this screen and do not reopen
      // settings in a loop.
      installVerifiedApk(downloadedPath);
    });
    return () => subscription.remove();
  }, [downloadedPath, installVerifiedApk, status, visible]);

  const startDownload = React.useCallback(async () => {
    if (!release || status === 'downloading' || status === 'installing') return;
    setError(null);
    setProgress(null);
    setStatus('downloading');
    try {
      const result = await downloadAndVerifyUpdate(release, nextProgress => {
        if (aliveRef.current) setProgress(nextProgress);
      });
      if (!aliveRef.current) return;
      setDownloadedPath(result.path);
      await installVerifiedApk(result.path);
    } catch (nextError) {
      if (aliveRef.current) {
        setError(nextError);
        setStatus('error');
      }
    }
  }, [installVerifiedApk, release, status]);

  const openPermissionSettings = React.useCallback(async () => {
    if (!AppUpdate) return;
    try {
      await AppUpdate.openUnknownAppSettings();
    } catch (nextError) {
      setError(nextError);
      setStatus('error');
    }
  }, []);

  const handleRetry = React.useCallback(() => {
    setStatus('available');
    setError(null);
    setDownloadedPath(null);
    installAttemptedRef.current = false;
  }, []);

  if (!release) return null;
  const apkSize = formatBytes(release.apkSizeBytes || release.assetSizeBytes);
  const percent = progress?.percent ?? 0;
  const isBusy = status === 'downloading' || status === 'installing';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!release.forceUpdate && !isBusy) onClose();
      }}
    >
      <View style={styles.overlay}>
        <Card style={[styles.modalCard, { backgroundColor: theme.colors.surface }]}>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.headingRow}>
              <View style={styles.headingIcon}>
                <Download size={22} color={theme.colors.accent} />
              </View>
              <View style={styles.headingText}>
                <Text style={[styles.title, { color: theme.colors.textPrimary }]}>发现新版本 {release.displayVersionName}</Text>
                <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>ShineWriter 应用内更新</Text>
              </View>
            </View>

            <View style={[styles.versionBox, { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.border }]}>
              <Text style={[styles.versionLabel, { color: theme.colors.textSecondary }]}>当前版本</Text>
              <Text style={[styles.versionValue, { color: theme.colors.textPrimary }]}>{currentVersionName}</Text>
              <Text style={[styles.arrow, { color: theme.colors.accent }]}>→</Text>
              <Text style={[styles.versionLabel, { color: theme.colors.textSecondary }]}>最新版本</Text>
              <Text style={[styles.versionValue, { color: theme.colors.accent }]}>{release.displayVersionName}</Text>
            </View>

            <Text style={[styles.sectionTitle, { color: theme.colors.textPrimary }]}>更新说明</Text>
            {release.notes.length > 0 ? (
              release.notes.map((note, index) => (
                <View key={`${index}-${note}`} style={styles.noteRow}>
                  <Text style={[styles.bullet, { color: theme.colors.accent }]}>•</Text>
                  <Text style={[styles.note, { color: theme.colors.textSecondary }]}>{note}</Text>
                </View>
              ))
            ) : (
              <Text style={[styles.note, { color: theme.colors.textSecondary }]}>本次版本包含稳定性和体验改进。</Text>
            )}
            {apkSize ? (
              <Text style={[styles.meta, { color: theme.colors.textMuted }]}>安装包大小：{apkSize}</Text>
            ) : null}

            {status === 'downloading' ? (
              <View style={styles.progressArea}>
                <View style={styles.statusRow}>
                  <ActivityIndicator size="small" color={theme.colors.accent} />
                  <Text style={[styles.statusText, { color: theme.colors.textPrimary }]}>正在下载更新包… {percent}%</Text>
                </View>
                <View style={[styles.progressTrack, { backgroundColor: theme.colors.border }]}>
                  <View style={[styles.progressFill, { backgroundColor: theme.colors.accent, width: `${percent}%` }]} />
                </View>
                {progress && progress.contentLength > 0 ? (
                  <Text style={[styles.meta, { color: theme.colors.textMuted }]}>
                    {formatBytes(progress.bytesWritten) || '0 KB'} / {formatBytes(progress.contentLength)}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {status === 'permission' ? (
              <View style={[styles.permissionBox, { borderColor: theme.colors.warning, backgroundColor: `${theme.colors.warning}14` }]}>
                <Text style={[styles.permissionTitle, { color: theme.colors.warning }]}>等待安装权限</Text>
                <Text style={[styles.note, { color: theme.colors.textSecondary }]}>Android 需要允许 ShineWriter 安装本次已校验的 APK。授权后返回此页面即可继续。</Text>
              </View>
            ) : null}

            {status === 'installing' ? (
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={theme.colors.accent} />
                <Text style={[styles.statusText, { color: theme.colors.textPrimary }]}>正在打开 Android 系统安装器…</Text>
              </View>
            ) : null}

            {status === 'error' ? (
              <View style={[styles.errorBox, { borderColor: theme.colors.danger, backgroundColor: `${theme.colors.danger}14` }]}>
                <Text style={[styles.errorTitle, { color: theme.colors.danger }]}>{errorTitle(error)}</Text>
                <Text style={[styles.note, { color: theme.colors.textSecondary }]}>{formatUpdateError(error)}</Text>
              </View>
            ) : null}

            {status !== 'downloading' && status !== 'installing' ? (
              <View style={styles.actions}>
                {status === 'permission' ? (
                  <Button label="前往授权" icon={ExternalLink} onPress={openPermissionSettings} />
                ) : status === 'error' ? (
                  <Button label="重试下载" icon={Download} onPress={handleRetry} />
                ) : (
                  <Button label="立即更新" icon={ShieldCheck} onPress={startDownload} />
                )}
                {!release.forceUpdate ? (
                  <Pressable accessibilityRole="button" accessibilityLabel="稍后更新" onPress={onClose} style={styles.laterButton}>
                    <Text style={[styles.laterText, { color: theme.colors.textSecondary }]}>稍后更新</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </ScrollView>
        </Card>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.48)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    maxHeight: '86%',
    padding: 0,
    overflow: 'hidden',
  },
  scrollContent: { padding: spacing.lg },
  headingRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg },
  headingIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(67, 158, 166, 0.14)',
    marginRight: spacing.md,
  },
  headingText: { flex: 1 },
  title: { fontSize: 20, fontWeight: '700', fontFamily: 'serif' },
  subtitle: { fontSize: 13, marginTop: 3 },
  versionBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  versionLabel: { fontSize: 12 },
  versionValue: { fontSize: 14, fontWeight: '700' },
  arrow: { fontSize: 20, marginHorizontal: spacing.xs },
  sectionTitle: { fontSize: 15, fontWeight: '700', marginBottom: spacing.sm },
  noteRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  bullet: { fontSize: 18, lineHeight: 19, marginRight: spacing.sm },
  note: { flex: 1, fontSize: 13, lineHeight: 20 },
  meta: { fontSize: 12, marginTop: spacing.sm },
  progressArea: { marginTop: spacing.lg },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg },
  statusText: { fontSize: 14, fontWeight: '600', flex: 1 },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden', marginTop: spacing.sm },
  progressFill: { height: '100%', borderRadius: 4 },
  permissionBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: spacing.md, marginTop: spacing.lg },
  permissionTitle: { fontSize: 14, fontWeight: '700', marginBottom: spacing.xs },
  errorBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: spacing.md, marginTop: spacing.lg },
  errorTitle: { fontSize: 14, fontWeight: '700', marginBottom: spacing.xs },
  actions: { marginTop: spacing.lg, gap: spacing.sm },
  laterButton: { alignItems: 'center', paddingVertical: spacing.sm },
  laterText: { fontSize: 14, fontWeight: '600' },
});
