import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text } from 'react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Field, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import type { Preset } from '../types/novel';

interface Props {
  projectId: number;
}

export const PresetScreen: React.FC<Props> = ({ projectId }) => {
  const { theme } = useThemeStore();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [name, setName] = useState('');

  const load = useCallback(async () => {
    setPresets(await db.getPresetsByProject(projectId));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!name.trim()) return;
    // Phase9-BUG#9: 包裹 try-catch，失败时不 clear 名称输入，让用户能重试
    try {
      await db.createPreset(projectId, name.trim());
      setName('');
      await load();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  return (
    <Screen>
      <Header title="预设" />
      <Field value={name} onChangeText={setName} placeholder="预设名称" />
      <Button label="新建预设" onPress={add} disabled={!name.trim()} />
      {presets.length === 0 ? (
        <EmptyState title="还没有预设" />
      ) : (
        <FlatList
          data={presets}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Card>
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>{item.name}</Text>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>T={item.temperature} / P={item.top_p} / Max={item.max_tokens}</Text>
            </Card>
          )}
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.lg },
  title: { fontSize: 16, fontWeight: '800' },
  meta: { fontSize: 13, marginTop: 4 },
});
