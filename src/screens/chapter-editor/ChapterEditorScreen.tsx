import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { ChevronRight, Focus } from 'lucide-react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Toast from 'react-native-toast-message';
import { Button, Header, Screen, spacing } from '../../components/ui';
import * as db from '../../services/database';
import { createRevision } from '../../services/revisionService';
import { finalizeChapterMemory } from '../../services/storyMemory/storyMemoryService';
import {
  finalizeContinuationChapter,
  findLatestPendingReviewRunForChapter,
} from '../../services/continuation/generation';
import { findOrCreateNextChapter } from '../../services/chapterNavigation';
import { estimateTokens } from '../../utils/tokenEstimator';
import type { EditorStackParamList } from '../../navigation/TabNavigator';
import type { Chapter } from '../../types/novel';
import { useProjectStore } from '../../store/projectStore';
import { ChapterFields } from './ChapterFields';
import { ChapterPipelinePanel } from './ChapterPipelinePanel';
import { ChapterToolbar } from './ChapterToolbar';
import { ChapterTtsControls } from './ChapterTtsControls';
import { useChapterAutoSave } from './hooks/useChapterAutoSave';
import { useChapterDocument } from './hooks/useChapterDocument';
import { useChapterPipeline } from './hooks/useChapterPipeline';
import { useChapterTts } from './hooks/useChapterTts';
import { useUnsavedChangesGuard } from './hooks/useUnsavedChangesGuard';

type ChapterNavigation = NativeStackNavigationProp<
  EditorStackParamList,
  'ChapterEditor'
>;

interface Props {
  chapterId: number;
  onClose: () => void;
}

