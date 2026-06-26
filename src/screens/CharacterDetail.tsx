import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, Header, LoadingState, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';

interface Props {
  characterId: number;
  onClose: () => void;
}

export const CharacterDetail: React.FC<Props> = ({ characterId, onClose }) => {
  const { theme } = useThemeStore();
  // 10.4: 替换 useState<any>，使用具体类型 db.RowRecord
  const [character, setCharacter] = useState<db.RowRecord | null>(null);
  // 10.4: 加载期间显示 LoadingState，避免误导为"未找到角色"
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // 10.4: 补 try-catch，DB 异常时不再 unhandled rejection 静默白屏
    try {
      setCharacter(await db.getCharacterById(characterId));
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '加载角色失败', text2: e?.message });
    } finally {
      setLoading(false);
    }
  }, [characterId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Screen>
      <Header title="角色详情" action={<Button label="返回" variant="ghost" onPress={onClose} />} />
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <LoadingState />
        ) : (
          <Card>
            <Text style={[styles.title, { color: theme.colors.textPrimary }]}>{character?.name || '未找到角色'}</Text>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{character?.data_json || '无角色数据'}</Text>
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
