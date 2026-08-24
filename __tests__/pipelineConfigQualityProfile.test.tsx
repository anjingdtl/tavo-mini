import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const mockGetPipelineConfig = jest.fn();
const mockSetPipelineConfig = jest.fn();
const mockGetPresetsByProject = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));

jest.mock('../src/services/database', () => ({
  getPipelineConfig: (...args: unknown[]) => mockGetPipelineConfig(...args),
  setPipelineConfig: (...args: unknown[]) => mockSetPipelineConfig(...args),
  getPresetsByProject: (...args: unknown[]) => mockGetPresetsByProject(...args),
}));

import { useProjectStore } from '../src/store/projectStore';
import { PipelineConfigScreen } from '../src/screens/PipelineConfigScreen';

describe('PipelineConfigScreen generation quality', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPipelineConfig.mockResolvedValue({
      pipelineMode: 'full',
      reasoningEffort: 'high',
      executionProfile: 'standard',
      generationQualityProfile: 'standard',
      reasoningProfileVersion: 5,
      activeWriterStyleId: null,
      draftPresetId: null,
      reviewPresetId: null,
      factCheckPresetId: null,
      proofPresetId: null,
      draftMaxTokens: 4000,
      reviewMaxTokens: 1500,
      factCheckMaxTokens: 1500,
      proofMaxTokens: 4000,
    });
    mockGetPresetsByProject.mockResolvedValue([]);
    mockSetPipelineConfig.mockResolvedValue(undefined);
    useProjectStore.setState({
      currentProject: {
        id: 1,
        name: 'p',
        mode: 'outline',
      } as any,
    });
  });

  test('user-facing control is 极速 / 标准 / 质量 and no longer shows 低/中/高', async () => {
    const { getByText, queryByText, getByTestId } = render(
      <PipelineConfigScreen />,
    );
    await waitFor(() => getByText('生成质量'));
    expect(getByText('极速')).toBeTruthy();
    expect(getByText('标准')).toBeTruthy();
    expect(getByText('质量')).toBeTruthy();
    expect(queryByText('低')).toBeNull();
    expect(queryByText('中')).toBeNull();
    expect(queryByText('高')).toBeNull();
    expect(getByTestId('pipeline-generation-quality-fast')).toBeTruthy();
    fireEvent.press(getByText('极速'));
    fireEvent.press(getByTestId('pipeline-config-save'));
    await waitFor(() => expect(mockSetPipelineConfig).toHaveBeenCalled());
    expect(mockSetPipelineConfig.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        generationQualityProfile: 'fast',
        executionProfile: 'one_shot',
        reasoningEffort: 'low',
      }),
    );
  });
});
