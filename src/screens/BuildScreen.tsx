import React, { useMemo, useRef, useState } from 'react';
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
import {
  navigateToLLMSettings,
} from '../navigation/navigationRef';
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
import { saveConstructionArtifact } from '../services/constructionFileService';
import type { ConstructionArtifact, ConstructionInput } from '../services/constructionAiGenerator';
import {
  parseCharacterCardJSON,
  parseCharacterCardPNG,
  parseWorldBookJSON,
  pickSourceFile,
} from '../services/fileImport';
import { useThemeStore } from '../store/themeStore';

type BuildMode = 'independent' | 'fromWorldbook' | 'fromCharacter';
type IndependentTarget = 'character' | 'worldbook';
type GenerateStatus = 'idle' | 'queued' | 'running' | 'preview';

interface SourceState {
  kind: 'worldbook' | 'character';
  name: string;
  /** 喂给模型的来源快照文本（一次性参考，不落库）。 */
  snapshot: string;
  entryCount?: number;
  /** 预计输入 Token（来源快照本身的估算，用于展示）。 */
  tokens: number;
}

const MODE_OPTIONS: { value: BuildMode; label: string }[] = [
  { value: 'independent', label: '独立构建' },
  { value: 'fromWorldbook', label: '由世界书' },
  { value: 'fromCharacter', label: '由角色卡' },
];

const TARGET_OPTIONS: { value: IndependentTarget; label: string }[] = [
  { value: 'character', label: '角色卡' },
  { value: 'worldbook', label: '世界书' },
];

