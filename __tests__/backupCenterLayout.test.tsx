import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        accent: '#6366f1',
        textSecondary: '#666',
        textMuted: '#999',
        textPrimary: '#111',
        surface: '#fff',
        border: '#ddd',
        card: '#f5f5f5',
        danger: '#ef4444',
      },
    },
  }),
}));

jest.mock('../src/services/backupService', () => ({
  listBackups: jest.fn(async () => []),
  createManualBackup: jest.fn(async () => {}),
  restoreFromBackup: jest.fn(async () => {}),
  deleteBackup: jest.fn(async () => {}),
  createPreRestoreBackup: jest.fn(async () => {}),
}));

jest.mock('../src/services/database', () => ({
  openDatabase: jest.fn(async () => ({})),
}));

jest.mock('../src/services/migrations', () => ({
  SCHEMA_VERSION: 8,
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

import { BackupCenterScreen } from '../src/screens/BackupCenterScreen';

describe('BackupCenterScreen layout', () => {
  it('renders create backup button', async () => {
    const { findByText } = render(<BackupCenterScreen />);
    expect(await findByText('创建备份')).toBeTruthy();
  });
});
