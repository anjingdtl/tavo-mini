import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text } from 'react-native';
import { Button, Card, EmptyState, Field, Header, Screen, spacing } from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import type { Note } from '../types/novel';

export const NotesScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState('');

  const load = useCallback(async () => {
    if (!currentProject) return;
    setNotes(await db.getNotesByProject(currentProject.id));
  }, [currentProject]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!currentProject || !title.trim()) return;
    await db.createNote(currentProject.id, title.trim());
    setTitle('');
    await load();
  };

  return (
    <Screen>
      <Header title="笔记" subtitle={currentProject?.name || '请先选择项目'} />
      <Field value={title} onChangeText={setTitle} placeholder="新笔记标题" />
      <Button label="添加笔记" onPress={add} disabled={!title.trim()} />
      {notes.length === 0 ? (
        <EmptyState title="还没有笔记" />
      ) : (
        <FlatList
          data={notes}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Card>
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>{item.title || '无标题'}</Text>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{item.content || '空白笔记'}</Text>
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
