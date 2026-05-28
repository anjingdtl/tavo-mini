import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeStore } from '../store/themeStore';

interface Props {
  visible: boolean;
  text: string;
  isGenerating: boolean;
  onStop: () => void;
}

export const AIStreamText: React.FC<Props> = ({ visible, text, isGenerating, onStop }) => {
  const { theme } = useThemeStore();
  if (!visible) return null;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.card, borderTopColor: theme.colors.border }]}>
      {isGenerating ? (
        <View style={styles.statusBar}>
          <Text style={[styles.statusText, { color: theme.colors.accent }]}>AI 生成中...</Text>
          <TouchableOpacity onPress={onStop} style={[styles.stopBtn, { borderColor: theme.colors.accent }]}>
            <Text style={[styles.stopText, { color: theme.colors.accent }]}>停止</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {text ? <Text style={[styles.text, { color: theme.colors.textPrimary }]}>{text}</Text> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { padding: 12, borderTopWidth: 1 },
  statusBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  statusText: { fontSize: 12 },
  stopBtn: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, borderWidth: 1 },
  stopText: { fontSize: 13 },
  text: { fontSize: 14, lineHeight: 22 },
});
