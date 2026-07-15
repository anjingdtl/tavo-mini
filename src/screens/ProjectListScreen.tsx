import React, { useEffect, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Download, Plus, Trash2, Upload, X } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import { exportShineWriterNovelJSON, exportToMarkdown, exportToText } from '../services/exportService';
import { pickAndPreviewProjectPackage, importProjectPackage } from '../services/projectImport';
import type { Project, ProjectMode } from '../types/novel';

export const ProjectListScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const { projects, currentProject, loadProjects, createProject, deleteProject, setCurrentProject } = useProjectStore();
  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState<ProjectMode>('outline');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportingId, setExportingId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredProjects = searchQuery.trim()
    ? projects.filter(p => p.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : projects;

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
      {
        text: '删除',
        style: 'destructive',
        // Phase9-BUG#18: 包裹 try-catch + Toast，删除失败时给用户反馈
        onPress: async () => {
          try {
            await deleteProject(project.id);
          } catch (e: any) {
            Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
          }
        },
      },
    ]);
  };

  const exportProject = async (project: Project, type: 'md' | 'txt' | 'json') => {
    // 防重复点击：同一项目导出进行中时拒绝再次触发
    if (exportingId === project.id) return;
    setExportingId(project.id);
    try {
      const path =
        type === 'md'
          ? await exportToMarkdown(project.id)
          : type === 'txt'
            ? await exportToText(project.id)
            : await exportShineWriterNovelJSON(project.id);
      Alert.alert('导出成功', path);
    } catch (error: any) {
      Alert.alert('导出失败', error.message);
    } finally {
      setExportingId(null);
    }
  };

  const showExportOptions = (project: Project) => {
    Alert.alert('导出项目', `选择「${project.name}」的导出格式：`, [
      { text: '取消', style: 'cancel' },
      { text: 'Markdown', onPress: () => exportProject(project, 'md') },
      { text: 'TXT', onPress: () => exportProject(project, 'txt') },
      { text: '项目 JSON', onPress: () => exportProject(project, 'json') },
    ]);
  };

  const handleImport = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const result = await pickAndPreviewProjectPackage();
      if (!result) return;
      const { preview, pkg } = result;
      Alert.alert(
        '导入项目',
        `项目名：${preview.name}\n模式：${preview.mode === 'outline' ? '大纲' : '自由写作'}\n章节：${preview.chapterCount}\n资料：${preview.resourceCount}\n\n将作为新项目导入。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '导入',
            onPress: async () => {
              try {
                const newId = await importProjectPackage(pkg);
                await loadProjects();
                const newProject = useProjectStore.getState().projects.find(p => p.id === newId);
                if (newProject) setCurrentProject(newProject);
                Alert.alert('导入成功', `项目「${preview.name}」已导入。`);
              } catch (error: any) {
                Alert.alert('导入失败', error?.message || '未知错误');
              }
            },
          },
        ],
      );
    } catch (error: any) {
      Alert.alert('导入失败', error?.message || '无法读取项目文件。');
    } finally {
      setImporting(false);
    }
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
            <TouchableOpacity accessibilityLabel="导出项目" onPress={() => showExportOptions(item)} style={styles.iconButton}>
              <Download size={18} color={theme.colors.accent} />
            </TouchableOpacity>
            <TouchableOpacity accessibilityLabel="删除项目" onPress={() => confirmDelete(item)} style={styles.iconButton}>
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
      <Header title="小说项目" subtitle="选择一个项目后进入写作、资料和导出流程" action={
        <View style={styles.headerActions}>
          <Button label="导入" icon={Upload} variant="ghost" onPress={handleImport} disabled={importing} compact />
          <Button label="新建" icon={Plus} onPress={() => setShowNewModal(true)} compact />
        </View>
      } />
      {projects.length === 0 ? (
        <EmptyState title="还没有小说项目" description="新建一个项目后，可以创建章节、整理资料并调用 AI 续写。" action={<Button label="新建项目" icon={Plus} onPress={() => setShowNewModal(true)} />} />
      ) : (
        <>
          <View style={styles.searchBar}>
            <View style={styles.searchInputWrap}>
              <Field
                placeholder="搜索项目..."
                value={searchQuery}
                onChangeText={setSearchQuery}
                inputStyle={styles.searchInput}
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="清空搜索"
                  onPress={() => setSearchQuery('')}
                  style={styles.searchClearButton}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <X size={16} color={theme.colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          </View>
          {filteredProjects.length === 0 ? (
            <EmptyState title="无匹配项目" description="没有找到匹配的项目，试试其他关键词。" />
          ) : (
            <FlatList data={filteredProjects} keyExtractor={(item) => String(item.id)} renderItem={renderProject} contentContainerStyle={styles.list} />
          )}
        </>
      )}

      <Modal visible={showNewModal} transparent animationType="fade" onRequestClose={() => setShowNewModal(false)}>
        <Pressable style={styles.overlay} onPress={() => setShowNewModal(false)}>
          <Pressable style={[styles.modal, { backgroundColor: theme.colors.surface }]} onPress={(event) => event.stopPropagation()}>
            <Text style={[styles.modalTitle, { color: theme.colors.textPrimary }]}>新建小说项目</Text>
            <Field
              testID="new-project-name"
              label="项目名称"
              value={newName}
              onChangeText={setNewName}
              placeholder="例如：雨城纪事"
              autoFocus
            />
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
  searchBar: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  searchInputWrap: { position: 'relative', justifyContent: 'center' },
  searchInput: { paddingRight: 36 },
  searchClearButton: {
    position: 'absolute',
    right: spacing.sm,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  cardText: { flex: 1 },
  projectName: { fontSize: 17, fontWeight: '700', marginBottom: 4 },
  meta: { fontSize: 12 },
  activeText: { marginTop: spacing.sm, fontSize: 12, fontWeight: '700' },
  iconButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: spacing.xl },
  modal: { borderRadius: 8, padding: spacing.lg },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: spacing.md },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md, marginTop: spacing.lg },
  activeCard: { borderLeftWidth: 4 },
  headerActions: { flexDirection: 'row', gap: spacing.xs },
});