export const ChapterEditor: React.FC<Props> = ({ chapterId, onClose }) => {
  const navigation = useNavigation<ChapterNavigation>();
  const { chapter, loadChapter, setChapter } = useChapterDocument(chapterId);
  const { autoSaveRef, changeField, saveStatus, setSaveStatus } =
    useChapterAutoSave(chapter, setChapter);
  const { bypassNextRemove, flushAndClose } = useUnsavedChangesGuard({
    autoSaveRef,
    navigation,
    onClose,
    setSaveStatus,
  });
  const {
    currentStage,
    generating,
    progressStartedAt,
    progressVisible,
    queued,
    continuationStage,
    runPipeline,
    stopPipeline,
  } = useChapterPipeline({ chapter, chapterId, navigation });
  const {
    handleRangeSelected,
    isJustFinished,
    isPlaying,
    isSynthesizing,
    rangePickerVisible,
    setRangePickerVisible,
    toggleTts,
  } = useChapterTts(chapter);
  const scrollRef = useRef<ScrollView>(null);
  const latestChapterRef = useRef(chapter);
  latestChapterRef.current = chapter;
  const [focusMode, setFocusMode] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const finalizingRef = useRef(false);
  const [clearing, setClearing] = useState(false);
  const clearingRef = useRef(false);
  const [pendingContinuationRunId, setPendingContinuationRunId] = useState<
    string | null
  >(null);

  useFocusEffect(
    useCallback(() => {
      loadChapter().catch(() => {});
      // Re-discover unadopted continuation results so tab switches do not
      // strand awaiting_user runs without a return path.
      let cancelled = false;
      const project = useProjectStore.getState().currentProject;
      if (project?.mode === 'continuation') {
        findLatestPendingReviewRunForChapter(project.id, chapterId)
          .then(run => {
            if (!cancelled) setPendingContinuationRunId(run?.id ?? null);
          })
          .catch(() => {
            if (!cancelled) setPendingContinuationRunId(null);
          });
      } else {
        setPendingContinuationRunId(null);
      }
      return () => {
        cancelled = true;
      };
    }, [loadChapter, chapterId]),
  );

  const finalizeChapter = useCallback(async () => {
    const currentChapter = latestChapterRef.current;
    if (!currentChapter || finalizingRef.current) return;
    finalizingRef.current = true;
    setFinalizing(true);
    try {
      await autoSaveRef.current.flush();
      // Re-read after flushing the debounced write. Using the render-time
      // chapter object here could overwrite the just-saved body with a stale
      // snapshot, which then makes evidence validation fail intermittently.
      const savedChapter = await db.getChapterById(currentChapter.id);
      if (!savedChapter) throw new Error('章节不存在。');
      await db.updateChapter(savedChapter.id, {
        title: savedChapter.title,
        synopsis: savedChapter.synopsis,
        content: savedChapter.content,
      });
      setSaveStatus('saved');
      const project = useProjectStore.getState().currentProject;
      if (project?.mode === 'continuation') {
        // Spec §11: finalize inserts extract_state outbox; no LLM in transaction.
        // UI hints that state extraction will be an extra billed call.
        const fin = await finalizeContinuationChapter({
          projectId: project.id,
          chapterId: savedChapter.id,
          content: savedChapter.content,
        });
        await loadChapter();
        Toast.show({
          type: 'success',
          text1: '章节已定稿',
          text2: `状态提取与故事记忆重建已排队（hash ${fin.revisionHash.slice(0, 8)}）。`,
        });
      } else {
        const result = await finalizeChapterMemory(savedChapter.id);
        await loadChapter();
        Toast.show({
          type: result.checkpointAttempted && !result.checkpointUpdated
            ? 'info'
            : 'success',
          text1: '章节已定稿',
          text2: result.statusMessage || (
            result.checkpointUpdated
              ? `长期记忆已整理到第 ${
                  // statusMessage is preferred; this fallback keeps outline projects working
                  result.state.throughChapterPosition + 1
                } 章。`
              : result.pendingCount > 0
                ? `长期记忆待整理 ${result.pendingCount} 章。`
                : undefined
          ),
        });
      }
    } catch (error: any) {
      Alert.alert(
        '定稿失败',
        `章节正文已尽量保存。\n${
          error?.message || '请稍后重试。'
        }`,
      );
    } finally {
      finalizingRef.current = false;
      setFinalizing(false);
    }
  }, [autoSaveRef, loadChapter, setSaveStatus]);

  const finishClearing = useCallback(() => {
    clearingRef.current = false;
    setClearing(false);
  }, []);

  const clearContent = useCallback(() => {
    const currentChapter = latestChapterRef.current;
    if (!currentChapter || clearingRef.current) return;
    clearingRef.current = true;
    setClearing(true);
    Alert.alert('清空正文', '确定要清空当前章节的全部正文内容？', [
      { text: '取消', style: 'cancel', onPress: finishClearing },
      {
        text: '清空',
        style: 'destructive',
        onPress: async () => {
          try {
            await autoSaveRef.current.flush();
            const latestChapter = latestChapterRef.current;
            if (!latestChapter) return;
            await createRevision({
              projectId: latestChapter.project_id,
              targetType: 'chapter',
              targetId: latestChapter.id,
              title: latestChapter.title,
              content: latestChapter.content,
              source: 'before_clear',
            });
            await db.updateChapter(latestChapter.id, { content: '' });
            latestChapterRef.current = { ...latestChapter, content: '' };
            await loadChapter();
            setSaveStatus('saved');
          } catch (error: any) {
            Toast.show({
              type: 'error',
              text1: '操作失败',
              text2: error?.message,
            });
          } finally {
            finishClearing();
          }
        },
      },
    ], { cancelable: false });
  }, [autoSaveRef, finishClearing, loadChapter, setSaveStatus]);

  const changeEditableField = useCallback(
    (field: keyof Chapter, value: string) => {
      if (clearingRef.current) return;
      const currentChapter = latestChapterRef.current;
      if (currentChapter) {
        latestChapterRef.current = { ...currentChapter, [field]: value };
      }
      changeField(field, value);
    },
    [changeField],
  );

  const manualCheckpoint = useCallback(async () => {
    if (!chapter) return;
    try {
      await createRevision({
        projectId: chapter.project_id,
        targetType: 'chapter',
        targetId: chapter.id,
        title: chapter.title,
        content: chapter.content,
        source: 'manual_checkpoint',
      });
      Alert.alert('版本已保存', '当前内容已保存为手动版本快照。');
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: error?.message });
    }
  }, [chapter]);

  /**
   * "下一章"按钮处理：
   * 1) 当前章节正文为空 → 弹 Alert 拒绝（避免创建空章节）
   * 2) flush 自动保存（与 finalizeChapter 同模式）
   * 3) 找下一章或创建新章节（按项目模式分流，续写用边界接续标题）
   * 4) bypass + replace 跳转：按返回键回章节列表而非上一章
   */
  const onCreateNextChapter = useCallback(async () => {
    const currentChapter = latestChapterRef.current;
    if (!currentChapter) return;
    if (currentChapter.content.trim().length === 0) {
      Alert.alert(
        '当前章节还没有正文',
        '请先生成内容或手动填写正文后再开下一章。',
      );
      return;
    }
    try {
      await autoSaveRef.current.flush();
      const project = useProjectStore.getState().currentProject;
      const mode = project?.mode ?? 'outline';
      const nextChapterId = await findOrCreateNextChapter(
        currentChapter.project_id,
        currentChapter.id,
        mode,
      );
      bypassNextRemove();
      navigation.replace('ChapterEditor', { chapterId: nextChapterId });
    } catch (error: any) {
      Alert.alert('跳转下一章失败', error?.message || '未知错误');
    }
  }, [autoSaveRef, bypassNextRemove, navigation]);

  const saveLabel =
    saveStatus === 'saved'
      ? '已保存'
      : saveStatus === 'saving'
      ? '保存中...'
      : '保存失败';
  const estimatedTokenCount = useMemo(
    () => estimateTokens(chapter?.content || ''),
    [chapter?.content],
  );

  if (!chapter) {
    return (
      <Screen>
        <Header
          title="章节编辑"
          action={<Button label="返回" variant="ghost" onPress={onClose} />}
        />
      </Screen>
    );
  }

  const isContinuation =
    useProjectStore.getState().currentProject?.mode === 'continuation';
  const toolbar = (
    <ChapterToolbar
      clearing={clearing}
      finalizing={finalizing}
      generating={generating}
      isJustFinished={isJustFinished}
      isPlaying={isPlaying}
      isSynthesizing={isSynthesizing}
      isContinuation={isContinuation}
      hasPendingContinuationResult={Boolean(pendingContinuationRunId)}
      onClear={clearContent}
      onContext={() =>
        navigation.navigate('ContextPreview', { chapterId: chapter.id })
      }
      onDraft={() =>
        navigation.navigate('DraftPreview', {
          targetType: 'chapter',
          targetId: chapter.id,
          projectId: chapter.project_id,
        })
      }
      onFinalize={() => finalizeChapter().catch(() => {})}
      onHistory={() =>
        navigation.navigate('RevisionHistory', {
          targetType: 'chapter',
          targetId: chapter.id,
          projectId: chapter.project_id,
        })
      }
      onManualCheckpoint={() => manualCheckpoint().catch(() => {})}
      onOpenContinuationResult={
        pendingContinuationRunId
          ? () =>
              navigation.navigate('ContinuationResult', {
                runId: pendingContinuationRunId,
              })
          : undefined
      }
      onRunPipeline={runPipeline}
      onStopPipeline={stopPipeline}
      onToggleTts={() => toggleTts().catch(() => {})}
      onSummary={() =>
        Alert.alert('章节摘要', chapter.memory_summary || '暂无记忆摘要。')
      }
    />
  );

  // 正文非空时才在编辑区底部显示"下一章"主操作按钮。
  // 空章节守卫在 onCreateNextChapter 内部也兜了一次（防 prop 误传）。
  const showNextChapterButton = chapter.content.trim().length > 0;
  const nextChapterButton = showNextChapterButton ? (
    <View style={styles.nextChapterButton}>
      <Button
        testID="next-chapter-button"
        label="下一章"
        icon={ChevronRight}
        variant="primary"
        onPress={() => onCreateNextChapter().catch(() => {})}
      />
    </View>
  ) : null;

  return (
    <Screen>
      <Header
        title={focusMode ? '专注模式' : '章节编辑'}
        subtitle={saveLabel}
        action={
          <View style={styles.headerActions}>
            <Button
              label={focusMode ? '退出' : '专注'}
              icon={Focus}
              variant="ghost"
              onPress={() => setFocusMode(value => !value)}
              compact
            />
            <Button
              label="返回"
              variant="ghost"
              onPress={() => flushAndClose().catch(() => {})}
              compact
            />
          </View>
        }
      />
      <ChapterPipelinePanel
        currentStage={currentStage}
        progressStartedAt={progressStartedAt}
        progressVisible={progressVisible}
        queued={queued}
        continuationStage={continuationStage}
        focusMode={focusMode}
      />
      <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
        <ChapterFields
          chapter={chapter}
          changeField={changeEditableField}
          estimatedTokenCount={estimatedTokenCount}
          focusMode={focusMode}
          saveLabel={saveLabel}
          toolbar={toolbar}
          nextChapterButton={nextChapterButton}
          onScrollToTop={() =>
            scrollRef.current?.scrollTo({ y: 0, animated: true })
          }
        />
      </ScrollView>
      <ChapterTtsControls
        visible={rangePickerVisible}
        onClose={() => setRangePickerVisible(false)}
        onSelect={handleRangeSelected}
      />
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 120 },
  headerActions: { flexDirection: 'row', gap: spacing.xs },
  nextChapterButton: { marginTop: spacing.lg },
});
