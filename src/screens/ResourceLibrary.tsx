import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  BookMarked,
  Download,
  FilePlus2,
  Import,
  NotebookPen,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  UserRound,
} from 'lucide-react-native';
import { types } from '@react-native-documents/picker';
import Toast from 'react-native-toast-message';
import { useFocusEffect } from '@react-navigation/native';
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
import { CharacterEditor } from '../components/CharacterEditor';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import type { ResourceType } from '../services/database';
import { estimateTokens } from '../utils/tokenEstimator';
import { getNoteChapters } from '../utils/noteChapters';
import {
  DEFAULT_STYLE_WEIGHTS,
  type StyleWeights,
  analyzeNotesStyle,
} from '../services/styleAnalyzer';
import {
  getCharacterImagePath,
  importCharacters,
  importCharactersAsCollection,
  importNotes,
  importSelectedCharacter,
  importSelectedNoteText,
  importSelectedWorldBook,
  importWorldBooks,
  pickCharacterFolderFiles,
  pickCharacterPngImageReplacement,
  pickLocalFiles,
  withCharacterImageAsset,
} from '../services/fileImport';
import { BatchImportResultModal } from '../components/BatchImportResultModal';
import * as exportService from '../services/exportService';

type ResourceTab = 'characters' | 'worldbook' | 'notes' | 'presets';
type EditorKind =
  | ResourceTab
  | 'worldbookCollection'
  | 'characterCollection'
  | 'noteCollection';

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

function isCollectionEnabledForProject(collection: any): boolean {
  return collection.enabled_for_project == null
    ? collection.enabled === 1
    : collection.enabled_for_project === 1;
}

function collectionTokenEstimate(collection: any): number {
  const calculated = Number(collection.calculated_estimated_tokens);
  if (Number.isFinite(calculated) && calculated >= 0) return calculated;
  return Number(collection.estimated_tokens || 0);
}

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

