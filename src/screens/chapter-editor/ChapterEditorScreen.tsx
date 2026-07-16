import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { Focus } from 'lucide-react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Toast from 'react-native-toast-message';
import { Button, Header, Screen, spacing } from '../../components/ui';
import * as db from '../../services/database';
import { createRevision } from '../../services/revisionService';
import { generateMemorySummary } from '../../services/summaryGenerator';
import { estimateTokens } from '../../utils/tokenEstimator';
import type { EditorStackParamList } from '../../navigation/TabNavigator';
import type { Chapter } from '../../types/novel';
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
  const { flushAndClose } = useUnsavedChangesGuard({
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
  const [clearing, setClearing] = useState(false);
  const clearingRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      loadChapter().catch(() => {});
    }, [loadChapter]),
  );

  const finalizeChapter = useCallback(async () => {
    if (!chapter || finalizing) return;
    setFinalizing(true);
    try {
      await autoSaveRef.current.flush();
      await db.updateChapter(chapter.id, {
        title: chapter.title,
        synopsis: chapter.synopsis,
        content: chapter.content,
      });
      setSaveStatus('saved');
      const memorySummary = await generateMemorySummary(chapter.id, 200);
      await db.updateChapter(chapter.id, {
        memory_summary: memorySummary,
        memory_summary_tokens: estimateTokens(memorySummary),
      });
      await loadChapter();
    } catch (error: any) {
      Alert.alert(
        '摘要生成失败',
        error?.message || '章节已保存，但自动记忆摘要生成失败。',
      );
    } finally {
      setFinalizing(false);
    }
  }, [autoSaveRef, chapter, finalizing, loadChapter, setSaveStatus]);

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

  const toolbar = (
    <ChapterToolbar
      clearing={clearing}
      finalizing={finalizing}
      generating={generating}
      isJustFinished={isJustFinished}
      isPlaying={isPlaying}
      isSynthesizing={isSynthesizing}
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
      onRunPipeline={runPipeline}
      onStopPipeline={stopPipeline}
      onToggleTts={() => toggleTts().catch(() => {})}
      onSummary={() =>
        Alert.alert('章节摘要', chapter.memory_summary || '暂无记忆摘要。')
      }
    />
  );

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
});
