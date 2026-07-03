import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { BookMarked, Download, FilePlus2, Import, NotebookPen, Pencil, RefreshCw, SlidersHorizontal, Trash2, UserRound } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { useFocusEffect } from '@react-navigation/native';
import { Button, Card, EmptyState, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { CharacterEditor } from '../components/CharacterEditor';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import type { ResourceType } from '../services/database';
import { estimateTokens } from '../utils/tokenEstimator';
import { DEFAULT_STYLE_WEIGHTS, type StyleWeights, analyzeNotesStyle } from '../services/styleAnalyzer';
import {
  getCharacterImagePath,
  importCharacters,
  importNotes,
  importSelectedCharacter,
  importSelectedNoteText,
  importSelectedWorldBook,
  importWorldBooks,
  pickCharacterPngImageReplacement,
  pickLocalFiles,
  withCharacterImageAsset,
} from '../services/fileImport';
import { BatchImportResultModal } from '../components/BatchImportResultModal';
import * as exportService from '../services/exportService';

type ResourceTab = 'characters' | 'worldbook' | 'notes' | 'presets';
type EditorKind = ResourceTab | 'worldbookCollection';

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
  kind: EditorKind;
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
  constant: boolean;
}

export const ResourceLibrary: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [tab, setTab] = useState<ResourceTab>('characters');
  const [items, setItems] = useState<Record<ResourceTab, any[]>>({ characters: [], worldbook: [], notes: [], presets: [] });
  const [collections, setCollections] = useState<any[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [noteMode, setNoteMode] = useState<'none' | 'style' | 'retrieval'>('none');
  const [styleWeights, setStyleWeights] = useState<StyleWeights>(DEFAULT_STYLE_WEIGHTS);
  const [retrievalTopK, setRetrievalTopK] = useState(5);
  const [enabledNoteIds, setEnabledNoteIds] = useState<number[]>([]);
  const [showNotePicker, setShowNotePicker] = useState(false);
  const [showStyleProfile, setShowStyleProfile] = useState(false);
  const [batchResult, setBatchResult] = useState<
    | {
        title: string;
        success: Array<{ fileName: string; id: any }>;
        failed: Array<{ fileName: string; error: string }>;
      }
    | null
  >(null);
  const [styleProfileText, setStyleProfileText] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const projectId = currentProject?.id || 0;

  const loadData = useCallback(async () => {
    const [characters, worldbook, notes, presets, worldbookCollections, noteConfig] = await Promise.all([
      db.getAllCharacters(projectId),
      db.getAllWorldbookEntries(projectId),
      db.getAllNotes(projectId),
      db.getAllPresets(projectId),
      db.getWorldbookCollections(projectId),
      db.getProjectNoteConfig(projectId),
    ]);
    setItems({ characters, worldbook, notes, presets });
    setCollections(worldbookCollections);
    if (noteConfig) {
      // 防御性归一化：DB 异常返回 null/undefined 时回退默认，避免渲染时 .length 报错
      setNoteMode(noteConfig.mode || 'none');
      setStyleWeights({ ...DEFAULT_STYLE_WEIGHTS, ...(noteConfig.styleWeights || {}) });
      setRetrievalTopK(typeof noteConfig.retrievalTopK === 'number' ? noteConfig.retrievalTopK : 5);
      setEnabledNoteIds(Array.isArray(noteConfig.enabledNoteIds) ? noteConfig.enabledNoteIds : []);
    } else {
      setNoteMode('none');
      setStyleWeights(DEFAULT_STYLE_WEIGHTS);
      setRetrievalTopK(5);
      setEnabledNoteIds([]);
    }
    if (selectedCollectionId && !worldbookCollections.some((collection: any) => collection.id === selectedCollectionId)) {
      setSelectedCollectionId(null);
    }
  }, [projectId, selectedCollectionId]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData]),
  );

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

  const addNewCharacter = async () => {
    try {
      const id = await db.createCharacter(projectId, '未命名角色', 'json', '{}');
      await loadData();
      const newItem = await db.getCharacterById(id);
      if (newItem) openEditor('characters', newItem);
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '新建失败', text2: error.message });
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

  const addNewWorldbook = async () => {
    try {
      const id = await db.createWorldbookCollection(projectId, '未命名世界书', { enabled: 1 });
      await loadData();
      const refreshedCollections = await db.getWorldbookCollections(projectId);
      const newItem = refreshedCollections.find((c: any) => c.id === id);
      if (newItem) openEditor('worldbookCollection', newItem);
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '新建失败', text2: error.message });
    }
  };

  const addNewWorldbookEntry = async () => {
    if (!selectedCollectionId) return;
    try {
      const id = await db.createWorldbookEntry(projectId, '', '', 1, { collection_id: selectedCollectionId });
      await loadData();
      const entries = await db.getWorldbookEntriesByCollection(selectedCollectionId);
      const newItem = entries.find((e: any) => e.id === id);
      if (newItem) openEditor('worldbook', newItem);
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '新建失败', text2: error.message });
    }
  };

  const importNoteText = async () => {
    try {
      const result = await importSelectedNoteText(projectId);
      if (result) Toast.show({ type: 'success', text1: 'TXT 已导入为笔记', text2: `${result.createdCount} 条笔记` });
      await loadData();
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '导入失败', text2: error.message });
    }
  };

  const importCharactersBatch = async () => {
    const files = await pickLocalFiles([types.json, types.images], 50);
    if (!files) return;
    try {
      const result = await importCharacters(projectId, files);
      if (result.total === 0) return;
      Toast.show({
        type: result.failed.length === 0 ? 'success' : 'info',
        text1: `角色卡批量导入：${result.success.length} 成功 / ${result.failed.length} 失败`,
      });
      if (result.failed.length > 0) {
        setBatchResult({ title: '批量导入角色卡', success: result.success, failed: result.failed });
      }
      await loadData();
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '批量导入失败', text2: error.message });
    }
  };

  const importWorldbooksBatch = async () => {
    const files = await pickLocalFiles([types.json], 50);
    if (!files) return;
    try {
      const result = await importWorldBooks(projectId, files);
      if (result.total === 0) return;
      Toast.show({
        type: result.failed.length === 0 ? 'success' : 'info',
        text1: `世界书批量导入：${result.success.length} 成功 / ${result.failed.length} 失败`,
      });
      if (result.failed.length > 0) {
        setBatchResult({ title: '批量导入世界书', success: result.success, failed: result.failed });
      }
      await loadData();
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '批量导入失败', text2: error.message });
    }
  };

  const importNotesBatch = async () => {
    const files = await pickLocalFiles([types.plainText, types.allFiles], 50);
    if (!files) return;
    try {
      const result = await importNotes(projectId, files);
      if (result.total === 0) return;
      Toast.show({
        type: result.failed.length === 0 ? 'success' : 'info',
        text1: `TXT 笔记批量导入：${result.success.length} 成功 / ${result.failed.length} 失败`,
      });
      if (result.failed.length > 0) {
        setBatchResult({ title: '批量导入 TXT 笔记', success: result.success, failed: result.failed });
      }
      await loadData();
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '批量导入失败', text2: error.message });
    }
  };

  const handleNoteModeChange = async (mode: 'none' | 'style' | 'retrieval') => {
    setNoteMode(mode);
    try {
      await db.setProjectNoteConfig(projectId, { mode, styleWeights, retrievalTopK, enabledNoteIds });
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '保存失败', text2: error.message });
    }
  };

  const handleWeightChange = async (key: keyof StyleWeights, value: number) => {
    const newWeights = { ...styleWeights, [key]: value };
    setStyleWeights(newWeights);
    try {
      // 用当前 noteMode 而非写死 'style'，避免在 retrieval 模式下被误调时覆盖
      await db.setProjectNoteConfig(projectId, { mode: noteMode, styleWeights: newWeights, retrievalTopK, enabledNoteIds });
    } catch {
      // 静默失败，不打断用户调整
    }
  };

  const handleTopKChange = async (value: number) => {
    setRetrievalTopK(value);
    try {
      // 用当前 noteMode 而非写死 'retrieval'
      await db.setProjectNoteConfig(projectId, { mode: noteMode, styleWeights, retrievalTopK: value, enabledNoteIds });
    } catch {
      // 静默失败
    }
  };

  const handleToggleNoteId = async (noteId: number) => {
    const newIds = enabledNoteIds.includes(noteId)
      ? enabledNoteIds.filter((id) => id !== noteId)
      : [...enabledNoteIds, noteId];
    setEnabledNoteIds(newIds);
    try {
      await db.setProjectNoteConfig(projectId, { mode: noteMode, styleWeights, retrievalTopK, enabledNoteIds: newIds });
    } catch {
      // 静默失败
    }
  };

  const handleReanalyze = async () => {
    setAnalyzing(true);
    try {
      const ids = enabledNoteIds.length > 0 ? enabledNoteIds : items.notes.map((n: any) => n.id);
      if (ids.length === 0) {
        Toast.show({ type: 'info', text1: '没有可分析的笔记' });
        return;
      }
      await analyzeNotesStyle(ids);
      Toast.show({ type: 'success', text1: '风格分析完成' });
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '风格分析失败', text2: error.message });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleViewProfile = async () => {
    if (items.notes.length === 0) return;
    const id = enabledNoteIds[0] || items.notes[0].id;
    try {
      const profile = await db.getNoteStyleProfile(id);
      setStyleProfileText(profile?.profileText || '暂无风格画像');
      setShowStyleProfile(true);
    } catch {
      setStyleProfileText('读取画像失败');
      setShowStyleProfile(true);
    }
  };

  const addManual = async () => {
    const value = draft.trim();
    if (!value) return;
    try {
      if (tab === 'worldbook') {
        if (selectedCollectionId) {
          await db.createWorldbookEntry(projectId, value, '', 1, { collection_id: selectedCollectionId });
        } else {
          await db.createWorldbookCollection(projectId, value, { enabled: 1 });
        }
      }
      if (tab === 'notes') await db.createNote(projectId, value);
      if (tab === 'presets') await db.createPreset(projectId, value);
      setDraft('');
      await loadData();
    } catch (error: any) {
      Alert.alert('新增失败', error?.message || '资料写入失败。');
    }
  };

  const openEditor = async (kind: EditorKind, item: any) => {
    const noteContent = kind === 'notes' ? await db.getNoteContentById(item.id) : '';
    setEditor({
      kind,
      item,
      name: titleFor(kind, item),
      content: kind === 'notes' ? noteContent : kind === 'worldbook' ? item.content || '' : '',
      secondary: item.keyword_secondary || '',
      comment: item.comment || '',
      dataJson: item.data_json || '{}',
      imagePath: getCharacterImagePath(item.data_json) || '',
      systemPrompt: item.system_prompt || '',
      writingStyle: item.writing_style || '',
      extraInstructions: item.extra_instructions || '',
      temperature: String(item.temperature ?? 0.8),
      topP: String(item.top_p ?? 0.9),
      maxTokens: String(item.max_tokens ?? defaultMaxTokens(kind)),
      enabled: item.enabled !== 0,
      isDefault: item.is_default === 1,
      constant: item.constant === 1,
    });
  };

  const saveEditor = async () => {
    if (!editor) return;
    const item = editor.item;
    const maxTokens = Number(editor.maxTokens) || defaultMaxTokens(editor.kind);
    try {
      if (editor.kind === 'characters') {
        const parsed = JSON.parse(editor.dataJson);
        const data = editor.imagePath ? withCharacterImageAsset(parsed, editor.imagePath) : parsed;
        await db.updateCharacter(item.id, editor.name.trim() || '未命名角色', JSON.stringify(data));
        await db.updateCharacterTokenBudget(item.id, maxTokens);
      }
      if (editor.kind === 'worldbookCollection') {
        await db.updateWorldbookCollection(item.id, {
          name: editor.name.trim() || '未命名世界书',
          max_tokens: maxTokens,
        });
        await db.setWorldbookCollectionEnabledForProject(projectId, item.id, editor.enabled);
      }
      if (editor.kind === 'worldbook') {
        await db.updateWorldbookEntry(item.id, {
          keyword_primary: editor.name.trim(),
          keyword_secondary: editor.secondary,
          content: editor.content,
          comment: editor.comment,
          enabled: editor.enabled ? 1 : 0,
          constant: editor.constant ? 1 : 0,
          max_tokens: maxTokens,
        });
      }
      if (editor.kind === 'notes') {
        await db.updateNote(item.id, editor.name.trim() || '无标题笔记', editor.content);
        await db.updateNoteTokenBudget(item.id, maxTokens);
      }
      if (editor.kind === 'presets') {
        await db.updatePreset(item.id, {
          name: editor.name.trim() || '未命名预设',
          is_default: editor.isDefault ? 1 : 0,
          system_prompt: editor.systemPrompt,
          writing_style: editor.writingStyle,
          extra_instructions: editor.extraInstructions,
          temperature: Number(editor.temperature) || 0.8,
          top_p: Number(editor.topP) || 0.9,
          max_tokens: maxTokens,
        });
      }
      setEditor(null);
      await loadData();
      Toast.show({ type: 'success', text1: '资料已保存' });
    } catch (error: any) {
      Alert.alert('保存失败', editor.kind === 'characters' ? '角色卡 JSON 格式不正确。' : error?.message || '资料保存失败。');
    }
  };

  const replaceCharacterPng = async () => {
    if (!editor) return;
    try {
      const imagePath = await pickCharacterPngImageReplacement();
      if (!imagePath) return;
      setEditor({ ...editor, imagePath });
    } catch (error: any) {
      Alert.alert('替换图片失败', error?.message || '请选择有效的 PNG 图片。');
    }
  };

  const handleExportCharacter = async (item: any) => {
    try {
      await exportService.exportCharacterJSON(item.id);
      Toast.show({ type: 'success', text1: '角色卡已导出' });
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '导出失败', text2: error.message });
    }
  };

  const handleExportWorldbook = async (item: any) => {
    try {
      await exportService.exportWorldbookCollectionJSON(item.id);
      Toast.show({ type: 'success', text1: '世界书已导出' });
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '导出失败', text2: error.message });
    }
  };

  const handleExportNote = async (item: any) => {
    try {
      await exportService.exportNoteMarkdown(item.id);
      Toast.show({ type: 'success', text1: '笔记已导出' });
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '导出失败', text2: error.message });
    }
  };

  const handleExportPreset = async (item: any) => {
    try {
      await exportService.exportPresetJSON(item.id);
      Toast.show({ type: 'success', text1: '预设已导出' });
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '导出失败', text2: error.message });
    }
  };

  const toggleProjectUsage = async (item: any) => {
    if (!currentProject) {
      Alert.alert('未选择项目', '请先在项目页选择当前项目。');
      return;
    }
    // Phase9-BUG#11: 包裹 try-catch，失败时 Toast 提示（状态会通过 store 自动同步）
    try {
      await db.setProjectResourceEnabled(currentProject.id, RESOURCE_TYPE[tab], item.id, item.enabled_for_project !== 1);
      await loadData();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const setAllCharacters = async (enabled: boolean) => {
    if (!currentProject) {
      Alert.alert('未选择项目', '请先在项目页选择当前项目。');
      return;
    }
    // Phase9-BUG#12: 包裹 try-catch + Toast
    try {
      await db.setAllProjectResourcesEnabled(currentProject.id, 'character', enabled);
      await loadData();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const toggleCollection = async (collection: any) => {
    const newEnabled = collection.enabled === 1 ? 0 : 1;
    // Phase9-BUG#12: 包裹 try-catch + Toast
    try {
      await db.setWorldbookCollectionEnabledForProject(projectId, collection.id, newEnabled === 1);
      await loadData();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const remove = (kind: EditorKind, id: number, title: string) => {
    Alert.alert('删除资料', `确定删除「${title}」？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          // Phase9-BUG#10: 包裹 try-catch + Toast，串联多个 deleteXxx 任一失败时给用户反馈
          try {
            if (kind === 'characters') await db.deleteCharacter(id);
            if (kind === 'worldbookCollection') {
              await db.deleteWorldbookCollection(id);
              setSelectedCollectionId(null);
            }
            if (kind === 'worldbook') await db.deleteWorldbookEntry(id);
            if (kind === 'notes') await db.deleteNote(id);
            if (kind === 'presets') await db.deletePreset(id);
            await loadData();
          } catch (e: any) {
            Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
          }
        },
      },
    ]);
  };

  const activeItems = tab === 'worldbook' && selectedCollectionId
    ? items.worldbook.filter((item) => item.collection_id === selectedCollectionId)
    : items[tab];
  const canAddManual = tab !== 'characters';
  const editorTitle = useMemo(() => (editor ? `编辑${tabLabel(editor.kind)}` : ''), [editor]);

  return (
    <Screen>
      <Header title="资料库" subtitle={subtitle} />
      <View style={styles.tabs}>
        <SegmentedControl value={tab} options={TABS} onChange={(value) => { setTab(value); setSelectedCollectionId(null); }} />
      </View>
      <View style={styles.actions}>
        {tab === 'characters' ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actionScroll}>
            <Button label="导入角色卡" icon={Import} compact onPress={importCharacter} />
            <Button label="批量导入角色卡" icon={Import} variant="secondary" compact onPress={importCharactersBatch} />
            <Button label="新建角色卡" icon={FilePlus2} variant="secondary" compact onPress={addNewCharacter} />
            <Button label="启用全部角色" variant="secondary" compact onPress={() => setAllCharacters(true)} disabled={!currentProject} />
            <Button label="停用全部角色" variant="ghost" compact onPress={() => setAllCharacters(false)} disabled={!currentProject} />
          </ScrollView>
        ) : null}
        {tab === 'worldbook' ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actionScroll}>
            <Button label="导入世界书" icon={Import} compact onPress={importWorldbook} />
            <Button label="批量导入世界书" icon={Import} variant="secondary" compact onPress={importWorldbooksBatch} />
            {!selectedCollectionId && <Button label="新建世界书" icon={FilePlus2} variant="secondary" compact onPress={addNewWorldbook} />}
            {selectedCollectionId && <Button label="新建条目" icon={FilePlus2} variant="secondary" compact onPress={addNewWorldbookEntry} />}
            {selectedCollectionId ? <Button label="返回合集" variant="secondary" compact onPress={() => setSelectedCollectionId(null)} /> : null}
          </ScrollView>
        ) : null}
        {tab === 'notes' && currentProject ? (
          <View style={styles.noteModePanel}>
            <Text style={[styles.noteModeTitle, { color: theme.colors.textPrimary }]}>笔记模式</Text>
            <SegmentedControl
              value={noteMode}
              options={[
                { value: 'none', label: '禁用' },
                { value: 'style', label: '仿写' },
                { value: 'retrieval', label: '资料库' },
              ]}
              onChange={(value) => handleNoteModeChange(value)}
            />
            {noteMode === 'style' ? (
              <View style={styles.noteModeSection}>
                <Pressable onPress={() => setShowNotePicker(true)}>
                  <Text style={[styles.noteModeLink, { color: theme.colors.accent }]}>
                    参与仿写的笔记：{enabledNoteIds.length > 0 ? enabledNoteIds.length : items.notes.length}/{items.notes.length} 篇
                  </Text>
                </Pressable>
                <Text style={[styles.noteModeLabel, { color: theme.colors.textSecondary }]}>风格要素权重：</Text>
                {([
                  { key: 'sentence_structure' as const, label: '句式结构' },
                  { key: 'tone_emotion' as const, label: '语气与情感' },
                  { key: 'vocabulary' as const, label: '常用词汇搭配' },
                  { key: 'character_voice' as const, label: '角色设定' },
                  { key: 'narrative_rhythm' as const, label: '叙事节奏' },
                ]).map((item) => (
                  <View key={item.key} style={styles.weightRow}>
                    <Text style={[styles.weightLabel, { color: theme.colors.textPrimary }]}>{item.label}</Text>
                    <SegmentedControl
                      value={String(styleWeights[item.key] ?? 0)}
                      options={[
                        { value: '0', label: '关' },
                        { value: '1', label: '弱' },
                        { value: '2', label: '中' },
                        { value: '3', label: '强' },
                      ]}
                      onChange={(val) => handleWeightChange(item.key, Number(val))}
                    />
                  </View>
                ))}
                <View style={styles.rowActions}>
                  <Button label={analyzing ? '分析中...' : '重新分析风格'} icon={RefreshCw} variant="secondary" onPress={handleReanalyze} disabled={analyzing} />
                  <Button label="查看画像" variant="ghost" onPress={handleViewProfile} />
                </View>
              </View>
            ) : null}
            {noteMode === 'retrieval' ? (
              <View style={styles.noteModeSection}>
                <Pressable onPress={() => setShowNotePicker(true)}>
                  <Text style={[styles.noteModeLink, { color: theme.colors.accent }]}>
                    参与检索的笔记：{enabledNoteIds.length > 0 ? enabledNoteIds.length : items.notes.length}/{items.notes.length} 篇
                  </Text>
                </Pressable>
                <Text style={[styles.noteModeLabel, { color: theme.colors.textSecondary }]}>检索片段数上限：</Text>
                <SegmentedControl
                  value={String(retrievalTopK)}
                  options={[
                    { value: '3', label: '3' },
                    { value: '5', label: '5' },
                    { value: '8', label: '8' },
                    { value: '10', label: '10' },
                  ]}
                  onChange={(val) => handleTopKChange(Number(val))}
                />
                <Text style={[styles.noteModeHint, { color: theme.colors.textMuted }]}>生成正文时会自动从笔记中检索相关内容</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {tab === 'notes' ? <Button label="导入 TXT 笔记" icon={Import} onPress={importNoteText} /> : null}
        {tab === 'notes' ? <Button label="批量导入 TXT" icon={Import} variant="secondary" onPress={importNotesBatch} /> : null}
        {canAddManual ? (
          <>
            <Field value={draft} onChangeText={setDraft} placeholder={placeholderFor(tab, Boolean(selectedCollectionId))} inputStyle={styles.inlineInput} />
            <Button label="添加" icon={FilePlus2} onPress={addManual} disabled={!draft.trim()} />
          </>
        ) : null}
      </View>

      {tab === 'worldbook' && !selectedCollectionId ? (
        collections.length === 0 ? (
          <EmptyState title="还没有世界书合集" description="导入世界书文件会自动创建合集，也可以手动添加合集。" />
        ) : (
          <FlatList
            data={collections}
            keyExtractor={(item) => String(item.id)}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <Card>
                <View style={styles.row}>
                  <BookMarked size={20} color={theme.colors.accent} />
                  <View style={styles.rowText}>
                    <Text style={[styles.itemTitle, { color: theme.colors.textPrimary }]}>{item.name || '未命名世界书'}</Text>
                    <Text style={[styles.itemMeta, { color: theme.colors.textSecondary }]}>
                      {item.entry_count || 0} 条 · 预估 {item.estimated_tokens || 0} / Max {item.max_tokens || 50000} tokens
                    </Text>
                    <View style={styles.usageRow}>
                      <Text style={[styles.usageText, { color: theme.colors.textSecondary }]}>合集启用</Text>
                      <Switch value={item.enabled === 1} onValueChange={() => toggleCollection(item)} />
                    </View>
                  </View>
                </View>
                <View style={styles.cardActions}>
                  <Button label="打开" variant="secondary" onPress={() => setSelectedCollectionId(item.id)} />
                  <Button label="导出" icon={Download} variant="secondary" onPress={() => handleExportWorldbook(item)} />
                  <Button label="编辑" icon={Pencil} variant="secondary" onPress={() => openEditor('worldbookCollection', item)} />
                  <Button label="删除" icon={Trash2} variant="ghost" onPress={() => remove('worldbookCollection', item.id, item.name)} />
                </View>
              </Card>
            )}
          />
        )
      ) : activeItems.length === 0 ? (
        <EmptyState title={emptyTitle(tab)} description="使用上方按钮导入或创建资料。" />
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
                  <View style={styles.titleRow}>
                    <Text style={[styles.itemTitle, { color: theme.colors.textPrimary }]}>{titleFor(tab, item)}</Text>
                    {tab === 'notes' && noteMode !== 'none' ? (
                      <Text style={[styles.modeTag, { color: theme.colors.accent, borderColor: theme.colors.accent }]}>
                        {noteMode === 'style' ? '仿写' : '资料库'}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={[styles.itemMeta, { color: theme.colors.textSecondary }]} numberOfLines={2}>
                    {metaFor(tab, item)}
                  </Text>
                  <Text style={[styles.tokenMeta, { color: theme.colors.textSecondary }]}>
                    预估 {item.estimated_tokens ?? estimateTokens(item.content || item.data_json || '')} / Max {item.max_tokens ?? defaultMaxTokens(tab)} tokens
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
                <Button label="编辑" icon={Pencil} variant="secondary" onPress={() => openEditor(tab, item)} />
                {tab === 'characters' && <Button label="导出" icon={Download} variant="secondary" onPress={() => handleExportCharacter(item)} />}
                {tab === 'notes' && <Button label="导出" icon={Download} variant="secondary" onPress={() => handleExportNote(item)} />}
                {tab === 'presets' && <Button label="导出" icon={Download} variant="secondary" onPress={() => handleExportPreset(item)} />}
                <Button label="删除" icon={Trash2} variant="ghost" onPress={() => remove(tab, item.id, titleFor(tab, item))} />
              </View>
            </Card>
          )}
        />
      )}

      <Modal visible={Boolean(editor)} transparent animationType="fade" onRequestClose={() => setEditor(null)}>
        <View style={styles.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setEditor(null)} />
          <View style={[styles.modal, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.modalTitle, { color: theme.colors.textPrimary }]}>{editorTitle}</Text>
            {editor ? (
              <ScrollView keyboardShouldPersistTaps="handled">
                <Field label="名称 / 标题 / 主关键词" value={editor.name} onChangeText={(name) => setEditor({ ...editor, name })} />
                <Field label="Max Tokens" value={editor.maxTokens} onChangeText={(maxTokens) => setEditor({ ...editor, maxTokens })} keyboardType="number-pad" />
                <Text style={[styles.tokenMeta, { color: theme.colors.textSecondary }]}>
                  当前预估 {estimateEditorTokens(editor)} tokens
                </Text>
                {editor.kind === 'characters' ? (
                  <>
                    {editor.imagePath ? <Image source={{ uri: `file://${editor.imagePath}` }} style={styles.characterImage} resizeMode="cover" /> : null}
                    <Button label={editor.imagePath ? '替换 PNG 图片' : '选择 PNG 图片'} icon={Import} variant="secondary" onPress={replaceCharacterPng} />
                    <CharacterEditor
                      dataJson={editor.dataJson}
                      onChange={(dataJson) => setEditor({ ...editor, dataJson })}
                    />
                  </>
                ) : null}
                {editor.kind === 'worldbookCollection' ? (
                  <View style={styles.usageRow}>
                    <Text style={[styles.usageText, { color: theme.colors.textPrimary }]}>合集启用</Text>
                    <Switch value={editor.enabled} onValueChange={(enabled) => setEditor({ ...editor, enabled })} />
                  </View>
                ) : null}
                {editor.kind === 'worldbook' ? (
                  <>
                    <Field label="次关键词" value={editor.secondary} onChangeText={(secondary) => setEditor({ ...editor, secondary })} />
                    <Field label="说明" value={editor.comment} onChangeText={(comment) => setEditor({ ...editor, comment })} />
                    <Field label="内容" value={editor.content} onChangeText={(content) => setEditor({ ...editor, content })} multiline inputStyle={styles.largeInput} />
                    <View style={styles.usageRow}>
                      <Text style={[styles.usageText, { color: theme.colors.textPrimary }]}>常驻条目（不需要关键词触发）</Text>
                      <Switch value={editor.constant} onValueChange={(constant) => setEditor({ ...editor, constant })} />
                    </View>
                    <View style={styles.usageRow}>
                      <Text style={[styles.usageText, { color: theme.colors.textPrimary }]}>条目启用</Text>
                      <Switch value={editor.enabled} onValueChange={(enabled) => setEditor({ ...editor, enabled })} />
                    </View>
                  </>
                ) : null}
                {editor.kind === 'notes' ? (
                  <Field label="笔记内容" value={editor.content} onChangeText={(content) => setEditor({ ...editor, content })} multiline inputStyle={styles.largeInput} />
                ) : null}
                {editor.kind === 'presets' ? (
                  <>
                    <Field label="系统提示词" value={editor.systemPrompt} onChangeText={(systemPrompt) => setEditor({ ...editor, systemPrompt })} multiline inputStyle={styles.largeInput} />
                    <Field label="写作风格" value={editor.writingStyle} onChangeText={(writingStyle) => setEditor({ ...editor, writingStyle })} multiline />
                    <Field label="额外约束" value={editor.extraInstructions} onChangeText={(extraInstructions) => setEditor({ ...editor, extraInstructions })} multiline />
                    <View style={styles.numberRow}>
                      <Field label="温度" value={editor.temperature} onChangeText={(temperature) => setEditor({ ...editor, temperature })} keyboardType="decimal-pad" inputStyle={styles.numberInput} />
                      <Field label="Top P" value={editor.topP} onChangeText={(topP) => setEditor({ ...editor, topP })} keyboardType="decimal-pad" inputStyle={styles.numberInput} />
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
          </View>
        </View>
      </Modal>

      {/* 笔记选择器 Modal */}
      <Modal visible={showNotePicker} transparent animationType="fade" onRequestClose={() => setShowNotePicker(false)}>
        <View style={styles.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowNotePicker(false)} />
          <View style={[styles.modal, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.modalTitle, { color: theme.colors.textPrimary }]}>选择笔记</Text>
            <ScrollView style={styles.notePickerList}>
              {items.notes.map((note: any) => {
                const isSelected = enabledNoteIds.includes(note.id);
                return (
                  <Pressable
                    key={note.id}
                    style={[styles.notePickerItem, { borderColor: isSelected ? theme.colors.accent : theme.colors.border }]}
                    onPress={() => handleToggleNoteId(note.id)}
                  >
                    <Text style={[styles.notePickerTitle, { color: theme.colors.textPrimary }]}>{note.title || '无标题'}</Text>
                    <Text style={[styles.notePickerCheck, { color: isSelected ? theme.colors.accent : theme.colors.textMuted }]}>
                      {isSelected ? '✓' : '○'}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.modalActions}>
              <Button label="关闭" variant="ghost" onPress={() => setShowNotePicker(false)} />
            </View>
          </View>
        </View>
      </Modal>

      {/* 风格画像查看 Modal */}
      <Modal visible={showStyleProfile} transparent animationType="fade" onRequestClose={() => setShowStyleProfile(false)}>
        <View style={styles.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowStyleProfile(false)} />
          <View style={[styles.modal, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.modalTitle, { color: theme.colors.textPrimary }]}>风格画像</Text>
            <ScrollView style={styles.profileViewer}>
              <Text style={[styles.profileText, { color: theme.colors.textSecondary }]}>{styleProfileText || '暂无画像'}</Text>
            </ScrollView>
            <View style={styles.modalActions}>
              <Button label="关闭" variant="ghost" onPress={() => setShowStyleProfile(false)} />
            </View>
          </View>
        </View>
      </Modal>
    {batchResult ? (
        <BatchImportResultModal
          visible
          title={batchResult.title}
          success={batchResult.success}
          failed={batchResult.failed}
          onClose={() => setBatchResult(null)}
        />
      ) : null}
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

function defaultMaxTokens(kind: EditorKind): number {
  if (kind === 'characters') return 50000;
  if (kind === 'worldbookCollection') return 50000;
  if (kind === 'worldbook') return 2000;
  if (kind === 'notes') return 30000;
  return 4000;
}

function tabLabel(kind: EditorKind): string {
  if (kind === 'characters') return '角色卡';
  if (kind === 'worldbookCollection') return '世界书合集';
  if (kind === 'worldbook') return '世界书条目';
  if (kind === 'notes') return '笔记';
  return '预设';
}

function placeholderFor(tab: ResourceTab, addingEntry: boolean): string {
  if (tab === 'worldbook') return addingEntry ? '新世界书条目主关键词' : '新世界书合集名称';
  if (tab === 'notes') return '新笔记标题';
  return '新预设名称';
}

function emptyTitle(tab: ResourceTab): string {
  if (tab === 'characters') return '还没有角色卡';
  if (tab === 'worldbook') return '还没有世界书条目';
  if (tab === 'notes') return '还没有笔记';
  return '还没有预设';
}

function titleFor(kind: EditorKind, item: any): string {
  if (kind === 'characters') return item.name || '未命名角色';
  if (kind === 'worldbookCollection') return item.name || '未命名世界书';
  if (kind === 'worldbook') return item.keyword_primary || '未命名条目';
  return item.title || item.name || '未命名';
}

function metaFor(tab: ResourceTab, item: any): string {
  if (tab === 'characters') return item.source_type === 'png' ? 'PNG 角色卡' : 'JSON 角色卡';
  if (tab === 'worldbook') return `${item.collection_name || '未分组'} · ${item.enabled ? '条目可用' : '条目停用'} · ${item.content || '暂无内容'}`;
  if (tab === 'notes') return item.content || '空白笔记';
  return `${item.is_default ? '全局默认 · ' : ''}T=${item.temperature} / P=${item.top_p} / Max=${item.max_tokens}`;
}

function estimateEditorTokens(editor: EditorState): number {
  if (editor.kind === 'characters') return estimateTokens(editor.dataJson);
  if (editor.kind === 'worldbook') return estimateTokens(editor.content);
  if (editor.kind === 'notes') return estimateTokens(editor.content);
  if (editor.kind === 'presets') return estimateTokens([editor.systemPrompt, editor.writingStyle, editor.extraInstructions].join('\n'));
  return Number(editor.item.estimated_tokens || 0);
}

const styles = StyleSheet.create({
  tabs: { padding: spacing.lg, paddingBottom: 0 },
  actions: { padding: spacing.lg, paddingBottom: 0, gap: spacing.sm },
  actionScroll: { flexDirection: 'row', gap: spacing.sm, paddingRight: spacing.lg, paddingVertical: spacing.xs },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  inlineInput: { minHeight: 40 },
  list: { padding: spacing.lg, paddingBottom: 96 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  rowText: { flex: 1 },
  itemTitle: { fontSize: 16, fontWeight: '800', marginBottom: 4 },
  itemMeta: { fontSize: 13, lineHeight: 18 },
  tokenMeta: { fontSize: 12, fontWeight: '700', marginTop: 4, marginBottom: spacing.sm },
  usageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, marginTop: spacing.sm },
  usageText: { fontSize: 13, fontWeight: '700' },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: spacing.lg },
  modal: { maxHeight: '88%', borderRadius: 8, padding: spacing.lg },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: spacing.md },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md, marginTop: spacing.md },
  largeInput: { minHeight: 160, textAlignVertical: 'top' },
  characterImage: { width: 128, height: 180, borderRadius: 8, marginBottom: spacing.md, alignSelf: 'center' },
  numberRow: { flexDirection: 'row', gap: spacing.sm },
  numberInput: { minWidth: 80 },
  // 笔记双模式 UI
  noteModePanel: { gap: spacing.sm },
  noteModeTitle: { fontSize: 15, fontWeight: '800' },
  noteModeSection: { gap: spacing.xs, marginTop: spacing.xs },
  noteModeLabel: { fontSize: 13, fontWeight: '700', marginTop: spacing.xs },
  noteModeLink: { fontSize: 13, fontWeight: '700' },
  noteModeHint: { fontSize: 12, marginTop: spacing.xs },
  weightRow: { gap: 4 },
  weightLabel: { fontSize: 13, fontWeight: '600' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  modeTag: { fontSize: 11, fontWeight: '700', borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  notePickerList: { maxHeight: 400 },
  notePickerItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.md, borderWidth: 1, borderRadius: 6, marginBottom: spacing.xs },
  notePickerTitle: { fontSize: 14, fontWeight: '600', flex: 1 },
  notePickerCheck: { fontSize: 18, fontWeight: '800' },
  profileViewer: { maxHeight: 400 },
  profileText: { fontSize: 14, lineHeight: 22 },
});
