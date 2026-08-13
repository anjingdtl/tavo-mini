import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Download,
  Eye,
  FileQuestion,
  Library,
  RefreshCw,
  Wand2,
  XCircle,
} from 'lucide-react-native';
import { types } from '@react-native-documents/picker';
import RNFS from 'react-native-fs';
import Toast from 'react-native-toast-message';
import {
  Button,
  Card,
  Field,
  Header,
  Screen,
  SegmentedControl,
  spacing,
} from '../components/ui';
import { ConstructionSlider } from '../components/ConstructionSlider';
import { useSettingsStore } from '../store/settingsStore';
import { useProjectStore } from '../store/projectStore';
import { navigateToLLMSettings } from '../navigation/navigationRef';
import {
  DEFAULT_ENTRY_COUNT,
  DEFAULT_RESERVE_PERCENT,
  RESERVE_PERCENT_MAX,
  RESERVE_PERCENT_MIN,
  WORLDBOOK_ENTRY_MAX,
  WORLDBOOK_ENTRY_MIN,
  clampEntryCount,
  clampPercent,
  computeConstructionBudget,
  formatReserveLabel,
} from '../services/construction/budget';
import {
  buildCharacterSourceSnapshot,
  buildWorldbookSourceSnapshot,
  estimateConstructionInputTokens,
  generateConstruction,
} from '../services/constructionAiGenerator';
import {
  importConstructionArtifactToLibrary,
  saveConstructionArtifact,
} from '../services/constructionFileService';
import type {
  ConstructionArtifact,
  ConstructionInput,
} from '../services/constructionAiGenerator';
import {
  parseCharacterCardJSON,
  parseCharacterCardPNG,
  parseWorldBookJSON,
  pickSourceFile,
} from '../services/fileImport';
import {
  buildTextSourceSnapshot,
  parseConstructionTextSource,
  type TextSourceSection,
  type TextSourceEncoding,
} from '../services/construction/textSourceParser';
import { readTextFileWithAutoEncodingResult } from '../services/textFileReader';
import {
  DEFAULT_DETAIL_LEVEL,
  getDetailConstraints,
  type ConstructionDetailLevel,
} from '../services/construction/quality';
import { readNovelCharacterDraft } from '../services/construction/characterDraftAdapter';
import { useThemeStore } from '../store/themeStore';

type BuildMode = 'independent' | 'fromWorldbook' | 'fromCharacter' | 'fromText';
type IndependentTarget = 'character' | 'worldbook' | 'preset';
type GenerateStatus = 'idle' | 'queued' | 'running' | 'preview';

interface SourceState {
  kind: 'worldbook' | 'character' | 'text';
  name: string;
  /** 喂给模型的来源快照文本（一次性参考，不落库）。 */
  snapshot: string;
  entryCount?: number;
  /** 预计输入 Token（来源快照本身的估算，用于展示）。 */
  tokens: number;
  sections?: TextSourceSection[];
  selectedSectionIds?: string[];
  encoding?: TextSourceEncoding;
}

const MODE_OPTIONS: { value: BuildMode; label: string }[] = [
  { value: 'independent', label: '独立构建' },
  { value: 'fromWorldbook', label: '由世界书' },
  { value: 'fromCharacter', label: '由角色卡' },
  { value: 'fromText', label: '由 TXT' },
];

const TARGET_OPTIONS: { value: IndependentTarget; label: string }[] = [
  { value: 'character', label: '角色卡' },
  { value: 'worldbook', label: '世界书' },
  { value: 'preset', label: '预设' },
];

const DETAIL_OPTIONS: { value: ConstructionDetailLevel; label: string }[] = [
  { value: 'compact', label: '紧凑' },
  { value: 'full', label: '丰满' },
  { value: 'deep', label: '深度' },
];

function formatGenerationError(error: unknown): string {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message || '')
      : '';

  // 认证失败在构建页中最常见，也最容易因 Toast 自动消失而被误判为“没有结果”。
  // 不回显服务端原文，避免将请求中的凭据片段再次展示给用户。
  if (/\b401\b|authentication\s+fails|invalid\s+(api\s*)?key/i.test(message)) {
    return 'API 认证失败（HTTP 401）。请在 LLM 设置中更新 API Key，并使用「保存并测试」确认连接后再生成。';
  }

  return message || '请检查 LLM 配置与网络后重试。';
}

