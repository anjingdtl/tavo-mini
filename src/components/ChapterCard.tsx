import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Chapter, ChapterStatus } from '../types/novel';

interface ThemeColors {
  card: string;
  accent: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
}

interface Props {
  chapter: Chapter;
  isActive: boolean;
  plotlineColors: string[];
  onPress: () => void;
  theme: ThemeColors;
}

const STATUS_LABELS: Record<ChapterStatus, string> = {
  planned: '计划', draft: '草稿', revision: '修订', final: '定稿',
};

export const ChapterCard: React.FC<Props> = ({ chapter, isActive, plotlineColors, onPress, theme }) => {
  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: theme.card, borderColor: isActive ? theme.accent : theme.border }, isActive && styles.activeCard]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.textPrimary }]} numberOfLines={1}>{chapter.title}</Text>
        <Text style={[styles.status, { color: theme.textSecondary, backgroundColor: theme.border }]}>{STATUS_LABELS[chapter.status as ChapterStatus]}</Text>
      </View>
      {chapter.synopsis ? (
        <Text style={[styles.synopsis, { color: theme.textSecondary }]} numberOfLines={2}>{chapter.synopsis}</Text>
      ) : null}
      {plotlineColors.length > 0 && (
        <View style={styles.plotlineBar}>
          {plotlineColors.map((color, i) => (
            // 11.14 修复：用 color 值作稳定 key，避免 index 作 key 在增删时复用错位
            <View key={`${color}-${i}`} style={[styles.plotlineDot, { backgroundColor: color }]} />
          ))}
        </View>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: { padding: 12, borderRadius: 8, marginBottom: 8, borderWidth: 1, borderLeftWidth: 1 },
  activeCard: { borderLeftWidth: 4 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  title: { fontSize: 15, fontWeight: '600', flex: 1, marginRight: 8 },
  status: { fontSize: 11, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  synopsis: { fontSize: 12, marginBottom: 4 },
  plotlineBar: { flexDirection: 'row', gap: 4, marginTop: 4 },
  plotlineDot: { width: 12, height: 4, borderRadius: 2 },
});
