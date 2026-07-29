import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BookOpen, FileSearch, FilePlus2, Network, Sparkles } from 'lucide-react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Button, Card, EmptyState, Header, Screen, spacing } from '../../components/ui';
import { useProjectStore } from '../../store/projectStore';
import * as db from '../../services/database';
import { useThemeStore } from '../../store/themeStore';
import type { Chapter } from '../../types/novel';

/** Mode-specific root: continuation never enters the ordinary outline workbench. */
export const ContinuationWorkspaceScreen: React.FC = () => {
  const { currentProject } = useProjectStore();
  const { theme } = useThemeStore();
  const navigation = useNavigation<any>();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const load = useCallback(async () => {
    if (!currentProject) return setChapters([]);
    setChapters(await db.getChaptersByProject(currentProject.id));
  }, [currentProject]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const add = async () => {
    if (!currentProject) return;
    const id = await db.createChapter(currentProject.id, chapters.length);
    navigation.navigate('ChapterEditor', { chapterId: id });
  };
  if (!currentProject) return <Screen><Header title="原著续写" /><EmptyState title="请先选择续写项目" description="在作品库中创建或选择一个原著续写项目。" /></Screen>;
  return <Screen>
    <Header title={currentProject.name} subtitle="原著续写工作台" action={<Button label="新建续写章节" icon={FilePlus2} compact onPress={() => add().catch(() => {})} />} />
    <View style={styles.summary}>
      <Card style={styles.summaryCard}>
        <TouchableOpacity onPress={() => navigation.navigate('Resources')} accessibilityRole="button" accessibilityLabel="打开原著与 Canon 资料" style={styles.summaryItem}>
          <Network size={16} color={theme.colors.accent} />
          <View style={styles.summaryText}><Text style={[styles.summaryTitle, { color: theme.colors.textPrimary }]}>Canon 驱动续写</Text><Text style={[styles.summaryMeta, { color: theme.colors.textSecondary }]} numberOfLines={1}>原著、边界与 Canon 统一调度</Text></View>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.navigate('Resources')} accessibilityRole="button" accessibilityLabel="打开外部补充资料" style={[styles.summaryItem, styles.summaryItemSecondary, { borderTopColor: theme.colors.border }]}>
          <Sparkles size={16} color={theme.colors.accent} />
          <View style={styles.summaryText}><Text style={[styles.summaryTitle, { color: theme.colors.textPrimary }]}>外部补充资料</Text><Text style={[styles.summaryMeta, { color: theme.colors.textSecondary }]} numberOfLines={1}>标为“外部补充”的资料会注入续写</Text></View>
        </TouchableOpacity>
      </Card>
    </View>
    <View style={styles.section}><Text style={[styles.title, { color: theme.colors.textPrimary }]}>续写章节</Text><Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{chapters.length} 章</Text></View>
    {chapters.length === 0 ? <EmptyState title="还没有续写章节" description="请先在资料页完成原著接入与 Canon 分析，再开始 AI 续写。" action={<Button label="新建续写章节" icon={BookOpen} onPress={() => add().catch(() => {})} />} /> : <FlatList data={chapters} keyExtractor={item => String(item.id)} contentContainerStyle={styles.list} renderItem={({item}) => <Card><TouchableOpacity onPress={() => navigation.navigate('ChapterEditor', { chapterId: item.id })} accessibilityRole="button" accessibilityLabel={`编辑${item.title || `第 ${item.position + 1} 章`}`}><Text style={[styles.title,{color:theme.colors.textPrimary}]}>{item.title || `第 ${item.position + 1} 章`}</Text><Text style={[styles.meta,{color:theme.colors.textSecondary}]} numberOfLines={2}>{item.synopsis || '未填写续写要求'}</Text></TouchableOpacity><View style={styles.contextAction}><Button label="查看实际上下文" icon={FileSearch} variant="secondary" compact onPress={() => navigation.navigate('ContextPreview', { chapterId: item.id })} /></View></Card>} />}
  </Screen>;
};

const styles = StyleSheet.create({ summary:{padding:spacing.lg},summaryCard:{paddingVertical:0},summaryItem:{minHeight:52,paddingHorizontal:spacing.md,flexDirection:'row',alignItems:'center',gap:spacing.sm},summaryItemSecondary:{borderTopWidth:StyleSheet.hairlineWidth},summaryText:{flex:1},summaryTitle:{fontSize:14,fontWeight:'800'},summaryMeta:{fontSize:11,lineHeight:16,marginTop:1},title:{fontSize:16,fontWeight:'800'},meta:{fontSize:13,lineHeight:19,marginTop:4},section:{paddingHorizontal:spacing.lg,flexDirection:'row',justifyContent:'space-between',alignItems:'center'},list:{padding:spacing.lg,gap:spacing.sm,paddingBottom:96},contextAction:{marginTop:spacing.md,alignItems:'flex-start'} });
