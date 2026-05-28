import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import {
  BookMarked,
  FilePlus2,
  Import,
  NotebookPen,
  Pencil,
  SlidersHorizontal,
  Trash2,
  UserRound,
} from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import type { ResourceType } from '../services/database';
import {
  getCharacterImagePath,
  importSelectedCharacter,
  importSelectedNoteText,
  importSelectedWorldBook,
  pickCharacterPngImageReplacement,
  withCharacterImageAsset,
} from '../services/fileImport';

type ResourceTab = 'characters' | 'worldbook' | 'notes' | 'presets';

const TABS: { value: ResourceTab; label: string }[] = [
  { value: 'characters', label: '角色' },
  { value: 'worldbook', label: '世界书' },
  { value: 'notes', label: '笔记' },
  { value: 'presets', label: '预设' },
];

const RESOURCE_TYPE: Record<ResourceTab, ResourceType> = {
  characters: 'character',
  worldbook: 'worldbook',
  notes: 'note',
  presets: 'preset',
};

interface EditorState {
  item: any;
  name: string;
  content: string;
  secondary: string;
  comment: string;
  dataJson: string;
  imagePath: string;
  systemPrompt: string;
  writingStyle: string;
  extraInstructions: string;
  temperature: string;
  topP: string;
  maxTokens: string;
  enabled: boolean;
  isDefault: boolean;
}

