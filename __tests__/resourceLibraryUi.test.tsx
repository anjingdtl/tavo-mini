import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../src/services/database', () => ({
  getAllCharacters: jest.fn(async () => []),
  getAllWorldbookEntries: jest.fn(async () => []),
  getAllNotes: jest.fn(async () => []),
  getAllPresets: jest.fn(async () => []),
  getWorldbookCollections: jest.fn(async () => []),
  getProjectNoteConfig: jest.fn(async () => null),
}));

jest.mock('../src/services/fileImport', () => ({
  getCharacterImagePath: jest.fn(() => ''),
  importCharacters: jest.fn(async () => ({ total: 0, success: [], failed: [] })),
  importNotes: jest.fn(async () => ({ total: 0, success: [], failed: [] })),
  importSelectedCharacter: jest.fn(async () => null),
  importSelectedNoteText: jest.fn(async () => null),
  importSelectedWorldBook: jest.fn(async () => null),
  importWorldBooks: jest.fn(async () => ({ total: 0, success: [], failed: [] })),
  pickCharacterPngImageReplacement: jest.fn(async () => null),
  pickLocalFiles: jest.fn(async () => []),
  withCharacterImageAsset: jest.fn((data) => data),
  types: { json: 'application/json', images: 'image/*', plainText: 'text/plain', allFiles: '*/*' },
}));

jest.mock('../src/services/styleAnalyzer', () => ({
  DEFAULT_STYLE_WEIGHTS: {
    sentence_structure: 2,
    tone_emotion: 2,
    vocabulary: 1,
    character_voice: 2,
    narrative_rhythm: 2,
  },
  analyzeNotesStyle: jest.fn(async () => []),
}));

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: any) => {
    if (typeof cb === 'function') {
      cb();
    }
  },
}));

jest.mock('../src/store/projectStore', () => ({
  useProjectStore: () => ({
    currentProject: { id: 1, name: '测试项目' },
  }),
}));

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        background: '#F6F8FA',
        surface: '#FFFFFF',
        card: '#FFFFFF',
        border: '#D8E0E7',
        textPrimary: '#172026',
        textSecondary: '#52616B',
        textMuted: '#84919A',
        accent: '#2563EB',
        accentSoft: '#DBEAFE',
        danger: '#DC2626',
      },
    },
  }),
}));

import { ResourceLibrary } from '../src/screens/ResourceLibrary';

describe('ResourceLibrary UI', () => {
  it('renders characters action buttons after data loads', async () => {
    const { findByText } = render(<ResourceLibrary />);

    for (const label of ['导入角色卡', '批量导入角色卡', '新建角色卡', '启用全部角色', '停用全部角色']) {
      expect(await findByText(label)).toBeTruthy();
    }
  });

  it('renders worldbook action buttons after switching to worldbook tab', async () => {
    const { findByText, getByText } = render(<ResourceLibrary />);
    await findByText('导入角色卡');

    act(() => {
      fireEvent.press(getByText('世界书'));
    });

    for (const label of ['导入世界书', '批量导入世界书', '新建世界书']) {
      expect(await findByText(label)).toBeTruthy();
    }
  });

  it('renders note import buttons and note mode labels after switching to notes tab', async () => {
    const { findByText, findAllByText, getByText } = render(<ResourceLibrary />);
    await findByText('导入角色卡');

    act(() => {
      fireEvent.press(getByText('笔记'));
    });

    for (const label of ['导入 TXT 笔记', '批量导入 TXT']) {
      expect(await findByText(label)).toBeTruthy();
    }

    for (const label of ['禁用', '仿写', '资料库']) {
      expect((await findAllByText(label)).length).toBeGreaterThan(0);
    }
  });

  it('renders the list container with scrollable minHeight style', async () => {
    const { findByText, getByTestId } = render(<ResourceLibrary />);
    await findByText('导入角色卡');

    const container = getByTestId('resource-list-container');
    expect(container.props.style).toMatchObject({ minHeight: 240 });
  });
});
