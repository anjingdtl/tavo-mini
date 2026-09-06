import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { Button, Field, spacing } from '../../components/ui';
import { useThemeStore } from '../../store/themeStore';
import * as db from '../../services/database';
import {
  buildWriterStyleSemanticUpdate,
} from '../../services/writerStyle/editor';
import { semanticToRuntimeText } from '../../services/writerStyle/semantic';
import { compileWriterStyleProjections } from '../../services/writerStyle/compiler';
import type {
  PresetCompatibilityEnvelopeV1,
  WriterStyleAsset,
} from '../../services/writerStyle/types';
import {
  formFromWriterStyleAsset,
  formToWriterStyleSemantic,
  writerStyleFormSnapshot,
  type WriterStyleFormState,
} from './writerStyleForm';

export type WriterStyleSaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

const GROUPS: Array<{
  id: string;
  title: string;
  testID: string;
  fields: Array<{ key: keyof WriterStyleFormState; label: string; testID: string }>;
}> = [
  {
    id: 'positioning',
    title: '基本定位',
    testID: 'writer-style-group-positioning',
    fields: [
      { key: 'description', label: '风格说明', testID: 'writer-style-field-description' },
      { key: 'genresText', label: '适用题材', testID: 'writer-style-field-genres' },
      { key: 'audience', label: '目标读者', testID: 'writer-style-field-audience' },
      { key: 'tone', label: '整体气质', testID: 'writer-style-field-tone' },
    ],
  },
  {
    id: 'narration',
    title: '叙事方式',
    testID: 'writer-style-group-narration',
    fields: [
      { key: 'pointOfView', label: '叙述视角', testID: 'writer-style-field-pointOfView' },
      { key: 'narratorDistance', label: '叙述距离', testID: 'writer-style-field-narratorDistance' },
      { key: 'viewpointSwitching', label: '视角切换', testID: 'writer-style-field-viewpointSwitching' },
      { key: 'interiority', label: '内心呈现', testID: 'writer-style-field-interiority' },
    ],
  },
  {
    id: 'language',
    title: '语言风格',
    testID: 'writer-style-group-language',
    fields: [
      { key: 'texture', label: '语言质感', testID: 'writer-style-field-texture' },
      { key: 'syntax', label: '句法', testID: 'writer-style-field-syntax' },
      { key: 'vocabulary', label: '词汇', testID: 'writer-style-field-vocabulary' },
      { key: 'paragraphStructure', label: '段落组织', testID: 'writer-style-field-paragraphStructure' },
    ],
  },
  {
    id: 'scene',
    title: '场景与人物',
    testID: 'writer-style-group-scene',
    fields: [
      { key: 'sceneEnvironment', label: '场景环境', testID: 'writer-style-field-sceneEnvironment' },
      { key: 'characterPresentation', label: '人物呈现', testID: 'writer-style-field-characterPresentation' },
      { key: 'characterVoice', label: '人物声音', testID: 'writer-style-field-characterVoice' },
      { key: 'dialogue', label: '对白', testID: 'writer-style-field-dialogue' },
    ],
  },
  {
    id: 'mechanics',
    title: '叙事机制',
    testID: 'writer-style-group-mechanics',
    fields: [
      { key: 'pacing', label: '节奏', testID: 'writer-style-field-pacing' },
      { key: 'conflict', label: '冲突', testID: 'writer-style-field-conflict' },
      { key: 'informationReveal', label: '信息揭示', testID: 'writer-style-field-informationReveal' },
      { key: 'suspense', label: '悬念', testID: 'writer-style-field-suspense' },
      { key: 'foreshadowing', label: '伏笔', testID: 'writer-style-field-foreshadowing' },
      { key: 'chapterStructure', label: '章节结构', testID: 'writer-style-field-chapterStructure' },
      { key: 'continuity', label: '连续性', testID: 'writer-style-field-continuity' },
    ],
  },
  {
    id: 'literary',
    title: '文学质感',
    testID: 'writer-style-group-literary',
    fields: [
      { key: 'imagery', label: '意象', testID: 'writer-style-field-imagery' },
      { key: 'sensory', label: '感官', testID: 'writer-style-field-sensory' },
    ],
  },
];

function parseCompatibility(
  value: string | null | undefined,
): PresetCompatibilityEnvelopeV1 | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as PresetCompatibilityEnvelopeV1;
    return parsed && parsed.format === 'sillytavern_openai_preset' ? parsed : null;
  } catch {
    return null;
  }
}

