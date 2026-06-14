import React from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { PipelineResultScreen } from '../screens/PipelineResultScreen';

export interface GenerationResultModalProps {
  visible: boolean;
  taskId: string | null;
  onClosed: () => void;
  onAdopted?: (text: string) => void;
}

export const GenerationResultModal: React.FC<GenerationResultModalProps> = ({
  visible,
  taskId,
  onClosed,
  onAdopted,
}) => {
  if (!taskId) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="overFullScreen"
      onRequestClose={onClosed}
    >
      <View style={styles.backdrop}>
        <View style={styles.container}>
          <PipelineResultScreen
            taskId={taskId}
            onClose={onClosed}
            onAdopted={onAdopted}
          />
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  container: {
    flex: 1,
  },
});
