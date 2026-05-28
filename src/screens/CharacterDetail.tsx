import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { Button, Card, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';

interface Props {
  characterId: number;
  onClose: () => void;
}

export const CharacterDetail: React.FC<Props> = ({ characterId, onClose }) => {
  const { theme } = useThemeStore();
  const [character, setCharacter] = useState<any>(null);

  const load = useCallback(async () => {
    setCharacter(await db.getCharacterById(characterId));
  }, [characterId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Screen>
      <Header title="角色详情" action={<Button label="返回" variant="ghost" onPress={onClose} />} />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={[styles.title, { color: theme.colors.textPrimary }]}>{character?.name || '未找到角色'}</Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{character?.data_json || '无角色数据'}</Text>
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
