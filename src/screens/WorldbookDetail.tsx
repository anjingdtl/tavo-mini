import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, Header, LoadingState, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';

interface Props {
  entryId: number;
  onClose: () => void;
}

export const WorldbookDetail: React.FC<Props> = ({ entryId, onClose }) => {
  const { theme } = useThemeStore();
  // 10.4: 替换 useState<any>，使用具体类型 db.RowRecord
  const [entry, setEntry] = useState<db.RowRecord | null>(null);
  // 10.4: 加载期间显示 LoadingState，避免误导为"未找到条目"
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // 10.4: 补 try-catch，DB 异常时不再 unhandled rejection 静默白屏
    try {
      setEntry(await db.getWorldbookEntryById(entryId));
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '加载世界书条目失败', text2: e?.message });
    } finally {
      setLoading(false);
    }
  }, [entryId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Screen>
      <Header title="世界书条目" action={<Button label="返回" variant="ghost" onPress={onClose} />} />
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <LoadingState />
        ) : (
          <Card>
            <Text style={[styles.title, { color: theme.colors.textPrimary }]}>{entry?.keyword_primary || '未找到条目'}</Text>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{entry?.content || '无内容'}</Text>
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg },
  title: { fontSize: 18, fontWeight: '800', marginBottom: spacing.sm },
  meta: { fontSize: 13, lineHeight: 20 },
});
