/**
 * Multi-chapter batch screen (Phase 8) — outline mode only.
 *
 * One screen with internal views:
 *   1. create   — summary, N, target words, mode, optional budget caps
 *   2. preview  — editable plan (title/synopsis/beats/carryIn/carryOut/words)
 *   3. running  — serial progress, attempts, retry time, budget usage
 *   4. paused   — cause-specific actions
 *   5. report   — completion summary + token/call usage
 *
 * The batch state lives in SQLite; this screen mirrors it via the store.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Play, Pause, X, RefreshCw, ListChecks } from 'lucide-react-native';
import { Button, Card, Header, Screen, Section, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { useProjectStore } from '../store/projectStore';
import { useMultiChapterBatchStore } from '../store/multiChapterBatchStore';
import { isMultiChapterBatchEnabled } from '../services/featureFlags';
import {
  BATCH_DEFAULT_CHAPTERS,
  BATCH_DEFAULT_TARGET_WORDS,
  BATCH_MAX_CHAPTERS,
  BATCH_MIN_CHAPTERS,
} from '../types/multiChapterBatch';
import type { BatchChapterPlanItem } from '../types/multiChapterBatch';

type BatchView = 'create' | 'preview' | 'running' | 'paused' | 'report';

function useFlag(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let mounted = true;
    isMultiChapterBatchEnabled().then(v => {
      if (mounted) setEnabled(v);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return enabled;
}

export function MultiChapterBatchScreen(): React.ReactElement {
  const { theme } = useThemeStore();
  const enabled = useFlag();
  const { currentProject } = useProjectStore();
  const store = useMultiChapterBatchStore();
  const [view, setView] = useState<BatchView>('create');
  const [form, setForm] = useState({
    sourcePrompt: '',
    chapterCount: String(BATCH_DEFAULT_CHAPTERS),
    targetWords: String(BATCH_DEFAULT_TARGET_WORDS),
    pipelineMode: 'full' as 'draft_only' | 'fast' | 'full',
    maxLlmCalls: '',
    maxInputTokens: '',
    maxOutputTokens: '',
  });
  const [edited, setEdited] = useState<BatchChapterPlanItem[]>([]);

  const refresh = useCallback(() => {
    if (store.batch) {
      store.refresh().catch(() => {});
    }
  }, [store]);

  // 运行页轮询（运行中每 2s 刷新一次状态）。
  useEffect(() => {
    if (!store.batch || view !== 'running') return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [store.batch, view, refresh]);

  const batchStatus = store.batch?.status;
  useEffect(() => {
    if (!batchStatus) {
      setView('create');
    } else if (batchStatus === 'completed' || batchStatus === 'cancelled') {
      setView('report');
    } else if (batchStatus.startsWith('paused_')) {
      setView('paused');
    } else if (batchStatus === 'planning' || batchStatus === 'draft' || batchStatus === 'ready') {
      setView('preview');
    } else {
      setView('running');
    }
  }, [batchStatus]);

  const handleCreate = async () => {
    const count = Number(form.chapterCount);
    if (count < BATCH_MIN_CHAPTERS || count > BATCH_MAX_CHAPTERS) {
      Alert.alert('章节数不合法', `请在 ${BATCH_MIN_CHAPTERS}～${BATCH_MAX_CHAPTERS} 之间选择`);
      return;
    }
    if (!form.sourcePrompt.trim()) {
      Alert.alert('剧情摘要不能为空');
      return;
    }
    if (!currentProject) return;
    try {
      const id = await store.createDraftBatch({
        projectId: currentProject.id,
        sourcePrompt: form.sourcePrompt.trim(),
        chapterCount: count,
        targetWordsPerChapter: Number(form.targetWords) || BATCH_DEFAULT_TARGET_WORDS,
        pipelineMode: form.pipelineMode,
        maxLlmCalls: form.maxLlmCalls ? Number(form.maxLlmCalls) : null,
        maxInputTokens: form.maxInputTokens ? Number(form.maxInputTokens) : null,
        maxOutputTokens: form.maxOutputTokens ? Number(form.maxOutputTokens) : null,
      });
      const plan = await store.runPlanner(id);
      setEdited(plan.chapters.map(c => ({ ...c })));
      setView('preview');
    } catch (error: any) {
      Alert.alert('规划失败', String(error?.message || '请检查模型配置后重试'));
    }
  };

  const handleStart = async () => {
    if (!store.batch) return;
    const valid = edited.length > 0;
    if (!valid) {
      Alert.alert('请先完成计划');
      return;
    }
    try {
      await store.saveEditedPlan(store.batch.id, edited);
      await store.start(store.batch.id);
      setView('running');
    } catch (error: any) {
      Alert.alert('启动失败', String(error?.message || '请检查计划后重试'));
    }
  };

  const handleResume = async () => {
    if (!store.batch) return;
    try {
      await store.resume(store.batch.id);
    } catch (error: any) {
      Alert.alert('恢复失败', String(error?.message || '请稍后重试'));
    }
  };

  const handlePause = async () => {
    if (!store.batch) return;
    try {
      await store.pause(store.batch.id);
    } catch {
      // store surfaces errors via state
    }
  };

  const handleCancel = () => {
    if (!store.batch) return;
    const batchId = store.batch.id;
    Alert.alert('结束批次', '已完成章节会保留，未完成章节将被放弃。确定结束？', [
      { text: '取消', style: 'cancel' },
      {
        text: '结束批次',
        style: 'destructive',
        onPress: () => store.cancel(batchId).catch(() => {}),
      },
    ]);
  };

  if (!enabled) {
    return (
      <Screen>
        <Header title="批量写章" />
        <Text style={{ padding: spacing.lg, color: theme.colors.textSecondary }}>
          该功能暂未开放。
        </Text>
      </Screen>
    );
  }

  const headerTitle =
    view === 'create'
      ? '批量写章'
      : view === 'preview'
        ? '规划预览'
        : view === 'report'
          ? '批次报告'
          : store.batch
            ? `第 ${store.batch.currentOrdinal}/${store.batch.chapterCount} 章`
            : '批量写章';

  return (
    <Screen>
      <Header
        title={headerTitle}
        action={
          <Button
            label="返回"
            variant="ghost"
            compact
            onPress={() => {
              setView('create');
              store.loadActiveBatchForProject(currentProject?.id ?? 0).catch(() => {});
            }}
          />
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        {view === 'create' && (
          <>
            <Section title="剧情摘要">
              <TextInput
                style={[styles.input, { backgroundColor: theme.colors.card, color: theme.colors.textPrimary }]}
                placeholder="输入较长的局部剧情摘要、阶段目标或故事弧提示词…"
                placeholderTextColor={theme.colors.textMuted}
                multiline
                value={form.sourcePrompt}
                onChangeText={t => setForm(f => ({ ...f, sourcePrompt: t }))}
              />
            </Section>
            <Section title="生成参数">
              <Field label="生成章数 (1~10)">
                <TextInput
                  style={[styles.input, { backgroundColor: theme.colors.card, color: theme.colors.textPrimary }]}
                  keyboardType="numeric"
                  value={form.chapterCount}
                  onChangeText={t => setForm(f => ({ ...f, chapterCount: t }))}
                />
              </Field>
              <Field label="每章目标字数">
                <TextInput
                  style={[styles.input, { backgroundColor: theme.colors.card, color: theme.colors.textPrimary }]}
                  keyboardType="numeric"
                  value={form.targetWords}
                  onChangeText={t => setForm(f => ({ ...f, targetWords: t }))}
                />
              </Field>
              <SegmentedMode
                theme={theme}
                value={form.pipelineMode}
                onChange={v => setForm(f => ({ ...f, pipelineMode: v }))}
              />
            </Section>
            <Section title="批次消耗上限（可选）">
              <Field label="最大 LLM 调用次数">
                <TextInput
                  style={[styles.input, { backgroundColor: theme.colors.card, color: theme.colors.textPrimary }]}
                  keyboardType="numeric"
                  value={form.maxLlmCalls}
                  onChangeText={t => setForm(f => ({ ...f, maxLlmCalls: t }))}
                />
              </Field>
              <Field label="最大输入 tokens">
                <TextInput
                  style={[styles.input, { backgroundColor: theme.colors.card, color: theme.colors.textPrimary }]}
                  keyboardType="numeric"
                  value={form.maxInputTokens}
                  onChangeText={t => setForm(f => ({ ...f, maxInputTokens: t }))}
                />
              </Field>
              <Field label="最大输出 tokens">
                <TextInput
                  style={[styles.input, { backgroundColor: theme.colors.card, color: theme.colors.textPrimary }]}
                  keyboardType="numeric"
                  value={form.maxOutputTokens}
                  onChangeText={t => setForm(f => ({ ...f, maxOutputTokens: t }))}
                />
              </Field>
              <Button
                label={store.loading ? '正在规划…' : '开始规划'}
                icon={ListChecks}
                onPress={handleCreate}
                disabled={store.loading}
              />
            </Section>
          </>
        )}

        {view === 'preview' && (
          <>
            <Section title="计划预览（可编辑）">
              {edited.length === 0 && store.plan ? (
                <Text style={{ color: theme.colors.textSecondary }}>
                  计划已生成，共 {store.plan.chapters.length} 章。请逐章确认。
                </Text>
              ) : null}
              {edited.map((chapter, index) => (
                <Card key={chapter.ordinal} style={styles.cardMb}>
                  <Text style={[styles.bold, { color: theme.colors.accent }]}>
                    第 {chapter.ordinal} 章
                  </Text>
                  <TextInput
                    style={[styles.input, { backgroundColor: theme.colors.background, color: theme.colors.textPrimary }]}
                    value={chapter.title}
                    onChangeText={t =>
                      setEdited(prev => prev.map((c, i) => (i === index ? { ...c, title: t } : c)))
                    }
                  />
                  <TextInput
                    style={[styles.inputMultiline, { backgroundColor: theme.colors.background, color: theme.colors.textPrimary }]}
                    multiline
                    value={chapter.synopsis}
                    onChangeText={t =>
                      setEdited(prev => prev.map((c, i) => (i === index ? { ...c, synopsis: t } : c)))
                    }
                  />
                  <TextInput
                    style={[styles.input, { backgroundColor: theme.colors.background, color: theme.colors.textPrimary }]}
                    value={chapter.keyBeats.join('；')}
                    placeholder="关键节拍（分号分隔）"
                    placeholderTextColor={theme.colors.textMuted}
                    onChangeText={t =>
                      setEdited(prev =>
                        prev.map((c, i) =>
                          i === index
                            ? { ...c, keyBeats: t.split('；').map(s => s.trim()).filter(Boolean) }
                            : c,
                        ),
                      )
                    }
                  />
                  <TextInput
                    style={[styles.input, { backgroundColor: theme.colors.background, color: theme.colors.textPrimary }]}
                    value={chapter.carryIn || ''}
                    placeholder="承接前文"
                    placeholderTextColor={theme.colors.textMuted}
                    onChangeText={t =>
                      setEdited(prev => prev.map((c, i) => (i === index ? { ...c, carryIn: t } : c)))
                    }
                  />
                  <TextInput
                    style={[styles.input, { backgroundColor: theme.colors.background, color: theme.colors.textPrimary }]}
                    value={chapter.carryOut || ''}
                    placeholder="交给下一章"
                    placeholderTextColor={theme.colors.textMuted}
                    onChangeText={t =>
                      setEdited(prev => prev.map((c, i) => (i === index ? { ...c, carryOut: t } : c)))
                    }
                  />
                  <TextInput
                    style={[styles.input, { backgroundColor: theme.colors.background, color: theme.colors.textPrimary }]}
                    keyboardType="numeric"
                    value={String(chapter.targetWords)}
                    onChangeText={t =>
                      setEdited(prev =>
                        prev.map((c, i) =>
                          i === index ? { ...c, targetWords: Number(t) || 0 } : c,
                        ),
                      )
                    }
                  />
                </Card>
              ))}
            </Section>
            <View style={styles.row}>
              <Button
                label={store.loading ? '保存中…' : '开始批量写作'}
                icon={Play}
                onPress={handleStart}
                disabled={store.loading}
              />
              <Button label="放弃" variant="ghost" icon={X} onPress={handleCancel} />
            </View>
          </>
        )}

        {view === 'running' && store.batch && (
          <RunningView
            theme={theme}
            store={store}
            onPause={handlePause}
            onCancel={handleCancel}
            onRefresh={refresh}
          />
        )}

        {view === 'paused' && store.batch && (
          <PausedView theme={theme} store={store} onResume={handleResume} onCancel={handleCancel} />
        )}

        {view === 'report' && store.batch && (
          <ReportView theme={theme} store={store} onStartNew={() => {
            store.loadActiveBatchForProject(currentProject?.id ?? 0).catch(() => {});
            setView('create');
          }} />
        )}

        {store.error ? (
          <Text style={styles.errorBox}>
            {store.error}
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function SegmentedMode(props: {
  theme: any;
  value: 'draft_only' | 'fast' | 'full';
  onChange: (v: 'draft_only' | 'fast' | 'full') => void;
}) {
  return (
    <View style={styles.row}>
      {(
        [
          ['draft_only', '仅草稿'],
          ['fast', '快速'],
          ['full', '完整'],
        ] as const
      ).map(([value, label]) => (
        <Button
          key={value}
          label={label}
          variant={props.value === value ? 'primary' : 'ghost'}
          compact
          onPress={() => props.onChange(value)}
        />
      ))}
    </View>
  );
}

function RunningView(props: {
  theme: any;
  store: ReturnType<typeof useMultiChapterBatchStore.getState>;
  onPause: () => void;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  const { theme, store } = props;
  const batch = store.batch;
  if (!batch) {
    return <Text style={{ color: theme.colors.textSecondary }}>批次不存在</Text>;
  }
  const current = store.items.find(i => i.ordinal === batch.currentOrdinal);
  const completed = store.items.filter(i => i.status.startsWith('succeeded'));
  return (
    <>
      <Section title={`批次进度 ${batch.completedCount}/${batch.chapterCount}`}>
        <Card style={styles.cardMb}>
          <Text style={[styles.bold, { color: theme.colors.textPrimary }]}>
            当前章：第 {batch.currentOrdinal}/{batch.chapterCount} 章
            {current ? ` · ${current.title}` : ''}
          </Text>
          {current ? (
            <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
              章节状态：{current.status}
              {current.retryCount > 0 ? ` · 重试 ${current.retryCount} 次` : ''}
            </Text>
          ) : null}
          {store.lastMessage ? (
            <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
              {store.lastMessage}
            </Text>
          ) : null}
          {current?.nextRetryAt ? (
            <Text style={[styles.mt4, { color: theme.colors.warning }]}>
              下次重试时间：{new Date(current.nextRetryAt).toLocaleTimeString()}
            </Text>
          ) : null}
        </Card>
        <Card style={styles.cardMb}>
          <Text style={[styles.bold, { color: theme.colors.textPrimary }]}>批次消耗</Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            LLM 调用：{batch.usedLlmCalls}
            {batch.maxLlmCalls != null ? ` / ${batch.maxLlmCalls}` : ''}
          </Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            输入 tokens：{batch.usedInputTokens.toLocaleString()}
            {batch.maxInputTokens != null ? ` / ${batch.maxInputTokens.toLocaleString()}` : ''}
          </Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            输出 tokens：{batch.usedOutputTokens.toLocaleString()}
            {batch.maxOutputTokens != null ? ` / ${batch.maxOutputTokens.toLocaleString()}` : ''}
          </Text>
        </Card>
        {completed.length > 0 ? (
          <Card>
            <Text style={[styles.bold, { color: theme.colors.textPrimary }]}>已完成章节</Text>
            {completed.map(item => (
              <Text key={item.ordinal} style={[styles.mt4, { color: theme.colors.textSecondary }]}>
                第 {item.ordinal} 章 · {item.title} · {item.completionQuality || 'full_pipeline'}
              </Text>
            ))}
          </Card>
        ) : null}
      </Section>
      <View style={styles.row}>
        <Button label="暂停" variant="ghost" icon={Pause} onPress={props.onPause} />
        <Button label="刷新" variant="ghost" icon={RefreshCw} onPress={props.onRefresh} />
        <Button label="结束批次" variant="ghost" icon={X} onPress={props.onCancel} />
      </View>
    </>
  );
}

function PausedView(props: {
  theme: any;
  store: ReturnType<typeof useMultiChapterBatchStore.getState>;
  onResume: () => void;
  onCancel: () => void;
}) {
  const { theme, store } = props;
  const batch = store.batch!;
  const reasonLabels: Record<string, string> = {
    paused_timeout_unknown: '结果未知',
    paused_account_quota: '账户额度不足',
    paused_context_budget: '上下文预算不足',
    paused_batch_budget: '批次消耗预算已达上限',
    paused_project_changed: '项目章节已变化',
    paused_user: '已暂停',
  };
  const reason = reasonLabels[batch.status] || batch.status;
  const actions: Array<[string, () => void]> = [];
  if (batch.status !== 'paused_project_changed') {
    actions.push(['确认后继续', props.onResume]);
  }
  if (batch.status === 'paused_account_quota') {
    actions.push(['更换模型后继续', props.onResume]);
  }
  if (batch.status === 'paused_context_budget') {
    actions.push(['重新编译后继续', props.onResume]);
  }
  actions.push(['结束批次', props.onCancel]);
  return (
    <>
      <Section title="批次已暂停">
        <Card>
          <Text style={[styles.bold, { color: theme.colors.textPrimary }]}>{reason}</Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            {batch.errorMessage || '请选择下一步操作'}
          </Text>
          {batch.status === 'paused_timeout_unknown' ? (
            <Text style={[styles.mt8, { color: theme.colors.warning }]}>
              提示：请求可能已在服务端执行，重新执行可能产生重复费用。
            </Text>
          ) : null}
          {batch.status === 'paused_context_budget' ? (
            <Text style={[styles.mt8, { color: theme.colors.textSecondary }]}>
              当前章尚未调用模型；可重新弹性编译、更换更大上下文模型、降低目标字数或编辑当前章纲。
            </Text>
          ) : null}
          {batch.status === 'paused_batch_budget' ? (
            <Text style={[styles.mt8, { color: theme.colors.textSecondary }]}>
              可增加预算、减少剩余章数、降低后续字数或结束批次。
            </Text>
          ) : null}
        </Card>
      </Section>
      <View style={styles.column}>
        {actions.map(([label, fn]) => (
          <View key={label} style={{ marginBottom: spacing.sm }}>
            <Button label={label} onPress={fn} />
          </View>
        ))}
      </View>
    </>
  );
}

function ReportView(props: {
  theme: any;
  store: ReturnType<typeof useMultiChapterBatchStore.getState>;
  onStartNew: () => void;
}) {
  const { theme, store } = props;
  const batch = store.batch!;
  const full = store.items.filter(i => i.completionQuality === 'full_pipeline').length;
  const draft = store.items.filter(i => i.completionQuality === 'draft_only').length;
  return (
    <>
      <Section title={batch.status === 'completed' ? '批次完成' : '批次已结束'}>
        <Card>
          <Text style={[styles.bold, { color: theme.colors.textPrimary }]}>
            成功：{batch.completedCount}/{batch.chapterCount}
          </Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            完整流水线：{full} · 采用草稿：{draft}
          </Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            总调用：{batch.usedLlmCalls}
          </Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            输入 tokens：{batch.usedInputTokens.toLocaleString()}
          </Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            输出 tokens：{batch.usedOutputTokens.toLocaleString()}
          </Text>
          {batch.errorCode ? (
            <Text style={[styles.mt8, { color: theme.colors.danger }]}>
              结束原因：{batch.errorMessage || batch.errorCode}
            </Text>
          ) : null}
        </Card>
        {batch.status === 'completed' ? (
          <View style={{ marginTop: spacing.md }}>
            <Button label="返回章节列表" onPress={props.onStartNew} />
          </View>
        ) : null}
      </Section>
    </>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: spacing.sm }}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, paddingBottom: 80 },
  bold: { fontWeight: '600' },
  mt4: { marginTop: 4 },
  mt8: { marginTop: 8 },
  cardMb: { marginBottom: spacing.md },
  errorBox: { color: '#c00', paddingVertical: spacing.md },
  inputMultiline: {
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    minHeight: 60,
    textAlignVertical: 'top',
    marginBottom: spacing.sm,
  },
  input: {
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    minHeight: 44,
    textAlignVertical: 'top',
    marginBottom: spacing.sm,
  },
  row: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.sm },
  column: { marginTop: spacing.md },
  fieldLabel: { fontSize: 12, marginBottom: 4 },
});