export const BuildScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const { llmConfig } = useSettingsStore();

  const [mode, setMode] = useState<BuildMode>('independent');
  const [independentTarget, setIndependentTarget] =
    useState<IndependentTarget>('character');

  // 独立角色卡字段
  const [charName, setCharName] = useState('');
  const [charTheme, setCharTheme] = useState('');
  const [charRole, setCharRole] = useState('');
  const [charPersonality, setCharPersonality] = useState('');
  const [charAtmosphere, setCharAtmosphere] = useState('');
  // 独立世界书字段
  const [wbName, setWbName] = useState('');
  const [wbTheme, setWbTheme] = useState('');
  const [wbWorldview, setWbWorldview] = useState('');
  const [wbCategories, setWbCategories] = useState('');
  const [wbUsage, setWbUsage] = useState('');
  // 通用补充需求
  const [extra, setExtra] = useState('');
  const [entryCount, setEntryCount] = useState(DEFAULT_ENTRY_COUNT);

  const [reservePercent, setReservePercent] = useState(DEFAULT_RESERVE_PERCENT);
  const [source, setSource] = useState<SourceState | null>(null);
  const [status, setStatus] = useState<GenerateStatus>('idle');
  const [queueLabel, setQueueLabel] = useState<string>('');
  const [artifact, setArtifact] = useState<ConstructionArtifact | null>(null);
  const [showJson, setShowJson] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const target: IndependentTarget = useMemo(() => {
    if (mode === 'fromWorldbook') return 'character';
    if (mode === 'fromCharacter') return 'worldbook';
    return independentTarget;
  }, [mode, independentTarget]);

  // ---------- 在线 LLM 前置校验（SPEC §6.1） ----------
  const llmCheck = useMemo(() => {
    const providerType = llmConfig.provider_type || 'openai_compatible';
    const isOnline = providerType === 'openai_compatible';
    const complete =
      !!llmConfig.base_url.trim() &&
      !!llmConfig.api_key.trim() &&
      !!llmConfig.model_name.trim();
    if (!isOnline) {
      return {
        ready: false,
        reason: '当前激活的是本地 llama.cpp 模型，构建首版仅支持在线 OpenAI 兼容模型。',
      };
    }
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
        entryCount: target === 'worldbook' ? entryCount : undefined,
      }),
    [llmConfig, reservePercent, target, entryCount],
  );

  // ---------- 组装 ConstructionInput ----------
  const independentCharFilled =
    [charName, charTheme, charRole, charPersonality, charAtmosphere, extra].some(
      v => v.trim().length > 0,
    );

  const input: ConstructionInput | null = useMemo(() => {
    if (mode === 'independent') {
      if (target === 'character') {
        if (!independentCharFilled) return null;
        return {
          mode: 'character_independent',
          name: charName,
          theme: charTheme,
          role: charRole,
          personality: charPersonality,
          atmosphere: charAtmosphere,
          extra,
        };
      }
      return {
        mode: 'worldbook_independent',
        name: wbName,
        theme: wbTheme,
        worldview: wbWorldview,
        categories: wbCategories,
        usage: wbUsage,
        extra,
        entryCount: clampEntryCount(entryCount),
      };
    }
    if (!source) return null;
    if (mode === 'fromWorldbook') {
      return {
        mode: 'character_from_worldbook',
        sourceSnapshot: source.snapshot,
        sourceName: source.name,
        extra,
      };
    }
    return {
      mode: 'worldbook_from_character',
      sourceSnapshot: source.snapshot,
      sourceName: source.name,
      extra,
      entryCount: clampEntryCount(entryCount),
    };
  }, [
    mode,
    target,
    independentCharFilled,
    charName,
    charTheme,
    charRole,
    charPersonality,
    charAtmosphere,
    extra,
    wbName,
    wbTheme,
    wbWorldview,
    wbCategories,
    wbUsage,
    entryCount,
    source,
  ]);

  const inputTokens = input ? estimateConstructionInputTokens(input) : 0;
  const sourceOverBudget =
    llmCheck.ready && budget.sourceBudget > 0 && inputTokens > budget.sourceBudget;

  const canGenerate =
    llmCheck.ready &&
    budget.generatable &&
    !sourceOverBudget &&
    input !== null &&
    status !== 'running' &&
    status !== 'queued';

  // ---------- 切换模式 / 目标时恢复默认并清空产物（SPEC §6.2） ----------
  const resetToDefaults = (nextMode: BuildMode, nextTarget: IndependentTarget) => {
    setReservePercent(DEFAULT_RESERVE_PERCENT);
    setArtifact(null);
    setStatus('idle');
    setSource(null);
    if (nextMode === 'independent' && nextTarget === 'worldbook') {
      setEntryCount(DEFAULT_ENTRY_COUNT);
    }
    if (nextMode !== 'independent') {
      setEntryCount(DEFAULT_ENTRY_COUNT);
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

  // ---------- 生成 / 取消 ----------
  const handleGenerate = async () => {
    if (!input || !canGenerate) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('queued');
    setQueueLabel('排队中…');
    setArtifact(null);
    try {
      const result = await generateConstruction(input, {
        maxTokens: budget.outputReserve,
        signal: controller.signal,
        onQueueState: state => {
          if (state === 'queued') {
            setQueueLabel('排队中…');
            setStatus('queued');
          } else if (state === 'running') {
            setQueueLabel('生成中…');
            setStatus('running');
          }
        },
      });
      setArtifact(result);
      setStatus('preview');
    } catch (error: any) {
      if (controller.signal.aborted) {
        Toast.show({ type: 'info', text1: '已取消生成' });
      } else {
        Toast.show({
          type: 'error',
          text1: '生成失败',
          text2: error?.message || '请检查 LLM 配置与网络后重试。',
        });
      }
      setStatus('idle');
    } finally {
      abortRef.current = null;
      setQueueLabel('');
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleRegenerate = () => {
    setArtifact(null);
    setStatus('idle');
  };

  // ---------- 保存到手机（SPEC §9.3） ----------
  const handleSave = async () => {
    if (!artifact) return;
    try {
      const result = await saveConstructionArtifact(artifact);
      if (result.saved) {
        Toast.show({
          type: 'success',
          text1: '已保存到手机',
          text2: '请在「资料」中手动导入后启用。',
        });
      }
      // 用户取消保存：不显示成功提示，预览保持未保存状态（SPEC §9.3）。
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: '保存失败',
        text2: error?.message || '写入手机存储失败。',
      });
    }
  };

  const generating = status === 'queued' || status === 'running';

  return (
    <Screen>
      <Header
        title="构建"
        subtitle="独立生成文件；保存后请在资料库手动导入。"
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
          <SegmentedControl value={mode} options={MODE_OPTIONS} onChange={handleModeChange} />
          {mode === 'independent' ? (
            <View style={styles.subTarget}>
              <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
                目标类型
              </Text>
              <SegmentedControl
                value={independentTarget}
                options={TARGET_OPTIONS}
                onChange={handleTargetChange}
              />
            </View>
          ) : null}
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
                personality={charPersonality}
                setPersonality={setCharPersonality}
                atmosphere={charAtmosphere}
                setAtmosphere={setCharAtmosphere}
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
                usage={wbUsage}
                setUsage={setWbUsage}
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
                  buttonLabel={source ? '重新选择角色卡' : '选择角色卡 JSON / PNG'}
                  onPick={pickCharacterSource}
                  source={source}
                />
                <EntryCountStepper
                  entryCount={entryCount}
                  onStep={handleEntryStep}
                />
              </>
            ) : null}

            <Field
              testID="build-extra"
              label="补充需求（可选）"
              value={extra}
              onChangeText={setExtra}
              placeholder="例如：职业、阵营、希望扩展的地区或剧情冲突"
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
                <Text style={[styles.statusText, { color: theme.colors.textPrimary }]}>
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
                  <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
                    {budget.reason}
                  </Text>
                ) : null}
                {sourceOverBudget ? (
                  <Text style={[styles.hint, { color: theme.colors.danger }]}>
                    来源内容（约 {inputTokens.toLocaleString('en-US')} Token）超过可用预算（{budget.sourceBudget.toLocaleString('en-US')} Token）。请减少世界书条目、选择更小的来源文件、在仍满足最低输出时降低输出预留，或使用上下文更大的在线模型。
                  </Text>
                ) : null}
                {mode === 'independent' && target === 'character' && !independentCharFilled ? (
                  <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
                    请至少填写一个有效的角色设定字段。
                  </Text>
                ) : null}
                {mode !== 'independent' && !source ? (
                  <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
                    请先选择来源文件。
                  </Text>
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
          <View style={[styles.jsonModal, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.modalTitle, { color: theme.colors.textPrimary }]}>
              产物 JSON
            </Text>
            <ScrollView style={styles.jsonScroll}>
              <Text style={[styles.jsonText, { color: theme.colors.textSecondary }]}>
                {artifact ? JSON.stringify(artifact.kind === 'character' ? artifact.card : artifact.lorebook, null, 2) : ''}
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
  name: string; setName: (v: string) => void;
  themeText: string; setThemeText: (v: string) => void;
  role: string; setRole: (v: string) => void;
  personality: string; setPersonality: (v: string) => void;
  atmosphere: string; setAtmosphere: (v: string) => void;
}> = ({ name, setName, themeText, setThemeText, role, setRole, personality, setPersonality, atmosphere, setAtmosphere }) => (
  <>
    <Field testID="build-char-name" label="角色名称（可选）" value={name} onChangeText={setName} placeholder="例如：沈砚" />
    <Field testID="build-char-theme" label="题材 / 时代" value={themeText} onChangeText={setThemeText} placeholder="例如：蒸汽雾港" />
    <Field testID="build-char-role" label="角色定位" value={role} onChangeText={setRole} placeholder="例如：反派机关师" />
    <Field testID="build-char-personality" label="核心性格 / 矛盾" value={personality} onChangeText={setPersonality} multiline inputStyle={styles.largeInput} placeholder="例如：表面温和、记仇" />
    <Field testID="build-char-atmosphere" label="叙事氛围" value={atmosphere} onChangeText={setAtmosphere} placeholder="例如：阴郁、悬念" />
  </>
);

const IndependentWorldbookForm: React.FC<{
  name: string; setName: (v: string) => void;
  themeText: string; setThemeText: (v: string) => void;
  worldview: string; setWorldview: (v: string) => void;
  categories: string; setCategories: (v: string) => void;
  usage: string; setUsage: (v: string) => void;
  entryCount: number; onEntryStep: (delta: number) => void;
}> = ({ name, setName, themeText, setThemeText, worldview, setWorldview, categories, setCategories, usage, setUsage, entryCount, onEntryStep }) => (
  <>
    <Field testID="build-wb-name" label="世界书名称（可选）" value={name} onChangeText={setName} placeholder="例如：雾港纪事" />
    <Field testID="build-wb-theme" label="题材 / 时代" value={themeText} onChangeText={setThemeText} placeholder="例如：蒸汽雾港" />
    <Field testID="build-wb-worldview" label="核心世界观" value={worldview} onChangeText={setWorldview} multiline inputStyle={styles.largeInput} placeholder="例如：海雾笼罩的港口城邦" />
    <Field testID="build-wb-categories" label="希望覆盖的类别" value={categories} onChangeText={setCategories} placeholder="例如：地点、组织、世界铁律" />
    <Field testID="build-wb-usage" label="叙事用途" value={usage} onChangeText={setUsage} placeholder="例如：悬疑群像" />
    <EntryCountStepper entryCount={entryCount} onStep={onEntryStep} />
  </>
);

const EntryCountStepper: React.FC<{ entryCount: number; onStep: (delta: number) => void }> = ({ entryCount, onStep }) => {
  const { theme } = useThemeStore();
  return (
    <View style={styles.stepperRow}>
      <Text style={[styles.stepperLabel, { color: theme.colors.textPrimary }]}>世界书条目数量</Text>
      <View style={styles.stepperControls}>
        <Button label="−" compact onPress={() => onStep(-1)} disabled={entryCount <= WORLDBOOK_ENTRY_MIN} />
        <Text style={[styles.stepperValue, { color: theme.colors.textPrimary }]}>{entryCount}</Text>
        <Button label="+" compact onPress={() => onStep(1)} disabled={entryCount >= WORLDBOOK_ENTRY_MAX} />
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
      <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.hint, { color: theme.colors.textMuted }]}>{hint}</Text>
      <Button label={buttonLabel} icon={Download} variant="secondary" onPress={onPick} />
      {source ? (
        <View style={styles.sourceSummary}>
          <Text style={[styles.sourceName, { color: theme.colors.textPrimary }]}>{source.name}</Text>
          <Text style={[styles.sourceMeta, { color: theme.colors.textSecondary }]}>
            {source.kind === 'worldbook'
              ? `${source.entryCount ?? 0} 条条目 · `
              : '角色卡 · '}
            预计输入 {source.tokens.toLocaleString('en-US')} Token
          </Text>
        </View>
      ) : null}
    </View>
  );
};

