import React, { useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Download,
  History,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Header,
  Screen,
  SegmentedControl,
  spacing,
} from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import {
  exportShineWriterNovelJSON,
  exportToMarkdown,
  exportToText,
} from '../services/exportService';
import {
  pickAndPreviewProjectPackage,
  importProjectPackage,
} from '../services/projectImport';
import {
  pickAndPreviewTxtProject,
  importTxtProject,
  buildTxtPreview,
  smartSplitTxtChaptersWithLLM,
  type TxtImportPackage,
} from '../services/projectTxtImport';
import {
  NEW_PROJECT_MODE_OPTIONS,
  PROJECT_MODE_LABELS,
  isValidProjectMode,
} from '../services/continuation/projectMode';
import {
  createRecoveryProject,
  diagnoseChapterRecovery,
} from '../services/continuation/continuationChapterRecoveryService';
import type { Project, ProjectMode } from '../types/novel';

export const ProjectListScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const {
    projects,
    currentProject,
    loadProjects,
    createProject,
    deleteProject,
    setCurrentProject,
    workspaceMode,
    selectWorkspaceMode,
  } = useProjectStore();
  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState<ProjectMode>('outline');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportingId, setExportingId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [modeFilter, setModeFilter] = useState<'outline' | 'continuation'>(
    workspaceMode,
  );

  const filteredProjects = projects.filter(
    project =>
      project.mode === modeFilter &&
      (!searchQuery.trim() ||
        project.name.toLowerCase().includes(searchQuery.trim().toLowerCase())),
  );

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    setModeFilter(workspaceMode);
  }, [workspaceMode]);

  const selectMode = (mode: 'outline' | 'continuation') => {
    setModeFilter(mode);
    selectWorkspaceMode(mode).catch(error => {
      Toast.show({
        type: 'error',
        text1: '切换项目模式失败',
        text2: error?.message,
      });
    });
    // The workspace mode changes immediately, including when this mode has no
    // project, so the bottom navigation no longer waits for a card tap.
  };

  const openNewProjectModal = (mode: ProjectMode = modeFilter) => {
    // Header / empty-state 新建必须跟随当前作品库模式，避免在「原著续写」
    // 页签下点右上角新建却落到大纲创作。
    setNewMode(mode === 'continuation' ? 'continuation' : 'outline');
    setNewName('');
    setShowNewModal(true);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await createProject(name, newMode);
      setNewName('');
      // Keep the library tab and next-create default on the mode just used.
      setModeFilter(newMode === 'continuation' ? 'continuation' : 'outline');
      setNewMode(newMode === 'continuation' ? 'continuation' : 'outline');
      setShowNewModal(false);
    } catch (error: any) {
      Alert.alert(
        '创建项目失败',
        error?.message || '数据库写入失败，请重启应用后再试。',
      );
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

  /**
   * Accident recovery: never splice into the live timeline. Creates a separate
   * 「…（找回）」continuation project from revisions/artifacts, leaving the
   * source project (e.g. the post-accident 10+ chapters) untouched.
   */
  const handleRecoverChapters = async (project: Project) => {
    if (project.mode !== 'continuation') {
      Alert.alert('无法找回', '找回章节仅支持原著续写项目。');
      return;
    }
    try {
      const diagnosis = await diagnoseChapterRecovery(project.id);
      if (diagnosis.recoverableCount === 0) {
        Alert.alert(
          '没有可找回的正文',
          `当前项目「${project.name}」在修订记录/生成产物里没有找到足够长的章节正文。\n\n请优先到「设置 → 备份中心」用事故前备份，或导入曾导出的项目 JSON / Markdown 作为新项目。\n\n现有 ${diagnosis.liveChapterCount} 篇续写章节不会被改动。`,
        );
        return;
      }

      const runCreate = async (orphansAndArtifactsOnly: boolean) => {
        try {
          const result = await createRecoveryProject({
            sourceProjectId: project.id,
            orphansAndArtifactsOnly,
          });
          await loadProjects();
          const created = useProjectStore
            .getState()
            .projects.find(p => p.id === result.projectId);
          if (created) await setCurrentProject(created);
          Alert.alert(
            '找回项目已创建',
            [
              `项目：「${result.name}」`,
              `写入 ${result.chapterCount} 篇找回章节`,
              `来源：孤儿修订 ${result.sources.orphan} / 其它修订 ${result.sources.revision} / 生成物 ${result.sources.artifact}`,
              '',
              '源项目未改动。旧线只在找回项目查看/导出；新线继续在原项目写，两线不要硬拼 position。',
            ].join('\n'),
          );
        } catch (e: any) {
          Alert.alert('找回失败', e?.message || '未知错误');
        }
      };

      const buttons: Array<{
        text: string;
        style?: 'cancel' | 'destructive' | 'default';
        onPress?: () => void;
      }> = [{ text: '取消', style: 'cancel' }];

      if (diagnosis.orphanRevisionTargets > 0 || diagnosis.artifactBodies > 0) {
        buttons.push({
          text: '只找回已删除章（推荐）',
          onPress: () => {
            runCreate(true).catch(() => {});
          },
        });
      }
      // Secondary: full revision archive when user has no orphans but still has history
      buttons.push({
        text:
          diagnosis.orphanRevisionTargets > 0
            ? '含全部修订快照'
            : '从全部修订创建找回项目',
        onPress: () => {
          runCreate(false).catch(() => {});
        },
      });

      Alert.alert(
        '找回旧章节到新项目',
        [
          `源项目：「${project.name}」`,
          `当前仍在的续写章：${diagnosis.liveChapterCount} 篇（有正文 ${diagnosis.liveChaptersWithContent} 篇）—— 一律不动。`,
          `扫描到可找回正文：约 ${diagnosis.recoverableCount} 篇`,
          `  · 已删除章节的修订（孤儿）：${diagnosis.orphanRevisionTargets}`,
          `  · 仍存在章节的修订快照：${Math.max(0, diagnosis.revisionTargets - diagnosis.orphanRevisionTargets)}`,
          `  · AI 生成产物：${diagnosis.artifactBodies}`,
          '',
          '推荐「只找回已删除章」：新建「…（找回）」项目，与你事故后另写的十多章彻底分离。',
          '若孤儿为 0，说明旧章修订可能已被清理——请改用备份中心或导出包。',
        ].join('\n'),
        buttons,
      );
    } catch (e: any) {
      Alert.alert('诊断失败', e?.message || '无法扫描可找回章节。');
    }
  };

  const exportProject = async (
    project: Project,
    type: 'md' | 'txt' | 'json',
  ) => {
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

  const handleImport = () => {
    if (importing) return;
    Alert.alert('导入', '选择要导入的文件类型：', [
      { text: '取消', style: 'cancel' },
      { text: 'JSON 项目包', onPress: () => handleImportJson() },
      { text: 'TXT 小说', onPress: () => handleImportTxt() },
    ]);
  };

  const handleImportJson = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const result = await pickAndPreviewProjectPackage();
      if (!result) return;
      const { preview, pkg } = result;
      Alert.alert(
        '导入项目',
        `项目名：${preview.name}\n模式：${
          isValidProjectMode(preview.mode)
            ? PROJECT_MODE_LABELS[preview.mode]
            : preview.mode
        }\n章节：${preview.chapterCount}\n资料：${
          preview.resourceCount
        }\n\n将作为新项目导入。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '导入',
            onPress: async () => {
              try {
                const newId = await importProjectPackage(pkg);
                await loadProjects();
                const newProject = useProjectStore
                  .getState()
                  .projects.find(p => p.id === newId);
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

  const showTxtImportConfirm = (input: {
    preview: ReturnType<typeof buildTxtPreview>;
    pkg: TxtImportPackage;
    rawText: string;
  }) => {
    const { preview, pkg, rawText } = input;
    const sampleLine =
      preview.sampleTitles.length > 0
        ? `章节样例：${preview.sampleTitles.join('、')}\n`
        : '';
    const warningLine =
      preview.warnings.length > 0 ? `\n${preview.warnings.join('\n')}` : '';
    Alert.alert(
      '导入 TXT 小说',
      `项目名：${preview.name}\n编码：${preview.encoding}\n章节：${
        preview.chapterCount
      }\n${sampleLine}\n将导入为「大纲创作」项目，章节可继续编辑。${warningLine}`,
      [
        { text: '取消', style: 'cancel' },
        ...(preview.needsSmartSplit
          ? [
              {
                text: '智能分章（LLM）',
                onPress: async () => {
                  setImporting(true);
                  try {
                    const chapters = await smartSplitTxtChaptersWithLLM(rawText);
                    const nextPkg: TxtImportPackage = {
                      ...pkg,
                      chapters,
                      splitMode: 'llm',
                      warnings: [],
                    };
                    showTxtImportConfirm({
                      preview: buildTxtPreview(nextPkg),
                      pkg: nextPkg,
                      rawText,
                    });
                  } catch (error: any) {
                    Alert.alert(
                      '智能分章失败',
                      error?.message || '请检查 LLM 配置后重试。',
                    );
                  } finally {
                    setImporting(false);
                  }
                },
              },
            ]
          : []),
        {
          text: '导入',
          onPress: async () => {
            setImporting(true);
            try {
              const newId = await importTxtProject(pkg);
              await loadProjects();
              const newProject = useProjectStore
                .getState()
                .projects.find(p => p.id === newId);
              if (newProject) setCurrentProject(newProject);
              Toast.show({
                type: 'success',
                text1: '导入成功',
                text2: `项目「${pkg.name}」已导入 ${pkg.chapters.length} 章。`,
              });
            } catch (error: any) {
              Alert.alert('导入失败', error?.message || '未知错误');
            } finally {
              setImporting(false);
            }
          },
        },
      ],
    );
  };

  const handleImportTxt = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const result = await pickAndPreviewTxtProject();
      if (!result) return;
      showTxtImportConfirm(result);
    } catch (error: any) {
      Alert.alert('导入失败', error?.message || '无法读取 TXT 文件。');
    } finally {
      setImporting(false);
    }
  };

  const renderProject = ({ item }: { item: Project }) => {
    const active = currentProject?.id === item.id;
    return (
      <TouchableOpacity
        onPress={() => setCurrentProject(item)}
        activeOpacity={0.75}
      >
        <Card
          style={
            active
              ? [styles.activeCard, { borderColor: theme.colors.accent }]
              : undefined
          }
        >
          <View style={styles.cardHeader}>
            <View style={styles.cardText}>
              <Text
                style={[
                  styles.projectName,
                  { color: theme.colors.textPrimary },
                ]}
              >
                {item.name}
              </Text>
              <Text
                style={[styles.meta, { color: theme.colors.textSecondary }]}
              >
                {PROJECT_MODE_LABELS[item.mode] ?? item.mode} · 更新于{' '}
                {new Date(item.updated_at).toLocaleDateString('zh-CN')}
              </Text>
            </View>
            {item.mode === 'continuation' ? (
              <TouchableOpacity
                accessibilityLabel="找回旧章节到新项目"
                onPress={() => handleRecoverChapters(item)}
                style={styles.iconButton}
              >
                <History size={18} color={theme.colors.accent} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              accessibilityLabel="导出项目"
              onPress={() => showExportOptions(item)}
              style={styles.iconButton}
            >
              <Download size={18} color={theme.colors.accent} />
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityLabel="删除项目"
              onPress={() => confirmDelete(item)}
              style={styles.iconButton}
            >
              <Trash2 size={18} color={theme.colors.danger} />
            </TouchableOpacity>
          </View>
          {active ? (
            <Text style={[styles.activeText, { color: theme.colors.accent }]}>
              当前工作项目
            </Text>
          ) : null}
        </Card>
      </TouchableOpacity>
    );
  };

  return (
    <Screen>
      <Header
        testID="project-library"
        title="作品库"
        subtitle={
          modeFilter === 'continuation'
            ? '原著接入、Canon 与续写工作流'
            : '从大纲、章节和自有资料开始创作'
        }
        action={
          <View style={styles.headerActions}>
            <Button
              label="导入"
              icon={Upload}
              variant="ghost"
              onPress={handleImport}
              disabled={importing}
              compact
            />
            <Button
              label="新建"
              icon={Plus}
              onPress={() => openNewProjectModal(modeFilter)}
              compact
              testID="new-project-button"
            />
          </View>
        }
      />
      <View style={styles.modeTabs}>
        <SegmentedControl
          value={modeFilter}
          onChange={value => selectMode(value as 'outline' | 'continuation')}
          size="prominent"
          testIDPrefix="project-mode"
          options={[
            {
              value: 'outline',
              label: `大纲创作（${
                projects.filter(p => p.mode === 'outline').length
              }）`,
              testID: 'project-mode-outline',
              accessibilityLabel: '大纲创作',
            },
            {
              value: 'continuation',
              label: `原著续写（${
                projects.filter(p => p.mode === 'continuation').length
              }）`,
              testID: 'project-mode-continuation',
              accessibilityLabel: '原著续写',
            },
          ]}
        />
      </View>
      {filteredProjects.length === 0 && !searchQuery.trim() ? (
        <EmptyState
          title={
            modeFilter === 'continuation'
              ? '还没有原著续写项目'
              : '还没有大纲创作作品'
          }
          description={
            modeFilter === 'continuation'
              ? '创建后先导入原著、设置边界并完成 Canon 分析。'
              : '创建后即可编写章节、整理资料并调用 AI 流水线。'
          }
          action={
            <Button
              label={
                modeFilter === 'continuation'
                  ? '新建原著续写项目'
                  : '新建大纲作品'
              }
              icon={Plus}
              onPress={() => openNewProjectModal(modeFilter)}
            />
          }
        />
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
            <EmptyState
              title="无匹配项目"
              description="没有找到匹配的项目，试试其他关键词。"
            />
          ) : (
            <FlatList
              data={filteredProjects}
              keyExtractor={item => String(item.id)}
              renderItem={renderProject}
              contentContainerStyle={styles.list}
            />
          )}
        </>
      )}

      <Modal
        visible={showNewModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowNewModal(false)}
      >
        <Pressable
          style={styles.overlay}
          onPress={() => setShowNewModal(false)}
        >
          <Pressable
            style={[styles.modal, { backgroundColor: theme.colors.surface }]}
            onPress={event => event.stopPropagation()}
          >
            <Text
              style={[styles.modalTitle, { color: theme.colors.textPrimary }]}
            >
              新建{newMode === 'continuation' ? '原著续写项目' : '大纲作品'}
            </Text>
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
              options={NEW_PROJECT_MODE_OPTIONS.map(o => ({ ...o }))}
            />
            <View style={styles.modalActions}>
              <Button
                label="取消"
                variant="ghost"
                onPress={() => setShowNewModal(false)}
              />
              <Button
                testID="create-project-button"
                label={creating ? '创建中...' : '创建'}
                onPress={handleCreate}
                disabled={!newName.trim() || creating}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.lg, paddingBottom: 96 },
  modeTabs: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
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
  projectName: {
    fontSize: 19,
    fontFamily: 'serif',
    fontWeight: '700',
    marginBottom: 5,
  },
  meta: { fontSize: 12, lineHeight: 18 },
  activeText: {
    marginTop: spacing.sm,
    fontSize: 12,
    fontFamily: 'serif',
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  modal: { borderRadius: 10, padding: spacing.lg },
  modalTitle: {
    fontSize: 20,
    fontFamily: 'serif',
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  activeCard: { borderLeftWidth: 4 },
  headerActions: { flexDirection: 'row', gap: spacing.xs },
});
