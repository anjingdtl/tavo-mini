import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button } from './ui';

export interface BatchImportResultModalProps<T = any> {
  visible: boolean;
  title: string;
  success: Array<{ fileName: string; id: T }>;
  failed: Array<{ fileName: string; error: string }>;
  onClose: () => void;
}

export function BatchImportResultModal<T>({
  visible,
  title,
  success,
  failed,
  onClose,
}: BatchImportResultModalProps<T>) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <View style={styles.summary}>
            <Text style={styles.successText}>✅ 成功 {success.length}</Text>
            <Text style={styles.failedText}>❌ 失败 {failed.length}</Text>
          </View>
          <ScrollView style={styles.list}>
            {success.map((s, i) => (
              <Text key={`s-${i}`} style={styles.successRow}>
                ✓ {s.fileName} → ID {String(s.id)}
              </Text>
            ))}
            {failed.map((f, i) => (
              <View key={`f-${i}`} style={styles.failedRow}>
                <Text style={styles.failedName}>✗ {f.fileName}</Text>
                <Text style={styles.failedReason}>{f.error}</Text>
              </View>
            ))}
          </ScrollView>
          <Button label="关闭" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    maxHeight: '80%',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
    color: '#222',
  },
  summary: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 12,
  },
  successText: {
    color: '#2e7d32',
    fontWeight: '500',
  },
  failedText: {
    color: '#c62828',
    fontWeight: '500',
  },
  list: {
    maxHeight: 360,
    marginBottom: 12,
  },
  successRow: {
    paddingVertical: 4,
    color: '#222',
  },
  failedRow: {
    paddingVertical: 4,
  },
  failedName: {
    color: '#c62828',
    fontWeight: '500',
  },
  failedReason: {
    color: '#666',
    fontSize: 12,
    marginLeft: 12,
    marginTop: 2,
  },
});