export const BuildScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const { llmConfig } = useSettingsStore();
  const currentProject = useProjectStore(state => state.currentProject);

  const [mode, setMode] = useState<BuildMode>('independent');
  const [independentTarget, setIndependentTarget] =
    useState<IndependentTarget>('character');
  const [importingToLibrary, setImportingToLibrary] = useState(false);

  // 独立角色卡字段
  const [charName, setCharName] = useState('');
  const [charTheme, setCharTheme] = useState('');
  const [charRole, setCharRole] = useState('');
  const [charIdentity, setCharIdentity] = useState('');
  const [charAppearance, setCharAppearance] = useState('');
  const [charBackground, setCharBackground] = useState('');
  const [charPersonality, setCharPersonality] = useState('');
  const [charMotivation, setCharMotivation] = useState('');
  const [charConflict, setCharConflict] = useState('');
  const [charRelationships, setCharRelationships] = useState('');
  // 独立世界书字段
  const [wbName, setWbName] = useState('');
  const [wbTheme, setWbTheme] = useState('');
  const [wbWorldview, setWbWorldview] = useState('');
  const [wbCategories, setWbCategories] = useState('');
  const [wbImpactScope, setWbImpactScope] = useState('');
  const [wbForbiddenRules, setWbForbiddenRules] = useState('');
  const [wbStableRelations, setWbStableRelations] = useState('');
  // 独立作家风格预设字段
  const [presetName, setPresetName] = useState('');
  const [presetGenre, setPresetGenre] = useState('');
  const [presetAudience, setPresetAudience] = useState('');
  const [presetPointOfView, setPresetPointOfView] = useState('');
  const [presetNarratorDistance, setPresetNarratorDistance] = useState('');
  const [presetLanguageTexture, setPresetLanguageTexture] = useState('');
  const [presetSyntax, setPresetSyntax] = useState('');
  const [presetVocabulary, setPresetVocabulary] = useState('');
  const [presetParagraphStructure, setPresetParagraphStructure] = useState('');
  const [presetSceneEnvironment, setPresetSceneEnvironment] = useState('');
  const [presetCharacterVoice, setPresetCharacterVoice] = useState('');
  const [presetDialogue, setPresetDialogue] = useState('');
  const [presetPacing, setPresetPacing] = useState('');
  const [presetConflict, setPresetConflict] = useState('');
  const [presetSuspense, setPresetSuspense] = useState('');
  const [presetChapterStructure, setPresetChapterStructure] = useState('');
  const [presetImagery, setPresetImagery] = useState('');
  const [presetSensory, setPresetSensory] = useState('');
  const [presetProhibitions, setPresetProhibitions] = useState('');
  // 通用补充需求
  const [extra, setExtra] = useState('');
  const [entryCount, setEntryCount] = useState(DEFAULT_ENTRY_COUNT);
  const [detailLevel, setDetailLevel] =
    useState<ConstructionDetailLevel>(DEFAULT_DETAIL_LEVEL);

  const [reservePercent, setReservePercent] = useState(DEFAULT_RESERVE_PERCENT);
  const [source, setSource] = useState<SourceState | null>(null);
  const [status, setStatus] = useState<GenerateStatus>('idle');
  const [queueLabel, setQueueLabel] = useState<string>('');
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<ConstructionArtifact | null>(null);
  const [showJson, setShowJson] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastAutoBudgetSignature = useRef<string | null>(null);
  // 分批生成时跟踪当前批次，供 onQueueState 拼接「第 X/Y 批」前缀。
  const batchProgressRef = useRef<{
    current: number;
    total: number;
  } | null>(null);

  const target: IndependentTarget = useMemo(() => {
    if (mode === 'fromWorldbook') return 'character';
    if (mode === 'fromCharacter') return 'worldbook';
    return independentTarget;
  }, [mode, independentTarget]);

  // ---------- 在线 LLM 前置校验（SPEC §6.1） ----------
  const llmCheck = useMemo(() => {
    const complete =
      !!llmConfig.base_url.trim() &&
      !!llmConfig.api_key.trim() &&
      !!llmConfig.model_name.trim();
    if (!complete) {
      return {
        ready: false,
        reason:
          '当前在线 LLM 配置不完整（缺少接口地址、API Key 或模型名），请前往 LLM 设置补全。',
      };
    }
    return { ready: true, reason: '' };
  }, [llmConfig]);

  const budget = useMemo(
    () =>
      computeConstructionBudget({
        contextWindow: llmConfig.context_window,
        maxOutputTokens: llmConfig.max_output_tokens,
        reservePercent,
        target,
        detailLevel,
        entryCount: target === 'worldbook' ? entryCount : undefined,
      }),
    [llmConfig, reservePercent, target, entryCount, detailLevel],
  );

  // 初始进入或切换规模/目标时，提高到刚好可生成的预留；用户手动调低后保留其选择并给出阻断提示。
  const autoBudgetSignature = `${mode}:${target}:${detailLevel}:${entryCount}`;
  useEffect(() => {
    if (lastAutoBudgetSignature.current === autoBudgetSignature) return;
    lastAutoBudgetSignature.current = autoBudgetSignature;
    if (
      budget.minReservePercent != null &&
      budget.reservePercent < budget.minReservePercent
    ) {
      setReservePercent(budget.minReservePercent);
    }
  }, [autoBudgetSignature, budget.minReservePercent, budget.reservePercent]);

  // ---------- 组装 ConstructionInput ----------
  const independentCharFilled = [
    charName,
    charTheme,
    charRole,
    charIdentity,
    charAppearance,
    charBackground,
    charPersonality,
    charMotivation,
    charConflict,
    charRelationships,
    extra,
  ].some(v => v.trim().length > 0);
  const independentPresetFilled = [
    presetName,
    presetGenre,
    presetAudience,
    presetPointOfView,
    presetNarratorDistance,
    presetLanguageTexture,
    presetSyntax,
    presetVocabulary,
    presetParagraphStructure,
    presetSceneEnvironment,
    presetCharacterVoice,
    presetDialogue,
    presetPacing,
    presetConflict,
    presetSuspense,
    presetChapterStructure,
    presetImagery,
    presetSensory,
    presetProhibitions,
    extra,
  ].some(v => v.trim().length > 0);

  const input: ConstructionInput | null = useMemo(() => {
    if (mode === 'independent') {
      if (target === 'character') {
        if (!independentCharFilled) return null;
        return {
          mode: 'character_independent',
          name: charName,
          theme: charTheme,
          role: charRole,
          identity: charIdentity,
          appearance: charAppearance,
          background: charBackground,
          personality: charPersonality,
          motivation: charMotivation,
          conflict: charConflict,
          relationships: charRelationships,
          extra,
          detailLevel,
        };
      }
      if (target === 'preset') {
        if (!independentPresetFilled) return null;
        return {
          mode: 'preset_independent',
          name: presetName,
          genre: presetGenre,
          audience: presetAudience,
          pointOfView: presetPointOfView,
          narratorDistance: presetNarratorDistance,
          languageTexture: presetLanguageTexture,
          syntax: presetSyntax,
          vocabulary: presetVocabulary,
          paragraphStructure: presetParagraphStructure,
          sceneEnvironment: presetSceneEnvironment,
          characterVoice: presetCharacterVoice,
          dialogue: presetDialogue,
          pacing: presetPacing,
          conflict: presetConflict,
          suspense: presetSuspense,
          chapterStructure: presetChapterStructure,
          imagery: presetImagery,
          sensory: presetSensory,
          prohibitions: presetProhibitions,
          extra,
          detailLevel,
        };
      }
      return {
        mode: 'worldbook_independent',
        name: wbName,
        theme: wbTheme,
        worldview: wbWorldview,
        categories: wbCategories,
        impactScope: wbImpactScope,
        forbiddenRules: wbForbiddenRules,
        stableRelations: wbStableRelations,
        extra,
        entryCount: clampEntryCount(entryCount),
        detailLevel,
      };
    }
    if (!source) return null;
    if (mode === 'fromWorldbook') {
      return {
        mode: 'character_from_worldbook',
        sourceSnapshot: source.snapshot,
        sourceName: source.name,
        extra,
        detailLevel,
      };
    }
    if (mode === 'fromCharacter') {
      return {
        mode: 'worldbook_from_character',
        sourceSnapshot: source.snapshot,
        sourceName: source.name,
        extra,
        entryCount: clampEntryCount(entryCount),
        detailLevel,
      };
    }
    if (mode === 'fromText' && target === 'character') {
      return {
        mode: 'character_from_text',
        sourceSnapshot: source.snapshot,
        sourceName: source.name,
        extra,
        detailLevel,
      };
    }
    if (mode === 'fromText' && target === 'preset') {
      return {
        mode: 'preset_from_text',
        sourceSnapshot: source.snapshot,
        sourceName: source.name,
        extra,
        detailLevel,
      };
    }
    if (mode === 'fromText') {
      return {
        mode: 'worldbook_from_text',
        sourceSnapshot: source.snapshot,
        sourceName: source.name,
        extra,
        entryCount: clampEntryCount(entryCount),
        detailLevel,
      };
    }
    return null;
  }, [
    mode,
    target,
    independentCharFilled,
    independentPresetFilled,
    charName,
    charTheme,
    charRole,
    charIdentity,
    charAppearance,
    charBackground,
    charPersonality,
    charMotivation,
    charConflict,
    charRelationships,
    extra,
    wbName,
    wbTheme,
    wbWorldview,
    wbCategories,
    wbImpactScope,
    wbForbiddenRules,
    wbStableRelations,
    presetName,
    presetGenre,
    presetAudience,
    presetPointOfView,
    presetNarratorDistance,
    presetLanguageTexture,
    presetSyntax,
    presetVocabulary,
    presetParagraphStructure,
    presetSceneEnvironment,
    presetCharacterVoice,
    presetDialogue,
    presetPacing,
    presetConflict,
    presetSuspense,
    presetChapterStructure,
    presetImagery,
    presetSensory,
    presetProhibitions,
    entryCount,
    source,
    detailLevel,
  ]);

  const inputTokens = input ? estimateConstructionInputTokens(input) : 0;
  const sourceOverBudget =
    llmCheck.ready &&
    budget.sourceBudget > 0 &&
    inputTokens > budget.sourceBudget;

  const canGenerate =
    llmCheck.ready &&
    budget.generatable &&
    !sourceOverBudget &&
    input !== null &&
    status !== 'running' &&
    status !== 'queued';

  // ---------- 切换模式 / 目标时恢复默认并清空产物（SPEC §6.2） ----------
  const resetToDefaults = (
    nextMode: BuildMode,
    nextTarget: IndependentTarget,
  ) => {
    setReservePercent(DEFAULT_RESERVE_PERCENT);
    setArtifact(null);
    setStatus('idle');
    setSource(null);
    if (nextMode === 'independent' && nextTarget === 'worldbook') {
      setEntryCount(
        getDetailConstraints(detailLevel).worldbook.defaultEntryCount,
      );
    }
    if (nextMode !== 'independent') {
      setEntryCount(
        getDetailConstraints(detailLevel).worldbook.defaultEntryCount,
      );
    }
  };

  const handleModeChange = (next: BuildMode) => {
    setMode(next);
    resetToDefaults(next, target);
  };
  const handleTargetChange = (next: IndependentTarget) => {
    setIndependentTarget(next);
    resetToDefaults('independent', next);
  };

  const handleDetailLevelChange = (next: ConstructionDetailLevel) => {
    setDetailLevel(next);
    setArtifact(null);
    setStatus('idle');
    if (target === 'worldbook') {
      setEntryCount(getDetailConstraints(next).worldbook.defaultEntryCount);
    }
  };

  const handleEntryStep = (delta: number) => {
    setEntryCount(prev => clampEntryCount(prev + delta));
    setArtifact(null);
    setStatus('idle');
  };

  // ---------- 来源文件选择 ----------
  const pickWorldbookSource = async () => {
    let copiedPath: string | null = null;
    try {
      const file = await pickSourceFile([types.json]);
      if (!file) return;
      copiedPath = file.localPath;
      const text = await RNFS.readFile(file.localPath, 'utf8');
      const parsed = parseWorldBookJSON(text, file.name);
      const snapshot = buildWorldbookSourceSnapshot({
        name: parsed.name,
        entries: parsed.entries as unknown as Array<Record<string, unknown>>,
      });
      setSource({
        kind: 'worldbook',
        name: parsed.name,
        snapshot,
        entryCount: parsed.entries.length,
        tokens: estimateConstructionInputTokens({
          mode: 'character_from_worldbook',
          sourceSnapshot: snapshot,
          extra,
        }),
      });
      setArtifact(null);
      setStatus('idle');
      Toast.show({
        type: 'success',
        text1: '已读取世界书来源',
        text2: `${parsed.entries.length} 条条目`,
      });
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: '来源格式错误',
        text2: error?.message || '无法解析该世界书文件。',
      });
    } finally {
      // pickSourceFile 总是把用户文件复制到 cachesDirectory；解析为快照后不再需要。
      if (copiedPath) RNFS.unlink(copiedPath).catch(() => {});
    }
  };

  const pickCharacterSource = async () => {
    let copiedPath: string | null = null;
    try {
      const file = await pickSourceFile([types.json, types.images]);
      if (!file) return;
      copiedPath = file.localPath;
      const isPng =
        file.name.toLowerCase().endsWith('.png') ||
        file.mimeType === 'image/png';
      const payload = isPng
        ? await parseCharacterCardPNG(file.localPath)
        : parseCharacterCardJSON(
            await RNFS.readFile(file.localPath, 'utf8'),
            file.name,
          );
      const snapshot = buildCharacterSourceSnapshot({
        name: payload.name,
        data: payload.data,
      });
      setSource({
        kind: 'character',
        name: payload.name,
        snapshot,
        tokens: estimateConstructionInputTokens({
          mode: 'worldbook_from_character',
          sourceSnapshot: snapshot,
          entryCount: clampEntryCount(entryCount),
        }),
      });
      setArtifact(null);
      setStatus('idle');
      Toast.show({
        type: 'success',
        text1: '已读取角色卡来源',
        text2: payload.name,
      });
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: '来源格式错误',
        text2: error?.message || '无法解析该角色卡文件。',
      });
    } finally {
      // 角色卡来源同样只保留内存中的解析快照，避免缓存文件累积。
      if (copiedPath) RNFS.unlink(copiedPath).catch(() => {});
    }
  };

  const pickTextSource = async () => {
    let copiedPath: string | null = null;
    try {
      const file = await pickSourceFile([types.plainText, types.allFiles]);
      if (!file) return;
      copiedPath = file.localPath;
      const isText =
        /\.txt$/i.test(file.name) || file.mimeType === 'text/plain';
      if (!isText) throw new Error('请选择扩展名为 .txt 的文本文件。');
      // Keep TXT sources on the same native, chunked decoder as note and
      // continuation imports. RNFS' utf8/base64 path rejects common Windows
      // GBK/GB18030 text with “Invalid UTF-8 detected”.
      const decoded = await readTextFileWithAutoEncodingResult(file.localPath);
      const parsed = parseConstructionTextSource(
        decoded.text,
        file.name,
        decoded.encoding,
      );
      const selectedSectionIds = parsed.sections.map(section => section.id);
      const snapshot = buildTextSourceSnapshot(parsed, selectedSectionIds);
      const sourceInput =
        target === 'character'
          ? {
              mode: 'character_from_text' as const,
              sourceSnapshot: snapshot,
              detailLevel,
            }
          : target === 'preset'
            ? {
                mode: 'preset_from_text' as const,
                sourceSnapshot: snapshot,
                detailLevel,
              }
          : {
              mode: 'worldbook_from_text' as const,
              sourceSnapshot: snapshot,
              entryCount: clampEntryCount(entryCount),
              detailLevel,
            };
      setSource({
        kind: 'text',
        name: parsed.name,
        snapshot,
        tokens: estimateConstructionInputTokens(sourceInput),
        sections: parsed.sections,
        selectedSectionIds,
        encoding: parsed.encoding,
      });
      setArtifact(null);
      setStatus('idle');
      Toast.show({
        type: 'success',
        text1: '已读取 TXT 素材',
        text2: `${
          parsed.sections.length
        } 个可选片段 · ${parsed.encoding.toUpperCase()}`,
      });
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: 'TXT 解析失败',
        text2: error?.message || '无法读取该 TXT 文件。',
      });
    } finally {
      if (copiedPath) RNFS.unlink(copiedPath).catch(() => {});
    }
  };

  const toggleTextSection = (sectionId: string) => {
    setSource(previous => {
      if (!previous || previous.kind !== 'text' || !previous.sections)
        return previous;
      const selected = new Set(previous.selectedSectionIds || []);
      if (selected.has(sectionId)) selected.delete(sectionId);
      else selected.add(sectionId);
      const selectedSectionIds = previous.sections
        .map(section => section.id)
        .filter(id => selected.has(id));
      if (selectedSectionIds.length === 0) {
        Toast.show({ type: 'info', text1: '请至少保留一个 TXT 片段' });
        return previous;
      }
      const parsed = {
        name: previous.name,
        encoding: previous.encoding || 'utf-8',
        sections: previous.sections,
      };
      const snapshot = buildTextSourceSnapshot(parsed, selectedSectionIds);
      const sourceInput =
        target === 'character'
          ? {
              mode: 'character_from_text' as const,
              sourceSnapshot: snapshot,
              detailLevel,
            }
          : target === 'preset'
            ? {
                mode: 'preset_from_text' as const,
                sourceSnapshot: snapshot,
                detailLevel,
              }
          : {
              mode: 'worldbook_from_text' as const,
              sourceSnapshot: snapshot,
              entryCount: clampEntryCount(entryCount),
              detailLevel,
            };
      return {
        ...previous,
        snapshot,
        tokens: estimateConstructionInputTokens(sourceInput),
        selectedSectionIds,
      };
    });
    setArtifact(null);
    setStatus('idle');
  };

  // ---------- 生成 / 取消 ----------
  const handleGenerate = async () => {
    if (!input || !canGenerate) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('queued');
    setQueueLabel('排队中…');
    setArtifact(null);
    setGenerationError(null);
    batchProgressRef.current = null;
    try {
      const result = await generateConstruction(input, {
        maxTokens: budget.outputReserve,
        signal: controller.signal,
        onQueueState: state => {
          const batch = batchProgressRef.current;
          const prefix = batch
            ? `第 ${batch.current}/${batch.total} 批 · `
            : '';
          if (state === 'queued') {
            setQueueLabel(`${prefix}排队中…`);
            setStatus('queued');
          } else if (state === 'running') {
            setQueueLabel(`${prefix}生成中…`);
            setStatus('running');
          }
        },
        onBatchProgress: progress => {
          batchProgressRef.current = {
            current: progress.current,
            total: progress.total,
          };
          setQueueLabel(`第 ${progress.current}/${progress.total} 批 · 生成中…`);
          setStatus('running');
        },
      });
      setArtifact(result);
      setGenerationError(null);
      setStatus('preview');
    } catch (error: any) {
      if (controller.signal.aborted) {
        setGenerationError(null);
        Toast.show({ type: 'info', text1: '已取消生成' });
      } else {
        const message = formatGenerationError(error);
        setGenerationError(message);
        Toast.show({
          type: 'error',
          text1: '生成失败',
          text2: message,
        });
      }
      setStatus('idle');
    } finally {
      abortRef.current = null;
      setQueueLabel('');
      batchProgressRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleRegenerate = () => {
    setArtifact(null);
    setGenerationError(null);
    setStatus('idle');
  };

  // ---------- 保存到手机 ----------
  const handleSave = async () => {
    if (!artifact) return;
    try {
      const result = await saveConstructionArtifact(artifact);
      if (result.saved) {
        Toast.show({
          type: 'success',
          text1: '已保存到手机',
          text2: '也可点「导入资料库」直接写入当前项目。',
        });
      }
      // 用户取消保存：不显示成功提示，预览保持可操作状态。
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: '保存失败',
        text2: error?.message || '写入手机存储失败。',
      });
    }
  };

  // ---------- 直接导入资料库 ----------
  const handleImportToLibrary = async () => {
    if (!artifact || importingToLibrary) return;
    if (!currentProject?.id) {
      Toast.show({
        type: 'error',
        text1: '请先选择项目',
        text2: '导入资料库需要当前项目；请先在「项目」中打开一个项目。',
      });
      return;
    }
    setImportingToLibrary(true);
    try {
      const result = await importConstructionArtifactToLibrary(
        artifact,
        currentProject.id,
      );
      if (result.kind === 'character') {
        Toast.show({
          type: 'success',
          text1: '已导入资料库',
          text2: `角色卡「${result.name}」已写入并在当前项目启用。`,
        });
      } else if (result.kind === 'preset') {
        Toast.show({
          type: 'success',
          text1: '已导入资料库',
          text2: `预设「${result.name}」已加入我的预设。`,
        });
      } else {
        Toast.show({
          type: 'success',
          text1: '已导入资料库',
          text2: `世界书「${result.name}」· ${result.entriesImported} 条，已在当前项目启用。`,
        });
      }
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: '导入资料库失败',
        text2: error?.message || '写入资料库失败。',
      });
    } finally {
      setImportingToLibrary(false);
    }
  };

  const generating = status === 'queued' || status === 'running';

  return (
    <Screen>
      <Header
        title="构建"
        subtitle={
          currentProject
            ? `可保存到手机，或直接导入当前项目「${currentProject.name}」资料库。`
            : '可保存到手机；导入资料库前请先在「项目」中选择项目。'
        }
      />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* 在线 LLM 前置校验 */}
        {!llmCheck.ready ? (
          <Card>
            <View style={styles.row}>
              <FileQuestion size={20} color={theme.colors.accent} />
              <Text
                style={[styles.bodyText, { color: theme.colors.textPrimary }]}
              >
                {llmCheck.reason}
              </Text>
            </View>
            <Button
              label="前往 LLM 设置"
              icon={Wand2}
              onPress={navigateToLLMSettings}
            />
          </Card>
        ) : null}

        {/* 模式选择 */}
        <View style={styles.section}>
          <SegmentedControl
            value={mode}
            options={MODE_OPTIONS}
            onChange={handleModeChange}
          />
          {mode === 'independent' || mode === 'fromText' ? (
            <View style={styles.subTarget}>
              <Text
                style={[styles.label, { color: theme.colors.textSecondary }]}
              >
                目标类型
              </Text>
              <SegmentedControl
                value={independentTarget}
                options={TARGET_OPTIONS}
                onChange={handleTargetChange}
              />
            </View>
          ) : null}
          <View style={styles.subTarget}>
            <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
              内容丰满度
            </Text>
            <SegmentedControl
              value={detailLevel}
              options={DETAIL_OPTIONS}
              onChange={handleDetailLevelChange}
            />
            <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
              档位用于提示模型并分配输出预算；未完全达标的可用结果仍会保留，并显示补强建议。
            </Text>
          </View>
        </View>

        {/* 需求表单 / 来源选择 */}
        {llmCheck.ready && status !== 'preview' ? (
          <Card>
            {mode === 'independent' && target === 'character' ? (
              <IndependentCharacterForm
                name={charName}
                setName={setCharName}
                themeText={charTheme}
                setThemeText={setCharTheme}
                role={charRole}
                setRole={setCharRole}
                identity={charIdentity}
                setIdentity={setCharIdentity}
                appearance={charAppearance}
                setAppearance={setCharAppearance}
                background={charBackground}
                setBackground={setCharBackground}
                personality={charPersonality}
                setPersonality={setCharPersonality}
                motivation={charMotivation}
                setMotivation={setCharMotivation}
                conflict={charConflict}
                setConflict={setCharConflict}
                relationships={charRelationships}
                setRelationships={setCharRelationships}
              />
            ) : null}
            {mode === 'independent' && target === 'preset' ? (
              <IndependentPresetForm
                fields={[
                  { key: 'name', label: '预设名称', value: presetName, setValue: setPresetName, placeholder: '例如：克制悬疑叙事' },
                  { key: 'genre', label: '适用题材 / 类型', value: presetGenre, setValue: setPresetGenre, placeholder: '例如：都市悬疑、历史群像' },
                  { key: 'audience', label: '目标读者 / 整体气质', value: presetAudience, setValue: setPresetAudience },
                  { key: 'pointOfView', label: '叙述视角', value: presetPointOfView, setValue: setPresetPointOfView, multiline: true },
                  { key: 'narratorDistance', label: '叙述者距离', value: presetNarratorDistance, setValue: setPresetNarratorDistance, multiline: true },
                  { key: 'languageTexture', label: '语言质感', value: presetLanguageTexture, setValue: setPresetLanguageTexture, multiline: true },
                  { key: 'syntax', label: '句法倾向', value: presetSyntax, setValue: setPresetSyntax, multiline: true },
                  { key: 'vocabulary', label: '词汇倾向', value: presetVocabulary, setValue: setPresetVocabulary, multiline: true },
                  { key: 'paragraphStructure', label: '段落组织', value: presetParagraphStructure, setValue: setPresetParagraphStructure, multiline: true },
                  { key: 'sceneEnvironment', label: '场景与环境描写', value: presetSceneEnvironment, setValue: setPresetSceneEnvironment, multiline: true },
                  { key: 'characterVoice', label: '人物描写', value: presetCharacterVoice, setValue: setPresetCharacterVoice, multiline: true },
                  { key: 'dialogue', label: '对白与人物声音', value: presetDialogue, setValue: setPresetDialogue, multiline: true },
                  { key: 'pacing', label: '节奏', value: presetPacing, setValue: setPresetPacing, multiline: true },
                  { key: 'conflict', label: '冲突推进', value: presetConflict, setValue: setPresetConflict, multiline: true },
                  { key: 'suspense', label: '悬念 / 信息揭示 / 伏笔', value: presetSuspense, setValue: setPresetSuspense, multiline: true },
                  { key: 'chapterStructure', label: '章节结构', value: presetChapterStructure, setValue: setPresetChapterStructure, multiline: true },
                  { key: 'imagery', label: '意象', value: presetImagery, setValue: setPresetImagery, multiline: true },
                  { key: 'sensory', label: '感官', value: presetSensory, setValue: setPresetSensory, multiline: true },
                  { key: 'prohibitions', label: '禁止项 / 反模式', value: presetProhibitions, setValue: setPresetProhibitions, multiline: true },
                ]}
              />
            ) : null}
            {mode === 'independent' && target === 'worldbook' ? (
              <IndependentWorldbookForm
                name={wbName}
                setName={setWbName}
                themeText={wbTheme}
                setThemeText={setWbTheme}
                worldview={wbWorldview}
                setWorldview={setWbWorldview}
                categories={wbCategories}
                setCategories={setWbCategories}
                impactScope={wbImpactScope}
                setImpactScope={setWbImpactScope}
                forbiddenRules={wbForbiddenRules}
                setForbiddenRules={setWbForbiddenRules}
                stableRelations={wbStableRelations}
                setStableRelations={setWbStableRelations}
                entryCount={entryCount}
                onEntryStep={handleEntryStep}
              />
            ) : null}
            {mode === 'fromWorldbook' ? (
              <SourcePicker
                label="世界书来源文件"
                hint="作为一次性参考快照，不会保存路径或联动资料库。"
                buttonLabel={source ? '重新选择世界书' : '选择世界书 JSON'}
                onPick={pickWorldbookSource}
                source={source}
              />
            ) : null}
            {mode === 'fromCharacter' ? (
              <>
                <SourcePicker
                  label="角色卡来源文件"
                  hint="作为一次性参考快照，不会保存路径或联动资料库。"
                  buttonLabel={
                    source ? '重新选择角色卡' : '选择角色卡 JSON / PNG'
                  }
                  onPick={pickCharacterSource}
                  source={source}
                />
                <EntryCountStepper
                  entryCount={entryCount}
                  onStep={handleEntryStep}
                />
              </>
            ) : null}
            {mode === 'fromText' ? (
              <>
                <SourcePicker
                  label="TXT 素材来源"
                  hint="仅在点击生成后把当前勾选的内容发送给在线模型；不会保存路径、写入资料库或备份。"
                  buttonLabel={source ? '重新选择 TXT' : '选择 TXT'}
                  onPick={pickTextSource}
                  source={source}
                />
                {source?.kind === 'text' ? (
                  <TextSourceSections
                    sections={source.sections || []}
                    selectedIds={source.selectedSectionIds || []}
                    onToggle={toggleTextSection}
                  />
                ) : null}
                {target === 'worldbook' ? (
                  <EntryCountStepper
                    entryCount={entryCount}
                    onStep={handleEntryStep}
                  />
                ) : null}
              </>
            ) : null}

            <Field
              testID="build-extra"
              label="补充需求（可选）"
              value={extra}
              onChangeText={setExtra}
              placeholder="例如：职业、阵营、希望补充的稳定事实或关系"
              multiline
              inputStyle={styles.largeInput}
            />

            <BudgetPanel
              budget={budget}
              reservePercent={reservePercent}
              onChangeReserve={setReservePercent}
              inputTokens={inputTokens}
              sourceOverBudget={sourceOverBudget}
            />
          </Card>
        ) : null}

        {/* 生成状态 / 操作 */}
        {llmCheck.ready ? (
          <View style={styles.actions}>
            {generating ? (
              <>
                <Text
                  style={[
                    styles.statusText,
                    { color: theme.colors.textPrimary },
                  ]}
                >
                  {queueLabel || '生成中…'}
                </Text>
                <Button
                  label="取消生成"
                  icon={XCircle}
                  variant="danger"
                  onPress={handleCancel}
                />
              </>
            ) : status === 'preview' && artifact ? (
              <PreviewPanel
                artifact={artifact}
                onRegenerate={handleRegenerate}
                onBackToEdit={() => {
                  setArtifact(null);
                  setStatus('idle');
                }}
                onViewJson={() => setShowJson(true)}
                onSave={handleSave}
                onImportToLibrary={handleImportToLibrary}
                importingToLibrary={importingToLibrary}
              />
            ) : (
              <>
                <Button
                  testID="build-generate"
                  label="生成"
                  icon={Wand2}
                  onPress={handleGenerate}
                  disabled={!canGenerate}
                />
                {!budget.generatable ? (
                  <Text
                    style={[styles.hint, { color: theme.colors.textSecondary }]}
                  >
                    {budget.reason}
                  </Text>
                ) : null}
                {sourceOverBudget ? (
                  <Text style={[styles.hint, { color: theme.colors.danger }]}>
                    来源内容（约 {inputTokens.toLocaleString('en-US')}{' '}
                    Token）超过可用预算（
                    {budget.sourceBudget.toLocaleString('en-US')} Token）。TXT
                    可取消勾选片段；其他来源请选择更小文件，或使用上下文更大的在线模型。
                  </Text>
                ) : null}
                {mode === 'independent' &&
                target === 'character' &&
                !independentCharFilled ? (
                  <Text
                    style={[styles.hint, { color: theme.colors.textSecondary }]}
                  >
                    请至少填写一个有效的角色设定字段。
                  </Text>
                ) : null}
                {mode === 'independent' &&
                target === 'preset' &&
                !independentPresetFilled ? (
                  <Text
                    style={[styles.hint, { color: theme.colors.textSecondary }]}
                  >
                    请至少填写一个有效的预设构建要求。
                  </Text>
                ) : null}
                {mode !== 'independent' && !source ? (
                  <Text
                    style={[styles.hint, { color: theme.colors.textSecondary }]}
                  >
                    请先选择来源文件。
                  </Text>
                ) : null}
                {generationError ? (
                  <View
                    testID="build-generation-error"
                    style={[
                      styles.generationError,
                      { borderColor: theme.colors.danger },
                    ]}
                  >
                    <Text
                      style={[
                        styles.generationErrorTitle,
                        { color: theme.colors.danger },
                      ]}
                    >
                      生成失败
                    </Text>
                    <Text
                      style={[styles.hint, { color: theme.colors.textPrimary }]}
                    >
                      {generationError}
                    </Text>
                    <View style={styles.generationErrorActions}>
                      <Button
                        testID="build-generation-error-settings"
                        label="前往 LLM 设置"
                        compact
                        variant="secondary"
                        onPress={navigateToLLMSettings}
                      />
                      <Button
                        label="关闭提示"
                        compact
                        variant="ghost"
                        onPress={() => setGenerationError(null)}
                      />
                    </View>
                  </View>
                ) : null}
              </>
            )}
          </View>
        ) : null}
      </ScrollView>

      <Modal
        visible={showJson}
        transparent
        animationType="fade"
        onRequestClose={() => setShowJson(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setShowJson(false)}
          />
          <View
            style={[
              styles.jsonModal,
              { backgroundColor: theme.colors.surface },
            ]}
          >
            <Text
              style={[styles.modalTitle, { color: theme.colors.textPrimary }]}
            >
              产物 JSON
            </Text>
            <ScrollView style={styles.jsonScroll}>
              <Text
                style={[styles.jsonText, { color: theme.colors.textSecondary }]}
              >
                  {artifact
                  ? JSON.stringify(
                      artifact.kind === 'character'
                        ? artifact.card
                        : artifact.kind === 'worldbook'
                          ? artifact.lorebook
                          : artifact.preset,
                      null,
                      2,
                    )
                  : ''}
              </Text>
            </ScrollView>
            <View style={styles.modalActions}>
              <Button
                label="关闭"
                variant="ghost"
                onPress={() => setShowJson(false)}
              />
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
};

