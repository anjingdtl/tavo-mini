import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('../src/store/settingsStore', () => ({
  useSettingsStore: () => ({
    llmConfig: {
      base_url: 'https://llm.example.com',
      api_key: 'key',
      model_name: 'model',
      context_window: 32768,
      max_output_tokens: 8192,
    },
  }),
}));

jest.mock('../src/store/projectStore', () => ({
  useProjectStore: (selector: (state: any) => unknown) =>
    selector({ currentProject: { id: 1, name: '测试项目' } }),
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
        warning: '#B45309',
      },
    },
  }),
}));

jest.mock('../src/navigation/navigationRef', () => ({
  navigateToLLMSettings: jest.fn(),
}));

jest.mock('../src/services/constructionAiGenerator', () => ({
  buildCharacterSourceSnapshot: jest.fn(),
  buildWorldbookSourceSnapshot: jest.fn(),
  estimateConstructionInputTokens: jest.fn(() => 10),
  generateConstruction: jest.fn(),
}));

jest.mock('../src/services/constructionFileService', () => ({
  importConstructionArtifactToLibrary: jest.fn(),
  saveConstructionArtifact: jest.fn(),
}));

jest.mock('../src/services/fileImport', () => ({
  parseCharacterCardJSON: jest.fn(),
  parseCharacterCardPNG: jest.fn(),
  parseWorldBookJSON: jest.fn(),
  pickSourceFile: jest.fn(),
}));

jest.mock('../src/services/textFileReader', () => ({
  readTextFileWithAutoEncodingResult: jest.fn(),
}));

jest.mock('../src/services/construction/characterDraftAdapter', () => ({
  readNovelCharacterDraft: jest.fn(() => null),
}));

import { BuildScreen } from '../src/screens/BuildScreen';

describe('BuildScreen preset target', () => {
  it('shows preset as a peer target with independent mechanism fields', () => {
    const { getByTestId } = render(<BuildScreen />);

    fireEvent.press(getByTestId('build-target-writer-style'));

    expect(getByTestId('build-preset-name')).toBeTruthy();
    expect(getByTestId('build-preset-pointOfView')).toBeTruthy();
    expect(getByTestId('build-preset-dialogue')).toBeTruthy();
    expect(getByTestId('build-preset-prohibitions')).toBeTruthy();
    expect(getByTestId('build-generate')).toBeTruthy();
  });

  it('keeps preset available for the TXT source mode', () => {
    const { getByText, getByTestId } = render(<BuildScreen />);

    fireEvent.press(getByText('由 TXT'));
    fireEvent.press(getByTestId('build-target-writer-style'));

    expect(getByText('TXT 素材来源')).toBeTruthy();
    expect(getByTestId('build-generate')).toBeTruthy();
  });
});

describe('BuildScreen independent briefs', () => {
  it('shows a compact Character Brief form instead of fragmented character fields', () => {
    const { getByTestId, queryByTestId, queryByText } = render(<BuildScreen />);

    expect(getByTestId('build-char-name')).toBeTruthy();
    expect(getByTestId('build-char-brief')).toBeTruthy();
    expect(getByTestId('build-character-image')).toBeTruthy();
    expect(queryByTestId('build-char-role')).toBeNull();
    expect(queryByTestId('build-char-identity')).toBeNull();
    expect(queryByTestId('build-char-appearance')).toBeNull();
    expect(queryByTestId('build-char-background')).toBeNull();
    expect(queryByTestId('build-char-personality')).toBeNull();
    expect(queryByTestId('build-char-motivation')).toBeNull();
    expect(queryByTestId('build-char-conflict')).toBeNull();
    expect(queryByTestId('build-char-relationships')).toBeNull();
    expect(queryByText('角色定位')).toBeNull();
    expect(queryByText('核心性格')).toBeNull();
    expect(queryByText('外貌与辨识特征')).toBeNull();
  });

  it('shows a compact Worldbook Brief form instead of classification fields', () => {
    const { getByTestId, getByText, queryByTestId, queryByText } = render(
      <BuildScreen />,
    );

    fireEvent.press(getByTestId('build-target-worldbook'));

    expect(getByTestId('build-wb-name')).toBeTruthy();
    expect(getByTestId('build-wb-brief')).toBeTruthy();
    expect(getByText(/条目数量/)).toBeTruthy();
    expect(queryByTestId('build-wb-worldview')).toBeNull();
    expect(queryByTestId('build-wb-categories')).toBeNull();
    expect(queryByTestId('build-wb-impact-scope')).toBeNull();
    expect(queryByTestId('build-wb-forbidden-rules')).toBeNull();
    expect(queryByTestId('build-wb-stable-relations')).toBeNull();
    expect(queryByText('核心世界观')).toBeNull();
    expect(queryByText('影响范围 / 长期世界后果')).toBeNull();
    expect(queryByText('不可违反的规则')).toBeNull();
    expect(queryByText('稳定关系（可选）')).toBeNull();
  });

  it('enables generation from a Brief, name, or visual reference without requiring all fields', () => {
    const { getByTestId, queryByText } = render(<BuildScreen />);

    expect(getByTestId('build-generate')).toBeTruthy();
    expect(queryByText('请至少填写角色名称、角色简介，或选择一张角色参考图。')).toBeTruthy();
    fireEvent.changeText(getByTestId('build-char-brief'), '一位护送商队的机械师。');
    expect(queryByText('请至少填写角色名称、角色简介，或选择一张角色参考图。')).toBeNull();
    expect(queryByText('请至少填写一个有效的角色设定字段。')).toBeNull();
  });
});
