import React from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface UpgradeScreenProps {
  visible: boolean;
  fromVersion: string;
  toVersion: string;
  onConfirm: () => void;
  status: 'waiting' | 'migrating' | 'success' | 'error';
  errorMessage?: string;
}

export const UpgradeScreen: React.FC<UpgradeScreenProps> = ({
  visible,
  fromVersion,
  toVersion,
  onConfirm,
  status,
  errorMessage,
}) => {
  return (
    <Modal visible={visible} transparent={false} animationType="fade">
      <View style={styles.container}>
        <Text style={styles.title}>版本升级</Text>
        <Text style={styles.subtitle}>
          V{fromVersion} → V{toVersion}
        </Text>

        {status === 'waiting' && (
          <>
            <Text style={styles.description}>
              本次升级涉及数据结构重大变更，将自动迁移您的数据。迁移前已自动备份。
            </Text>
            <TouchableOpacity style={styles.button} onPress={onConfirm}>
              <Text style={styles.buttonText}>开始升级</Text>
            </TouchableOpacity>
          </>
        )}

        {status === 'migrating' && (
          <>
            <ActivityIndicator size="large" color="#439EA6" style={styles.spinner} />
            <Text style={styles.description}>正在迁移数据，请勿关闭应用...</Text>
          </>
        )}

        {status === 'success' && (
          <Text style={styles.successText}>升级完成</Text>
        )}

        {status === 'error' && (
          <>
            <Text style={styles.errorText}>升级遇到问题</Text>
            <Text style={styles.description}>{errorMessage || '正在恢复备份...'}</Text>
          </>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#071827',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#D7F1F4',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#B0E0E3',
    marginBottom: 24,
  },
  description: {
    fontSize: 14,
    color: '#B0E0E3',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#439EA6',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  spinner: {
    marginVertical: 16,
  },
  successText: {
    fontSize: 18,
    color: '#439EA6',
    fontWeight: '600',
  },
  errorText: {
    fontSize: 18,
    color: '#E57373',
    fontWeight: '600',
    marginBottom: 8,
  },
});