// ---------- 子组件 ----------

const IndependentCharacterForm: React.FC<{
  name: string;
  setName: (v: string) => void;
  themeText: string;
  setThemeText: (v: string) => void;
  role: string;
  setRole: (v: string) => void;
  identity: string;
  setIdentity: (v: string) => void;
  appearance: string;
  setAppearance: (v: string) => void;
  background: string;
  setBackground: (v: string) => void;
  personality: string;
  setPersonality: (v: string) => void;
  motivation: string;
  setMotivation: (v: string) => void;
  conflict: string;
  setConflict: (v: string) => void;
  relationships: string;
  setRelationships: (v: string) => void;
}> = ({
  name,
  setName,
  themeText,
  setThemeText,
  role,
  setRole,
  identity,
  setIdentity,
  appearance,
  setAppearance,
  background,
  setBackground,
  personality,
  setPersonality,
  motivation,
  setMotivation,
  conflict,
  setConflict,
  relationships,
  setRelationships,
}) => (
  <>
    <Field
      testID="build-char-name"
      label="角色名称（可选）"
      value={name}
      onChangeText={setName}
      placeholder="例如：沈砚"
    />
    <Field
      testID="build-char-theme"
      label="题材 / 时代"
      value={themeText}
      onChangeText={setThemeText}
      placeholder="例如：蒸汽雾港"
    />
    <Field
      testID="build-char-role"
      label="角色定位"
      value={role}
      onChangeText={setRole}
      placeholder="例如：反派机关师"
    />
    <Field
      testID="build-char-identity"
      label="身份 / 社会位置"
      value={identity}
      onChangeText={setIdentity}
      multiline
      inputStyle={styles.mediumInput}
      placeholder="例如：旧王朝遗民、港口工会登记的修理师"
    />
    <Field
      testID="build-char-background"
      label="成长环境 / 关键经历"
      value={background}
      onChangeText={setBackground}
      multiline
      inputStyle={styles.mediumInput}
      placeholder="例如：在雾港底层长大，经历过一次工坊事故"
    />
    <Field
      testID="build-char-appearance"
      label="外貌与辨识特征（可选）"
      value={appearance}
      onChangeText={setAppearance}
      multiline
      inputStyle={styles.mediumInput}
      placeholder="例如：左手戴银色义肢，衣领总有机油味"
    />
    <Field
      testID="build-char-personality"
      label="核心性格"
      value={personality}
      onChangeText={setPersonality}
      multiline
      inputStyle={styles.largeInput}
      placeholder="例如：表面温和，遇到背叛会冷静记账"
    />
    <Field
      testID="build-char-motivation"
      label="目标 / 动机"
      value={motivation}
      onChangeText={setMotivation}
      multiline
      inputStyle={styles.mediumInput}
      placeholder="例如：找到导致工坊事故的真正责任人"
    />
    <Field
      testID="build-char-conflict"
      label="主要矛盾 / 弱点"
      value={conflict}
      onChangeText={setConflict}
      multiline
      inputStyle={styles.mediumInput}
      placeholder="例如：不信任权威，却必须依赖工会资源"
    />
    <Field
      testID="build-char-relationships"
      label="关键关系（可选）"
      value={relationships}
      onChangeText={setRelationships}
      multiline
      inputStyle={styles.mediumInput}
      placeholder="例如：与工会会长合作但互相提防；与妹妹保持秘密通信"
    />
  </>
);

