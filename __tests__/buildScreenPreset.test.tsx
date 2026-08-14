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