export const ResourceLibrary: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [tab, setTab] = useState<ResourceTab>('characters');
  const [items, setItems] = useState<Record<ResourceTab, any[]>>({ characters: [], worldbook: [], notes: [], presets: [] });
  const [draft, setDraft] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const projectId = currentProject?.id || 0;

  const loadData = useCallback(async () => {
    const [characters, worldbook, notes, presets] = await Promise.all([
      db.getAllCharacters(projectId),
      db.getAllWorldbookEntries(projectId),
      db.getAllNotes(projectId),
      db.getAllPresets(projectId),
    ]);
    setItems({ characters, worldbook, notes, presets });
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const subtitle = currentProject ? `全局资料库 · 当前项目：${currentProject.name}` : '全局资料库 · 选择项目后可配置启用关系';

  const importCharacter = async () => {
    try {
      const id = await importSelectedCharacter(projectId);
      if (id) Toast.show({ type: 'success', text1: '角色卡已导入' });
      await loadData();
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '导入失败', text2: error.message });
    }
  };

  const importWorldbook = async () => {
    try {
      const result = await importSelectedWorldBook(projectId);
      if (result) Toast.show({ type: 'success', text1: '世界书已导入', text2: `${result.entriesImported || 0} 个条目` });
      await loadData();
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '导入失败', text2: error.message });
    }
  };

  const importNoteText = async () => {
    try {
      const id = await importSelectedNoteText(projectId);
      if (id) Toast.show({ type: 'success', text1: 'TXT 已导入为笔记' });
      await loadData();
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '导入失败', text2: error.message });
    }
  };

  const addManual = async () => {
    const value = draft.trim();
    if (!value) return;
    try {
      if (tab === 'worldbook') await db.createWorldbookEntry(projectId, value, '', 1);
      if (tab === 'notes') await db.createNote(projectId, value);
      if (tab === 'presets') await db.createPreset(projectId, value);
      setDraft('');
      await loadData();
    } catch (error: any) {
      Alert.alert('新增失败', error?.message || '资料写入失败。');
    }
  };

  const openEditor = (item: any) => {
    setEditor({
      item,
      name: titleFor(tab, item),
      content: tab === 'notes' ? item.content || '' : tab === 'worldbook' ? item.content || '' : '',
      secondary: item.keyword_secondary || '',
      comment: item.comment || '',
      dataJson: item.data_json || '{}',
      imagePath: getCharacterImagePath(item.data_json) || '',
      systemPrompt: item.system_prompt || '',
      writingStyle: item.writing_style || '',
      extraInstructions: item.extra_instructions || '',
      temperature: String(item.temperature ?? 0.8),
      topP: String(item.top_p ?? 0.9),
      maxTokens: String(item.max_tokens ?? 4000),
      enabled: item.enabled !== 0,
      isDefault: item.is_default === 1,
    });
  };

  const saveEditor = async () => {
    if (!editor) return;
    const item = editor.item;
    try {
      if (tab === 'characters') {
        const parsed = JSON.parse(editor.dataJson);
        const data = editor.imagePath ? withCharacterImageAsset(parsed, editor.imagePath) : parsed;
        await db.updateCharacter(item.id, editor.name.trim() || '未命名角色', JSON.stringify(data));
      }
      if (tab === 'worldbook') {
        await db.updateWorldbookEntry(item.id, {
          keyword_primary: editor.name.trim() || '未命名条目',
          keyword_secondary: editor.secondary,
          content: editor.content,
          comment: editor.comment,
          enabled: editor.enabled ? 1 : 0,
        });
      }
      if (tab === 'notes') {
        await db.updateNote(item.id, editor.name.trim() || '无标题笔记', editor.content);
      }
      if (tab === 'presets') {
        await db.updatePreset(item.id, {
          name: editor.name.trim() || '未命名预设',
          is_default: editor.isDefault ? 1 : 0,
          system_prompt: editor.systemPrompt,
          writing_style: editor.writingStyle,
          extra_instructions: editor.extraInstructions,
          temperature: Number(editor.temperature) || 0.8,
          top_p: Number(editor.topP) || 0.9,
          max_tokens: Number(editor.maxTokens) || 4000,
        });
      }
      setEditor(null);
      await loadData();
      Toast.show({ type: 'success', text1: '资料已保存' });
    } catch (error: any) {
      Alert.alert('保存失败', tab === 'characters' ? '角色卡 JSON 格式不正确。' : error?.message || '资料保存失败。');
    }
  };

  const replaceCharacterPng = async () => {
    if (!editor) return;
    try {
      const imagePath = await pickCharacterPngImageReplacement();
      if (imagePath) setEditor({ ...editor, imagePath });
    } catch (error: any) {
      Alert.alert('替换图片失败', error?.message || '请选择有效的 PNG 图片。');
    }
  };

  const toggleProjectUsage = async (item: any) => {
    if (!currentProject) {
      Alert.alert('未选择项目', '请先在项目页选择一个当前项目，再配置该项目使用哪些资料。');
      return;
    }
    await db.setProjectResourceEnabled(currentProject.id, RESOURCE_TYPE[tab], item.id, item.enabled_for_project !== 1);
    await loadData();
  };

  const remove = (id: number, title: string) => {
    Alert.alert('删除全局资料', `确定删除「${title}」？所有项目都将无法再使用它。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          if (tab === 'characters') await db.deleteCharacter(id);
          if (tab === 'worldbook') await db.deleteWorldbookEntry(id);
          if (tab === 'notes') await db.deleteNote(id);
          if (tab === 'presets') await db.deletePreset(id);
          await loadData();
        },
      },
    ]);
  };

  const activeItems = items[tab];
  const canAddManual = tab !== 'characters';
  const editorTitle = useMemo(() => (editor ? `编辑${tabLabel(tab)}` : ''), [editor, tab]);

  return (
    <Screen>
      <Header title="资料库" subtitle={subtitle} />
      <View style={styles.tabs}>
        <SegmentedControl value={tab} options={TABS} onChange={setTab} />
      </View>
      <View style={styles.actions}>
        {tab === 'characters' ? <Button label="导入角色卡" icon={Import} onPress={importCharacter} /> : null}
        {tab === 'worldbook' ? <Button label="导入世界书" icon={Import} onPress={importWorldbook} /> : null}
        {tab === 'notes' ? <Button label="导入 TXT 笔记" icon={Import} onPress={importNoteText} /> : null}
        {canAddManual ? (
          <>
            <Field value={draft} onChangeText={setDraft} placeholder={placeholderFor(tab)} inputStyle={styles.inlineInput} />
            <Button label="添加全局资料" icon={FilePlus2} onPress={addManual} disabled={!draft.trim()} />
          </>
        ) : null}
      </View>
      {activeItems.length === 0 ? (
        <EmptyState title={emptyTitle(tab)} description="使用上方按钮导入或创建全局资料。" />
      ) : (
        <FlatList
          data={activeItems}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Card>
              <View style={styles.row}>
                {iconFor(tab, theme.colors.accent)}
                <View style={styles.rowText}>
                  <Text style={[styles.itemTitle, { color: theme.colors.textPrimary }]}>{titleFor(tab, item)}</Text>
                  <Text style={[styles.itemMeta, { color: theme.colors.textSecondary }]} numberOfLines={2}>
                    {metaFor(tab, item)}
                  </Text>
                  <View style={styles.usageRow}>
                    <Text style={[styles.usageText, { color: theme.colors.textSecondary }]}>当前项目使用</Text>
                    <Switch
                      value={item.enabled_for_project === 1}
                      disabled={!currentProject}
                      onValueChange={() => toggleProjectUsage(item)}
                      trackColor={{ false: theme.colors.border, true: theme.colors.accentSoft }}
                      thumbColor={item.enabled_for_project === 1 ? theme.colors.accent : theme.colors.textMuted}
                    />
                  </View>
                </View>
              </View>
              <View style={styles.cardActions}>
                <Button label="编辑" icon={Pencil} variant="secondary" onPress={() => openEditor(item)} />
                <Button label="删除" icon={Trash2} variant="ghost" onPress={() => remove(item.id, titleFor(tab, item))} />
              </View>
            </Card>
          )}
        />
      )}

      <Modal visible={Boolean(editor)} transparent animationType="fade" onRequestClose={() => setEditor(null)}>
        <Pressable style={styles.overlay} onPress={() => setEditor(null)}>
          <Pressable style={[styles.modal, { backgroundColor: theme.colors.surface }]} onPress={(event) => event.stopPropagation()}>
            <Text style={[styles.modalTitle, { color: theme.colors.textPrimary }]}>{editorTitle}</Text>
            {editor ? (
              <ScrollView keyboardShouldPersistTaps="handled">
                <Field label="名称 / 标题 / 主关键词" value={editor.name} onChangeText={(name) => setEditor({ ...editor, name })} />
                {tab === 'characters' ? (
                  <>
                    {editor.imagePath ? (
                      <Image source={{ uri: `file://${editor.imagePath}` }} style={styles.characterImage} resizeMode="cover" />
                    ) : null}
                    <Button label={editor.imagePath ? '替换 PNG 图片' : '选择 PNG 图片'} icon={Import} variant="secondary" onPress={replaceCharacterPng} />
                    <Field
                      label="角色卡 JSON"
                      value={editor.dataJson}
                      onChangeText={(dataJson) => setEditor({ ...editor, dataJson })}
                      multiline
                      inputStyle={styles.largeInput}
                    />
                  </>
                ) : null}
                {tab === 'worldbook' ? (
                  <>
                    <Field label="次关键词" value={editor.secondary} onChangeText={(secondary) => setEditor({ ...editor, secondary })} />
                    <Field label="说明" value={editor.comment} onChangeText={(comment) => setEditor({ ...editor, comment })} />
                    <Field label="内容" value={editor.content} onChangeText={(content) => setEditor({ ...editor, content })} multiline inputStyle={styles.largeInput} />
                    <View style={styles.usageRow}>
                      <Text style={[styles.usageText, { color: theme.colors.textPrimary }]}>世界书条目可用</Text>
                      <Switch value={editor.enabled} onValueChange={(enabled) => setEditor({ ...editor, enabled })} />
                    </View>
                  </>
                ) : null}
                {tab === 'notes' ? (
                  <Field label="笔记内容" value={editor.content} onChangeText={(content) => setEditor({ ...editor, content })} multiline inputStyle={styles.largeInput} />
                ) : null}
                {tab === 'presets' ? (
                  <>
                    <Field label="系统提示词" value={editor.systemPrompt} onChangeText={(systemPrompt) => setEditor({ ...editor, systemPrompt })} multiline inputStyle={styles.largeInput} />
                    <Field label="写作风格" value={editor.writingStyle} onChangeText={(writingStyle) => setEditor({ ...editor, writingStyle })} multiline />
                    <Field label="额外约束" value={editor.extraInstructions} onChangeText={(extraInstructions) => setEditor({ ...editor, extraInstructions })} multiline />
                    <View style={styles.numberRow}>
                      <Field label="温度" value={editor.temperature} onChangeText={(temperature) => setEditor({ ...editor, temperature })} keyboardType="decimal-pad" inputStyle={styles.numberInput} />
                      <Field label="Top P" value={editor.topP} onChangeText={(topP) => setEditor({ ...editor, topP })} keyboardType="decimal-pad" inputStyle={styles.numberInput} />
                      <Field label="Max" value={editor.maxTokens} onChangeText={(maxTokens) => setEditor({ ...editor, maxTokens })} keyboardType="number-pad" inputStyle={styles.numberInput} />
                    </View>
                    <View style={styles.usageRow}>
                      <Text style={[styles.usageText, { color: theme.colors.textPrimary }]}>设为全局默认预设</Text>
                      <Switch value={editor.isDefault} onValueChange={(isDefault) => setEditor({ ...editor, isDefault })} />
                    </View>
                  </>
                ) : null}
              </ScrollView>
            ) : null}
            <View style={styles.modalActions}>
              <Button label="取消" variant="ghost" onPress={() => setEditor(null)} />
              <Button label="保存" onPress={saveEditor} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
};