interface PresetFormField {
  key: string;
  label: string;
  value: string;
  setValue: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
}

const IndependentPresetForm: React.FC<{ fields: PresetFormField[] }> = ({
  fields,
}) => {
  const { theme } = useThemeStore();
  return (
    <>
      <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
        可按需填写；生成结果会把这些要求抽象成系统提示词、写作风格和额外约束三部分。
      </Text>
      {fields.map(field => (
        <Field
          key={field.key}
          testID={`build-preset-${field.key}`}
          label={field.label}
          value={field.value}
          onChangeText={field.setValue}
          placeholder={field.placeholder}
          multiline={field.multiline}
          inputStyle={field.multiline ? styles.mediumInput : undefined}
        />
      ))}
    </>
  );
};

const IndependentWorldbookForm: React.FC<{
  name: string;
  setName: (v: string) => void;
  themeText: string;
  setThemeText: (v: string) => void;
  worldview: string;
  setWorldview: (v: string) => void;
  categories: string;
  setCategories: (v: string) => void;
  impactScope: string;
  setImpactScope: (v: string) => void;
  forbiddenRules: string;
  setForbiddenRules: (v: string) => void;
  stableRelations: string;
  setStableRelations: (v: string) => void;
  entryCount: number;
  onEntryStep: (delta: number) => void;
}> = ({
  name,
  setName,
  themeText,
  setThemeText,
  worldview,
  setWorldview,
  categories,
  setCategories,
  impactScope,
  setImpactScope,
  forbiddenRules,
  setForbiddenRules,
  stableRelations,
  setStableRelations,
  entryCount,
  onEntryStep,
}) => (
  <>
    <Field
      testID="build-wb-name"
      label="世界书名称（可选）"
      value={name}
      onChangeText={setName}
      placeholder="例如：雾港纪事"
    />
    <Field
      testID="build-wb-theme"
      label="题材 / 时代"
      value={themeText}
      onChangeText={setThemeText}
      placeholder="例如：蒸汽雾港"
    />
    <Field
      testID="build-wb-worldview"
      label="核心世界观"
      value={worldview}
      onChangeText={setWorldview}
      multiline
      inputStyle={styles.largeInput}
      placeholder="例如：海雾笼罩的港口城邦，机械与旧贵族共同维持秩序"
    />
    <Field
      testID="build-wb-categories"
      label="重点覆盖领域"
      value={categories}
      onChangeText={setCategories}
      placeholder="例如：地点、组织、世界铁律"
    />
    <Field
      testID="build-wb-impact-scope"
      label="影响范围 / 长期世界后果"
      value={impactScope}
      onChangeText={setImpactScope}
      multiline
      inputStyle={styles.mediumInput}
      placeholder="例如：影响整座港口城的贸易、夜间治安和市民传闻"
    />
    <Field
      testID="build-wb-forbidden-rules"
      label="不可违反的规则"
      value={forbiddenRules}
      onChangeText={setForbiddenRules}
      multiline
      inputStyle={styles.mediumInput}
      placeholder="例如：雾灯熄灭后，任何机械不得自行启动"
    />
    <Field
      testID="build-wb-stable-relations"
      label="稳定关系（可选）"
      value={stableRelations}
      onChangeText={setStableRelations}
      multiline
      inputStyle={styles.mediumInput}
      placeholder="例如：工会控制维修许可，旧贵族控制航运税"
    />
    <EntryCountStepper entryCount={entryCount} onStep={onEntryStep} />
  </>
);

