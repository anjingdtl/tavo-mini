import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  Bot,
  Eye,
  FileText,
  History,
  Inbox,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react-native';
import { Button, spacing } from '../../components/ui';

interface Props {
  clearing: boolean;
  finalizing: boolean;
  generating: boolean;
  isJustFinished: boolean;
  isPlaying: boolean;
  isSynthesizing: boolean;
  /** continuation projects use 续写 wording (Spec §10.1). */
  isContinuation?: boolean;
  /** Pending awaiting_user continuation run — re-open result after leaving. */
  hasPendingContinuationResult?: boolean;
  onClear: () => void;
  onContext: () => void;
  onDraft: () => void;
  onFinalize: () => void;
  onHistory: () => void;
  onManualCheckpoint: () => void;
  onOpenContinuationResult?: () => void;
  onTargetedRevision?: () => void;
  onWholeChapterRewrite?: () => void;
  onRunPipeline: () => void;
  onStopPipeline: () => void;
  onToggleTts: () => void;
  onSummary: () => void;
}

export function ChapterToolbar({
  clearing,
  finalizing,
  generating,
  isJustFinished,
  isPlaying,
  isSynthesizing,
  isContinuation = false,
  hasPendingContinuationResult = false,
  onClear,
  onContext,
  onDraft,
  onFinalize,
  onHistory,
  onManualCheckpoint,
  onOpenContinuationResult,
  onTargetedRevision,
  onWholeChapterRewrite,
  onRunPipeline,
  onStopPipeline,
  onToggleTts,
  onSummary,
}: Props) {
  const aiLabel = generating
    ? 'AI 生成中…'
    : isContinuation
    ? 'AI 续写'
    : 'AI 重新生成';
  return (
    <View style={styles.toolbar}>
      <ScrollView
        testID="chapter-toolbar-scroll"
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.toolbarRow}
      >
        <Button
          testID="chapter-ai-generate"
          label={aiLabel}
          icon={Bot}
          onPress={onRunPipeline}
          disabled={generating || finalizing}
          compact
          minWidth={92}
        />
        {generating ? (
          <Button
            testID="chapter-stop"
            label="停止"
            icon={Square}
            variant="secondary"
            onPress={onStopPipeline}
            compact
            minWidth={72}
          />
        ) : null}
        {isContinuation &&
        hasPendingContinuationResult &&
        onOpenContinuationResult ? (
          <Button
            testID="open-continuation-result"
            label="续写结果"
            icon={Inbox}
            variant="secondary"
            onPress={onOpenContinuationResult}
            disabled={generating}
            compact
            minWidth={92}
          />
        ) : null}
        {onTargetedRevision ? (
          <Button
            testID="chapter-targeted-revision"
            label="精准修订"
            icon={FileText}
            variant="secondary"
            onPress={onTargetedRevision}
            disabled={generating || finalizing || clearing}
            compact
            minWidth={92}
          />
        ) : null}
        {onWholeChapterRewrite ? (
          <Button
            testID="chapter-whole-rewrite"
            label="整章重写"
            icon={Bot}
            variant="secondary"
            onPress={onWholeChapterRewrite}
            disabled={generating || finalizing || clearing}
            compact
            minWidth={92}
          />
        ) : null}
        <Button
          testID="chapter-finalize"
          label={finalizing ? '定稿中…' : '定稿'}
          icon={FileText}
          variant="secondary"
          onPress={onFinalize}
          disabled={finalizing || generating}
          compact
          minWidth={72}
        />
        <Button
          label="版本"
          icon={History}
          variant="secondary"
          onPress={onManualCheckpoint}
          compact
          minWidth={72}
        />
        <Button
          label={clearing ? '清空中…' : '清空'}
          icon={Trash2}
          variant="ghost"
          onPress={onClear}
          disabled={generating || finalizing || clearing}
          compact
          minWidth={72}
        />
        <Button
          label="摘要"
          icon={FileText}
          variant="ghost"
          onPress={onSummary}
          compact
          minWidth={72}
        />
        <Button
          label="历史"
          icon={History}
          variant="ghost"
          onPress={onHistory}
          compact
          minWidth={72}
        />
        <Button
          label={
            isSynthesizing
              ? '生成中…'
              : isPlaying
              ? '停止'
              : isJustFinished
              ? '已结束'
              : '朗读'
          }
          icon={isPlaying ? Square : Volume2}
          variant={isPlaying ? 'secondary' : 'ghost'}
          onPress={onToggleTts}
          compact
          minWidth={72}
        />
        <Button
          label="上下文"
          icon={Eye}
          variant="ghost"
          testID="chapter-context-button"
          onPress={onContext}
          compact
          minWidth={72}
        />
        <Button
          label="草稿"
          icon={Inbox}
          variant="ghost"
          onPress={onDraft}
          compact
          minWidth={72}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { marginVertical: spacing.lg },
  toolbarRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.lg,
  },
});
