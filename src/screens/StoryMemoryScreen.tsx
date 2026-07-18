import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Header, LoadingState, Screen, spacing } from '../components/ui';
import * as db from '../services/database';
import {
  rebuildStoryMemory,
  type StoryMemoryRebuildProgress,
} from '../services/storyMemory/storyMemoryRebuild';
import type { StoryMemoryState } from '../services/storyMemory/storyMemoryTypes';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';

const STATUS_LABEL = {
  empty: '尚未初始化', clean: '正常', dirty: '需要重建',
  rebuilding: '重建中', failed: '重建失败',
};

export const StoryMemoryScreen: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const { currentProject } = useProjectStore();
  const { theme } = useThemeStore();
  const [state, setState] = useState<StoryMemoryState | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<StoryMemoryRebuildProgress | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!currentProject) {
      setState(null);
      setLoading(false);
      return;
    }
    const record = await db.ensureProjectStoryMemoryRow(currentProject.id);
    setState(record.state);
    setLoading(false);
  }, [currentProject]);

  useEffect(() => {
    load().catch(error => {
      setLoading(false);
      Toast.show({ type: 'error', text1: '故事记忆读取失败', text2: error?.message });
    });
    return () => controllerRef.current?.abort();
  }, [load]);

  const runRebuild = useCallback(async (
    mode: 'auto' | 'full' | 'legacy_bootstrap',
    clearFirst = false,
  ) => {
    if (!currentProject || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      if (clearFirst) await db.clearStoryMemory(currentProject.id);
      const result = await rebuildStoryMemory(currentProject.id, {
        mode,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setState(result.state);
      Toast.show({ type: 'success', text1: '故事记忆已重建完成' });
    } catch (error: any) {
      if (error?.code !== 'MEMORY_REBUILD_CANCELLED') {
        Toast.show({ type: 'error', text1: '故事记忆重建失败', text2: error?.message });
      }
      await load();
    } finally {
      controllerRef.current = null;
      setProgress(null);
    }
  }, [currentProject, load]);

  if (loading) return <Screen><Header title="故事记忆" /><LoadingState label="正在读取故事状态..." /></Screen>;
  if (!currentProject || !state) return <Screen><Header title="故事记忆" action={onClose ? <Button label="关闭" variant="ghost" onPress={onClose} /> : undefined} /><EmptyState title="请先选择小说项目" /></Screen>;

  const characters = Object.values(state.characters);
  const relationships = Object.values(state.relationships);
  const mainline = state.mainline;
  return (
    <Screen>
      <Header title="故事记忆" subtitle={currentProject.name} action={onClose ? <Button label="关闭" variant="ghost" onPress={onClose} /> : undefined} />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={[styles.title, { color: theme.colors.textPrimary }]}>状态：{STATUS_LABEL[state.metadata.status]}</Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>已构建到：{state.throughChapterPosition >= 0 ? `第 ${state.throughChapterPosition + 1} 章` : '无'}</Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>Dirty 起点：{state.metadata.dirtyFromPosition == null ? '无' : `第 ${state.metadata.dirtyFromPosition + 1} 章`}</Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>预估 Token：{state.metadata.estimatedTokens.toLocaleString()}</Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>来源：{state.metadata.source === 'legacy_bootstrap' ? '旧摘要快速初始化' : '完整正文'}</Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>更新时间：{state.metadata.updatedAt || '无'}</Text>
          {state.metadata.lastError ? <Text style={styles.error}>最近错误：{state.metadata.lastError}</Text> : null}
        </Card>

        {progress ? <Card><Text style={[styles.title, { color: theme.colors.textPrimary }]}>重建进度 {progress.completedChapters}/{progress.totalChapters}</Text><Text style={[styles.meta, { color: theme.colors.textSecondary }]}>复用 {progress.reusedPatches} · 重新生成 {progress.regeneratedPatches}</Text><Button label="取消重建" variant="secondary" onPress={() => controllerRef.current?.abort()} /></Card> : null}

        <View style={styles.actions}>
          <Button label="快速初始化" onPress={() => runRebuild('legacy_bootstrap')} />
          <Button label={state.metadata.status === 'failed' ? '从失败章继续' : '继续重建'} variant="secondary" onPress={() => runRebuild('auto')} />
          <Button label="完整重建" variant="secondary" onPress={() => runRebuild('full')} />
          <Button label="清空并重建" variant="danger" onPress={() => Alert.alert('清空并重建', '将删除现有结构化记忆并从正文重建，章节正文不会删除。', [{ text: '取消', style: 'cancel' }, { text: '继续', style: 'destructive', onPress: () => runRebuild('full', true) }])} />
        </View>

        <Card>
          <Text style={[styles.section, { color: theme.colors.textPrimary }]}>登场人物（{characters.length}）</Text>
          {characters.length ? characters.map(item => <Text key={item.id} style={[styles.item, { color: theme.colors.textSecondary }]}>• {item.canonicalName}｜{item.role || '身份未知'}｜{item.currentState.location || '位置未知'}｜目标：{item.currentState.currentGoal || '无'}｜{item.status}</Text>) : <Text style={[styles.item, { color: theme.colors.textSecondary }]}>无</Text>}
        </Card>
        <Card>
          <Text style={[styles.section, { color: theme.colors.textPrimary }]}>人物关系（{relationships.length}）</Text>
          {relationships.length ? relationships.map(item => <Text key={item.id} style={[styles.item, { color: theme.colors.textSecondary }]}>• {item.fromCharacterId} {item.direction === 'bidirectional' ? '↔' : '→'} {item.toCharacterId}｜{item.relationType}｜{item.currentState}</Text>) : <Text style={[styles.item, { color: theme.colors.textSecondary }]}>无</Text>}
        </Card>
        <Card>
          <Text style={[styles.section, { color: theme.colors.textPrimary }]}>故事主线</Text>
          <Text style={[styles.item, { color: theme.colors.textSecondary }]}>剧情弧：{mainline.currentArc?.name || '无'}</Text>
          <Text style={[styles.item, { color: theme.colors.textSecondary }]}>当前目标：{mainline.currentObjective || '无'}</Text>
          <Text style={[styles.item, { color: theme.colors.textSecondary }]}>活跃冲突：{Object.values(mainline.activeConflicts).map(item => item.title).join('、') || '无'}</Text>
          <Text style={[styles.item, { color: theme.colors.textSecondary }]}>未解决线索：{Object.values(mainline.openThreads).map(item => item.title).join('、') || '无'}</Text>
          <Text style={[styles.item, { color: theme.colors.textSecondary }]}>未兑现伏笔：{Object.values(mainline.foreshadowing).filter(item => item.status !== 'paid').map(item => item.setup).join('、') || '无'}</Text>
        </Card>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 100, gap: spacing.md },
  title: { fontSize: 16, fontWeight: '800', marginBottom: spacing.sm },
  section: { fontSize: 16, fontWeight: '800', marginBottom: spacing.sm },
  meta: { fontSize: 12, lineHeight: 20 },
  item: { fontSize: 13, lineHeight: 21, marginBottom: spacing.xs },
  error: { color: '#dc2626', fontSize: 12, marginTop: spacing.sm },
  actions: { gap: spacing.sm },
});
