import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../src/services/database', () => ({
  getAllCharacters: jest.fn(async () => [
    { id: 1, name: '角色 A', source_type: 'json', data_json: '{}', collection_id: 9, enabled_for_project: 1, max_tokens: 50000, estimated_tokens: 3 },
  ]),
  getAllWorldbookEntries: jest.fn(async () => []),
  getAllNotes: jest.fn(async () => []),
  getNoteContentById: jest.fn(async () => ''),
  getAllPresets: jest.fn(async () => []),
  getCharacterCollections: jest.fn(async () => [
    { id: 9, name: '角色合集 A', enabled: 1, character_count: 1, estimated_tokens: 3, max_tokens: 50000 },
  ]),
  getWorldbookCollections: jest.fn(async () => []),
  getProjectNoteConfig: jest.fn(async () => null),
  setCharacterCollectionEnabledForProject: jest.fn(async () => undefined),
}));

jest.mock('../src/services/fileImport', () => ({
  getCharacterImagePath: jest.fn(() => ''),
  importCharacters: jest.fn(async () => ({ total: 0, success: [], failed: [] })),
  importNotes: jest.fn(async () => ({ total: 0, success: [], failed: [] })),
  importSelectedCharacter: jest.fn(async () => null),
  importSelectedNoteText: jest.fn(async () => null),
  importSelectedWorldBook: jest.fn(async () => null),
  importWorldBooks: jest.fn(async () => ({ total: 0, success: [], failed: [] })),
  pickCharacterFolderFiles: jest.fn(async () => []),
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
import * as db from '../src/services/database';

describe('ResourceLibrary UI', () => {
  it('renders characters action buttons after data loads', async () => {
    const { findByText } = render(<ResourceLibrary />);

    for (const label of ['导入角色卡', '批量导入角色卡', '导入文件夹', '新建角色合集', '整理已导入']) {
      expect(await findByText(label)).toBeTruthy();
    }
  });

  it('opens a character collection and toggles collection enablement', async () => {
    const { findByText, getByText, getByTestId } = render(<ResourceLibrary />);

    expect(await findByText('角色合集 A')).toBeTruthy();
    act(() => {
      fireEvent(getByTestId('character-collection-toggle-9'), 'valueChange', false);
    });
    expect(db.setCharacterCollectionEnabledForProject).toHaveBeenCalledWith(1, 9, false);

    act(() => {
      fireEvent.press(getByText('打开'));
    });

    expect(await findByText('返回合集')).toBeTruthy();
    expect(await findByText('角色 A')).toBeTruthy();
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

  it('opens a note chapter directory and jumps to the selected heading', async () => {
    (db.getAllNotes as jest.Mock).mockResolvedValue([
      {
        id: 8,
        title: '长笔记',
        content: '预览',
        enabled_for_project: 1,
        max_tokens: 30000,
      },
    ]);
    (db.getNoteContentById as jest.Mock).mockResolvedValue(
      '导语\n第1章 初遇\n正文\n第2章 重逢\n正文',
    );

    const { findByText, getAllByText, getByPlaceholderText, getByText } = render(<ResourceLibrary />);
    await findByText('导入角色卡');
    fireEvent.press(getByText('笔记'));
    await findByText('长笔记');
    fireEvent.press(getAllByText('编辑')[0]);
    await findByText('章节 (2)');
    fireEvent.press(getByText('章节 (2)'));
    await findByText('第2章 重逢');
    fireEvent.press(getByText('第2章 重逢'));

    expect(getByPlaceholderText('请输入笔记内容').props.selection).toEqual({
      start: 13,
      end: 13,
    });
  });

  it('renders the list container with scrollable minHeight style', async () => {
    const { findByText, getByTestId } = render(<ResourceLibrary />);
    await findByText('导入角色卡');

    const container = getByTestId('resource-list-container');
    expect(container.props.style).toMatchObject({ minHeight: 240 });
  });
});
