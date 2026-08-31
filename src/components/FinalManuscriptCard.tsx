/**
 * Final Manuscript Card（B1/B3）：最终稿的一等公民展示。
 *
 * 大纲与续写两条链共用同一 Final UI 语义：
 *  - 显示最终稿字数（统一口径 nonWhitespaceCharCount）；
 *  - 明确「已修订 N 字」/「与初稿一致」；
 *  - [阅读全文] 按钮直接打开最终稿正文。
 *
 * 数据来自 FinalWritingArtifact（由现有持久化真相重建，本组件不写库）。
 */
import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, spacing } from './ui';
import { useThemeStore } from '../store/themeStore';
import type { FinalWritingArtifact } from '../services/writing/finalArtifactData';

export interface FinalManuscriptCardProps {
  artifact: FinalWritingArtifact | null;
  /** 追加的便捷动作（B4 起用：编辑最终稿 / 继续下一章）。 */
  actions?: React.ReactNode;
  /** 编辑最终稿（进入章节编辑器）。 */
  onEdit?: () => void;
  /** 进入章节编辑器后选择范围并执行一次精准修订。 */
  onTargetedRevision?: () => void;
  /** 进入章节编辑器并执行一次待确认的整章重写。 */
  onWholeChapterRewrite?: () => void;
  /** 继续写下一章。 */
  onNext?: () => void;
}

function formatCount(n: number): string {
  return n.toLocaleString('zh-CN');
}

function deltaText(artifact: FinalWritingArtifact): string | null {
  if (!artifact.draftBody) return null;
  const draft = artifact.draftBody.length;
  const delta = artifact.body.length - draft;
  if (delta === 0) return null;
  return `${delta > 0 ? '+' : ''}${formatCount(delta)} 字`;
}