export const ResourceLibrary: React.FC<{
  route?: { params?: { initialTab?: ResourceTab } };
}> = ({ route }) => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [tab, setTab] = useState<ResourceTab>(
    route?.params?.initialTab ?? 'characters',
  );
  const [items, setItems] = useState<Record<ResourceTab, any[]>>({
    characters: [],
    worldbook: [],
    notes: [],
    presets: [],
  });
  const [characterCollections, setCharacterCollections] = useState<any[]>([]);
  const [collections, setCollections] = useState<any[]>([]);
  const [noteCollections, setNoteCollections] = useState<any[]>([]);
  const [selectedCharacterCollectionId, setSelectedCharacterCollectionId] =
    useState<number | null>(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState<
    number | null
  >(null);
  const [selectedNoteCollectionId, setSelectedNoteCollectionId] = useState<
    number | null
  >(null);
  const [draft, setDraft] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [showNoteChapters, setShowNoteChapters] = useState(false);
  const [noteSelection, setNoteSelection] = useState({ start: 0, end: 0 });
  const noteContentInputRef = useRef<TextInput>(null);
  const [noteMode, setNoteMode] = useState<'none' | 'style' | 'retrieval'>(
    'none',
  );
  const [styleWeights, setStyleWeights] = useState<StyleWeights>(
    DEFAULT_STYLE_WEIGHTS,
  );
  const [retrievalTopK, setRetrievalTopK] = useState(5);
  const [retrievalFragmentChars, setRetrievalFragmentChars] = useState(1000);
  const [enabledNoteIds, setEnabledNoteIds] = useState<number[]>([]);
  const enabledNoteIdsRef = useRef<number[]>([]);
  const [showNotePicker, setShowNotePicker] = useState(false);
  const [showStyleProfile, setShowStyleProfile] = useState(false);
  const [batchResult, setBatchResult] = useState<{
    title: string;
    success: Array<{ fileName: string; id: any }>;
    failed: Array<{ fileName: string; error: string }>;
  } | null>(null);
  const [styleProfileText, setStyleProfileText] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const loadGenerationRef = useRef(0);
  const projectId = currentProject?.id || 0;
  const projectEnabledNotes = useMemo(
    () => items.notes.filter((note: any) => note.enabled_for_project === 1),
    [items.notes],
  );
  const effectiveEnabledNoteIds = useMemo(() => {
    const eligibleIds = projectEnabledNotes.map((note: any) => Number(note.id));
    if (enabledNoteIds.length === 0) return eligibleIds;
    const eligibleSet = new Set(eligibleIds);
    return enabledNoteIds.map(Number).filter(id => eligibleSet.has(id));
  }, [enabledNoteIds, projectEnabledNotes]);

  useEffect(() => {
    enabledNoteIdsRef.current = enabledNoteIds;
  }, [enabledNoteIds]);

  const loadData = useCallback(async () => {
    const loadGeneration = ++loadGenerationRef.current;
    const [
      characters,
      worldbook,
      notes,
      presets,
      characterCollectionRows,
      worldbookCollections,
      noteCollectionRows,
      noteConfig,
    ] = await Promise.all([
      db.getAllCharacters(projectId),
      db.getAllWorldbookEntries(projectId),
      db.getAllNotes(projectId),
      db.getAllPresets(projectId),
      db.getCharacterCollections(projectId),
      db.getWorldbookCollections(projectId),
      db.getNoteCollections(projectId),
      db.getProjectNoteConfig(projectId),
    ]);
    // Project changes can start a second load before the first Promise.all
    // settles. Never let the old project overwrite the newer screen state.
    if (loadGeneration !== loadGenerationRef.current) return;
    setItems({ characters, worldbook, notes, presets });
    setCharacterCollections(characterCollectionRows);
    setCollections(worldbookCollections);
    setNoteCollections(noteCollectionRows);
    if (noteConfig) {
      // 防御性归一化：DB 异常返回 null/undefined 时回退默认，避免渲染时 .length 报错
      setNoteMode(noteConfig.mode || 'none');
      setStyleWeights({
        ...DEFAULT_STYLE_WEIGHTS,
        ...(noteConfig.styleWeights || {}),
      });
      setRetrievalTopK(
        typeof noteConfig.retrievalTopK === 'number'
          ? noteConfig.retrievalTopK
          : 5,
      );
      setRetrievalFragmentChars(
        typeof noteConfig.retrievalFragmentChars === 'number'
          ? noteConfig.retrievalFragmentChars
          : 1000,
      );
      const loadedIds = Array.isArray(noteConfig.enabledNoteIds)
        ? noteConfig.enabledNoteIds.map(Number)
        : [];
      enabledNoteIdsRef.current = loadedIds;
      setEnabledNoteIds(loadedIds);
    } else {
      setNoteMode('none');
      setStyleWeights(DEFAULT_STYLE_WEIGHTS);
      setRetrievalTopK(5);
      setRetrievalFragmentChars(1000);
      enabledNoteIdsRef.current = [];
      setEnabledNoteIds([]);
    }
    if (
      selectedNoteCollectionId &&
      !noteCollectionRows.some(
        (collection: any) => collection.id === selectedNoteCollectionId,
      )
    ) {
      setSelectedNoteCollectionId(null);
    }
    if (
      selectedCollectionId &&
      !worldbookCollections.some(
        (collection: any) => collection.id === selectedCollectionId,
      )
    ) {
      setSelectedCollectionId(null);
    }
    if (
      selectedCharacterCollectionId &&
      !characterCollectionRows.some(
        (collection: any) => collection.id === selectedCharacterCollectionId,
      )
    ) {
      setSelectedCharacterCollectionId(null);
    }
  }, [
    projectId,
    selectedCollectionId,
    selectedCharacterCollectionId,
    selectedNoteCollectionId,
  ]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData]),
  );

  const subtitle = currentProject
    ? `全局资料库 · 当前项目：${currentProject.name}`
    : '全局资料库 · 选择项目后可配置启用关系';

  const importCharacter = async () => {
    try {
      const collectionId =
        selectedCharacterCollectionId ||
        (await db.ensureDefaultCharacterCollection(projectId));
      const id = await importSelectedCharacter(projectId, collectionId);
      if (id) Toast.show({ type: 'success', text1: '角色卡已导入' });
      await loadData();
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '导入失败', text2: error.message });
    }
  };

  const addNewCharacter = async () => {
    try {
      const collectionId =
        selectedCharacterCollectionId ||
        (await db.ensureDefaultCharacterCollection(projectId));
      const id = await db.createCharacter(
        projectId,
        '未命名角色',
        'json',
        '{}',
        { collectionId },
      );
      await loadData();
      const newItem = await db.getCharacterById(id);
      if (newItem) openEditor('characters', newItem);
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '新建失败', text2: error.message });
    }
  };

  const addNewCharacterCollection = async () => {
    try {
      const id = await db.createCharacterCollection(
        projectId,
        '未命名角色合集',
        { enabled: 1 },
      );
      await loadData();
      const refreshedCollections = await db.getCharacterCollections(projectId);
      const newItem = refreshedCollections.find((c: any) => c.id === id);
      if (newItem) openEditor('characterCollection', newItem);
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '新建失败', text2: error.message });
    }
  };

  const importWorldbook = async () => {
    try {
      const result = await importSelectedWorldBook(projectId);
      if (result)
        Toast.show({
          type: 'success',
          text1: '世界书已导入',
          text2: `${result.entriesImported || 0} 个条目`,
        });
      await loadData();
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '导入失败', text2: error.message });
    }
  };

  const addNewWorldbook = async () => {
    try {
      const id = await db.createWorldbookCollection(projectId, '未命名世界书', {
        enabled: 1,
      });
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
      const id = await db.createWorldbookEntry(projectId, '', '', 1, {
        collection_id: selectedCollectionId,
      });
      await loadData();
      const entries = await db.getWorldbookEntriesByCollection(
        selectedCollectionId,
      );
      const newItem = entries.find((e: any) => e.id === id);
      if (newItem) openEditor('worldbook', newItem);
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '新建失败', text2: error.message });
    }
  };

  const importNoteText = async () => {
    try {
      const result = await importSelectedNoteText(projectId);
      if (result)
        Toast.show({
          type: 'success',
          text1: 'TXT 已导入为笔记',
          text2: `${result.createdCount} 条笔记`,
        });
      await loadData();
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '导入失败', text2: error.message });
    }
  };

  const importCharactersBatch = async () => {
    const files = await pickLocalFiles([types.json, types.images], 50);
    if (!files) return;
    try {
      const result = selectedCharacterCollectionId
        ? await importCharacters(projectId, files, {
            collectionId: selectedCharacterCollectionId,
          })
        : await importCharactersAsCollection(
            projectId,
            `批量角色卡 ${new Date().toLocaleString('zh-CN', {
              hour12: false,
            })}`,
            files,
          );
      if (result.total === 0) return;
      Toast.show({
        type: result.failed.length === 0 ? 'success' : 'info',
        text1: `角色卡批量导入：${result.success.length} 成功 / ${result.failed.length} 失败`,
      });
      if (result.failed.length > 0) {
        setBatchResult({
          title: '批量导入角色卡',
          success: result.success,
          failed: result.failed,
        });
      }
      await loadData();
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: '批量导入失败',
        text2: error.message,
      });
    }
  };

  const importCharactersFolder = async () => {
    try {
      const files = await pickCharacterFolderFiles();
      if (!files) return;
      if (files.length === 0) {
        Toast.show({ type: 'info', text1: '文件夹内没有 JSON/PNG 角色卡' });
        return;
      }
      const result = selectedCharacterCollectionId
        ? await importCharacters(projectId, files, {
            collectionId: selectedCharacterCollectionId,
          })
        : await importCharactersAsCollection(
            projectId,
            `文件夹角色卡 ${new Date().toLocaleString('zh-CN', {
              hour12: false,
            })}`,
            files,
          );
      Toast.show({
        type: result.failed.length === 0 ? 'success' : 'info',
        text1: `文件夹导入：${result.success.length} 成功 / ${result.failed.length} 失败`,
      });
      if (result.failed.length > 0) {
        setBatchResult({
          title: '文件夹导入角色卡',
          success: result.success,
          failed: result.failed,
        });
      }
      await loadData();
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: '文件夹导入失败',
        text2: error.message,
      });
    }
  };

  const collectUngroupedCharacters = async () => {
    try {
      const id = await db.createCharacterCollection(projectId, '全部人物卡', {
        enabled: 1,
      });
      await db.setAllCharactersCollectionId(projectId, id);
      setSelectedCharacterCollectionId(id);
      await loadData();
      Toast.show({ type: 'success', text1: '已整理到人物卡合集' });
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '整理失败', text2: error.message });
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
        setBatchResult({
          title: '批量导入世界书',
          success: result.success,
          failed: result.failed,
        });
      }
      await loadData();
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: '批量导入失败',
        text2: error.message,
      });
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
        setBatchResult({
          title: '批量导入 TXT 笔记',
          success: result.success,
          failed: result.failed,
        });
      }
      await loadData();
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: '批量导入失败',
        text2: error.message,
      });
    }
  };

  const handleNoteModeChange = async (mode: 'none' | 'style' | 'retrieval') => {
    setNoteMode(mode);
    try {
      await db.setProjectNoteConfig(projectId, { mode });
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '保存失败', text2: error.message });
    }
  };

  const handleWeightChange = async (key: keyof StyleWeights, value: number) => {
    const newWeights = { ...styleWeights, [key]: value };
    setStyleWeights(newWeights);
    try {
      // 用当前 noteMode 而非写死 'style'，避免在 retrieval 模式下被误调时覆盖
      await db.setProjectNoteConfig(projectId, { styleWeights: newWeights });
    } catch {
      // 静默失败，不打断用户调整
    }
  };

  const handleTopKChange = async (value: number) => {
    setRetrievalTopK(value);
    try {
      // 用当前 noteMode 而非写死 'retrieval'
      await db.setProjectNoteConfig(projectId, { retrievalTopK: value });
    } catch {
      // 静默失败
    }
  };

  const handleFragmentCharsChange = async (value: number) => {
    setRetrievalFragmentChars(value);
    try {
      await db.setProjectNoteConfig(projectId, {
        retrievalFragmentChars: value,
      });
    } catch {
      // 静默失败，不打断用户调整
    }
  };

  const handleToggleNoteId = async (noteId: number) => {
    const eligibleIds = projectEnabledNotes.map((note: any) => Number(note.id));
    const eligibleSet = new Set(eligibleIds);
    const configuredIds = enabledNoteIdsRef.current;
    const selectedIds =
      configuredIds.length > 0
        ? configuredIds.map(Number).filter(id => eligibleSet.has(id))
        : eligibleIds;
    const newIds = selectedIds.includes(noteId)
      ? selectedIds.filter(id => id !== noteId)
      : [...selectedIds, noteId];
    if (newIds.length === 0 && eligibleIds.length > 0) {
      Toast.show({
        type: 'info',
        text1: '请至少保留一篇笔记',
        text2: '如需全部关闭，请将笔记模式切换为“禁用”。',
      });
      return;
    }
    enabledNoteIdsRef.current = newIds;
    setEnabledNoteIds(newIds);
    try {
      await db.setProjectNoteConfig(projectId, { enabledNoteIds: newIds });
    } catch (error: any) {
      await loadData();
      Toast.show({ type: 'error', text1: '保存失败', text2: error.message });
    }
  };

  const handleReanalyze = async () => {
    setAnalyzing(true);
    try {
      const ids = effectiveEnabledNoteIds;
      if (ids.length === 0) {
        Toast.show({ type: 'info', text1: '没有可分析的笔记' });
        return;
      }
      await analyzeNotesStyle(ids);
      Toast.show({ type: 'success', text1: '风格分析完成' });
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: '风格分析失败',
        text2: error.message,
      });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleViewProfile = async () => {
    if (effectiveEnabledNoteIds.length === 0) {
      Toast.show({ type: 'info', text1: '当前项目没有参与仿写的笔记' });
      return;
    }
    try {
      const profiles = await Promise.all(
        effectiveEnabledNoteIds.map(async id => {
          const note = projectEnabledNotes.find((item: any) => item.id === id);
          const profile = await db.getNoteStyleProfile(id);
          return `【${note?.title || '无标题'}】\n${
            profile?.profileText || '暂无风格画像'
          }`;
        }),
      );
      setStyleProfileText(profiles.join('\n\n'));
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
          await db.createWorldbookEntry(projectId, value, '', 1, {
            collection_id: selectedCollectionId,
          });
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
    const noteContent =
      kind === 'notes' ? await db.getNoteContentById(item.id) : '';
    // BUG-8 修复：新建的角色/世界书 name 是 "未命名角色" 等占位符，
    // 如果直接预填到 TextInput 会让用户的输入被拼接到占位符后面（"未命名角色Xxx"），
    // 即使保存成功也保留占位符。这里把已存在的真实 name 才预填，否则留空让 placeholder 显示。
    const placeholderByKind: Record<EditorKind, string> = {
      characters: '未命名角色',
      characterCollection: '未命名角色合集',
      worldbookCollection: '未命名世界书',
      noteCollection: '未命名笔记合集',
      worldbook: '未命名条目',
      notes: '无标题笔记',
      presets: '未命名预设',
    };
    // 世界书条目的名称实际存储在 keyword_primary，而不是通用的 name 字段。
    // 若这里读取 item.name，编辑器会显示为空；用户随后仅修改正文再保存时，
    // saveEditor 会把 keyword_primary 覆盖为空，列表就会回退显示“未命名条目”。
    const storedName =
      kind === 'worldbook' ? item.keyword_primary || '' : item.name || '';
    const isPlaceholder = storedName === placeholderByKind[kind];
    setShowNoteChapters(false);
    setNoteSelection({ start: 0, end: 0 });
    setEditor({
      kind,
      item,
      name: isPlaceholder ? '' : storedName,
      content:
        kind === 'notes'
          ? noteContent
          : kind === 'worldbook'
          ? item.content || ''
          : '',
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
      // 世界书条目默认常驻；仅显式 constant=0 时关闭
      constant:
        kind === 'worldbook' ? item.constant !== 0 : item.constant === 1,
    });
  };

  const saveEditor = async () => {
    if (!editor) return;
    const item = editor.item;
    const maxTokens = Number(editor.maxTokens) || defaultMaxTokens(editor.kind);
    try {
      if (editor.kind === 'characters') {
        const parsed = JSON.parse(editor.dataJson);
        const data = editor.imagePath
          ? withCharacterImageAsset(parsed, editor.imagePath)
          : parsed;
        await db.updateCharacter(
          item.id,
          editor.name.trim() || '未命名角色',
          JSON.stringify(data),
        );
        await db.updateCharacterTokenBudget(item.id, maxTokens);
      }
      if (editor.kind === 'characterCollection') {
        await db.updateCharacterCollection(item.id, {
          name: editor.name.trim() || '未命名角色合集',
          max_tokens: maxTokens,
        });
        await db.setCharacterCollectionEnabledForProject(
          projectId,
          item.id,
          editor.enabled,
        );
      }
      if (editor.kind === 'worldbookCollection') {
        await db.updateWorldbookCollection(item.id, {
          name: editor.name.trim() || '未命名世界书',
          max_tokens: maxTokens,
        });
        await db.setWorldbookCollectionEnabledForProject(
          projectId,
          item.id,
          editor.enabled,
        );
      }
      if (editor.kind === 'noteCollection') {
        await db.updateNoteCollection(item.id, {
          name: editor.name.trim() || '未命名笔记合集',
          max_tokens: maxTokens,
        });
        await db.setNoteCollectionEnabledForProject(
          projectId,
          item.id,
          editor.enabled,
        );
      }
      if (editor.kind === 'worldbook') {
        await db.updateWorldbookEntry(item.id, {
          keyword_primary: editor.name.trim(),
          keyword_secondary: editor.secondary,
          content: editor.content,
          comment: editor.comment,
          constant: editor.constant ? 1 : 0,
          max_tokens: maxTokens,
        });
      }
      if (editor.kind === 'notes') {
        await db.updateNote(
          item.id,
          editor.name.trim() || '无标题笔记',
          editor.content,
        );
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
      Alert.alert(
        '保存失败',
        editor.kind === 'characters'
          ? '角色卡 JSON 格式不正确。'
          : error?.message || '资料保存失败。',
      );
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
      await db.setProjectResourceEnabled(
        currentProject.id,
        RESOURCE_TYPE[tab],
        item.id,
        item.enabled_for_project !== 1,
      );
      await loadData();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const toggleCharacterCollection = async (collection: any) => {
    const newEnabled = isCollectionEnabledForProject(collection) ? 0 : 1;
    try {
      await db.setCharacterCollectionEnabledForProject(
        projectId,
        collection.id,
        newEnabled === 1,
      );
      await loadData();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const toggleCollection = async (collection: any) => {
    if (!currentProject) {
      Toast.show({ type: 'info', text1: '请先选择项目', text2: '世界书合集按项目独立启用或停用。' });
      return;
    }
    const newEnabled = isCollectionEnabledForProject(collection) ? 0 : 1;
    // Phase9-BUG#12: 包裹 try-catch + Toast
    try {
      await db.setWorldbookCollectionEnabledForProject(
        projectId,
        collection.id,
        newEnabled === 1,
      );
      await loadData();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const toggleNoteCollection = async (collection: any) => {
    try {
      await db.setNoteCollectionEnabledForProject(
        projectId,
        collection.id,
        !isCollectionEnabledForProject(collection),
      );
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
            if (kind === 'characterCollection') {
              await db.deleteCharacterCollection(id);
              setSelectedCharacterCollectionId(null);
            }
            if (kind === 'worldbookCollection') {
              await db.deleteWorldbookCollection(id);
              setSelectedCollectionId(null);
            }
            if (kind === 'worldbook') await db.deleteWorldbookEntry(id);
            if (kind === 'noteCollection') {
              await db.deleteNoteCollection(id);
              setSelectedNoteCollectionId(null);
            }
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

  const activeItems =
    tab === 'characters' && selectedCharacterCollectionId
      ? items.characters.filter(
          item => item.collection_id === selectedCharacterCollectionId,
        )
      : tab === 'worldbook' && selectedCollectionId
      ? items.worldbook.filter(
          item => item.collection_id === selectedCollectionId,
        )
      : tab === 'notes' && selectedNoteCollectionId
      ? items.notes.filter(
          item => item.collection_id === selectedNoteCollectionId,
        )
      : items[tab];
  const canAddManual = tab !== 'characters';
  const editorTitle = useMemo(
    () => (editor ? `编辑${tabLabel(editor.kind)}` : ''),
    [editor],
  );
  const noteChapters = useMemo(
    () => (editor?.kind === 'notes' ? getNoteChapters(editor.content) : []),
    [editor],
  );

  const jumpToNoteChapter = (offset: number) => {
    setShowNoteChapters(false);
    setNoteSelection({ start: offset, end: offset });
    setTimeout(() => noteContentInputRef.current?.focus(), 0);
  };

  return (
    <Screen>
      <Header title="资料库" subtitle={subtitle} />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.tabs}>
          <SegmentedControl
            value={tab}
            options={TABS}
            onChange={value => {
              setTab(value);
              setSelectedCollectionId(null);
              setSelectedCharacterCollectionId(null);
              setSelectedNoteCollectionId(null);
            }}
          />
        </View>
        <View style={styles.actions}>
          {tab === 'characters' ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.actionScroll}
            >
              <Button
                label="导入角色卡"
                icon={Import}
                compact
                onPress={importCharacter}
              />
              <Button
                label="批量导入角色卡"
                icon={Import}
                variant="secondary"
                compact
                onPress={importCharactersBatch}
              />
              <Button
                label="导入文件夹"
                icon={Import}
                variant="secondary"
                compact
                onPress={importCharactersFolder}
              />
              {!selectedCharacterCollectionId && (
                <Button
                  label="新建角色合集"
                  icon={FilePlus2}
                  variant="secondary"
                  compact
                  onPress={addNewCharacterCollection}
                />
              )}
              {selectedCharacterCollectionId && (
                <Button
                  label="新建角色卡"
                  icon={FilePlus2}
                  variant="secondary"
                  compact
                  onPress={addNewCharacter}
                />
              )}
              {!selectedCharacterCollectionId && (
                <Button
                  label="整理已导入"
                  variant="secondary"
                  compact
                  onPress={collectUngroupedCharacters}
                  disabled={!currentProject}
                />
              )}
              {selectedCharacterCollectionId ? (
                <Button
                  label="返回合集"
                  variant="secondary"
                  compact
                  onPress={() => setSelectedCharacterCollectionId(null)}
                />
              ) : null}
            </ScrollView>
          ) : null}
          {tab === 'worldbook' ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.actionScroll}
            >
              <Button
                label="导入世界书"
                icon={Import}
                compact
                onPress={importWorldbook}
              />
              <Button
                label="批量导入世界书"
                icon={Import}
                variant="secondary"
                compact
                onPress={importWorldbooksBatch}
              />
              {!selectedCollectionId && (
                <Button
                  label="新建世界书"
                  icon={FilePlus2}
                  variant="secondary"
                  compact
                  onPress={addNewWorldbook}
                />
              )}
              {selectedCollectionId && (
                <Button
                  label="新建条目"
                  icon={FilePlus2}
                  variant="secondary"
                  compact
                  onPress={addNewWorldbookEntry}
                />
              )}
              {selectedCollectionId ? (
                <Button
                  label="返回合集"
                  variant="secondary"
                  compact
                  onPress={() => setSelectedCollectionId(null)}
                />
              ) : null}
            </ScrollView>
          ) : null}
          {tab === 'notes' ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.actionScroll}
            >
              <Button
                label="导入 TXT 笔记"
                icon={Import}
                compact
                onPress={importNoteText}
              />
              <Button
                label="批量导入 TXT"
                icon={Import}
                variant="secondary"
                compact
                onPress={importNotesBatch}
              />
              {selectedNoteCollectionId ? (
                <Button
                  label="返回合集"
                  variant="secondary"
                  compact
                  onPress={() => setSelectedNoteCollectionId(null)}
                />
              ) : null}
            </ScrollView>
          ) : null}
          {tab === 'notes' && currentProject ? (
            <View style={styles.noteModePanel}>
              <Text
                style={[
                  styles.noteModeTitle,
                  { color: theme.colors.textPrimary },
                ]}
              >
                笔记模式
              </Text>
              <SegmentedControl
                value={noteMode}
                options={[
                  { value: 'none', label: '禁用' },
                  { value: 'style', label: '仿写' },
                  { value: 'retrieval', label: '资料库' },
                ]}
                onChange={value => handleNoteModeChange(value)}
              />
              {noteMode === 'style' ? (
                <View style={styles.noteModeSection}>
                  <Pressable onPress={() => setShowNotePicker(true)}>
                    <Text
                      style={[
                        styles.noteModeLink,
                        { color: theme.colors.accent },
                      ]}
                    >
                      参与仿写的笔记：
                      {effectiveEnabledNoteIds.length}/
                      {projectEnabledNotes.length} 篇
                    </Text>
                  </Pressable>
                  <Text
                    style={[
                      styles.noteModeLabel,
                      { color: theme.colors.textSecondary },
                    ]}
                  >
                    风格要素权重：
                  </Text>
                  {[
                    { key: 'sentence_structure' as const, label: '句式结构' },
                    { key: 'tone_emotion' as const, label: '语气与情感' },
                    { key: 'vocabulary' as const, label: '常用词汇搭配' },
                    { key: 'character_voice' as const, label: '角色设定' },
                    { key: 'narrative_rhythm' as const, label: '叙事节奏' },
                  ].map(item => (
                    <View key={item.key} style={styles.weightRow}>
                      <Text
                        style={[
                          styles.weightLabel,
                          { color: theme.colors.textPrimary },
                        ]}
                      >
                        {item.label}
                      </Text>
                      <SegmentedControl
                        value={String(styleWeights[item.key] ?? 0)}
                        options={[
                          { value: '0', label: '关' },
                          { value: '1', label: '弱' },
                          { value: '2', label: '中' },
                          { value: '3', label: '强' },
                        ]}
                        onChange={val =>
                          handleWeightChange(item.key, Number(val))
                        }
                      />
                    </View>
                  ))}
                  <View style={styles.rowActions}>
                    <Button
                      label={analyzing ? '分析中...' : '重新分析风格'}
                      icon={RefreshCw}
                      variant="secondary"
                      onPress={handleReanalyze}
                      disabled={analyzing}
                    />
                    <Button
                      label="查看画像"
                      variant="ghost"
                      onPress={handleViewProfile}
                    />
                  </View>
                </View>
              ) : null}
              {noteMode === 'retrieval' ? (
                <View style={styles.noteModeSection}>
                  <Pressable onPress={() => setShowNotePicker(true)}>
                    <Text
                      style={[
                        styles.noteModeLink,
                        { color: theme.colors.accent },
                      ]}
                    >
                      参与检索的笔记：
                      {effectiveEnabledNoteIds.length}/
                      {projectEnabledNotes.length} 篇
                    </Text>
                  </Pressable>
                  <Text
                    style={[
                      styles.noteModeLabel,
                      { color: theme.colors.textSecondary },
                    ]}
                  >
                    检索片段数上限：
                  </Text>
                  <SegmentedControl
                    value={String(retrievalTopK)}
                    options={[
                      { value: '3', label: '3' },
                      { value: '5', label: '5' },
                      { value: '8', label: '8' },
                      { value: '10', label: '10' },
                    ]}
                    onChange={val => handleTopKChange(Number(val))}
                  />
                  <Text
                    style={[
                      styles.noteModeLabel,
                      { color: theme.colors.textSecondary },
                    ]}
                  >
                    单条命中片段长度：
                  </Text>
                  <SegmentedControl
                    value={String(retrievalFragmentChars)}
                    options={[
                      { value: '500', label: '500 字' },
                      { value: '1000', label: '1000 字' },
                      { value: '2000', label: '2000 字' },
                      { value: '4000', label: '4000 字' },
                    ]}
                    onChange={val => handleFragmentCharsChange(Number(val))}
                  />
                  <Text
                    style={[
                      styles.noteModeHint,
                      { color: theme.colors.textMuted },
                    ]}
                  >
                    生成正文时会自动从笔记中检索相关内容
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {canAddManual && !selectedNoteCollectionId ? (
            <>
              <Field
                value={draft}
                onChangeText={setDraft}
                placeholder={placeholderFor(tab, Boolean(selectedCollectionId))}
                inputStyle={styles.inlineInput}
              />
              <Button
                label="添加"
                icon={FilePlus2}
                onPress={addManual}
                disabled={!draft.trim()}
              />
            </>
          ) : null}
        </View>

        <View testID="resource-list-container" style={styles.listContainer}>
          {tab === 'characters' && !selectedCharacterCollectionId ? (
            characterCollections.length === 0 ? (
              <EmptyState
                title="还没有角色合集"
                description="导入角色卡或新建合集后，可以集中启用和停用人物卡。"
              />
            ) : (
              <FlatList
                data={characterCollections}
                scrollEnabled={false}
                keyExtractor={item => String(item.id)}
                contentContainerStyle={styles.list}
                renderItem={({ item }) => (
                  <Card>
                    <View style={styles.row}>
                      <UserRound size={20} color={theme.colors.accent} />
                      <View style={styles.rowText}>
                        <Text
                          style={[
                            styles.itemTitle,
                            { color: theme.colors.textPrimary },
                          ]}
                        >
                          {item.name || '未命名角色合集'}
                        </Text>
                        <Text
                          style={[
                            styles.itemMeta,
                            { color: theme.colors.textSecondary },
                          ]}
                        >
                          {item.character_count || 0} 张 · 预估{' '}
                          {item.estimated_tokens || 0} / Max{' '}
                          {item.max_tokens || 50000} tokens
                        </Text>
                        <View style={styles.usageRow}>
                          <Text
                            style={[
                              styles.usageText,
                              { color: theme.colors.textSecondary },
                            ]}
                          >
                            合集启用
                          </Text>
                          <Switch
                            testID={`character-collection-toggle-${item.id}`}
                            value={isCollectionEnabledForProject(item)}
                            onValueChange={() =>
                              toggleCharacterCollection(item)
                            }
                          />
                        </View>
                      </View>
                    </View>
                    <View style={styles.cardActions}>
                      <Button
                        label="打开"
                        variant="secondary"
                        onPress={() =>
                          setSelectedCharacterCollectionId(item.id)
                        }
                      />
                      <Button
                        label="编辑"
                        icon={Pencil}
                        variant="secondary"
                        onPress={() => openEditor('characterCollection', item)}
                      />
                      <Button
                        label="删除"
                        icon={Trash2}
                        variant="ghost"
                        onPress={() =>
                          remove('characterCollection', item.id, item.name)
                        }
                      />
                    </View>
                  </Card>
                )}
              />
            )
          ) : tab === 'worldbook' && !selectedCollectionId ? (
            collections.length === 0 ? (
              <EmptyState
                title="还没有世界书合集"
                description="导入世界书文件会自动创建合集，也可以手动添加合集。"
              />
            ) : (
              <FlatList
                data={collections}
                scrollEnabled={false}
                keyExtractor={item => String(item.id)}
                contentContainerStyle={styles.list}
                renderItem={({ item }) => (
                  <Card>
                    <View style={styles.row}>
                      <BookMarked size={20} color={theme.colors.accent} />
                      <View style={styles.rowText}>
                        <Text
                          style={[
                            styles.itemTitle,
                            { color: theme.colors.textPrimary },
                          ]}
                        >
                          {item.name || '未命名世界书'}
                        </Text>
                        <Text
                          style={[
                            styles.itemMeta,
                            { color: theme.colors.textSecondary },
                          ]}
                        >
                          {item.entry_count || 0} 条 · 预估{' '}
                          {collectionTokenEstimate(item)} / Max{' '}
                          {item.max_tokens || 50000} tokens
                        </Text>
                        <View style={styles.usageRow}>
                          <Text
                            style={[
                              styles.usageText,
                              { color: theme.colors.textSecondary },
                            ]}
                          >
                            合集启用
                          </Text>
                          <Switch
                            value={isCollectionEnabledForProject(item)}
                            disabled={!currentProject}
                            onValueChange={() => toggleCollection(item)}
                          />
                        </View>
                      </View>
                    </View>
                    <View style={styles.cardActions}>
                      <Button
                        label="打开"
                        variant="secondary"
                        onPress={() => setSelectedCollectionId(item.id)}
                      />
                      <Button
                        label="导出"
                        icon={Download}
                        variant="secondary"
                        onPress={() => handleExportWorldbook(item)}
                      />
                      <Button
                        label="编辑"
                        icon={Pencil}
                        variant="secondary"
                        onPress={() => openEditor('worldbookCollection', item)}
                      />
                      <Button
                        label="删除"
                        icon={Trash2}
                        variant="ghost"
                        onPress={() =>
                          remove('worldbookCollection', item.id, item.name)
                        }
                      />
                    </View>
                  </Card>
                )}
              />
            )
          ) : tab === 'notes' &&
            !selectedNoteCollectionId &&
            noteCollections.length > 0 ? (
            <FlatList
              data={[
                ...noteCollections.map(item => ({
                  ...item,
                  _isNoteCollection: true,
                })),
                ...items.notes.filter(item => !item.collection_id),
              ]}
              scrollEnabled={false}
              keyExtractor={item =>
                `${item._isNoteCollection ? 'collection' : 'note'}-${item.id}`
              }
              contentContainerStyle={styles.list}
              renderItem={({ item }) =>
                item._isNoteCollection ? (
                  <Card>
                    <View style={styles.row}>
                      <NotebookPen size={20} color={theme.colors.accent} />
                      <View style={styles.rowText}>
                        <Text
                          style={[
                            styles.itemTitle,
                            { color: theme.colors.textPrimary },
                          ]}
                        >
                          {item.name || '未命名笔记合集'}
                        </Text>
                        <Text
                          style={[
                            styles.itemMeta,
                            { color: theme.colors.textSecondary },
                          ]}
                        >
                          {item.note_count || 0} 篇分片 · 预估{' '}
                          {item.estimated_tokens || 0} / Max{' '}
                          {item.max_tokens || 50000} tokens
                        </Text>
                        <View style={styles.usageRow}>
                          <Text
                            style={[
                              styles.usageText,
                              { color: theme.colors.textSecondary },
                            ]}
                          >
                            合集启用
                          </Text>
                          <Switch
                            testID={`note-collection-toggle-${item.id}`}
                            value={item.enabled === 1}
                            onValueChange={() => toggleNoteCollection(item)}
                          />
                        </View>
                      </View>
                    </View>
                    <View style={styles.cardActions}>
                      <Button
                        label="打开"
                        variant="secondary"
                        onPress={() => setSelectedNoteCollectionId(item.id)}
                      />
                      <Button
                        label="编辑"
                        icon={Pencil}
                        variant="secondary"
                        onPress={() => openEditor('noteCollection', item)}
                      />
                      <Button
                        label="删除"
                        icon={Trash2}
                        variant="ghost"
                        onPress={() =>
                          remove('noteCollection', item.id, item.name)
                        }
                      />
                    </View>
                  </Card>
                ) : (
                  <Card>
                    <View style={styles.row}>
                      <NotebookPen size={20} color={theme.colors.accent} />
                      <View style={styles.rowText}>
                        <Text
                          style={[
                            styles.itemTitle,
                            { color: theme.colors.textPrimary },
                          ]}
                        >
                          {titleFor('notes', item)}
                        </Text>
                        <Text
                          style={[
                            styles.itemMeta,
                            { color: theme.colors.textSecondary },
                          ]}
                          numberOfLines={2}
                        >
                          {metaFor('notes', item)}
                        </Text>
                        <View style={styles.usageRow}>
                          <Text
                            style={[
                              styles.usageText,
                              { color: theme.colors.textSecondary },
                            ]}
                          >
                            当前项目使用
                          </Text>
                          <Switch
                            value={item.enabled_for_project === 1}
                            disabled={!currentProject}
                            onValueChange={() => toggleProjectUsage(item)}
                          />
                        </View>
                      </View>
                    </View>
                    <View style={styles.cardActions}>
                      <Button
                        label="编辑"
                        icon={Pencil}
                        variant="secondary"
                        onPress={() => openEditor('notes', item)}
                      />
                      <Button
                        label="删除"
                        icon={Trash2}
                        variant="ghost"
                        onPress={() =>
                          remove('notes', item.id, titleFor('notes', item))
                        }
                      />
                    </View>
                  </Card>
                )
              }
            />
          ) : activeItems.length === 0 ? (
            <EmptyState
              title={emptyTitle(tab)}
              description="使用上方按钮导入或创建资料。"
            />
          ) : (
            <FlatList
              data={activeItems}
              scrollEnabled={false}
              keyExtractor={item => String(item.id)}
              contentContainerStyle={styles.list}
              renderItem={({ item }) => (
                <Card>
                  <View style={styles.row}>
                    {iconFor(tab, theme.colors.accent)}
                    <View style={styles.rowText}>
                      <View style={styles.titleRow}>
                        <Text
                          style={[
                            styles.itemTitle,
                            { color: theme.colors.textPrimary },
                          ]}
                        >
                          {titleFor(tab, item)}
                        </Text>
                        {tab === 'notes' && noteMode !== 'none' ? (
                          <Text
                            style={[
                              styles.modeTag,
                              {
                                color: theme.colors.accent,
                                borderColor: theme.colors.accent,
                              },
                            ]}
                          >
                            {noteMode === 'style' ? '仿写' : '资料库'}
                          </Text>
                        ) : null}
                      </View>
                      <Text
                        style={[
                          styles.itemMeta,
                          { color: theme.colors.textSecondary },
                        ]}
                        numberOfLines={2}
                      >
                        {metaFor(tab, item)}
                      </Text>
                      <Text
                        style={[
                          styles.tokenMeta,
                          { color: theme.colors.textSecondary },
                        ]}
                      >
                        预估{' '}
                        {item.estimated_tokens ??
                          estimateTokens(
                            item.content || item.data_json || '',
                          )}{' '}
                        / Max {item.max_tokens ?? defaultMaxTokens(tab)} tokens
                      </Text>
                      <View style={styles.usageRow}>
                        <Text
                          style={[
                            styles.usageText,
                            { color: theme.colors.textSecondary },
                          ]}
                        >
                          当前项目使用
                        </Text>
                        <Switch
                          value={item.enabled_for_project === 1}
                          disabled={!currentProject}
                          onValueChange={() => toggleProjectUsage(item)}
                          trackColor={{
                            false: theme.colors.border,
                            true: theme.colors.accentSoft,
                          }}
                          thumbColor={
                            item.enabled_for_project === 1
                              ? theme.colors.accent
                              : theme.colors.textMuted
                          }
                        />
                      </View>
                    </View>
                  </View>
                  <View style={styles.cardActions}>
                    <Button
                      label="编辑"
                      icon={Pencil}
                      variant="secondary"
                      onPress={() => openEditor(tab, item)}
                    />
                    {tab === 'characters' && (
                      <Button
                        label="导出"
                        icon={Download}
                        variant="secondary"
                        onPress={() => handleExportCharacter(item)}
                      />
                    )}
                    {tab === 'notes' && (
                      <Button
                        label="导出"
                        icon={Download}
                        variant="secondary"
                        onPress={() => handleExportNote(item)}
                      />
                    )}
                    {tab === 'presets' && (
                      <Button
                        label="导出"
                        icon={Download}
                        variant="secondary"
                        onPress={() => handleExportPreset(item)}
                      />
                    )}
                    <Button
                      label="删除"
                      icon={Trash2}
                      variant="ghost"
                      onPress={() => remove(tab, item.id, titleFor(tab, item))}
                    />
                  </View>
                </Card>
              )}
            />
          )}
        </View>
      </ScrollView>

      <Modal
        visible={Boolean(editor)}
        transparent
        animationType="fade"
        onRequestClose={() => setEditor(null)}
      >
        <View style={styles.overlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setEditor(null)}
          />
          <View
            style={[styles.modal, { backgroundColor: theme.colors.surface }]}
          >
            <Text
              style={[styles.modalTitle, { color: theme.colors.textPrimary }]}
            >
              {editorTitle}
            </Text>
            {editor ? (
              <ScrollView keyboardShouldPersistTaps="handled">
                <Field
                  testID="resource-editor-name"
                  label="名称 / 标题 / 主关键词"
                  value={editor.name}
                  onChangeText={name => setEditor({ ...editor, name })}
                />
                <Field
                  testID="resource-editor-max-tokens"
                  label="Max Tokens"
                  value={editor.maxTokens}
                  onChangeText={maxTokens =>
                    setEditor({ ...editor, maxTokens })
                  }
                  keyboardType="number-pad"
                />
                <Text
                  style={[
                    styles.tokenMeta,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  当前预估 {estimateEditorTokens(editor)} tokens
                </Text>
                {editor.kind === 'characters' ? (
                  <>
                    {editor.imagePath ? (
                      <Image
                        source={{ uri: `file://${editor.imagePath}` }}
                        style={styles.characterImage}
                        resizeMode="cover"
                      />
                    ) : null}
                    <Button
                      label={
                        editor.imagePath ? '替换 PNG 图片' : '选择 PNG 图片'
                      }
                      icon={Import}
                      variant="secondary"
                      onPress={replaceCharacterPng}
                    />
                    <CharacterEditor
                      dataJson={editor.dataJson}
                      onChange={dataJson => setEditor({ ...editor, dataJson })}
                    />
                  </>
                ) : null}
                {editor.kind === 'characterCollection' ? (
                  <View style={styles.usageRow}>
                    <Text
                      style={[
                        styles.usageText,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      合集启用
                    </Text>
                    <Switch
                      value={editor.enabled}
                      onValueChange={enabled =>
                        setEditor({ ...editor, enabled })
                      }
                    />
                  </View>
                ) : null}
                {editor.kind === 'worldbookCollection' ? (
                  <View style={styles.usageRow}>
                    <Text
                      style={[
                        styles.usageText,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      合集启用
                    </Text>
                    <Switch
                      value={editor.enabled}
                      onValueChange={enabled =>
                        setEditor({ ...editor, enabled })
                      }
                    />
                  </View>
                ) : null}
                {editor.kind === 'noteCollection' ? (
                  <View style={styles.usageRow}>
                    <Text
                      style={[
                        styles.usageText,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      合集启用
                    </Text>
                    <Switch
                      value={editor.enabled}
                      onValueChange={enabled =>
                        setEditor({ ...editor, enabled })
                      }
                    />
                  </View>
                ) : null}
                {editor.kind === 'worldbook' ? (
                  <>
                    <Field
                      label="次关键词"
                      value={editor.secondary}
                      onChangeText={secondary =>
                        setEditor({ ...editor, secondary })
                      }
                    />
                    <Field
                      label="说明"
                      value={editor.comment}
                      onChangeText={comment =>
                        setEditor({ ...editor, comment })
                      }
                    />
                    <Field
                      testID="resource-editor-content"
                      label="内容"
                      value={editor.content}
                      onChangeText={content =>
                        setEditor({ ...editor, content })
                      }
                      multiline
                      inputStyle={styles.largeInput}
                    />
                    <View style={styles.usageRow}>
                      <Text
                        style={[
                          styles.usageText,
                          { color: theme.colors.textPrimary },
                        ]}
                      >
                        常驻条目（不需要关键词触发）
                      </Text>
                      <Switch
                        value={editor.constant}
                        onValueChange={constant =>
                          setEditor({ ...editor, constant })
                        }
                      />
                    </View>
                  </>
                ) : null}
                {editor.kind === 'notes' ? (
                  <>
                    <View style={styles.noteContentHeader}>
                      <Text
                        style={[
                          styles.noteContentLabel,
                          { color: theme.colors.textSecondary },
                        ]}
                      >
                        笔记内容
                      </Text>
                      <Button
                        label={`章节${
                          noteChapters.length ? ` (${noteChapters.length})` : ''
                        }`}
                        icon={BookMarked}
                        variant="secondary"
                        compact
                        onPress={() => setShowNoteChapters(true)}
                      />
                    </View>
                    <TextInput
                      ref={noteContentInputRef}
                      value={editor.content}
                      onChangeText={content =>
                        setEditor({ ...editor, content })
                      }
                      onSelectionChange={event =>
                        setNoteSelection(event.nativeEvent.selection)
                      }
                      selection={noteSelection}
                      multiline
                      textAlignVertical="top"
                      placeholder="请输入笔记内容"
                      placeholderTextColor={theme.colors.textMuted}
                      style={[
                        styles.noteContentInput,
                        {
                          backgroundColor: theme.colors.card,
                          borderColor: theme.colors.border,
                          color: theme.colors.textPrimary,
                        },
                      ]}
                    />
                  </>
                ) : null}
                {editor.kind === 'presets' ? (
                  <>
                    <Field
                      label="系统提示词"
                      value={editor.systemPrompt}
                      onChangeText={systemPrompt =>
                        setEditor({ ...editor, systemPrompt })
                      }
                      multiline
                      inputStyle={styles.largeInput}
                    />
                    <Field
                      label="写作风格"
                      value={editor.writingStyle}
                      onChangeText={writingStyle =>
                        setEditor({ ...editor, writingStyle })
                      }
                      multiline
                    />
                    <Field
                      label="额外约束"
                      value={editor.extraInstructions}
                      onChangeText={extraInstructions =>
                        setEditor({ ...editor, extraInstructions })
                      }
                      multiline
                    />
                    <View style={styles.numberRow}>
                      <Field
                        label="温度"
                        value={editor.temperature}
                        onChangeText={temperature =>
                          setEditor({ ...editor, temperature })
                        }
                        keyboardType="decimal-pad"
                        inputStyle={styles.numberInput}
                      />
                      <Field
                        label="Top P"
                        value={editor.topP}
                        onChangeText={topP => setEditor({ ...editor, topP })}
                        keyboardType="decimal-pad"
                        inputStyle={styles.numberInput}
                      />
                    </View>
                    <View style={styles.usageRow}>
                      <Text
                        style={[
                          styles.usageText,
                          { color: theme.colors.textPrimary },
                        ]}
                      >
                        设为全局默认预设
                      </Text>
                      <Switch
                        value={editor.isDefault}
                        onValueChange={isDefault =>
                          setEditor({ ...editor, isDefault })
                        }
                      />
                    </View>
                  </>
                ) : null}
              </ScrollView>
            ) : null}
            <View style={styles.modalActions}>
              <Button
                label="取消"
                variant="ghost"
                onPress={() => setEditor(null)}
              />
              <Button label="保存" onPress={saveEditor} />
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showNoteChapters}
        transparent
        animationType="fade"
        onRequestClose={() => setShowNoteChapters(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setShowNoteChapters(false)}
          />
          <View
            style={[
              styles.chapterModal,
              { backgroundColor: theme.colors.surface },
            ]}
          >
            <Text
              style={[styles.modalTitle, { color: theme.colors.textPrimary }]}
            >
              笔记章节
            </Text>
            {noteChapters.length > 0 ? (
              <ScrollView
                style={styles.chapterList}
                keyboardShouldPersistTaps="handled"
              >
                {noteChapters.map((chapter, index) => (
                  <Pressable
                    key={`${chapter.offset}-${chapter.title}`}
                    style={[
                      styles.chapterItem,
                      { borderBottomColor: theme.colors.border },
                    ]}
                    onPress={() => jumpToNoteChapter(chapter.offset)}
                  >
                    <Text
                      style={[
                        styles.chapterIndex,
                        { color: theme.colors.textMuted },
                      ]}
                    >
                      {index + 1}
                    </Text>
                    <Text
                      style={[
                        styles.chapterTitle,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      {chapter.title}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <Text
                style={[
                  styles.chapterEmpty,
                  { color: theme.colors.textSecondary },
                ]}
              >
                未识别到章节标题。可使用“第 1 章”、Markdown 标题或 Chapter 1
                格式。
              </Text>
            )}
            <View style={styles.modalActions}>
              <Button
                label="关闭"
                variant="ghost"
                onPress={() => setShowNoteChapters(false)}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* 笔记选择器 Modal */}
      <Modal
        visible={showNotePicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowNotePicker(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setShowNotePicker(false)}
          />
          <View
            style={[styles.modal, { backgroundColor: theme.colors.surface }]}
          >
            <Text
              style={[styles.modalTitle, { color: theme.colors.textPrimary }]}
            >
              选择笔记
            </Text>
            <ScrollView style={styles.notePickerList}>
              {projectEnabledNotes.map((note: any) => {
                const isSelected = effectiveEnabledNoteIds.includes(note.id);
                return (
                  <Pressable
                    key={note.id}
                    style={[
                      styles.notePickerItem,
                      {
                        borderColor: isSelected
                          ? theme.colors.accent
                          : theme.colors.border,
                      },
                    ]}
                    onPress={() => handleToggleNoteId(note.id)}
                  >
                    <Text
                      style={[
                        styles.notePickerTitle,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      {note.title || '无标题'}
                    </Text>
                    <Text
                      style={[
                        styles.notePickerCheck,
                        {
                          color: isSelected
                            ? theme.colors.accent
                            : theme.colors.textMuted,
                        },
                      ]}
                    >
                      {isSelected ? '✓' : '○'}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.modalActions}>
              <Button
                label="关闭"
                variant="ghost"
                onPress={() => setShowNotePicker(false)}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* 风格画像查看 Modal */}
      <Modal
        visible={showStyleProfile}
        transparent
        animationType="fade"
        onRequestClose={() => setShowStyleProfile(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setShowStyleProfile(false)}
          />
          <View
            style={[styles.modal, { backgroundColor: theme.colors.surface }]}
          >
            <Text
              style={[styles.modalTitle, { color: theme.colors.textPrimary }]}
            >
              风格画像
            </Text>
            <ScrollView style={styles.profileViewer}>
              <Text
                style={[
                  styles.profileText,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {styleProfileText || '暂无画像'}
              </Text>
            </ScrollView>
            <View style={styles.modalActions}>
              <Button
                label="关闭"
                variant="ghost"
                onPress={() => setShowStyleProfile(false)}
              />
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
  if (kind === 'characterCollection') return 50000;
  if (kind === 'worldbookCollection') return 50000;
  if (kind === 'noteCollection') return 50000;
  if (kind === 'worldbook') return 2000;
  if (kind === 'notes') return 30000;
  return 4000;
}

function tabLabel(kind: EditorKind): string {
  if (kind === 'characters') return '角色卡';
  if (kind === 'characterCollection') return '角色合集';
  if (kind === 'worldbookCollection') return '世界书合集';
  if (kind === 'noteCollection') return '笔记合集';
  if (kind === 'worldbook') return '世界书条目';
  if (kind === 'notes') return '笔记';
  return '预设';
}

function placeholderFor(tab: ResourceTab, addingEntry: boolean): string {
  if (tab === 'worldbook')
    return addingEntry ? '新世界书条目主关键词' : '新世界书合集名称';
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
  if (kind === 'characterCollection') return item.name || '未命名角色合集';
  if (kind === 'worldbookCollection') return item.name || '未命名世界书';
  if (kind === 'worldbook') return item.keyword_primary || '未命名条目';
  return item.title || item.name || '未命名';
}

function metaFor(tab: ResourceTab, item: any): string {
  if (tab === 'characters')
    return `${item.collection_name || '未分组'} · ${
      item.source_type === 'png' ? 'PNG 角色卡' : 'JSON 角色卡'
    }`;
  if (tab === 'worldbook')
    return `${item.collection_name || '未分组'} · ${item.content || '暂无内容'}`;
  if (tab === 'notes') return item.content || '空白笔记';
  return `${item.is_default ? '全局默认 · ' : ''}T=${item.temperature} / P=${
    item.top_p
  } / Max=${item.max_tokens}`;
}

function estimateEditorTokens(editor: EditorState): number {
  if (editor.kind === 'characters') return estimateTokens(editor.dataJson);
  if (editor.kind === 'worldbook') return estimateTokens(editor.content);
  if (editor.kind === 'notes') return estimateTokens(editor.content);
  if (editor.kind === 'presets')
    return estimateTokens(
      [editor.systemPrompt, editor.writingStyle, editor.extraInstructions].join(
        '\n',
      ),
    );
  return Number(editor.item.estimated_tokens || 0);
}

const styles = StyleSheet.create({
  tabs: { padding: spacing.lg, paddingBottom: 0 },
  actions: { padding: spacing.lg, paddingBottom: 0, gap: spacing.sm },
  actionScroll: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.lg,
    paddingVertical: spacing.xs,
  },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  inlineInput: { minHeight: 40 },
  scrollContent: { paddingBottom: 120 },
  listContainer: { minHeight: 240 },
  list: { padding: spacing.lg, paddingBottom: 96 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  rowText: { flex: 1 },
  itemTitle: { fontSize: 16, fontWeight: '800', marginBottom: 4 },
  itemMeta: { fontSize: 13, lineHeight: 18 },
  tokenMeta: {
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
    marginBottom: spacing.sm,
  },
  usageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  usageText: { fontSize: 13, fontWeight: '700' },
  cardActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modal: { maxHeight: '88%', borderRadius: 8, padding: spacing.lg },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: spacing.md },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  largeInput: { minHeight: 160, textAlignVertical: 'top' },
  characterImage: {
    width: 128,
    height: 180,
    borderRadius: 8,
    marginBottom: spacing.md,
    alignSelf: 'center',
  },
  numberRow: { flexDirection: 'row', gap: spacing.sm },
  numberInput: { minWidth: 80 },
  // 笔记双模式 UI
  noteModePanel: { gap: spacing.sm },
  noteModeTitle: { fontSize: 15, fontWeight: '800' },
  noteModeSection: { gap: spacing.xs, marginTop: spacing.xs },
  noteModeLabel: { fontSize: 13, fontWeight: '700', marginTop: spacing.xs },
  noteModeLink: { fontSize: 13, fontWeight: '700' },
  noteModeHint: { fontSize: 12, marginTop: spacing.xs },
  noteContentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  noteContentLabel: { fontSize: 13, fontWeight: '600' },
  noteContentInput: {
    minHeight: 280,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.md,
    fontSize: 14,
    lineHeight: 21,
  },
  chapterModal: {
    width: '88%',
    maxHeight: '74%',
    borderRadius: 16,
    padding: spacing.lg,
  },
  chapterList: { maxHeight: 420 },
  chapterItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chapterIndex: {
    width: 26,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  chapterTitle: { flex: 1, fontSize: 15, fontWeight: '600' },
  chapterEmpty: { fontSize: 14, lineHeight: 21, paddingVertical: spacing.lg },
  weightRow: { gap: 4 },
  weightLabel: { fontSize: 13, fontWeight: '600' },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  modeTag: {
    fontSize: 11,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  notePickerList: { maxHeight: 400 },
  notePickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    borderWidth: 1,
    borderRadius: 6,
    marginBottom: spacing.xs,
  },
  notePickerTitle: { fontSize: 14, fontWeight: '600', flex: 1 },
  notePickerCheck: { fontSize: 18, fontWeight: '800' },
  profileViewer: { maxHeight: 400 },
  profileText: { fontSize: 14, lineHeight: 22 },
});
