import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, spacing } from '../../components/ui';
import type { ChapterReadingRange } from '../../data/repositories/projectRepository';
import { useThemeStore } from '../../store/themeStore';

export function ChapterTtsControls({
  onClose,
  onSelect,
  visible,
}: {
  onClose: () => void;
  onSelect: (range: ChapterReadingRange) => void;
  visible: boolean;
}) {
  const { theme } = useThemeStore();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        testID="range-picker-backdrop"
        style={styles.rangeBackdrop}
        onPress={onClose}
      >
        <Pressable
          style={[styles.rangeSheet, { backgroundColor: theme.colors.surface }]}
          onPress={event => event.stopPropagation()}
        >
          <Text
            style={[styles.rangeTitle, { color: theme.colors.textPrimary }]}
          >
            选择朗读范围
          </Text>
          <Text
            style={[
              styles.rangeSubtitle,
              { color: theme.colors.textSecondary },
            ]}
          >
            请选择要连续朗读的章节范围。
          </Text>
          <View style={styles.rangeActions}>
            <Button
              label="本章"
              variant="secondary"
              onPress={() => onSelect('current')}
            />
            <Button
              label="从本章到结尾"
              variant="secondary"
              onPress={() => onSelect('fromCurrent')}
            />
            <Button label="全书" onPress={() => onSelect('all')} />
            <Button label="取消" variant="ghost" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  rangeBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  rangeSheet: { borderRadius: 8, padding: spacing.lg },
  rangeTitle: { fontSize: 18, fontWeight: '800', marginBottom: spacing.xs },
  rangeSubtitle: { fontSize: 13, marginBottom: spacing.md, lineHeight: 20 },
  rangeActions: { gap: spacing.sm },
});