const EntryCountStepper: React.FC<{
  entryCount: number;
  onStep: (delta: number) => void;
}> = ({ entryCount, onStep }) => {
  const { theme } = useThemeStore();
  return (
    <View style={styles.stepperRow}>
      <Text style={[styles.stepperLabel, { color: theme.colors.textPrimary }]}>
        世界书条目数量
      </Text>
      <View style={styles.stepperControls}>
        <Button
          label="−"
          compact
          onPress={() => onStep(-1)}
          disabled={entryCount <= WORLDBOOK_ENTRY_MIN}
        />
        <Text
          style={[styles.stepperValue, { color: theme.colors.textPrimary }]}
        >
          {entryCount}
        </Text>
        <Button
          label="+"
          compact
          onPress={() => onStep(1)}
          disabled={entryCount >= WORLDBOOK_ENTRY_MAX}
        />
      </View>
    </View>
  );
};

const SourcePicker: React.FC<{
  label: string;
  hint: string;
  buttonLabel: string;
  onPick: () => void;
  source: SourceState | null;
}> = ({ label, hint, buttonLabel, onPick, source }) => {
  const { theme } = useThemeStore();
  return (
    <View style={styles.sourceBlock}>
      <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
        {label}
      </Text>
      <Text style={[styles.hint, { color: theme.colors.textMuted }]}>
        {hint}
      </Text>
      <Button
        label={buttonLabel}
        icon={Download}
        variant="secondary"
        onPress={onPick}
      />
      {source ? (
        <View style={styles.sourceSummary}>
          <Text
            style={[styles.sourceName, { color: theme.colors.textPrimary }]}
          >
            {source.name}
          </Text>
          <Text
            style={[styles.sourceMeta, { color: theme.colors.textSecondary }]}
          >
            {source.kind === 'worldbook'
              ? `${source.entryCount ?? 0} 条条目 · `
              : source.kind === 'text'
              ? `${source.selectedSectionIds?.length ?? 0}/${
                  source.sections?.length ?? 0
                } 个片段 · ${source.encoding?.toUpperCase() || 'TXT'} · `
              : '角色卡 · '}
            预计输入 {source.tokens.toLocaleString('en-US')} Token
          </Text>
        </View>
      ) : null}
    </View>
  );
};

