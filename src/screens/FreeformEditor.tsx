import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Bot, GitBranch, History, Plus, Trash2 } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { runFreeformPipeline } from '../services/pipelineRunner';
import { Button, Card, EmptyState, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import { debounce } from '../utils/debounce';
import { estimateTokens } from '../utils/tokenEstimator';
import * as db from '../services/database';
import { buildContext } from '../services/contextBuilder';
import { callLLMResult } from '../services/llm';
import type { Chapter, Fragment, FragmentType } from '../types/novel';

const TYPE_OPTIONS: { value: FragmentType; label: string }[] = [
  { value: 'seed', label: '种子' },
  { value: 'user', label: '手写' },
  { value: 'guided', label: '引导' },
  { value: 'generated', label: 'AI' },
];

export const FreeformEditor: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const navigation = useNavigation();
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [documentText, setDocumentText] = useState('');
  const [steerText, setSteerText] = useState('');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'failed'>('saved');
  const [generating, setGenerating] = useState(false);
  const [lastUsage, setLastUsage] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [text, setText] = useState('');
  const [type, setType] = useState<FragmentType>('user');
  const autoSaveRef = useRef(
    debounce(async (projectId: number, content: string) => {
      try {
        await db.setFreeformDocument(projectId, content);
        setSaveStatus('saved');
      } catch {
        setSaveStatus('failed');
      }
    }, 900),
  );

  const loadData = useCallback(async () => {
    if (!currentProject) return;
    const [nextFragments, content] = await Promise.all([
      db.getFragmentsByProject(currentProject.id),
      db.getFreeformDocument(currentProject.id),
    ]);
    setFragments(nextFragments);
    setDocumentText(content);
  }, [currentProject]);

  useEffect(() => {
    loadData();
    const autoSave = autoSaveRef.current;
    // Flush on background/inactive
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        autoSave.flush().catch(() => {});
      }
    });
    return () => {
      autoSave.flush().catch(() => {});
      sub.remove();
    };
  }, [loadData]);

  const changeDocument = (content: string) => {
    if (!currentProject) return;
    setDocumentText(content);
    setSaveStatus('saving');
    autoSaveRef.current.call(currentProject.id, content);
  };

  const saveLabel = saveStatus === 'saved' ? '已保存' : saveStatus === 'saving' ? '保存中...' : '保存失败';

  const addFragment = async () => {
    if (!currentProject || !text.trim()) return;
    await db.createFragment(currentProject.id, type, text.trim(), fragments.length);
    setText('');
    setType('user');
    setShowModal(false);
    await loadData();
  };

  const appendFragment = (fragment: Fragment) => {
    changeDocument(`${documentText}${documentText ? '\n\n' : ''}${fragment.content}`);
  };

  const generateContinuation = async () => {
    if (!currentProject || generating) return;
    setGenerating(true);
    try {
      const config = await db.getContextConfig();
      const presets = await db.getPresetsByProject(currentProject.id);
      const pseudoChapter: Chapter = {
        id: 0,
        project_id: currentProject.id,
        position: Number.MAX_SAFE_INTEGER,
        title: '自由写作',
        synopsis: steerText,
        content: documentText,
        status: 'draft',
        summary_json: null,
        created_at: '',
        updated_at: '',
      };
      const { messages } = await buildContext(pseudoChapter, config, currentProject.id, presets[0]);
      messages.push({
        role: 'user',
        content: `以下是自由写作正文，请继续创作下一段并直接输出正文。\n\n${documentText || '（这是故事开头）'}\n\n用户指示：${steerText || '自然承接，推进剧情。'}`,
      });
      const result = await callLLMResult(messages, presets[0]?.max_tokens || 2000, {
        max_tokens: presets[0]?.max_tokens || 2000,
        scenario: 'freeform_continue',
      });
      if (result.text?.trim()) {
        const next = `${documentText}${documentText ? '\n\n' : ''}${result.text.trim()}`;
        setDocumentText(next);
        await db.setFreeformDocument(currentProject.id, next);
        await db.createFragment(currentProject.id, 'generated', result.text.trim(), fragments.length);
        setSteerText('');
        setLastUsage(`本轮 tokens：输入 ${result.inputTokens} / 输出 ${result.outputTokens} / 总计 ${result.totalTokens}`);
        setSaveStatus('saved');
        await loadData();
      }
    } catch (error: any) {
      Alert.alert('续写失败', error?.message || '请检查 API 配置。');
    } finally {
      setGenerating(false);
    }
  };

  const runFreeformPipelineFlow = async () => {
    if (!currentProject) return;

    const { createTask, getActiveTaskForTarget } = usePipelineTaskStore.getState();
    const existing = getActiveTaskForTarget('freeform', currentProject.id);
    if (existing) {
      Alert.alert('已有进行中的流水线', '请等待当前任务完成或到任务中心取消。');
      return;
    }

    const taskId = createTask('freeform', currentProject.id);
    try {
      await runFreeformPipeline(taskId, currentProject.id, documentText, steerText);

      const store = usePipelineTaskStore.getState();
      const finishedTask = store.tasks.find((t) => t.id === taskId);
      if (finishedTask?.status === 'completed') {
        Alert.alert('流水线完成', '自由写作流水线已完成，请到任务中心查看结果。');
      } else if (finishedTask?.status === 'failed') {
        Alert.alert('流水线失败', finishedTask.error || '未知错误');
      }
    } catch (error: any) {
      Alert.alert('流水线异常', error.message || '请检查 API 配置。');
    }
  };

  const deleteFragment = (fragment: Fragment) => {
    Alert.alert('删除片段', '确定删除这个片段？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          await db.deleteFragment(fragment.id);
          await loadData();
        },
      },
    ]);
  };

  if (!currentProject) {
    return (
      <Screen>
        <Header title="自由写作" subtitle="请先选择项目" />
        <EmptyState title="没有当前项目" description="进入项目页选择项目后，可以在这里自由写正文。" />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title={currentProject.name} subtitle={`自由正文 · ${saveLabel}`} action={<Button label="片段" icon={Plus} onPress={() => setShowModal(true)} />} />
      <ScrollView contentContainerStyle={styles.content}>
        <Field
          label="正文"
          value={documentText}
          onChangeText={changeDocument}
          placeholder="直接在这里写正文，AI 续写也会追加到这里..."
          multiline
          inputStyle={styles.editor}
        />
        <Field label="AI 续写指示" value={steerText} onChangeText={setSteerText} placeholder="可选：下一段想写什么" multiline inputStyle={styles.steer} />
        <View style={styles.toolbar}>
          <Button label={generating ? '续写中...' : 'AI 续写'} icon={Bot} onPress={generateContinuation} disabled={generating} />
          <Button label="流水线续写" icon={GitBranch} variant="secondary" onPress={runFreeformPipelineFlow} disabled={generating} />
          <Button label="历史" icon={History} variant="ghost" onPress={() => {
            // @ts-ignore
            navigation.navigate('RevisionHistory', { targetType: 'freeform', targetId: currentProject.id, projectId: currentProject.id });
          }} />
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
            {documentText.length} 字 · 预估 {estimateTokens(documentText)} tokens
          </Text>
        </View>
        {lastUsage ? <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{lastUsage}</Text> : null}
        <Text style={[styles.sectionTitle, { color: theme.colors.textPrimary }]}>素材片段</Text>
        {fragments.length === 0 ? (
          <EmptyState title="还没有片段" description="添加种子文本、手写片段或 AI 生成片段，作为自由正文的素材。" />
        ) : (
          <FlatList
            data={fragments}
            scrollEnabled={false}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => (
              <Card>
                <View style={styles.fragmentHeader}>
                  <Text style={[styles.type, { color: theme.colors.accent }]}>{TYPE_OPTIONS.find((option) => option.value === item.type)?.label || item.type}</Text>
                  <View style={styles.fragmentActions}>
                    <Button label="追加" variant="secondary" onPress={() => appendFragment(item)} />
                    <Button label="删除" icon={Trash2} variant="ghost" onPress={() => deleteFragment(item)} />
                  </View>
                </View>
                <Text style={[styles.fragmentContent, { color: theme.colors.textPrimary }]}>{item.content}</Text>
              </Card>
            )}
          />
        )}
      </ScrollView>
      <Modal visible={showModal} transparent animationType="slide" onRequestClose={() => setShowModal(false)}>
        <Pressable style={styles.overlay} onPress={() => setShowModal(false)}>
          <Pressable style={[styles.modal, { backgroundColor: theme.colors.surface }]} onPress={(event) => event.stopPropagation()}>
            <Text style={[styles.modalTitle, { color: theme.colors.textPrimary }]}>添加片段</Text>
            <SegmentedControl value={type} options={TYPE_OPTIONS} onChange={setType} />
            <Field value={text} onChangeText={setText} placeholder="输入片段内容..." multiline inputStyle={styles.textArea} />
            <View style={styles.actions}>
              <Button label="取消" variant="ghost" onPress={() => setShowModal(false)} />
              <Button label="添加" onPress={addFragment} disabled={!text.trim()} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 120 },
  editor: { minHeight: 360, textAlignVertical: 'top', fontSize: 16, lineHeight: 25 },
  steer: { minHeight: 72, textAlignVertical: 'top' },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  meta: { fontSize: 12, fontWeight: '700' },
  sectionTitle: { fontSize: 16, fontWeight: '800', marginTop: spacing.lg, marginBottom: spacing.sm },
  fragmentHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.sm },
  fragmentActions: { flexDirection: 'row', gap: spacing.sm },
  type: { fontSize: 12, fontWeight: '800' },
  fragmentContent: { fontSize: 15, lineHeight: 23 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  modal: { borderTopLeftRadius: 8, borderTopRightRadius: 8, padding: spacing.lg, gap: spacing.md },
  modalTitle: { fontSize: 18, fontWeight: '800' },
  textArea: { minHeight: 140, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md },
});