const BudgetPanel: React.FC<{
  budget: ReturnType<typeof computeConstructionBudget>;
  reservePercent: number;
  onChangeReserve: (v: number) => void;
  inputTokens: number;
  sourceOverBudget: boolean;
}> = ({ budget, reservePercent, onChangeReserve, inputTokens, sourceOverBudget }) => {
  const { theme } = useThemeStore();
  return (
    <View style={styles.budgetBlock}>
      <Text style={[styles.budgetTitle, { color: theme.colors.textSecondary }]}>输出预留</Text>
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
        <BudgetCell label="上下文容量" value={budget.contextWindow.toLocaleString('en-US')} />
        <BudgetCell label="输出预留" value={budget.outputReserve.toLocaleString('en-US')} />
        <BudgetCell label="来源预算" value={budget.sourceBudget.toLocaleString('en-US')} />
        <BudgetCell label="预计输入" value={inputTokens.toLocaleString('en-US')} danger={sourceOverBudget} />
      </View>
      {budget.cappedByMaxOutput ? (
        <Text style={[styles.budgetNote, { color: theme.colors.textSecondary }]}>已受当前 LLM 最大输出 Token 限制。</Text>
      ) : null}
      {!budget.generatable ? (
        <Text style={[styles.budgetNote, { color: theme.colors.danger }]}>{budget.reason}</Text>
      ) : null}
    </View>
  );
};

