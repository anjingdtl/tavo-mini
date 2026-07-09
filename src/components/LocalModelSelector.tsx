import React, { useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CheckCircle2 } from 'lucide-react-native';
import { useLocalModelStore } from '../store/localModelStore';
import { useThemeStore } from '../store/themeStore';
import { Card, spacing } from './ui';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const LocalModelSelector: React.FC<{
  selectedId: string | null;
  onSelect: (id: string) => void;
}> = ({ selectedId, onSelect }) => {
  const { theme } = useThemeStore();
  const { models, refreshModels } = useLocalModelStore();

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  const readyModels = models.filter((m) => m.status === 'ready');
  const unavailableModels = models.filter((m) => m.status === 'unavailable');

  if (readyModels.length === 0) {
    return (
      <Card style={styles.emptyCard}>
        <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
          {unavailableModels.length > 0
            ? `${unavailableModels.length} 个旧模型已不可用（LiteRT-LM 引擎已移除），请重新导入 GGUF 模型。`
            : '暂无可用的本地模型，请先到「管理本地模型」页面导入。'}
        </Text>
      </Card>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: theme.colors.textSecondary }]}>已导入的本地模型</Text>
      {readyModels.map((model) => {
        const selected = model.id === selectedId;
        return (
          <TouchableOpacity key={model.id} onPress={() => onSelect(model.id)} activeOpacity={0.7}>
            <Card style={[styles.modelCard, selected && { borderColor: theme.colors.accent }]}>
              <View style={styles.row}>
                <View style={styles.info}>
                  <Text style={[styles.name, { color: theme.colors.textPrimary }]} numberOfLines={1}>
                    {model.display_name}
                  </Text>
                  <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
                    {formatBytes(model.file_size)} · {model.validated_backend || 'cpu'} · {model.prompt_template}
                  </Text>
                </View>
                {selected ? <CheckCircle2 size={18} color={theme.colors.accent} /> : null}
              </View>
            </Card>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { marginBottom: spacing.md },
  label: { fontSize: 12, fontWeight: '700', marginBottom: spacing.sm },
  emptyCard: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xl },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  modelCard: { paddingVertical: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 2 },
});
