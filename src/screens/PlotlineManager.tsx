import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { Bot, Plus, Trash2 } from 'lucide-react-native';
import { Button, Card, EmptyState, Field, Header, Screen, spacing } from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import { callLLM } from '../services/llm';
import { extractJSON } from '../utils/jsonExtractor';
import type { Plotline } from '../types/novel';

const COLORS = ['#2563EB', '#DC2626', '#059669', '#D97706', '#7C3AED', '#DB2777'];

export const PlotlineManager: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [plotlines, setPlotlines] = useState<Plotline[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [generating, setGenerating] = useState(false);

  const loadPlotlines = useCallback(async () => {
    if (!currentProject) return;
    setPlotlines(await db.getPlotlinesByProject(currentProject.id));
  }, [currentProject]);

  useEffect(() => {
    loadPlotlines();
  }, [loadPlotlines]);

  const add = async () => {
    if (!currentProject || !name.trim()) return;
    await db.createPlotline(currentProject.id, name.trim(), description.trim(), COLORS[plotlines.length % COLORS.length]);
    setName('');
    setDescription('');
    await loadPlotlines();
  };

  const generate = async () => {
    if (!currentProject) return;
    setGenerating(true);
    try {
      const chapters = await db.getChaptersByProject(currentProject.id);
      const chapterText = chapters.map((chapter, index) => `第 ${index + 1} 章：${chapter.title} ${chapter.synopsis}`).join('\n');
      const result = await callLLM(
        [
          { role: 'system', content: '你是小说策划。请输出严格 JSON：{"plotlines":[{"name":"名称","description":"描述"}]}' },
          { role: 'user', content: `根据以下章节信息设计 3-5 条情节线：\n${chapterText || '暂无章节'}` },
        ],
        1200,
      );
      const json = result ? extractJSON(result) : null;
      if (!json) throw new Error('模型没有返回有效 JSON。');
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed.plotlines)) throw new Error('JSON 中缺少 plotlines 数组。');
      for (const item of parsed.plotlines) {
        await db.createPlotline(currentProject.id, String(item.name || '情节线'), String(item.description || ''), COLORS[plotlines.length % COLORS.length]);
      }
      await loadPlotlines();
    } catch (error: any) {
      Alert.alert('生成失败', error.message);
    } finally {
      setGenerating(false);
    }
  };

  const remove = (item: Plotline) => {
    Alert.alert('删除情节线', `确定删除「${item.name}」？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => { await db.deletePlotline(item.id); await loadPlotlines(); } },
    ]);
  };

  return (
    <Screen>
      <Header title="情节线" subtitle={currentProject?.name || '请先选择项目'} />
      <View style={styles.form}>
        <Field value={name} onChangeText={setName} placeholder="情节线名称" />
        <Field value={description} onChangeText={setDescription} placeholder="描述（可选）" />
        <View style={styles.actions}>
          <Button label="添加" icon={Plus} onPress={add} disabled={!name.trim()} />
          <Button label={generating ? '生成中...' : 'AI 生成'} icon={Bot} variant="secondary" onPress={generate} disabled={generating || !currentProject} />
        </View>
      </View>
      {plotlines.length === 0 ? (
        <EmptyState title="还没有情节线" description="手动添加或用 AI 根据章节概要生成。" />
      ) : (
        <FlatList
          data={plotlines}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Card style={[styles.plotlineCard, { borderLeftColor: item.color }]}>
              <View style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={[styles.title, { color: theme.colors.textPrimary }]}>{item.name}</Text>
                  <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{item.description || '暂无描述'}</Text>
                </View>
                <Button label="删除" icon={Trash2} variant="ghost" onPress={() => remove(item)} />
              </View>
            </Card>
          )}
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  form: { padding: spacing.lg, paddingBottom: 0 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  list: { padding: spacing.lg, paddingBottom: 96 },
  row: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  rowText: { flex: 1 },
  title: { fontSize: 16, fontWeight: '800', marginBottom: 4 },
  meta: { fontSize: 13, lineHeight: 19 },
  plotlineCard: { borderLeftWidth: 4 },
});
