import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, Field, spacing } from './ui';
import { useThemeStore } from '../store/themeStore';
import type { Chapter } from '../types/novel';
import * as db from '../services/database';
import {
  applyUserRevisionPreview,
  applyUserRevisionPreviewToCandidate,
  createTargetedRevisionPreview,
  createWholeChapterRewritePreview,
  discardUserRevisionPreview,
  loadUserRevisionCandidateBase,
  loadUserRevisionFrozenTruth,
  UserRevisionError,
  type UserRevisionCandidateBase,
  type UserRevisionKind,
  type UserRevisionPreview,
  type UserRevisionScenario,
} from '../services/writing/userRevision';
import { hashContent } from '../services/continuation/generation/continuationV5Contracts';

interface Props {
  visible: boolean;
  kind: UserRevisionKind | null;
  chapter: Chapter;
  scenario: UserRevisionScenario;
  selectionStart: number;
  selectionEnd: number;
  flushBeforeAction?: () => Promise<void>;
  /**
   * P1-1 Pre-Adoption mode: revision base is the Final Candidate Artifact of
   * this chapter's latest completed generation, not the chapter body. Apply
   * writes the candidate store; adoption later promotes the revised candidate.
   */
  candidate?: {
    chapterId: number;
    projectId: number;
    scenario: UserRevisionScenario;
  } | null;
  onClose: () => void;
  onApplied: (content: string) => void;
  /** Called after a candidate apply so the result screen can reload. */
  onCandidateApplied?: () => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof UserRevisionError) return error.message;
  if (error instanceof Error) return error.message;
  return '修订操作失败，请稍后重试。';
}

function kindTitle(kind: UserRevisionKind | null): string {
  return kind === 'targeted_revision' ? '精准修订' : '整章重写';
}

