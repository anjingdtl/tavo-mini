/**
 * Continuation state proposal review (Spec §12, fix-plan §4.2).
 *
 * Lists pending state-extraction proposals for the current project, lets the
 * user confirm or reject each one with an optional decision note, and only the
 * confirm action calls confirmProposal (which creates the state event + Story
 * Memory dirty + outbox in one local transaction). Never displays the prompt,
 * chapter body, or any credentials — only the proposal summary, type, evidence
 * span and linked entities.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Header, Screen, spacing } from '../../components/ui';
import { useProjectStore } from '../../store/projectStore';
import { useThemeStore } from '../../store/themeStore';
import {
  confirmAllProposals,
  confirmProposal,
  listProposals,
  rejectProposal,
  type ContinuationStateProposal,
} from '../../services/continuation/generation';

const PROPOSAL_TYPE_LABELS: Record<string, string> = {
  character_state: '人物状态',
  relationship_change: '关系变化',
  plot_advance: '剧情推进',
  character_experience: '人物经历',
  knowledge_change: '信息变化',
  new_world_fact: '世界设定',
  new_character: '新人物',
  new_location: '新地点',
  new_organization: '新组织',
  foreshadowing: '伏笔',
  other: '其他',
};

function proposalSummary(p: ContinuationStateProposal): string {
  try {
    const payload = JSON.parse(p.payloadJson);
    return String(payload.summary ?? payload.description ?? payload.name ?? '');
  } catch {
    return '';
  }
}

function proposalSubject(p: ContinuationStateProposal): string {
  if (p.subjectRefType && p.subjectRefId) {
    return `${p.subjectRefType}#${p.subjectRefId}`;
  }
  return '';
}

export const ContinuationStateReviewScreen: React.FC<{
  onClose: () => void;
}> = ({ onClose }) => {
  const { theme } = useThemeStore();
  const colors = theme.colors;
  const { currentProject } = useProjectStore();
  const [loading, setLoading] = useState(true);
  const [proposals, setProposals] = useState<ContinuationStateProposal[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [noteForId, setNoteForId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');

  const reload = useCallback(async () => {
    if (!currentProject) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await listProposals(currentProject.id, 'pending');
      setProposals(rows);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '加载失败', text2: e?.message });
    } finally {
      setLoading(false);
    }
  }, [currentProject]);

  useFocusEffect(
    useCallback(() => {
      reload().catch(() => {});
    }, [reload]),
  );

  const doConfirm = async (p: ContinuationStateProposal) => {
    setBusyId(p.id);
    try {
      await confirmProposal({
        proposalId: p.id,
        decisionNote: noteForId === p.id && noteText.trim() ? noteText.trim() : undefined,
      });
      Toast.show({ type: 'success', text1: '已确认状态变化' });
      setNoteForId(null);
      setNoteText('');
      await reload();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '确认失败', text2: e?.message });
    } finally {
      setBusyId(null);
    }
  };

  const doConfirmAll = async () => {
    if (!currentProject || proposals.length === 0 || bulkBusy || busyId) return;
    setBulkBusy(true);
    try {
      const result = await confirmAllProposals({
        projectId: currentProject.id,
        proposalIds: proposals.map(p => p.id),
      });
      await reload();
      if (result.failedProposalIds.length > 0) {
        Toast.show({
          type: 'error',
          text1: `已确认 ${result.confirmedCount} 条，${result.failedProposalIds.length} 条失败`,
          text2: result.syncFailed > 0 ? '状态同步仍有失败项，请在状态同步卡片中重试。' : undefined,
        });
      } else if (result.syncFailed > 0) {
        Toast.show({
          type: 'error',
          text1: `已确认 ${result.confirmedCount} 条，但状态同步失败 ${result.syncFailed} 项`,
          text2: '请在状态同步卡片中重试。',
        });
      } else {
        Toast.show({ type: 'success', text1: `已全部确认 ${result.confirmedCount} 条状态变化` });
      }
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '批量确认失败', text2: e?.message });
    } finally {
      setBulkBusy(false);
    }
  };

  const doReject = (p: ContinuationStateProposal) => {
    Alert.alert('拒绝该状态变化', '拒绝后该变化不会被纳入后续续写上下文。确认拒绝？', [
      { text: '取消', style: 'cancel' },
      {
        text: '拒绝',
        style: 'destructive',
        onPress: async () => {
          setBusyId(p.id);
          try {
            await rejectProposal(
              p.id,
              noteForId === p.id && noteText.trim() ? noteText.trim() : undefined,
            );
            Toast.show({ type: 'info', text1: '已拒绝该状态变化' });
            setNoteForId(null);
            setNoteText('');
            await reload();
          } catch (e: any) {
            Toast.show({ type: 'error', text1: '拒绝失败', text2: e?.message });
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  };

  const headerAction = <Button label="返回" variant="ghost" onPress={onClose} />;

  if (!currentProject) {
    return (
      <Screen>
        <Header title="状态待确认" action={headerAction} />
        <EmptyState title="请先选择项目" description="在「项目」Tab 选择一个原著续写项目。" />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="状态待确认" action={headerAction} />
      <ScrollView contentContainerStyle={styles.pad}>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          定稿章节会提取状态变化供你审核。确认后的变化将纳入后续续写上下文并触发 Story Memory 重建。
        </Text>
        {loading ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
        ) : proposals.length === 0 ? (
          <EmptyState title="暂无待确认状态" description="定稿续写章节后，提取到的状态变化会出现在这里。" />
        ) : (
          <>
            <View style={styles.bulkActions}>
              <Button
                label={bulkBusy ? '正在全部确认…' : `全部确认（${proposals.length}）`}
                onPress={doConfirmAll}
                disabled={bulkBusy || !!busyId}
              />
            </View>
            {proposals.map(p => (
              <Card key={p.id}>
                <View style={styles.rowBetween}>
                  <Text style={[styles.type, { color: colors.accent }]}>
                    {PROPOSAL_TYPE_LABELS[p.proposalType] ?? p.proposalType}
                  </Text>
                  <Text style={[styles.meta, { color: colors.textMuted }]}>
                    位置 {p.evidenceStart}–{p.evidenceEnd}
                  </Text>
                </View>
                <Text style={[styles.summary, { color: colors.textPrimary }]}>
                  {proposalSummary(p) || '（无摘要）'}
                </Text>
                {!!proposalSubject(p) && (
                  <Text style={[styles.meta, { color: colors.textSecondary }]}>
                    关联：{proposalSubject(p)}
                  </Text>
                )}
                {noteForId === p.id && (
                  <TextInput
                    style={[
                      styles.note,
                      {
                        color: colors.textPrimary,
                        borderColor: colors.border,
                        backgroundColor: colors.background,
                      },
                    ]}
                    placeholder="决策备注（可选）"
                    placeholderTextColor={colors.textMuted}
                    value={noteText}
                    onChangeText={setNoteText}
                    multiline
                  />
                )}
                <View style={styles.actions}>
                  <Button
                    label={busyId === p.id ? '处理中…' : '确认'}
                    onPress={() => doConfirm(p)}
                    disabled={bulkBusy || busyId === p.id}
                    compact
                  />
                  <Button
                    label="拒绝"
                    variant="danger"
                    onPress={() => doReject(p)}
                    disabled={bulkBusy || busyId === p.id}
                    compact
                  />
                  <Button
                    label={noteForId === p.id ? '收起备注' : '备注'}
                    variant="ghost"
                    onPress={() => {
                      if (noteForId === p.id) {
                        setNoteForId(null);
                        setNoteText('');
                      } else {
                        setNoteForId(p.id);
                        setNoteText('');
                      }
                    }}
                    disabled={bulkBusy || busyId === p.id}
                    compact
                  />
                </View>
              </Card>
            ))}
          </>
        )}
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  pad: { padding: spacing.md, paddingBottom: 48 },
  hint: { fontSize: 13, lineHeight: 20, marginBottom: spacing.md },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  type: { fontSize: 14, fontWeight: '600' },
  meta: { fontSize: 12 },
  summary: { fontSize: 14, lineHeight: 22, marginBottom: spacing.xs },
  note: {
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.sm,
    fontSize: 13,
    minHeight: 60,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    textAlignVertical: 'top',
  },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs, flexWrap: 'wrap' },
  bulkActions: { marginBottom: spacing.sm },
});
