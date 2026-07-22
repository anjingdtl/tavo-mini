import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useThemeStore } from '../store/themeStore';
import type { PipelineTask } from '../types/pipeline';

export interface PipelineResultPromptProps {
  task: PipelineTask | null;
  onDismiss: () => void;
  onViewResult: (taskId: string) => void;
}

export function buildPipelineResultPromptCopy(task: PipelineTask): {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
} {
  const hasDraft = Boolean(task.finalText && task.finalText.trim());
  const auditDegraded =
    Boolean(task.error) &&
    /已保留初稿|审核失败|评估失败|核查失败|未生成终审/.test(task.error || '');

  if (task.status === 'failed' && !hasDraft) {
    return {
      title: '流水线失败',
      body: task.error || '未知错误。',
      confirmLabel: '我知道了',
      cancelLabel: '关闭',
    };
  }
  // Failed or degraded-complete with a retained draft: let user open result.
  if (task.status === 'failed' || auditDegraded) {
    return {
      title: '流水线未完整完成',
      body: task.error || '审核未通过，已保留初稿。',
      confirmLabel: hasDraft ? '查看结果' : '我知道了',
      cancelLabel: '关闭',
    };
  }
  if (!hasDraft) {
    return {
      title: '流水线完成',
      body: '流水线已完成，但本次生成内容为空。',
      confirmLabel: '我知道了',
      cancelLabel: '关闭',
    };
  }
  // 8.7 修复：buildCopy 硬编码"章节 #N"，freeform 任务也显示"章节"
  const targetLabel = task.targetType === 'freeform' ? '自由文档' : `章节 #${task.targetId}`;
  return {
    title: '流水线已完成',
    body: `${targetLabel} 的流水线已生成新内容。是否前往查看并采纳？`,
    confirmLabel: '查看结果',
    cancelLabel: '稍后处理',
  };
}

function buildCopy(task: PipelineTask) {
  return buildPipelineResultPromptCopy(task);
}

/**
 * A single-instance modal that surfaces a finished pipeline task. It is
 * intentionally NOT a native Alert: native Alerts stick around on top of any
 * React Navigation screen the user navigates to, which is why the legacy
 * implementation felt like the prompt was being "shown again" every time
 * the user opened the result page. A controlled React Modal here is dismissible
 * by the consumer and can be wired to the "查看结果" navigation so the
 * modal disappears in lockstep with the screen change.
 */
export const PipelineResultPrompt: React.FC<PipelineResultPromptProps> = ({
  task,
  onDismiss,
  onViewResult,
}) => {
  const { theme } = useThemeStore();
  if (!task) return null;
  const { title, body, confirmLabel, cancelLabel } = buildCopy(task);
  return (
    <Modal
      visible={!!task}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
          <Text style={[styles.title, { color: theme.colors.textPrimary }]}>{title}</Text>
          <Text style={[styles.body, { color: theme.colors.textSecondary }]}>{body}</Text>
          <View style={styles.actions}>
            <Pressable
              onPress={onDismiss}
              testID="pipeline-prompt-dismiss"
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.button,
                styles.secondaryButton,
                { borderColor: theme.colors.border, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Text style={[styles.buttonText, { color: theme.colors.textSecondary }]}>{cancelLabel}</Text>
            </Pressable>
            {confirmLabel === '查看结果' ? (
              <Pressable
                onPress={() => { onViewResult(task.id); }}
                testID="pipeline-prompt-confirm"
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.button,
                  styles.primaryButton,
                  { backgroundColor: theme.colors.accent, opacity: pressed ? 0.8 : 1 },
                ]}
              >
                <Text style={[styles.buttonText, styles.primaryButtonText]}>{confirmLabel}</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={onDismiss}
                testID="pipeline-prompt-confirm"
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.button,
                  styles.primaryButton,
                  { backgroundColor: theme.colors.accent, opacity: pressed ? 0.8 : 1 },
                ]}
              >
                <Text style={[styles.buttonText, styles.primaryButtonText]}>{confirmLabel}</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    gap: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '800',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4,
  },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButton: {
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'transparent',
  },
  primaryButton: {},
  primaryButtonText: {
    color: '#fff',
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