export const UserRevisionModal: React.FC<Props> = ({
  visible,
  kind,
  chapter,
  scenario,
  selectionStart,
  selectionEnd,
  flushBeforeAction,
  candidate,
  onClose,
  onApplied,
  onCandidateApplied,
}) => {
  const { theme } = useThemeStore();
  const [instruction, setInstruction] = useState('');
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<UserRevisionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [candidateBase, setCandidateBase] =
    useState<UserRevisionCandidateBase | null>(null);
  const [candidateSelection, setCandidateSelection] = useState({
    start: 0,
    end: 0,
  });
  const candidateSelectionRef = useRef({ start: 0, end: 0 });

  useEffect(() => {
    if (!visible) return;
    setInstruction('');
    setWorking(false);
    setPreview(null);
    setError(null);
    setCandidateBase(null);
    setCandidateSelection({ start: 0, end: 0 });
    candidateSelectionRef.current = { start: 0, end: 0 };
    if (!candidate) return;
    let cancelled = false;
    loadUserRevisionCandidateBase({
      projectId: candidate.projectId,
      chapterId: candidate.chapterId,
      scenario: candidate.scenario,
    })
      .then(base => {
        if (!cancelled) setCandidateBase(base);
      })
      .catch(caught => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [kind, visible, candidate]);

  const close = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (preview?.state === 'pending') {
      try {
        discardUserRevisionPreview(preview);
      } catch {
        // The modal is closing; a completed preview has no pending action.
      }
    }
    setPreview(null);
    setError(null);
    onClose();
  };

  const generate = async () => {
    if (!kind || working) return;
    setWorking(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const effectiveScenario = candidate ? candidate.scenario : scenario;
      if (candidate) {
        if (!candidateBase) {
          throw new UserRevisionError(
            'USER_REVISION_CANDIDATE_MISSING',
            error || '候选正文尚未加载完成。',
          );
        }
        const baseChapter: Chapter = {
          ...chapter,
          id: candidate.chapterId,
          project_id: candidate.projectId,
          content: candidateBase.baseBody,
        };
        if (kind === 'targeted_revision') {
          const boxFingerprint = hashContent(candidateBase.baseBody);
          if (boxFingerprint !== candidateBase.baseBodyFingerprint) {
            throw new UserRevisionError(
              'USER_REVISION_CANDIDATE_STALE',
              '候选正文已变化，请关闭后重新打开修订。',
            );
          }
        }
        const next =
          kind === 'targeted_revision'
            ? await createTargetedRevisionPreview({
                chapter: baseChapter,
                scenario: effectiveScenario,
                instruction,
                selectionStart: candidateSelectionRef.current.start,
                selectionEnd: candidateSelectionRef.current.end,
                frozenTruth: candidateBase.frozenTruth,
                candidateRef: candidateBase.candidateRef,
                abortSignal: controller.signal,
              })
            : await createWholeChapterRewritePreview({
                chapter: baseChapter,
                scenario: effectiveScenario,
                instruction,
                frozenTruth: candidateBase.frozenTruth,
                candidateRef: candidateBase.candidateRef,
                abortSignal: controller.signal,
              });
        setPreview(next);
        return;
      }
      await flushBeforeAction?.();
      const latestChapter = await db.getChapterById(chapter.id);
      if (!latestChapter) {
        throw new UserRevisionError(
          'USER_REVISION_CHAPTER_MISSING',
          '章节不存在，无法生成修订预览。',
        );
      }
      const frozenTruth = await loadUserRevisionFrozenTruth({
        projectId: latestChapter.project_id,
        chapterId: latestChapter.id,
        scenario,
      });
      const next =
        kind === 'targeted_revision'
          ? await createTargetedRevisionPreview({
              chapter: latestChapter,
              scenario,
              instruction,
              selectionStart,
              selectionEnd,
              frozenTruth,
              abortSignal: controller.signal,
            })
          : await createWholeChapterRewritePreview({
              chapter: latestChapter,
              scenario,
              instruction,
              frozenTruth,
              abortSignal: controller.signal,
            });
      setPreview(next);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      Toast.show({
        type: 'error',
        text1: `${kindTitle(kind)}失败`,
        text2: message,
      });
    } finally {
      abortRef.current = null;
      setWorking(false);
    }
  };

  const apply = async () => {
    if (!preview || preview.state !== 'pending' || working) return;
    setWorking(true);
    setError(null);
    try {
      if (preview.candidateRef.kind !== 'chapter') {
        await applyUserRevisionPreviewToCandidate({ preview });
        Toast.show({
          type: 'success',
          text1: `${kindTitle(preview.kind)}已应用`,
          text2: '候选正文已更新，采纳后写入章节。',
        });
        onCandidateApplied?.();
        setPreview(null);
        onClose();
        return;
      }
      await flushBeforeAction?.();
      const result = await applyUserRevisionPreview({ preview });
      onApplied(result.chapter.content);
      Toast.show({
        type: 'success',
        text1: `${kindTitle(result.preview.kind)}已应用`,
        text2: '已保存版本快照，正文与故事记忆已更新。',
      });
      setPreview(null);
      onClose();
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      Toast.show({ type: 'error', text1: '应用修订失败', text2: message });
    } finally {
      setWorking(false);
    }
  };

  const discard = () => {
    if (preview?.state === 'pending') {
      setPreview(discardUserRevisionPreview(preview));
    }
    setPreview(null);
    setError(null);
  };

  const effectiveSelection = candidate ? candidateSelection : {
    start: selectionStart,
    end: selectionEnd,
  };
  const selectedLength = Math.max(
    0,
    effectiveSelection.end - effectiveSelection.start,
  );
  const title = kindTitle(kind);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}
    >
      <Pressable style={styles.overlay} onPress={close}>
        <Pressable
          style={[styles.sheet, { backgroundColor: theme.colors.surface }]}
          onPress={event => event.stopPropagation()}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
              {title}
            </Text>
            <Button label="关闭" compact variant="ghost" onPress={close} />
          </View>
          {!preview ? (
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text
                style={[styles.help, { color: theme.colors.textSecondary }]}
              >
                {candidate
                  ? kind === 'targeted_revision'
                    ? '在下方候选正文中长按选择要修订的范围；模型只能修改选区内正文。修订写入候选，采纳后生效。'
                    : '复用本次生成的 Frozen Truth，只执行一次显式整章重写；修订写入候选，采纳后生效。不会重新运行 Planner、QA 或 Revision 流水线。'
                  : kind === 'targeted_revision'
                  ? `当前选区 ${selectionStart}..${selectionEnd}（${selectedLength} 个 UTF-16 单元）。模型只能修改选区内正文。`
                  : '复用本章最近一次 Frozen Truth，只执行一次显式整章重写；不会重新运行 Planner、QA 或 Revision 流水线。'}
              </Text>
              {candidate && kind === 'targeted_revision' ? (
                candidateBase ? (
                  <View style={styles.candidateBoxWrap}>
                    <Text
                      style={[
                        styles.sectionTitle,
                        { color: theme.colors.textSecondary },
                      ]}
                    >
                      候选正文（长按选择范围：{candidateSelection.start}..{
                        candidateSelection.end
                      }
                      ，{selectedLength} 个单元）
                    </Text>
                    <TextInput
                      testID="candidate-revision-selection-box"
                      style={[
                        styles.candidateSelectionBox,
                        {
                          color: theme.colors.textPrimary,
                          borderColor: theme.colors.border,
                        },
                      ]}
                      value={candidateBase.baseBody}
                      multiline
                      scrollEnabled
                      textAlignVertical="top"
                      onSelectionChange={({
                        nativeEvent: { selection: next },
                      }) => {
                        if (next.end > next.start) {
                          candidateSelectionRef.current = next;
                          setCandidateSelection(next);
                        }
                      }}
                    />
                  </View>
                ) : (
                  <Text
                    style={[styles.help, { color: theme.colors.textSecondary }]}
                  >
                    候选正文加载中…
                  </Text>
                )
              ) : null}
              <Field
                testID="user-revision-instruction"
                label="修订要求"
                value={instruction}
                onChangeText={setInstruction}
                placeholder={
                  kind === 'targeted_revision'
                    ? '例如：让这段对话更克制，保留事实和语气。'
                    : '例如：保留事件因果，增强冲突和节奏。'
                }
                multiline
                inputStyle={styles.instruction}
              />
              {error ? (
                <Text style={[styles.error, { color: theme.colors.danger }]}>
                  {error}
                </Text>
              ) : null}
              <View style={styles.metaBox}>
                <Text
                  style={[styles.meta, { color: theme.colors.textSecondary }]}
                >
                  Thinking Always On · Governor 旁路 · hidden retry 0 · 预期 1
                  次 LLM
                </Text>
              </View>
              <Button
                testID="user-revision-generate"
                label={working ? '生成预览中…' : '生成预览'}
                disabled={working || !kind}
                onPress={() => generate().catch(() => {})}
              />
              {working ? <ActivityIndicator style={styles.spinner} /> : null}
            </ScrollView>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text
                style={[styles.help, { color: theme.colors.textSecondary }]}
              >
                这是待确认预览，不会自动写入正文。Receipt：逻辑 1 · 物理{' '}
                {preview.receipt.physicalRequestCount} · Formatter 0。
              </Text>
              {preview.kind === 'targeted_revision' ? (
                <View>
                  <Text
                    style={[
                      styles.sectionTitle,
                      { color: theme.colors.danger },
                    ]}
                  >
                    选区修改前
                  </Text>
                  <Card style={styles.previewCard}>
                    <Text
                      style={[
                        styles.previewText,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      {preview.selection
                        ? preview.baseBody.slice(
                            preview.selection.selectionStart,
                            preview.selection.selectionEnd,
                          )
                        : ''}
                    </Text>
                  </Card>
                  <Text
                    style={[
                      styles.sectionTitle,
                      { color: theme.colors.accent },
                    ]}
                  >
                    选区修改后
                  </Text>
                  <Card style={styles.previewCard}>
                    <Text
                      style={[
                        styles.previewText,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      {preview.selection
                        ? preview.candidateBody.slice(
                            preview.selection.selectionStart,
                            preview.candidateBody.length -
                              preview.baseBody.length +
                              preview.selection.selectionEnd,
                          )
                        : ''}
                    </Text>
                  </Card>
                </View>
              ) : (
                <View>
                  <Text
                    style={[
                      styles.sectionTitle,
                      { color: theme.colors.danger },
                    ]}
                  >
                    原正文
                  </Text>
                  <Card style={styles.previewCard}>
                    <Text
                      style={[
                        styles.previewText,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      {preview.baseBody}
                    </Text>
                  </Card>
                  <Text
                    style={[
                      styles.sectionTitle,
                      { color: theme.colors.accent },
                    ]}
                  >
                    重写预览
                  </Text>
                  <Card style={styles.previewCard}>
                    <Text
                      style={[
                        styles.previewText,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      {preview.candidateBody}
                    </Text>
                  </Card>
                </View>
              )}
              {error ? (
                <Text style={[styles.error, { color: theme.colors.danger }]}>
                  {error}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <Button
                  testID="user-revision-discard"
                  label="放弃预览"
                  variant="ghost"
                  disabled={working}
                  onPress={discard}
                />
                <Button
                  testID="user-revision-apply"
                  label={working ? '应用中…' : '确认应用'}
                  disabled={working}
                  onPress={() => apply().catch(() => {})}
                />
              </View>
              {working ? <ActivityIndicator style={styles.spinner} /> : null}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '92%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  title: { fontSize: 19, fontWeight: '800' },
  help: { fontSize: 13, lineHeight: 20, marginBottom: spacing.md },
  instruction: { minHeight: 100, textAlignVertical: 'top' },
  metaBox: { marginVertical: spacing.md },
  meta: { fontSize: 12, lineHeight: 18 },
  candidateBoxWrap: { marginBottom: spacing.md },
  candidateSelectionBox: {
    minHeight: 160,
    maxHeight: 260,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: spacing.sm,
    fontSize: 14,
    lineHeight: 22,
    marginTop: spacing.xs,
  },
  error: { fontSize: 13, lineHeight: 20, marginVertical: spacing.sm },
  spinner: { marginVertical: spacing.md },
  sectionTitle: { fontSize: 13, fontWeight: '800', marginTop: spacing.sm },
  previewCard: {
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    padding: spacing.md,
  },
  previewText: { fontSize: 14, lineHeight: 23 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
});
