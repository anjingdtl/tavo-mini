import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Plus, Trash2 } from 'lucide-react-native';
import { Button, Card, EmptyState, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import type { Fragment, FragmentType } from '../types/novel';

const TYPE_OPTIONS: { value: FragmentType; label: string }[] = [
  { value: 'seed', label: '种子' },
  { value: 'user', label: '手写' },
  { value: 'guided', label: '引导' },
  { value: 'generated', label: 'AI' },
];

export const FreeformEditor: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [text, setText] = useState('');
  const [type, setType] = useState<FragmentType>('user');

  const loadFragments = useCallback(async () => {
    if (!currentProject) return;
    setFragments(await db.getFragmentsByProject(currentProject.id));
  }, [currentProject]);

  useEffect(() => {
    loadFragments();
  }, [loadFragments]);

  const addFragment = async () => {
    if (!currentProject || !text.trim()) return;
    await db.createFragment(currentProject.id, type, text.trim(), fragments.length);
    setText('');
    setType('user');
    setShowModal(false);
    await loadFragments();
  };

  const deleteFragment = (fragment: Fragment) => {
    Alert.alert('删除片段', '确定删除这个片段？', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => { await db.deleteFragment(fragment.id); await loadFragments(); } },
    ]);
  };

  if (!currentProject) {
    return (
      <Screen>
        <Header title="自由写作" subtitle="请先选择项目" />
        <EmptyState title="没有当前项目" description="进入项目页选择项目后，可以在这里组织片段。" />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title={currentProject.name} subtitle="自由片段工作流" action={<Button label="片段" icon={Plus} onPress={() => setShowModal(true)} />} />
      {fragments.length === 0 ? (
        <EmptyState title="还没有片段" description="添加种子文本、手写片段或 AI 生成片段，逐步拼出故事。" action={<Button label="添加片段" icon={Plus} onPress={() => setShowModal(true)} />} />
      ) : (
        <FlatList
          data={fragments}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Card>
              <View style={styles.fragmentHeader}>
                <Text style={[styles.type, { color: theme.colors.accent }]}>{TYPE_OPTIONS.find((option) => option.value === item.type)?.label || item.type}</Text>
                <Button label="删除" icon={Trash2} variant="ghost" onPress={() => deleteFragment(item)} />
              </View>
              <Text style={[styles.content, { color: theme.colors.textPrimary }]}>{item.content}</Text>
            </Card>
          )}
        />
      )}
      <Modal visible={showModal} transparent animationType="slide" onRequestClose={() => setShowModal(false)}>
        <Pressable style={styles.overlay} onPress={() => setShowModal(false)}>
          <Pressable style={[styles.modal, { backgroundColor: theme.colors.surface }]} onPress={(event) => event.stopPropagation()}>
            <Text style={[styles.modalTitle, { color: theme.colors.textPrimary }]}>添加片段</Text>
            <SegmentedControl value={type} options={TYPE_OPTIONS} onChange={setType} />
            <Field value={text} onChangeText={setText} placeholder="输入片段内容..." multiline inputStyle={styles.textArea} />
            <View style={styles.actions}>
              <Button label="取消" variant="ghost" onPress={() => setShowModal(false)} />
              <Button label="添加" onPress={addFragment} disabled={!text.trim()} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.lg, paddingBottom: 96 },
  fragmentHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  type: { fontSize: 12, fontWeight: '800' },
  content: { fontSize: 15, lineHeight: 23 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  modal: { borderTopLeftRadius: 8, borderTopRightRadius: 8, padding: spacing.lg, gap: spacing.md },
  modalTitle: { fontSize: 18, fontWeight: '800' },
  textArea: { minHeight: 140, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md },
});
