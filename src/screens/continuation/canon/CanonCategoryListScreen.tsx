/**
 * Shared list UI for five Canon categories + review actions (Spec §11.2–11.6).
 * Reads via review list API + active snapshot; never issues ad-hoc Canon SQL.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { useFocusEffect } from '@react-navigation/native';
import { Button, Card, Header, Screen, spacing } from '../../../components/ui';
import { useProjectStore } from '../../../store/projectStore';
import { useThemeStore } from '../../../store/themeStore';
import {
  CanonQueryService,
  listCanonRows,
  listEvidenceForOwner,
  setReviewStatus,
  type GovernedTable,
} from '../../../services/continuation/canon';
import type { EvidenceOwnerType } from '../../../services/continuation/canon/types';

export type CanonCategoryKey =
  | 'world'
  | 'characters'
  | 'relationships'
  | 'plot'
  | 'experiences';

const CATEGORY_CONFIG: Record<
  CanonCategoryKey,
  {
    title: string;
    table: GovernedTable;
    ownerType: EvidenceOwnerType;
    titleOf: (row: any) => string;
    subtitleOf: (row: any) => string;
  }
> = {
  world: {
    title: '世界观',
    table: 'canon_world_rules',
    ownerType: 'world_rule',
    titleOf: r => r.title,
    subtitleOf: r => `${r.constraint_level} · ${r.category} · ${r.review_status}`,
  },
  characters: {
    title: '人物画像',
    table: 'canon_characters',
    ownerType: 'character',
    titleOf: r => r.canonical_name,
    subtitleOf: r => `${r.importance} · ${r.review_status}`,
  },
  relationships: {
    title: '人物关系',
    table: 'canon_relationships',
    ownerType: 'relationship',
    titleOf: r => `${r.source_character_id} → ${r.target_character_id} · ${r.relation_type}`,
    subtitleOf: r => `${r.public_status} · ${r.review_status}`,
  },
  plot: {
    title: '主线剧情',
    table: 'canon_plot_threads',
    ownerType: 'plot_thread',
    titleOf: r => r.title,
    subtitleOf: r => `${r.level} · ${r.status} · ${r.review_status}`,
  },
  experiences: {
    title: '人物经历',
    table: 'canon_character_experiences',
    ownerType: 'experience',
    titleOf: r => r.title,
    subtitleOf: r => `角色#${r.character_id} · pos ${r.chapter_position} · ${r.review_status}`,
  },
};

export const CanonCategoryListScreen: React.FC<{
  navigation: { goBack: () => void };
  route: { params?: { category?: CanonCategoryKey } };
  category?: CanonCategoryKey;
}> = ({ navigation, route, category: categoryProp }) => {
  const category = categoryProp ?? route.params?.category ?? 'world';
  const cfg = CATEGORY_CONFIG[category];
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<any[]>([]);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<string>('');

  const reload = useCallback(async () => {
    if (!currentProject) {
      setLoading(false);
      return;
    }
    try {
      let snapId: string | null = null;
      try {
        const snap = await CanonQueryService.getActiveSnapshot(currentProject.id);
        snapId = snap.id;
      } catch {
        // Allow browsing latest awaiting_review via analysis overview path later;
        // list still needs a snapshot id — try overview.
        const { getAnalysisOverview } = await import(
          '../../../services/continuation/canon/canonAnalysisService'
        );
        const overview = await getAnalysisOverview(currentProject.id);
        snapId =
          overview.activeSnapshot?.id ??
          overview.latestRun?.canonSnapshotId ??
          null;
      }
      setSnapshotId(snapId);
      if (!snapId) {
        setRows([]);
        return;
      }
      const list = await listCanonRows({
        table: cfg.table,
        snapshotId: snapId,
        limit: 100,
      });
      setRows(list);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '加载失败', text2: e?.message });
    } finally {
      setLoading(false);
    }
  }, [currentProject, cfg.table]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      reload();
    }, [reload]),
  );

  const act = async (
    id: number,
    status: 'confirmed' | 'locked' | 'ignored' | 'pending',
  ) => {
    if (!snapshotId) return;
    try {
      await setReviewStatus({
        table: cfg.table,
        id,
        snapshotId,
        status,
      });
      Toast.show({ type: 'success', text1: `已标记为 ${status}` });
      await reload();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const showEvidence = async (id: number) => {
    if (!snapshotId) return;
    try {
      const ev = await listEvidenceForOwner(snapshotId, cfg.ownerType, id);
      if (ev.length === 0) {
        setEvidencePreview('（无原文证据 — 用户设定或待补）');
      } else {
        setEvidencePreview(
          ev
            .map(
              e =>
                `§pos${e.chapterPosition} [${e.charStart},${e.charEnd}) ${e.quotePreview}`,
            )
            .join('\n'),
        );
      }
      setSelectedId(id);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '读取证据失败', text2: e?.message });
    }
  };

  return (
    <Screen>
      <Header
        title={cfg.title}
        action={<Button label="返回" variant="ghost" onPress={() => navigation.goBack()} />}
      />
      {loading ? (
        <ActivityIndicator style={{ marginTop: spacing.lg }} color={theme.colors.accent} />
      ) : !snapshotId ? (
        <Text style={[styles.empty, { color: theme.colors.textSecondary }]}>
          尚无 Canon 快照。请先在「分析概览」运行分析。
        </Text>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={item => String(item.id)}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            selectedId != null ? (
              <Card style={styles.evidenceCard}>
                <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
                  原文证据 #{selectedId}
                </Text>
                <Text style={{ color: theme.colors.textSecondary, marginTop: 4 }}>
                  {evidencePreview}
                </Text>
              </Card>
            ) : null
          }
          renderItem={({ item }) => (
            <Card style={styles.card}>
              <TouchableOpacity onPress={() => showEvidence(item.id)}>
                <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
                  {cfg.titleOf(item)}
                </Text>
                <Text style={{ color: theme.colors.textSecondary }}>
                  {cfg.subtitleOf(item)} · conf {Number(item.confidence).toFixed(2)}
                </Text>
              </TouchableOpacity>
              <View style={styles.actions}>
                <Button label="确认" variant="ghost" onPress={() => act(item.id, 'confirmed')} />
                <Button label="锁定" variant="ghost" onPress={() => act(item.id, 'locked')} />
                <Button label="忽略" variant="ghost" onPress={() => act(item.id, 'ignored')} />
              </View>
            </Card>
          )}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: theme.colors.textSecondary }]}>
              暂无条目
            </Text>
          }
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.md, paddingBottom: spacing.xl * 2 },
  card: { marginBottom: spacing.sm },
  title: { fontSize: 15, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.xs },
  empty: { padding: spacing.lg, textAlign: 'center' },
  evidenceCard: { marginBottom: spacing.md },
});
