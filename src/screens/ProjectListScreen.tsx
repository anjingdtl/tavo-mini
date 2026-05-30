import React, { useEffect, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Plus, Trash2 } from 'lucide-react-native';
import { Button, Card, EmptyState, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import type { Project, ProjectMode } from '../types/novel';

export const ProjectListScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const { projects, currentProject, loadProjects, createProject, deleteProject, setCurrentProject } = useProjectStore();
  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState<ProjectMode>('outline');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await createProject(name, newMode);
      setNewName('');
      setNewMode('outline');
      setShowNewModal(false);
    } catch (error: any) {
      Alert.alert('创建项目失败', error?.message || '数据库写入失败，请重启应用后再试。');
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = (project: Project) => {
    Alert.alert('删除项目', `确定删除「${project.name}」？此操作不可撤销。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => deleteProject(project.id) },
    ]);
  };

  const renderProject = ({ item }: { item: Project }) => {
    const active = currentProject?.id === item.id;
    return (
      <TouchableOpacity onPress={() => setCurrentProject(item)} activeOpacity={0.75}>
        <Card style={active ? [styles.activeCard, { borderColor: theme.colors.accent }] : undefined}>
          <View style={styles.cardHeader}>
            <View style={styles.cardText}>
              <Text style={[styles.projectName, { color: theme.colors.textPrimary }]}>{item.name}</Text>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
                {item.mode === 'outline' ? '大纲模式' : '自由写作'} · 更新于 {new Date(item.updated_at).toLocaleDateString('zh-CN')}
              </Text>
            </View>
            <TouchableOpacity accessibilityLabel="删除项目" onPress={() => confirmDelete(item)} style={styles.deleteButton}>
              <Trash2 size={18} color={theme.colors.danger} />
            </TouchableOpacity>
          </View>
          {active ? <Text style={[styles.activeText, { color: theme.colors.accent }]}>当前工作项目</Text> : null}
        </Card>
      </TouchableOpacity>
    );
  };

  return (
    <Screen>
      <Header title="小说项目" subtitle="选择一个项目后进入写作、资料和导出流程" action={<Button label="新建" icon={Plus} onPress={() => setShowNewModal(true)} />} />
      {projects.length === 0 ? (
        <EmptyState title="还没有小说项目" description="新建一个项目后，可以创建章节、整理资料并调用 AI 续写。" action={<Button label="新建项目" icon={Plus} onPress={() => setShowNewModal(true)} />} />
      ) : (
        <FlatList data={projects} keyExtractor={(item) => String(item.id)} renderItem={renderProject} contentContainerStyle={styles.list} />
      )}

      <Modal visible={showNewModal} transparent animationType="fade" onRequestClose={() => setShowNewModal(false)}>
        <Pressable style={styles.overlay} onPress={() => setShowNewModal(false)}>
          <Pressable style={[styles.modal, { backgroundColor: theme.colors.surface }]} onPress={(event) => event.stopPropagation()}>
            <Text style={[styles.modalTitle, { color: theme.colors.textPrimary }]}>新建小说项目</Text>
            <Field label="项目名称" value={newName} onChangeText={setNewName} placeholder="例如：雨城纪事" autoFocus />
            <SegmentedControl
              value={newMode}
              onChange={setNewMode}
              options={[
                { value: 'outline', label: '大纲模式' },
                { value: 'freeform', label: '自由写作' },
              ]}
            />
            <View style={styles.modalActions}>
              <Button label="取消" variant="ghost" onPress={() => setShowNewModal(false)} />
              <Button label={creating ? '创建中...' : '创建'} onPress={handleCreate} disabled={!newName.trim() || creating} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.lg, paddingBottom: 96 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  cardText: { flex: 1 },
  projectName: { fontSize: 17, fontWeight: '700', marginBottom: 4 },
  meta: { fontSize: 12 },
  activeText: { marginTop: spacing.sm, fontSize: 12, fontWeight: '700' },
  deleteButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: spacing.xl },
  modal: { borderRadius: 8, padding: spacing.lg },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: spacing.md },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md, marginTop: spacing.lg },
  activeCard: { borderLeftWidth: 4 },
});
