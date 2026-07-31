import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Header, LoadingState, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import {
  listBackups,
  createManualBackup,
  restoreFromBackup,
  deleteBackup,
} from '../services/backupService';
import type { BackupSummary, BackupProgress } from '../services/backupService';
import { openDatabase } from '../services/database';
import { SCHEMA_VERSION } from '../services/migrations';
import { useSettingsStore } from '../store/settingsStore';

const appVersion = require('../constants/version.json').versionName.replace(/^V/, '');
const schemaVersion = SCHEMA_VERSION;

const KIND_LABELS: Record<BackupSummary['kind'], string> = {
  automatic: '自动',
  manual: '手动',
  pre_restore: '恢复前',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  onClose?: () => void;
}

export const BackupCenterScreen: React.FC<Props> = ({ onClose }) => {
  const navigation = useNavigation();
  const handleClose = onClose || (() => navigation.goBack());
  const { theme } = useThemeStore();
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [operating, setOperating] = useState(false);
  const [progress, setProgress] = useState<BackupProgress | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // Phase9-BUG#16: 原 try-finally 缺少 catch，补 catch + Toast
    try {
      const list = await listBackups();
      setBackups(list);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    setOperating(true);
    setProgress({ percent: 0, stage: '准备中' });
    try {
      const db = await openDatabase();
      await createManualBackup(db, appVersion, Number(schemaVersion), setProgress);
      setProgress(null);
      await load();
    } catch (e: any) {
      Alert.alert('创建失败', e?.message || '未知错误');
    } finally {
      setProgress(null);
      setOperating(false);
    }
  };

  const handleRestore = (item: BackupSummary) => {
    const kindLabel = KIND_LABELS[item.kind] || item.kind;
    const metaInfo = [
      `类型：${kindLabel}`,
      `版本：V${item.appVersion || '—'}`,
      `Schema：${item.schemaVersion || '—'}`,
      `时间：${formatTime(item.createdAt)}`,
      `大小：${formatSize(item.size)}`,
    ].join('\n');

    Alert.alert(
      '恢复确认',
      `确定要从此备份恢复吗？恢复前会自动创建一份"恢复前"备份。\n\n${metaInfo}`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '恢复',
          style: 'destructive',
          onPress: async () => {
            setOperating(true);
            try {
              const db = await openDatabase();
              await restoreFromBackup(db, item.path, {
                appVersion,
                schemaVersion: Number(schemaVersion),
              });
              await useSettingsStore.getState().loadSettings();
              Alert.alert('恢复成功', '数据已从备份恢复，设置和列表已重新加载。');
              await load();
            } catch (e: any) {
              Alert.alert('恢复失败', e?.message || '未知错误');
            } finally {
              setOperating(false);
            }
          },
        },
      ],
    );
  };

  const handleDelete = (item: BackupSummary) => {
    Alert.alert('删除确认', '确定要删除此备份吗？此操作不可撤销。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          setOperating(true);
          try {
            await deleteBackup(item.path);
            await load();
          } catch (e: any) {
            Alert.alert('删除失败', e?.message || '未知错误');
          } finally {
            setOperating(false);
          }
        },
      },
    ]);
  };

  const renderItem = ({ item }: { item: BackupSummary }) => {
    const fileName = item.path.split('/').pop() || item.path;
    return (
      <Card>
        <View style={styles.row}>
          <Text style={[styles.fileName, { color: theme.colors.textPrimary }]} numberOfLines={1}>
            {fileName}
          </Text>
          <Text style={[styles.kindBadge, { color: theme.colors.accent }]}>
            {KIND_LABELS[item.kind]}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
            {formatTime(item.createdAt)}
          </Text>
          <Text style={[styles.meta, { color: theme.colors.textMuted }]}>
            {formatSize(item.size)}
          </Text>
        </View>
        {!item.valid && (
          <Text style={[styles.invalidLabel, { color: theme.colors.danger }]}>
            备份无效或已损坏
          </Text>
        )}
        <View style={styles.actionRow}>
          <Button
            label="恢复"
            variant="secondary"
            compact
            disabled={!item.valid || operating}
            onPress={() => handleRestore(item)}
          />
          <Button
            label="删除"
            variant="danger"
            compact
            disabled={operating}
            onPress={() => handleDelete(item)}
          />
        </View>
      </Card>
    );
  };

  return (
    <Screen>
      <Header
        title="备份中心"
        subtitle="管理与恢复数据备份"
        action={<Button label="关闭" variant="ghost" compact onPress={handleClose} />}
      />
      <View style={[styles.createRow, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.border }]}>
        <Button
          label={operating ? '创建中...' : '创建备份'}
          onPress={handleCreate}
          disabled={operating}
          flex
        />
        {operating && progress ? (
          <View style={styles.progressWrap}>
            <View style={[styles.progressTrack, { backgroundColor: theme.colors.accentSoft }]}>
              <View
                style={[styles.progressFill, { width: `${progress.percent}%`, backgroundColor: theme.colors.accent }]}
              />
            </View>
            <Text style={[styles.progressLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>
              {progress.percent}% · {progress.stage}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={[styles.privacyNotice, { backgroundColor: theme.colors.surface }]}>
        <Text style={[styles.privacyText, { color: theme.colors.textSecondary }]}>备份文件包含小说正文、人物、世界观和笔记等内容。请勿将未加密备份上传到不可信位置。</Text>
      </View>
      {loading ? (
        <LoadingState label="加载备份列表..." />
      ) : backups.length === 0 ? (
        <EmptyState
          title="暂无备份"
          description='点击上方"创建备份"手动保存当前数据'
        />
      ) : (
        <FlatList
          data={backups}
          keyExtractor={item => item.path}
          contentContainerStyle={styles.list}
          renderItem={renderItem}
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  createRow: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    elevation: 2,
    zIndex: 2,
  },
  progressWrap: {
    marginTop: spacing.sm,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: 6,
    borderRadius: 3,
  },
  progressLabel: {
    fontSize: 12,
    marginTop: spacing.xs,
  },
  privacyNotice: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  privacyText: {
    fontSize: 12,
    lineHeight: 18,
  },
  list: {
    padding: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 96,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  fileName: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
    marginRight: spacing.sm,
  },
  kindBadge: {
    fontSize: 12,
    fontWeight: '700',
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  meta: {
    fontSize: 12,
  },
  invalidLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: spacing.xs,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
});