export const FinalManuscriptCard: React.FC<FinalManuscriptCardProps> = ({
  artifact,
  actions,
  onEdit,
  onTargetedRevision,
  onWholeChapterRewrite,
  onNext,
}) => {
  const { theme } = useThemeStore();
  const [reading, setReading] = useState(false);
  const [diffIndex, setDiffIndex] = useState<number | null>(null);

  const revised = artifact?.summary.revisionApplied ?? false;
  const changeCount = artifact?.changes.changes.length ?? 0;
  const charCount = artifact?.summary.charStats.nonWhitespaceCharCount ?? 0;
  const paragraphCount = artifact?.summary.charStats.paragraphCount ?? 0;
  const delta = useMemo(
    () => (artifact ? deltaText(artifact) : null),
    [artifact],
  );

  if (!artifact) {
    return (
      <Card style={styles.card}>
        <Text style={[styles.muted, { color: theme.colors.textMuted }]}>
          暂无最终稿：该任务未生成可展示的成品正文。
        </Text>
      </Card>
    );
  }

  const statusText = revised
    ? delta
      ? `已修订（${delta}）`
      : '已修订'
    : '与初稿一致';

  const changeTypeLabel = (type: string): string => {
    switch (type) {
      case 'add':
        return '新增内容';
      case 'delete':
        return '删除内容';
      default:
        return '修改内容';
    }
  };

  const showReadingUnavailable = () => {
    Toast.show({
      type: 'info',
      text1: '最终稿为空',
      text2: '正文暂不可读。',
    });
  };

  return (
    <Card style={styles.card}>
      <View style={styles.headRow}>
        <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
          最终稿
        </Text>
        {revised ? (
          <View
            style={[styles.badge, { backgroundColor: theme.colors.accentSoft }]}
          >
            <Text style={[styles.badgeText, { color: theme.colors.accent }]}>
              {statusText}
            </Text>
          </View>
        ) : (
          <View
            style={[styles.badge, { backgroundColor: theme.colors.accentSoft }]}
          >
            <Text
              style={[styles.badgeText, { color: theme.colors.textSecondary }]}
            >
              {statusText}
            </Text>
          </View>
        )}
      </View>
      <Text style={[styles.charCount, { color: theme.colors.textPrimary }]}>
        {formatCount(charCount)} 字
      </Text>
      <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
        {paragraphCount} 段
      </Text>
      {delta && artifact.draftBody ? (
        <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
          初稿 {formatCount(artifact.draftBody.length)} 字 → 最终稿{' '}
          {formatCount(artifact.body.length)} 字
        </Text>
      ) : null}
      {revised ? (
        <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
          AI 本次修改：{changeCount} 处
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          label="阅读全文"
          compact
          icon={undefined as any}
          variant="ghost"
          onPress={() => {
            if (artifact.body.trim()) {
              setReading(true);
            } else {
              showReadingUnavailable();
            }
          }}
        />
        {revised && changeCount > 0 ? (
          <Button
            label={`查看修改（${changeCount}）`}
            compact
            icon={undefined as any}
            variant="ghost"
            onPress={() => setDiffIndex(0)}
          />
        ) : null}
        {onEdit ? (
          <Button
            label="编辑最终稿"
            compact
            icon={undefined as any}
            onPress={onEdit}
          />
        ) : null}
        {onTargetedRevision ? (
          <Button
            testID="final-targeted-revision"
            label="精准修订"
            compact
            icon={undefined as any}
            variant="secondary"
            onPress={onTargetedRevision}
          />
        ) : null}
        {onWholeChapterRewrite ? (
          <Button
            testID="final-whole-rewrite"
            label="整章重写"
            compact
            icon={undefined as any}
            variant="secondary"
            onPress={onWholeChapterRewrite}
          />
        ) : null}
        {onNext ? (
          <Button
            label="继续下一章"
            compact
            icon={undefined as any}
            variant="ghost"
            onPress={onNext}
          />
        ) : null}
        {actions}
      </View>

      <Modal
        visible={reading}
        transparent
        animationType="fade"
        onRequestClose={() => setReading(false)}
      >
        <Pressable
          style={styles.readerOverlay}
          onPress={() => setReading(false)}
        >
          <Pressable
            style={[styles.reader, { backgroundColor: theme.colors.surface }]}
            onPress={event => event.stopPropagation()}
          >
            <View style={styles.readerHead}>
              <Text
                style={[
                  styles.readerTitle,
                  { color: theme.colors.textPrimary },
                ]}
              >
                最终稿
              </Text>
              <Text
                style={[
                  styles.readerChars,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {formatCount(charCount)} 字
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="关闭最终稿"
                onPress={() => setReading(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.readerClose}
              >
                <Text
                  style={[
                    styles.readerCloseText,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  ✕
                </Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.readerBody}>
              <Text
                style={[styles.readerText, { color: theme.colors.textPrimary }]}
              >
                {artifact.body}
              </Text>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
      <Modal
        visible={diffIndex !== null && artifact != null}
        transparent
        animationType="fade"
        onRequestClose={() => setDiffIndex(null)}
      >
        <Pressable
          style={styles.readerOverlay}
          onPress={() => setDiffIndex(null)}
        >
          <Pressable
            style={[styles.reader, { backgroundColor: theme.colors.surface }]}
            onPress={event => event.stopPropagation()}
          >
            <View style={styles.readerHead}>
              <Text
                style={[
                  styles.readerTitle,
                  { color: theme.colors.textPrimary },
                ]}
              >
                查看修改
              </Text>
              <Text
                style={[
                  styles.readerChars,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {diffIndex !== null && artifact
                  ? `修改 ${diffIndex + 1} / ${artifact.changes.changes.length}`
                  : ''}
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="关闭修改"
                onPress={() => setDiffIndex(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.readerClose}
              >
                <Text
                  style={[
                    styles.readerCloseText,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  ✕
                </Text>
              </TouchableOpacity>
            </View>
            {diffIndex !== null &&
            artifact &&
            artifact.changes.changes[diffIndex] ? (
              <ScrollView style={styles.readerBody}>
                <View style={styles.diffRow}>
                  <Text
                    style={[
                      styles.diffTag,
                      {
                        backgroundColor: theme.colors.accentSoft,
                        color: theme.colors.accent,
                      },
                    ]}
                  >
                    {changeTypeLabel(
                      artifact.changes.changes[diffIndex].changeType,
                    )}
                  </Text>
                </View>
                {artifact.changes.changes[diffIndex].beforeText.trim() ? (
                  <View style={styles.diffBlock}>
                    <Text
                      style={[styles.diffLabel, { color: theme.colors.danger }]}
                    >
                      修改前
                    </Text>
                    <Text
                      style={[
                        styles.diffText,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      {artifact.changes.changes[diffIndex].beforeText}
                    </Text>
                  </View>
                ) : null}
                {artifact.changes.changes[diffIndex].afterText.trim() ? (
                  <View style={styles.diffBlock}>
                    <Text
                      style={[styles.diffLabel, { color: theme.colors.accent }]}
                    >
                      修改后
                    </Text>
                    <Text
                      style={[
                        styles.diffText,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      {artifact.changes.changes[diffIndex].afterText}
                    </Text>
                  </View>
                ) : null}
                <View style={styles.diffBlock}>
                  <Text
                    style={[
                      styles.diffLabel,
                      { color: theme.colors.textSecondary },
                    ]}
                  >
                    原因
                  </Text>
                  <Text
                    style={[
                      styles.diffReason,
                      { color: theme.colors.textSecondary },
                    ]}
                  >
                    {artifact.changes.changes[diffIndex].reason}
                  </Text>
                </View>
                <View style={styles.diffActions}>
                  <Button
                    label="上一条"
                    compact
                    variant="ghost"
                    disabled={diffIndex <= 0}
                    onPress={() => setDiffIndex(diffIndex - 1)}
                  />
                  <Button
                    label="下一条"
                    compact
                    variant="ghost"
                    disabled={diffIndex >= artifact.changes.changes.length - 1}
                    onPress={() => setDiffIndex(diffIndex + 1)}
                  />
                </View>
              </ScrollView>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </Card>
  );
};

const styles = StyleSheet.create({
  card: { padding: spacing.lg },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { fontSize: 16, fontFamily: 'serif', fontWeight: '700' },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 8,
  },
  badgeText: { fontSize: 12, fontWeight: '600' },
  charCount: {
    fontSize: 26,
    fontFamily: 'serif',
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  meta: { fontSize: 12, marginTop: 2, lineHeight: 18 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  muted: { fontSize: 13, lineHeight: 20 },
  readerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  reader: { borderRadius: 10, padding: spacing.lg, maxHeight: '85%' },
  readerHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  readerTitle: {
    fontSize: 18,
    fontFamily: 'serif',
    fontWeight: '700',
    flex: 1,
  },
  readerChars: { fontSize: 12 },
  readerClose: { padding: 4 },
  readerCloseText: { fontSize: 16 },
  readerBody: { flexGrow: 0 },
  readerText: { fontSize: 15, lineHeight: 26 },
  diffRow: { flexDirection: 'row', marginBottom: spacing.sm },
  diffTag: {
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
  diffBlock: { marginBottom: spacing.md },
  diffLabel: { fontSize: 12, fontWeight: '600', marginBottom: 3 },
  diffText: { fontSize: 14, lineHeight: 23 },
  diffReason: { fontSize: 13, lineHeight: 21 },
  diffActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
});
