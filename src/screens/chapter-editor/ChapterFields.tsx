import React from 'react';
import { Button, Field, spacing } from '../../components/ui';
import { StyleSheet, Text, View } from 'react-native';
import { ArrowUp } from 'lucide-react-native';
import { useThemeStore } from '../../store/themeStore';
import type { Chapter } from '../../types/novel';

interface Props {
  chapter: Chapter;
  changeField: (field: keyof Chapter, value: string) => void;
  estimatedTokenCount: number;
  focusMode: boolean;
  saveLabel: string;
  toolbar?: React.ReactNode;
  onScrollToTop: () => void;
}

export function ChapterFields({
  chapter,
  changeField,
  estimatedTokenCount,
  focusMode,
  saveLabel,
  toolbar,
  onScrollToTop,
}: Props) {
  const { theme } = useThemeStore();
  return (
    <>
      {!focusMode ? (
        <>
          <Field
            testID="chapter-title-input"
            label="章节标题"
            value={chapter.title}
            onChangeText={value => changeField('title', value)}
            placeholder="章节标题"
          />
          <Field
            testID="chapter-synopsis-input"
            label="章节概要"
            value={chapter.synopsis}
            onChangeText={value => changeField('synopsis', value)}
            placeholder="写下本章目标、冲突和结尾"
            multiline
            inputStyle={styles.synopsis}
          />
          {toolbar}
        </>
      ) : null}
      <Field
        testID="chapter-content-input"
        label="正文"
        value={chapter.content}
        onChangeText={value => changeField('content', value)}
        placeholder="开始写作..."
        multiline
        inputStyle={focusMode ? styles.focusEditor : styles.editor}
      />
      {chapter.memory_summary ? (
        <View
          style={[
            styles.summaryBox,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.card,
            },
          ]}
        >
          <Text
            style={[styles.summaryTitle, { color: theme.colors.textPrimary }]}
          >
            记忆摘要
          </Text>
          <Text
            style={[styles.summaryText, { color: theme.colors.textSecondary }]}
          >
            {chapter.memory_summary}
          </Text>
        </View>
      ) : null}
      <View style={styles.footer}>
        <Text
          style={[styles.footerText, { color: theme.colors.textSecondary }]}
        >
          {chapter.content.length} 字 · 预估 {estimatedTokenCount} tokens ·{' '}
          {saveLabel}
        </Text>
      </View>
      <Button
        label="回到顶部"
        icon={ArrowUp}
        variant="secondary"
        onPress={onScrollToTop}
      />
    </>
  );
}

const styles = StyleSheet.create({
  synopsis: { minHeight: 76, textAlignVertical: 'top' },
  editor: {
    minHeight: 420,
    textAlignVertical: 'top',
    fontSize: 16,
    lineHeight: 25,
  },
  focusEditor: {
    minHeight: 600,
    textAlignVertical: 'top',
    fontSize: 18,
    lineHeight: 30,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  footerText: { flex: 1, fontSize: 12, fontWeight: '700' },
  summaryBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  summaryTitle: { fontSize: 14, fontWeight: '800', marginBottom: spacing.xs },
  summaryText: { fontSize: 13, lineHeight: 20 },
});
