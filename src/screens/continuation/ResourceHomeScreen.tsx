/**
 * Resource home — the top of the 资料 stack (Spec §8.3).
 *
 * Replaces the old direct-to-ResourceLibrary tab. Offers five entries:
 * 续写 / 角色 / 世界书 / 笔记 / 预设. The latter four navigate into the existing
 * ResourceLibrary with an initialTab param; 续写 opens the continuation home.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  BookOpen,
  Boxes,
  FileText,
  NotebookPen,
  StickyNote,
} from 'lucide-react-native';
import { Card, Header, Screen, spacing } from '../../components/ui';
import { useProjectStore } from '../../store/projectStore';
import { useThemeStore } from '../../store/themeStore';
import { PROJECT_MODE_LABELS } from '../../services/continuation/projectMode';

type ResourceTab = 'characters' | 'worldbook' | 'notes' | 'presets';

const ENTRIES: {
  key: 'continuation' | ResourceTab;
  label: string;
  icon: React.FC<{ size?: number; color?: string }>;
  subtitle: string;
}[] = [
  {
    key: 'continuation',
    label: '续写',
    icon: BookOpen,
    subtitle: '原著导入、续写起点、Canon 分析',
  },
  {
    key: 'characters',
    label: '角色',
    icon: FileText,
    subtitle: '角色卡与角色合集',
  },
  {
    key: 'worldbook',
    label: '世界书',
    icon: Boxes,
    subtitle: '世界观条目与合集',
  },
  {
    key: 'notes',
    label: '笔记',
    icon: StickyNote,
    subtitle: '参考资料与笔记合集',
  },
  {
    key: 'presets',
    label: '预设',
    icon: NotebookPen,
    subtitle: '提示词预设',
  },
];

export const ResourceHomeScreen: React.FC<{
  navigation: { navigate: (screen: string, params?: any) => void };
}> = ({ navigation }) => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();

  const handlePress = (key: (typeof ENTRIES)[number]['key']) => {
    if (key === 'continuation') {
      navigation.navigate('ContinuationHome', {});
    } else {
      navigation.navigate('ResourceLibrary', { initialTab: key });
    }
  };

  return (
    <Screen>
      <Header
        title="资料"
        subtitle={currentProject ? currentProject.name : undefined}
      />
      <View style={styles.body}>
        {ENTRIES.map(entry => {
          const Icon = entry.icon;
          // Continuation is only meaningful for continuation projects; show it
          // regardless but the screen itself explains the mode gate.
          const note =
            entry.key === 'continuation' && currentProject
              ? PROJECT_MODE_LABELS[currentProject.mode] ?? ''
              : entry.subtitle;
          return (
            <TouchableOpacity
              key={entry.key}
              accessibilityRole="button"
              accessibilityLabel={entry.label}
              onPress={() => handlePress(entry.key)}
            >
              <Card style={styles.entry}>
                <View style={styles.entryRow}>
                  <Icon size={22} color={theme.colors.accent} />
                  <View style={styles.entryText}>
                    <Text style={[styles.entryTitle, { color: theme.colors.textPrimary }]}>
                      {entry.label}
                    </Text>
                    <Text style={[styles.entrySub, { color: theme.colors.textMuted }]}>
                      {entry.key === 'continuation' && currentProject
                        ? `${note} · ${currentProject.mode === 'continuation' ? '可用' : '当前项目不可用'}`
                        : entry.subtitle}
                    </Text>
                  </View>
                </View>
              </Card>
            </TouchableOpacity>
          );
        })}
      </View>
    </Screen>
  );
};

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.sm },
  entry: { paddingVertical: spacing.md },
  entryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  entryText: { flex: 1 },
  entryTitle: { fontSize: 16, fontWeight: '700' },
  entrySub: { fontSize: 12, marginTop: 2 },
});