function iconFor(tab: ResourceTab, color: string) {
  const props = { size: 20, color };
  if (tab === 'characters') return <UserRound {...props} />;
  if (tab === 'worldbook') return <BookMarked {...props} />;
  if (tab === 'notes') return <NotebookPen {...props} />;
  return <SlidersHorizontal {...props} />;
}

function tabLabel(tab: ResourceTab): string {
  if (tab === 'characters') return '角色卡';
  if (tab === 'worldbook') return '世界书';
  if (tab === 'notes') return '笔记';
  return '预设';
}

function placeholderFor(tab: ResourceTab): string {
  if (tab === 'worldbook') return '新世界书主关键词';
  if (tab === 'notes') return '新笔记标题';
  return '新预设名称';
}

function emptyTitle(tab: ResourceTab): string {
  if (tab === 'characters') return '还没有角色卡';
  if (tab === 'worldbook') return '还没有世界书条目';
  if (tab === 'notes') return '还没有笔记';
  return '还没有预设';
}

function titleFor(tab: ResourceTab, item: any): string {
  if (tab === 'characters') return item.name || '未命名角色';
  if (tab === 'worldbook') return item.keyword_primary || '未命名条目';
  return item.title || item.name || '未命名';
}

function metaFor(tab: ResourceTab, item: any): string {
  if (tab === 'characters') return item.source_type === 'png' ? 'PNG 角色卡' : 'JSON 角色卡';
  if (tab === 'worldbook') return `${item.enabled ? '资料可用' : '资料停用'} · ${item.content || '暂无内容'}`;
  if (tab === 'notes') return item.content || '空白笔记';
  return `${item.is_default ? '全局默认 · ' : ''}T=${item.temperature} / P=${item.top_p} / Max=${item.max_tokens}`;
}

const styles = StyleSheet.create({
  tabs: { padding: spacing.lg, paddingBottom: 0 },
  actions: { padding: spacing.lg, paddingBottom: 0, gap: spacing.sm },
  inlineInput: { minHeight: 40 },
  list: { padding: spacing.lg, paddingBottom: 96 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  rowText: { flex: 1 },
  itemTitle: { fontSize: 16, fontWeight: '800', marginBottom: 4 },
  itemMeta: { fontSize: 13, lineHeight: 18 },
  usageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, marginTop: spacing.sm },
  usageText: { fontSize: 13, fontWeight: '700' },
  cardActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: spacing.lg },
  modal: { maxHeight: '88%', borderRadius: 8, padding: spacing.lg },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: spacing.md },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md, marginTop: spacing.md },
  largeInput: { minHeight: 160, textAlignVertical: 'top' },
  characterImage: { width: 128, height: 180, borderRadius: 8, marginBottom: spacing.md, alignSelf: 'center' },
  numberRow: { flexDirection: 'row', gap: spacing.sm },
  numberInput: { minWidth: 80 },
});
