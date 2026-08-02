import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

const mockEnsureGenerationSettings = jest.fn();
const mockUpdateGenerationSettings = jest.fn();

jest.mock('../src/services/database', () => ({
  getLLMConfigs: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../src/services/continuation/generation', () => ({
  ensureGenerationSettings: (...args: any[]) =>
    mockEnsureGenerationSettings(...args),
  updateGenerationSettings: (...args: any[]) =>
    mockUpdateGenerationSettings(...args),
}));

import { useProjectStore } from '../src/store/projectStore';
import { ContinuationGenerationConfigScreen } from '../src/screens/continuation/ContinuationGenerationConfigScreen';

const settings = {
  projectId: 3,
  strictnessProfile: 'balanced',
  worldRuleLevel: 'strict',
  characterLevel: 'strict',
  relationshipLevel: 'strict',
  plotLevel: 'balanced',
  experienceLevel: 'strict',
  knowledgeLevel: 'strict',
  styleLevel: 'balanced',
  allowNewCharacters: true,
  allowNewLocations: true,
  allowNewOrganizations: true,
  majorRelationshipChangePolicy: 'require_confirmation',
  majorPowerChangePolicy: 'require_confirmation',
  characterDeathPolicy: 'require_confirmation',
  resurrectionPolicy: 'forbid',
  plannerLlmConfigId: null,
  writerLlmConfigId: null,
  checkerLlmConfigId: null,
  repairLlmConfigId: null,
  stateExtractionLlmConfigId: null,
  plannerConfirmationPolicy: 'risk_only',
  checkerEnabled: true,
  maxRepairRounds: 1,
  targetChapterChars: 3000,
  customRulesJson: '[]',
  createdAt: '',
  updatedAt: '',
} as any;

describe('ContinuationGenerationConfigScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureGenerationSettings.mockResolvedValue(settings);
    useProjectStore.setState({
      currentProject: {
        id: 3,
        name: '续写项目',
        mode: 'continuation',
        created_at: '',
        updated_at: '',
      } as any,
      workspaceMode: 'continuation',
    });
  });

  it('renders dedicated continuation settings instead of the outline four-stage pipeline', async () => {
    const { getByText, queryByText } = render(
      <ContinuationGenerationConfigScreen />,
    );

    await waitFor(() => expect(getByText('生成与一致性')).toBeTruthy());
    expect(getByText('阶段模型')).toBeTruthy();
    expect(queryByText('规划与风险确认')).toBeNull();
    expect(queryByText('规划')).toBeNull();
    expect(getByText('原著文风')).toBeTruthy();
    expect(getByText(/始终严格遵循原著画风画像/)).toBeTruthy();
    expect(queryByText('文风约束')).toBeNull();
    expect(getByText('校验严格度（预设）')).toBeTruthy();
    expect(queryByText('初稿作者')).toBeNull();
  });

  it('explains when no continuation project is selected', () => {
    useProjectStore.setState({
      currentProject: null,
      workspaceMode: 'continuation',
    });
    const { getByText } = render(<ContinuationGenerationConfigScreen />);
    expect(getByText('请先选择原著续写项目')).toBeTruthy();
  });
});
