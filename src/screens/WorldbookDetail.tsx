import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { Button, Card, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';

interface Props {
  entryId: number;
  onClose: () => void;
}

export const WorldbookDetail: React.FC<Props> = ({ entryId, onClose }) => {
  const { theme } = useThemeStore();
  const [entry, setEntry] = useState<any>(null);

  const load = useCallback(async () => {
    setEntry(await db.getWorldbookEntryById(entryId));
  }, [entryId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Screen>
      <Header title="世界书条目" action={<Button label="返回" variant="ghost" onPress={onClose} />} />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={[styles.title, { color: theme.colors.textPrimary }]}>{entry?.keyword_primary || '未找到条目'}</Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{entry?.content || '无内容'}</Text>
        </Card>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg },
  title: { fontSize: 18, fontWeight: '800', marginBottom: spacing.sm },
  meta: { fontSize: 13, lineHeight: 20 },
});