const TextSourceSections: React.FC<{
  sections: TextSourceSection[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}> = ({ sections, selectedIds, onToggle }) => {
  const { theme } = useThemeStore();
  const selected = new Set(selectedIds);
  return (
    <View style={styles.textSections}>
      <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
        用于生成的 TXT 片段
      </Text>
      {sections.map(section => {
        const active = selected.has(section.id);
        return (
          <Pressable
            key={section.id}
            testID={`build-text-section-${section.id}`}
            onPress={() => onToggle(section.id)}
            style={[
              styles.textSection,
              {
                borderColor: active ? theme.colors.accent : theme.colors.border,
              },
            ]}
          >
            <Text
              style={[
                styles.textSectionTitle,
                { color: theme.colors.textPrimary },
              ]}
            >
              {active ? '☑' : '☐'} {section.title}
            </Text>
            <Text
              style={[
                styles.textSectionMeta,
                { color: theme.colors.textSecondary },
              ]}
            >
              {section.estimatedTokens.toLocaleString('en-US')} Token
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
};

const BudgetPanel: React.FC<{
  budget: ReturnType<typeof computeConstructionBudget>;
  reservePercent: number;
  onChangeReserve: (v: number) => void;
  inputTokens: number;
  sourceOverBudget: boolean;
}> = ({
  budget,
  reservePercent,
  onChangeReserve,
  inputTokens,
  sourceOverBudget,
}) => {
  const { theme } = useThemeStore();
  return (
    <View style={styles.budgetBlock}>
      <Text style={[styles.budgetTitle, { color: theme.colors.textSecondary }]}>
        输出预留
      </Text>
      <ConstructionSlider
        testID="build-reserve-slider"
        min={RESERVE_PERCENT_MIN}
        max={RESERVE_PERCENT_MAX}
        value={clampPercent(reservePercent)}
        onChange={v => onChangeReserve(clampPercent(v))}
      />
      <Text style={[styles.budgetValue, { color: theme.colors.accent }]}>
        {formatReserveLabel(budget.reservePercent, budget.outputReserve)}
      </Text>
      <View style={styles.budgetGrid}>
        <BudgetCell
          label="上下文容量"
          value={budget.contextWindow.toLocaleString('en-US')}
        />
        <BudgetCell
          label={`${getDetailConstraints(budget.detailLevel).label}档生成目标`}
          value={budget.requiredMinOutput.toLocaleString('en-US')}
        />
        <BudgetCell
          label="输出预留"
          value={budget.outputReserve.toLocaleString('en-US')}
        />
        <BudgetCell
          label="来源预算"
          value={budget.sourceBudget.toLocaleString('en-US')}
        />
        <BudgetCell
          label="预计输入"
          value={inputTokens.toLocaleString('en-US')}
          danger={sourceOverBudget}
        />
      </View>
      {budget.cappedByMaxOutput ? (
        <Text
          style={[styles.budgetNote, { color: theme.colors.textSecondary }]}
        >
          已受当前 LLM 最大输出 Token 限制。
        </Text>
      ) : null}
      {!budget.generatable ? (
        <Text style={[styles.budgetNote, { color: theme.colors.danger }]}>
          {budget.reason}
        </Text>
      ) : null}
    </View>
  );
};

const BudgetCell: React.FC<{
  label: string;
  value: string;
  danger?: boolean;
}> = ({ label, value, danger }) => {
  const { theme } = useThemeStore();
  return (
    <View style={[styles.budgetCell, { borderColor: theme.colors.border }]}>
      <Text
        style={[styles.budgetCellLabel, { color: theme.colors.textSecondary }]}
      >
        {label}
      </Text>
      <Text
        style={[
          styles.budgetCellValue,
          danger
            ? { color: theme.colors.danger }
            : { color: theme.colors.textPrimary },
        ]}
      >
        {value}
      </Text>
    </View>
  );
};

const PreviewPanel: React.FC<{
  artifact: ConstructionArtifact;
  onRegenerate: () => void;
  onBackToEdit: () => void;
  onViewJson: () => void;
  onSave: () => void;
  onImportToLibrary: () => void;
  importingToLibrary: boolean;
}> = ({
  artifact,
  onRegenerate,
  onBackToEdit,
  onViewJson,
  onSave,
  onImportToLibrary,
  importingToLibrary,
}) => {
  const { theme } = useThemeStore();
  const qualityReport = artifact.qualityReport;
  const qualityLabel = qualityReport
    ? getDetailConstraints(qualityReport.detailLevel).label
    : '';
  return (
    <Card>
      {qualityReport && !qualityReport.passed ? (
        <View
          testID="build-quality-warning"
          style={[styles.qualityWarning, { borderColor: theme.colors.warning }]}
        >
          <Text
            style={[
              styles.qualityWarningTitle,
              { color: theme.colors.warning },
            ]}
          >
            未完全达到“{qualityLabel}”目标，已保留本次结果
          </Text>
          <Text style={[styles.hint, { color: theme.colors.textPrimary }]}>
            实际约 {qualityReport.actualOutputTokens.toLocaleString('en-US')} /
            目标 {qualityReport.requiredMinOutput.toLocaleString('en-US')}{' '}
            Token。仍可预览、保存或导入；如需更丰富内容，可重新生成。
          </Text>
          {qualityReport.failures.length > 0 || qualityReport.warnings.length > 0 ? (
            <Text
              style={[styles.hint, { color: theme.colors.textSecondary }]}
              numberOfLines={3}
            >
              建议补强：
              {[...qualityReport.failures, ...qualityReport.warnings]
                .slice(0, 2)
                .map(item => item.message)
                .join('；')}
              {qualityReport.failures.length + qualityReport.warnings.length > 2
                ? `；另有 ${qualityReport.failures.length + qualityReport.warnings.length - 2} 项`
                : ''}
            </Text>
          ) : null}
        </View>
      ) : null}
      {artifact.kind === 'character' ? (
        <CharacterPreview artifact={artifact} />
      ) : artifact.kind === 'worldbook' ? (
        <WorldbookPreview artifact={artifact} />
      ) : (
        <PresetPreview artifact={artifact} />
      )}
      <View style={styles.previewActions}>
        <Button
          label="重新生成"
          icon={RefreshCw}
          variant="secondary"
          onPress={onRegenerate}
        />
        <Button label="返回修改" variant="ghost" onPress={onBackToEdit} />
        <Button
          label="查看 JSON"
          icon={Eye}
          variant="ghost"
          onPress={onViewJson}
        />
        <Button
          testID="build-import-library"
          label={importingToLibrary ? '导入中…' : '导入资料库'}
          icon={Library}
          onPress={onImportToLibrary}
          disabled={importingToLibrary}
        />
        <Button
          testID="build-save"
          label="保存到手机"
          icon={Download}
          variant="secondary"
          onPress={onSave}
          disabled={importingToLibrary}
        />
      </View>
    </Card>
  );
};

const CharacterPreview: React.FC<{
  artifact: Extract<ConstructionArtifact, { kind: 'character' }>;
}> = ({ artifact }) => {
  const { theme } = useThemeStore();
  const novel = readNovelCharacterDraft(artifact.card);
  const novelRows = novel
    ? [
        ['角色定位', novel.role],
        ['身份背景', novel.identity || novel.background],
        ['核心性格', novel.personality],
        ['动机', novel.motivation],
        ['矛盾', novel.conflict],
        ['关系', Array.isArray(novel.relationships) ? novel.relationships.join('、') : novel.relationships],
        ['人物弧', novel.arc],
        ['连续性事实', Array.isArray(novel.continuity) ? novel.continuity.join('、') : novel.continuity],
      ].filter(([, value]) => String(value || '').trim())
    : [];
  return (
    <View>
      <Text style={[styles.previewTitle, { color: theme.colors.textPrimary }]}>
        {artifact.card.data.name}
      </Text>
      {novelRows.length > 0
        ? novelRows.map(([label, value]) => (
            <Text key={label} style={[styles.previewText, { color: theme.colors.textSecondary }]}>
              {label}：{value}
            </Text>
          ))
        : artifact.card.data.description ? (
            <Text style={[styles.previewText, { color: theme.colors.textSecondary }]}>
              简介：{artifact.card.data.description}
            </Text>
          ) : null}
      {!novel && artifact.card.data.personality ? (
        <Text style={[styles.previewText, { color: theme.colors.textSecondary }]}>
          性格：{artifact.card.data.personality}
        </Text>
      ) : null}
      {artifact.card.data.tags.length > 0 ? (
        <Text
          style={[styles.previewText, { color: theme.colors.textSecondary }]}
        >
          标签：{artifact.card.data.tags.join('、')}
        </Text>
      ) : null}
      {!novel && artifact.card.data.first_mes ? (
        <Text
          style={[styles.previewText, { color: theme.colors.textSecondary }]}
          numberOfLines={4}
        >
          开场白：{artifact.card.data.first_mes}
        </Text>
      ) : null}
      {artifact.qualityReport?.character ? (
        <Text
          style={[styles.previewText, { color: theme.colors.textSecondary }]}
        >
          质量：约{' '}
          {artifact.qualityReport.actualOutputTokens.toLocaleString('en-US')}{' '}
          Token · 覆盖维度{' '}
          {artifact.qualityReport.character.dimensionCoverage.length} 项
        </Text>
      ) : null}
    </View>
  );
};

const PresetPreview: React.FC<{
  artifact: Extract<ConstructionArtifact, { kind: 'preset' }>;
}> = ({ artifact }) => {
  const { theme } = useThemeStore();
  const fields = [
    ['系统提示词', artifact.preset.system_prompt],
    ['写作风格', artifact.preset.writing_style],
    ['额外约束', artifact.preset.extra_instructions],
  ];
  return (
    <View>
      <Text style={[styles.previewTitle, { color: theme.colors.textPrimary }]}>
        {artifact.name}
      </Text>
      {fields.map(([label, value]) => (
        <View key={label} style={styles.presetPreviewBlock}>
          <Text style={[styles.previewText, { color: theme.colors.textPrimary }]}>
            {label}
          </Text>
          <Text style={[styles.previewText, { color: theme.colors.textSecondary }]}>
            {value}
          </Text>
        </View>
      ))}
      {artifact.qualityReport?.preset ? (
        <Text style={[styles.previewText, { color: theme.colors.textSecondary }]}>
          质量：约 {artifact.qualityReport.actualOutputTokens.toLocaleString('en-US')} Token ·
          覆盖机制 {artifact.qualityReport.preset.mechanismCoverage.length} 项
        </Text>
      ) : null}
    </View>
  );
};

const WorldbookPreview: React.FC<{
  artifact: Extract<ConstructionArtifact, { kind: 'worldbook' }>;
}> = ({ artifact }) => {
  const { theme } = useThemeStore();
  return (
    <View>
      <Text style={[styles.previewTitle, { color: theme.colors.textPrimary }]}>
        {artifact.lorebook.data.name} · {artifact.lorebook.data.entries.length}{' '}
        条
      </Text>
      {artifact.lorebook.data.entries.map((entry, idx) => (
        <View
          key={`${entry.insertion_order}-${idx}`}
          style={[styles.entryRow, { borderBottomColor: theme.colors.border }]}
        >
          <Text style={[styles.entryKeys, { color: theme.colors.textPrimary }]}>
            触发词：{entry.keys.join('、')}
          </Text>
          {entry.comment ? (
            <Text
              style={[
                styles.entryComment,
                { color: theme.colors.textSecondary },
              ]}
            >
              说明：{entry.comment}
            </Text>
          ) : null}
          <Text
            style={[styles.entryContent, { color: theme.colors.textSecondary }]}
            numberOfLines={3}
          >
            {entry.content}
          </Text>
        </View>
      ))}
      {artifact.qualityReport?.worldbook ? (
        <Text
          style={[styles.previewText, { color: theme.colors.textSecondary }]}
        >
          全部常驻 · 估算常驻内容{' '}
          {artifact.qualityReport.worldbook.totalEstimatedPersistentTokens.toLocaleString(
            'en-US',
          )}{' '}
          Token
        </Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  scrollContent: { padding: spacing.lg, paddingBottom: 120, gap: spacing.md },
  section: { gap: spacing.sm },
  subTarget: { gap: spacing.xs, marginTop: spacing.sm },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'flex-start',
    marginBottom: spacing.md,
    flex: 1,
  },
  bodyText: { fontSize: 14, lineHeight: 21, flex: 1 },
  label: { fontSize: 12, fontWeight: '700', marginBottom: spacing.xs },
  hint: { fontSize: 12, lineHeight: 18, marginTop: spacing.xs },
  mediumInput: { minHeight: 72, textAlignVertical: 'top' },
  largeInput: { minHeight: 96, textAlignVertical: 'top' },
  actions: { gap: spacing.sm },
  statusText: { fontSize: 15, fontWeight: '700' },
  generationError: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: spacing.md,
    gap: spacing.xs,
  },
  generationErrorTitle: { fontSize: 14, fontWeight: '800' },
  generationErrorActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  qualityWarning: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: spacing.md,
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  qualityWarningTitle: { fontSize: 14, fontWeight: '800' },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  stepperLabel: { fontSize: 13, fontWeight: '700' },
  stepperControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  stepperValue: {
    fontSize: 15,
    fontWeight: '800',
    minWidth: 24,
    textAlign: 'center',
  },
  sourceBlock: { gap: spacing.xs, marginBottom: spacing.md },
  sourceSummary: { marginTop: spacing.xs },
  sourceName: { fontSize: 15, fontWeight: '800' },
  sourceMeta: { fontSize: 12, marginTop: 2 },
  textSections: { gap: spacing.xs, marginBottom: spacing.md },
  textSection: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    padding: spacing.sm,
  },
  textSectionTitle: { fontSize: 13, fontWeight: '700' },
  textSectionMeta: { fontSize: 11, marginTop: 2 },
  budgetBlock: { marginTop: spacing.md, gap: spacing.xs },
  budgetTitle: { fontSize: 13, fontWeight: '700' },
  budgetValue: { fontSize: 13, fontWeight: '700', textAlign: 'right' },
  budgetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  budgetCell: {
    flexBasis: '47%',
    flexGrow: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    padding: spacing.sm,
  },
  budgetCellLabel: { fontSize: 11, fontWeight: '700' },
  budgetCellValue: { fontSize: 14, fontWeight: '800', marginTop: 2 },
  budgetNote: { fontSize: 12, lineHeight: 18, marginTop: spacing.xs },
  previewActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
    justifyContent: 'flex-end',
  },
  previewTitle: { fontSize: 17, fontWeight: '800', marginBottom: spacing.xs },
  previewText: { fontSize: 13, lineHeight: 20, marginBottom: 4 },
  presetPreviewBlock: { marginBottom: spacing.sm },
  entryRow: {
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  entryKeys: { fontSize: 13, fontWeight: '700' },
  entryComment: { fontSize: 12, marginTop: 2 },
  entryContent: { fontSize: 13, lineHeight: 19, marginTop: 2 },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  jsonModal: { maxHeight: '84%', borderRadius: 12, padding: spacing.lg },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: spacing.md },
  jsonScroll: { maxHeight: 420 },
  jsonText: { fontSize: 12, lineHeight: 18, fontFamily: 'serif' },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.md,
  },
});