function sourceLabel(asset: WriterStyleAsset): string {
  switch (asset.source_format) {
    case 'sillytavern_openai':
      return 'SillyTavern';
    case 'shinewriter':
      return 'AI/结构化';
    case 'legacy_shinewriter':
      return '旧版';
    case 'default_runtime_baseline':
      return '内置';
    default:
      return asset.source_format || '用户';
  }
}

function formWithPendingProhibition(
  form: WriterStyleFormState,
  draftItem: string,
): WriterStyleFormState {
  const normalizedDraft = draftItem.trim();
  if (!normalizedDraft || form.prohibitions.includes(normalizedDraft)) {
    return form;
  }
  return {
    ...form,
    prohibitions: [...form.prohibitions, normalizedDraft],
  };
}

export function WriterStyleEditor({
  visible,
  asset,
  projectId,
  activeWriterStyleId,
  onClose,
  onSaved,
}: {
  visible: boolean;
  asset: WriterStyleAsset | null;
  projectId: number;
  activeWriterStyleId: number | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { theme } = useThemeStore();
  const [form, setForm] = useState<WriterStyleFormState | null>(null);
  const [baseline, setBaseline] = useState('');
  const [status, setStatus] = useState<WriterStyleSaveStatus>('clean');
  const [errorMessage, setErrorMessage] = useState('');
  const [draftItem, setDraftItem] = useState('');
  const draftItemRef = useRef('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSampler, setShowSampler] = useState(false);
  const [showProjections, setShowProjections] = useState(false);

  useEffect(() => {
    if (!visible || !asset) {
      setForm(null);
      setBaseline('');
      setStatus('clean');
      setErrorMessage('');
      draftItemRef.current = '';
      setDraftItem('');
      setShowAdvanced(false);
      setShowSampler(false);
      setShowProjections(false);
      return;
    }
    const next = formFromWriterStyleAsset(asset);
    setForm(next);
    setBaseline(writerStyleFormSnapshot(next));
    setStatus('clean');
    setErrorMessage('');
    draftItemRef.current = '';
    setDraftItem('');
  }, [asset, visible]);

  const normalizedDraft = draftItem.trim();
  const effectiveForm = form
    ? formWithPendingProhibition(form, normalizedDraft)
    : null;
  const dirty = Boolean(
    form &&
      (writerStyleFormSnapshot(form) !== baseline || Boolean(normalizedDraft)),
  );
  const isActive = Boolean(asset && activeWriterStyleId === asset.id);
  const compatibility = parseCompatibility(asset?.compatibility_json);
  const semantic = effectiveForm ? formToWriterStyleSemantic(effectiveForm) : null;
  const runtime = semantic ? semanticToRuntimeText(semantic) : null;
  const projections = useMemo(() => {
    if (!semantic || !runtime) return null;
    return compileWriterStyleProjections(semantic, {
      system: runtime.systemPrompt,
      style: runtime.writingStyle,
      extra: runtime.extraInstructions,
    });
  }, [runtime, semantic]);

  const patch = (partial: Partial<WriterStyleFormState>) => {
    setForm(current => (current ? { ...current, ...partial } : current));
    setStatus('dirty');
    setErrorMessage('');
  };

  const addListItem = (key: 'prohibitions' | 'extraInstructions') => {
    const value = draftItemRef.current.trim();
    if (!value || !form) return;
    if (form[key].includes(value)) {
      draftItemRef.current = '';
      setDraftItem('');
      return;
    }
    patch({ [key]: [...form[key], value] });
    draftItemRef.current = '';
    setDraftItem('');
  };

  const removeListItem = (key: 'prohibitions' | 'extraInstructions', index: number) => {
    if (!form) return;
    patch({ [key]: form[key].filter((_, itemIndex) => itemIndex !== index) });
  };

  const requestClose = () => {
    if (!dirty || status === 'saving') {
      onClose();
      return;
    }
    Alert.alert('作家风格尚未保存', '离开后未保存的修改会丢失。', [
      { text: '继续编辑', style: 'cancel' },
      { text: '放弃修改', style: 'destructive', onPress: onClose },
    ]);
  };

  const save = async (andSetActive = false) => {
    if (!asset || !form) return;
    // Build one immutable save snapshot. Do not depend on setForm completing
    // before the semantic is compiled or persisted.
    const saveForm = formWithPendingProhibition(form, draftItemRef.current);
    const saveSemantic = formToWriterStyleSemantic(saveForm);
    setStatus('saving');
    setErrorMessage('');
    try {
      const semanticUpdate = buildWriterStyleSemanticUpdate({
        asset,
        semantic: saveSemantic,
      });
      await db.updatePreset(asset.id, {
        ...semanticUpdate,
        name: semanticUpdate.name || '未命名作家风格',
        is_default: saveForm.isDefault ? 1 : 0,
        temperature: Number(saveForm.temperature) || 0.8,
        top_p: Number(saveForm.topP) || 0.9,
        // Writer-style max_tokens is legacy asset metadata. Blank/invalid is
        // AUTO (0); the active model capability owns runtime output sizing.
        max_tokens: Number(saveForm.maxTokens) || 0,
      });
      if (andSetActive && projectId) {
        await db.setProjectResourceEnabled(projectId, 'preset', asset.id, true);
        await db.setProjectActiveWriterStyle(projectId, asset.id);
      }
      draftItemRef.current = '';
      setDraftItem('');
      setForm(saveForm);
      setBaseline(writerStyleFormSnapshot(saveForm));
      setStatus('saved');
      await onSaved();
    } catch (error: any) {
      setStatus('error');
      setErrorMessage(error?.message || '作家风格保存失败。');
    }
  };

  const setActiveOnly = async () => {
    if (!asset || !projectId) return;
    setStatus('saving');
    try {
      await db.setProjectResourceEnabled(projectId, 'preset', asset.id, true);
      await db.setProjectActiveWriterStyle(projectId, asset.id);
      setStatus(dirty ? 'dirty' : 'saved');
      await onSaved();
    } catch (error: any) {
      setStatus('error');
      setErrorMessage(error?.message || '无法设为当前作家风格。');
    }
  };

  const statusLabel =
    status === 'saving'
      ? '保存中'
      : status === 'saved'
        ? '已保存'
        : status === 'error'
          ? '保存失败'
          : dirty
            ? '未保存'
            : '已同步';

  return (
    <Modal
      visible={visible && Boolean(asset && form)}
      transparent
      animationType="fade"
      onRequestClose={requestClose}
    >
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} />
        <View
          testID="writer-style-editor"
          style={[styles.modal, { backgroundColor: theme.colors.surface }]}
        >
          {asset && form ? (
            <>
              <Text
                style={[styles.modalTitle, { color: theme.colors.textPrimary }]}
              >
                编辑作家风格
              </Text>
              <View style={styles.metaRow}>
                <Text
                  testID="writer-style-source-badge"
                  style={[
                    styles.badge,
                    { color: theme.colors.accent, borderColor: theme.colors.accent },
                  ]}
                >
                  来源：{sourceLabel(asset)}
                </Text>
                {isActive ? (
                  <Text
                    testID="writer-style-active-badge"
                    style={[
                      styles.badge,
                      { color: theme.colors.accent, borderColor: theme.colors.accent },
                    ]}
                  >
                    当前项目正在使用
                  </Text>
                ) : null}
                <Text
                  testID="writer-style-save-status"
                  style={[
                    styles.status,
                    {
                      color:
                        status === 'error'
                          ? theme.colors.danger
                          : dirty
                            ? theme.colors.textSecondary
                            : theme.colors.accent,
                    },
                  ]}
                >
                  {statusLabel}
                </Text>
              </View>
              {errorMessage ? (
                <Text
                  testID="writer-style-save-error"
                  style={[styles.error, { color: theme.colors.danger }]}
                >
                  {errorMessage}
                </Text>
              ) : null}
              <ScrollView
                keyboardShouldPersistTaps="handled"
                testID="writer-style-editor-scroll"
              >
                <Field
                  testID="writer-style-editor-name"
                  label="名称"
                  value={form.name}
                  onChangeText={name => patch({ name })}
                />
                {GROUPS.map(group => (
                  <View key={group.id} testID={group.testID} style={styles.group}>
                    <Text
                      style={[styles.groupTitle, { color: theme.colors.textPrimary }]}
                    >
                      {group.title}
                    </Text>
                    {group.fields.map(field => (
                      <Field
                        key={field.key}
                        testID={field.testID}
                        label={field.label}
                        value={String(form[field.key] ?? '')}
                        onChangeText={value => patch({ [field.key]: value })}
                        multiline
                        inputStyle={styles.multiline}
                      />
                    ))}
                  </View>
                ))}

                <View testID="writer-style-group-prohibitions" style={styles.group}>
                  <Text
                    style={[styles.groupTitle, { color: theme.colors.textPrimary }]}
                  >
                    禁止项
                  </Text>
                  {form.prohibitions.map((item, index) => (
                    <View key={`${item}-${index}`} style={styles.listItem}>
                      <Text
                        style={[styles.listText, { color: theme.colors.textPrimary }]}
                      >
                        {item}
                      </Text>
                      <Button
                        label="删除"
                        variant="ghost"
                        compact
                        testID={`writer-style-prohibition-remove-${index}`}
                        onPress={() => removeListItem('prohibitions', index)}
                      />
                    </View>
                  ))}
                  <Field
                    testID="writer-style-prohibition-draft"
                    label="新增禁止项"
                    value={draftItem}
                    onChangeText={value => {
                      draftItemRef.current = value;
                      setDraftItem(value);
                      setStatus('dirty');
                      setErrorMessage('');
                    }}
                    placeholder="例如：禁止作者旁白解释写法"
                  />
                  <Button
                    testID="writer-style-prohibition-add"
                    label="添加禁止项"
                    variant="secondary"
                    onPress={() => addListItem('prohibitions')}
                    disabled={!draftItem.trim()}
                  />
                  <Text
                    style={[styles.hint, { color: theme.colors.textMuted }]}
                  >
                    其他要求
                  </Text>
                  {form.extraInstructions.map((item, index) => (
                    <View key={`${item}-${index}`} style={styles.listItem}>
                      <Text
                        style={[styles.listText, { color: theme.colors.textPrimary }]}
                      >
                        {item}
                      </Text>
                      <Button
                        label="删除"
                        variant="ghost"
                        compact
                        onPress={() =>
                          removeListItem('extraInstructions', index)
                        }
                      />
                    </View>
                  ))}
                </View>

                <View testID="writer-style-advanced" style={styles.group}>
                  <Button
                    testID="writer-style-advanced-toggle"
                    label={showAdvanced ? '收起高级设置' : '高级设置'}
                    variant="ghost"
                    onPress={() => setShowAdvanced(value => !value)}
                  />
                  {showAdvanced ? (
                    <>
                      <Text
                        style={[styles.hint, { color: theme.colors.textMuted }]}
                      >
                        运行时编译结果由 WriterStyleSemanticV1 确定性生成，不能反向当作主编辑模型。
                      </Text>
                      <Text
                        style={[styles.previewTitle, { color: theme.colors.textPrimary }]}
                      >
                        系统提示词
                      </Text>
                      <Text
                        testID="writer-style-compiled-system"
                        style={[styles.preview, { color: theme.colors.textSecondary }]}
                      >
                        {runtime?.systemPrompt || '（空）'}
                      </Text>
                      <Text
                        style={[styles.previewTitle, { color: theme.colors.textPrimary }]}
                      >
                        写作风格
                      </Text>
                      <Text
                        testID="writer-style-compiled-style"
                        style={[styles.preview, { color: theme.colors.textSecondary }]}
                      >
                        {runtime?.writingStyle || '（空）'}
                      </Text>
                      <Text
                        style={[styles.previewTitle, { color: theme.colors.textPrimary }]}
                      >
                        额外约束
                      </Text>
                      <Text
                        testID="writer-style-compiled-extra"
                        style={[styles.preview, { color: theme.colors.textSecondary }]}
                      >
                        {runtime?.extraInstructions || '（空）'}
                      </Text>
                    </>
                  ) : null}
                </View>

                <View testID="writer-style-sampler" style={styles.group}>
                  <Button
                    testID="writer-style-sampler-toggle"
                    label={showSampler ? '收起模型参数' : '模型参数'}
                    variant="ghost"
                    onPress={() => setShowSampler(value => !value)}
                  />
                  {showSampler ? (
                    <>
                      <View style={styles.numberRow}>
                        <Field
                          testID="writer-style-temperature"
                          label="温度"
                          value={form.temperature}
                          onChangeText={temperature => patch({ temperature })}
                          keyboardType="decimal-pad"
                          inputStyle={styles.numberInput}
                        />
                        <Field
                          testID="writer-style-top-p"
                          label="Top P"
                          value={form.topP}
                          onChangeText={topP => patch({ topP })}
                          keyboardType="decimal-pad"
                          inputStyle={styles.numberInput}
                        />
                      </View>
                      <Field
                        testID="writer-style-max-tokens"
                        label="Max Tokens"
                        value={form.maxTokens}
                        onChangeText={maxTokens => patch({ maxTokens })}
                        keyboardType="number-pad"
                      />
                      <View style={styles.switchRow}>
                        <Text
                          style={[styles.switchLabel, { color: theme.colors.textPrimary }]}
                        >
                          设为全局默认作家风格
                        </Text>
                        <Switch
                          testID="writer-style-default-switch"
                          value={form.isDefault}
                          onValueChange={isDefault => patch({ isDefault })}
                        />
                      </View>
                    </>
                  ) : null}
                </View>

                {compatibility ? (
                  <View testID="writer-style-tavern-panel" style={styles.group}>
                    <Text
                      style={[styles.groupTitle, { color: theme.colors.textPrimary }]}
                    >
                      SillyTavern 兼容信息
                    </Text>
                    <Text style={[styles.hint, { color: theme.colors.textMuted }]}>
                      只读保留 Chat Completion Preset / openai_preset 原始结构。产品编辑只改 Writer Style Semantic，不会另建第二套语义。
                    </Text>
                    <Text style={[styles.preview, { color: theme.colors.textSecondary }]}>
                      来源文件：{compatibility.sourceName || 'SillyTavern Chat Completion Preset'}
                      {'\n'}
                      Prompt 数：{Array.isArray(compatibility.rawPreset.prompts) ? compatibility.rawPreset.prompts.length : 0}
                      {'\n'}
                      托管标识：{compatibility.managedPromptIdentifier || '无'}
                      {'\n'}
                      Semantic 已改写：{compatibility.semanticDirty ? '是' : '否'}
                    </Text>
                    {(compatibility.promptMappings || []).map((mapping, index) => (
                      <Text
                        key={`${mapping.identifier || mapping.name || index}`}
                        style={[styles.preview, { color: theme.colors.textSecondary }]}
                      >
                        {mapping.name || mapping.identifier || '未命名 Prompt'} · {mapping.mapping} · {mapping.reason}
                      </Text>
                    ))}
                    {(compatibility.compatibilityNotes || []).map(note => (
                      <Text
                        key={note}
                        style={[styles.hint, { color: theme.colors.textMuted }]}
                      >
                        {note}
                      </Text>
                    ))}
                  </View>
                ) : null}

                <View testID="writer-style-projection-preview" style={styles.group}>
                  <Button
                    testID="writer-style-projection-toggle"
                    label={showProjections ? '收起五阶段预览' : '五阶段 Projection 预览'}
                    variant="ghost"
                    onPress={() => setShowProjections(value => !value)}
                  />
                  {showProjections && projections ? (
                    <>
                      {(
                        [
                          ['Draft · FULL', projections.draft],
                          ['Review · EVALUATION', projections.review],
                          ['FactCheck · HARD', projections.factCheck],
                          ['Brief · MINIMAL', projections.brief],
                          ['Proof · FULL', projections.proof],
                        ] as const
                      ).map(([label, projection]) => (
                        <View key={label}>
                          <Text
                            style={[styles.previewTitle, { color: theme.colors.textPrimary }]}
                          >
                            {label} · {projection.estimatedTokens} tokens
                          </Text>
                          <Text
                            style={[styles.preview, { color: theme.colors.textSecondary }]}
                            numberOfLines={8}
                          >
                            {projection.text}
                          </Text>
                        </View>
                      ))}
                    </>
                  ) : null}
                </View>
              </ScrollView>
              <View style={styles.modalActions}>
                <Button
                  testID="writer-style-cancel"
                  label="取消"
                  variant="ghost"
                  onPress={requestClose}
                  disabled={status === 'saving'}
                />
                {!isActive ? (
                  <Button
                    testID="writer-style-set-active"
                    label="设为当前作家风格"
                    variant="secondary"
                    onPress={() => setActiveOnly().catch(() => {})}
                    disabled={status === 'saving'}
                  />
                ) : null}
                <Button
                  testID="writer-style-save"
                  label={status === 'saving' ? '保存中...' : '保存'}
                  onPress={() => save(false).catch(() => {})}
                  disabled={status === 'saving'}
                />
              </View>
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modal: { maxHeight: '92%', borderRadius: 8, padding: spacing.lg },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: spacing.sm },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    alignItems: 'center',
  },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  status: { fontSize: 12, fontWeight: '700' },
  error: { fontSize: 13, marginBottom: spacing.sm },
  group: { marginTop: spacing.md, gap: spacing.xs },
  groupTitle: { fontSize: 15, fontWeight: '800', marginBottom: spacing.xs },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  listText: { flex: 1, fontSize: 13, lineHeight: 20 },
  hint: { fontSize: 12, lineHeight: 18, marginTop: spacing.xs },
  previewTitle: { fontSize: 13, fontWeight: '800', marginTop: spacing.sm },
  preview: { fontSize: 12, lineHeight: 18 },
  numberRow: { flexDirection: 'row', gap: spacing.sm },
  numberInput: { minWidth: 80 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  switchLabel: { fontSize: 13, fontWeight: '700', flex: 1, marginRight: spacing.md },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
});
