import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Button, Card, EmptyState, Header, LoadingState, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import {
  listBackups,
  createManualBackup,
  restoreFromBackup,
  deleteBackup,
  createPreRestoreBackup,
} from '../services/backupService';
import type { BackupSummary } from '../services/backupService';
import { openDatabase } from '../services/database';
import { SCHEMA_VERSION } from '../services/migrations';

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listBackups();
      setBackups(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    setOperating(true);
    try {
      const db = await openDatabase();
      await createManualBackup(db, appVersion, Number(schemaVersion));
      await load();
    } catch (e: any) {
      Alert.alert('创建失败', e?.message || '未知错误');
    } finally {
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
              await createPreRestoreBackup(db, appVersion, Number(schemaVersion));
              await restoreFromBackup(db, item.path);
              Alert.alert('恢复成功', '数据已从备份恢复，部分设置可能需要重启应用生效。');
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
          label="创建备份"
          onPress={handleCreate}
          disabled={operating}
          flex
        />
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