const BudgetCell: React.FC<{ label: string; value: string; danger?: boolean }> = ({ label, value, danger }) => {
  const { theme } = useThemeStore();
  return (
    <View style={[styles.budgetCell, { borderColor: theme.colors.border }]}>
      <Text style={[styles.budgetCellLabel, { color: theme.colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.budgetCellValue, danger ? { color: theme.colors.danger } : { color: theme.colors.textPrimary }]}>{value}</Text>
    </View>
  );
};

const PreviewPanel: React.FC<{
  artifact: ConstructionArtifact;
  onRegenerate: () => void;
  onBackToEdit: () => void;
  onViewJson: () => void;
  onSave: () => void;
}> = ({ artifact, onRegenerate, onBackToEdit, onViewJson, onSave }) => (
  <Card>
    {artifact.kind === 'character' ? (
      <CharacterPreview artifact={artifact} />
    ) : (
      <WorldbookPreview artifact={artifact} />
    )}
    <View style={styles.previewActions}>
      <Button label="重新生成" icon={RefreshCw} variant="secondary" onPress={onRegenerate} />
      <Button label="返回修改" variant="ghost" onPress={onBackToEdit} />
      <Button label="查看 JSON" icon={Eye} variant="ghost" onPress={onViewJson} />
      <Button testID="build-save" label="保存到手机" icon={Download} onPress={onSave} />
    </View>
  </Card>
);

const CharacterPreview: React.FC<{ artifact: Extract<ConstructionArtifact, { kind: 'character' }> }> = ({ artifact }) => {
  const { theme } = useThemeStore();
  return (
    <View>
      <Text style={[styles.previewTitle, { color: theme.colors.textPrimary }]}>{artifact.card.data.name}</Text>
      {artifact.card.data.description ? (
        <Text style={[styles.previewText, { color: theme.colors.textSecondary }]}>简介：{artifact.card.data.description}</Text>
      ) : null}
      {artifact.card.data.personality ? (
        <Text style={[styles.previewText, { color: theme.colors.textSecondary }]}>性格：{artifact.card.data.personality}</Text>
      ) : null}
      {artifact.card.data.tags.length > 0 ? (
        <Text style={[styles.previewText, { color: theme.colors.textSecondary }]}>标签：{artifact.card.data.tags.join('、')}</Text>
      ) : null}
      {artifact.card.data.first_mes ? (
        <Text style={[styles.previewText, { color: theme.colors.textSecondary }]} numberOfLines={4}>开场白：{artifact.card.data.first_mes}</Text>
      ) : null}
    </View>
  );
};

const WorldbookPreview: React.FC<{ artifact: Extract<ConstructionArtifact, { kind: 'worldbook' }> }> = ({ artifact }) => {
  const { theme } = useThemeStore();
  return (
    <View>
      <Text style={[styles.previewTitle, { color: theme.colors.textPrimary }]}>
        {artifact.lorebook.data.name} · {artifact.lorebook.data.entries.length} 条
      </Text>
      {artifact.lorebook.data.entries.map((entry, idx) => (
        <View key={`${entry.insertion_order}-${idx}`} style={[styles.entryRow, { borderBottomColor: theme.colors.border }]}>
          <Text style={[styles.entryKeys, { color: theme.colors.textPrimary }]}>触发词：{entry.keys.join('、')}</Text>
          {entry.comment ? (
            <Text style={[styles.entryComment, { color: theme.colors.textSecondary }]}>说明：{entry.comment}</Text>
          ) : null}
          <Text style={[styles.entryContent, { color: theme.colors.textSecondary }]} numberOfLines={3}>{entry.content}</Text>
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  scrollContent: { padding: spacing.lg, paddingBottom: 120, gap: spacing.md },
  section: { gap: spacing.sm },
  subTarget: { gap: spacing.xs, marginTop: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', marginBottom: spacing.md, flex: 1 },
  bodyText: { fontSize: 14, lineHeight: 21, flex: 1 },
  label: { fontSize: 12, fontWeight: '700', marginBottom: spacing.xs },
  hint: { fontSize: 12, lineHeight: 18, marginTop: spacing.xs },
  largeInput: { minHeight: 96, textAlignVertical: 'top' },
  actions: { gap: spacing.sm },
  statusText: { fontSize: 15, fontWeight: '700' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  stepperLabel: { fontSize: 13, fontWeight: '700' },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepperValue: { fontSize: 15, fontWeight: '800', minWidth: 24, textAlign: 'center' },
  sourceBlock: { gap: spacing.xs, marginBottom: spacing.md },
  sourceSummary: { marginTop: spacing.xs },
  sourceName: { fontSize: 15, fontWeight: '800' },
  sourceMeta: { fontSize: 12, marginTop: 2 },
  budgetBlock: { marginTop: spacing.md, gap: spacing.xs },
  budgetTitle: { fontSize: 13, fontWeight: '700' },
  budgetValue: { fontSize: 13, fontWeight: '700', textAlign: 'right' },
  budgetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  budgetCell: { flexBasis: '47%', flexGrow: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, padding: spacing.sm },
  budgetCellLabel: { fontSize: 11, fontWeight: '700' },
  budgetCellValue: { fontSize: 14, fontWeight: '800', marginTop: 2 },
  budgetNote: { fontSize: 12, lineHeight: 18, marginTop: spacing.xs },
  previewActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md, justifyContent: 'flex-end' },
  previewTitle: { fontSize: 17, fontWeight: '800', marginBottom: spacing.xs },
  previewText: { fontSize: 13, lineHeight: 20, marginBottom: 4 },
  entryRow: { paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  entryKeys: { fontSize: 13, fontWeight: '700' },
  entryComment: { fontSize: 12, marginTop: 2 },
  entryContent: { fontSize: 13, lineHeight: 19, marginTop: 2 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: spacing.lg },
  jsonModal: { maxHeight: '84%', borderRadius: 12, padding: spacing.lg },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: spacing.md },
  jsonScroll: { maxHeight: 420 },
  jsonText: { fontSize: 12, lineHeight: 18, fontFamily: 'serif' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: spacing.md },
});
