import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

const mockLoadFromDB = jest.fn();
const mockNavigate = jest.fn();
const mockListRunsForProject = jest.fn();
let mockWorkspaceMode: 'outline' | 'continuation' = 'outline';
let mockCurrentProject: any = null;

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: (selector: any) =>
    selector({
      getUnresolvedCount: () => 0,
      loadFromDB: mockLoadFromDB,
    }),
}));

jest.mock('../src/store/projectStore', () => ({
  useProjectStore: () => ({
    workspaceMode: mockWorkspaceMode,
    currentProject: mockCurrentProject,
  }),
}));

jest.mock('../src/services/continuation/generation', () => ({
  listRunsForProject: (...args: any[]) => mockListRunsForProject(...args),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
  }),
}));

import { SettingsScreen } from '../src/screens/SettingsScreen';
import appVersionJson from '../src/constants/version.json';

describe('SettingsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWorkspaceMode = 'outline';
    mockCurrentProject = null;
    mockListRunsForProject.mockResolvedValue([]);
  });

  it('shows the developer signature in About', () => {
    const { getByText } = render(<SettingsScreen />);

    expect(getByText('软件作者：ShineHe')).toBeTruthy();
  });

  it('shows the generated app version in About', () => {
    const { getByText } = render(<SettingsScreen />);

    expect(
      getByText(`Shine小说工作台 · ${appVersionJson.versionName}`),
    ).toBeTruthy();
  });

  it('groups backup and usage in one data card and moves context automation into model settings', () => {
    const { getAllByText, getByText, queryByText } = render(<SettingsScreen />);

    expect(getAllByText('数据').length).toBeGreaterThanOrEqual(2);
    expect(getByText('备份中心')).toBeTruthy();
    expect(getByText('用量统计')).toBeTruthy();
    expect(queryByText('上下文自动化配置')).toBeNull();
  });

  it('does not expose the background writing switch', () => {
    const { queryByText } = render(<SettingsScreen />);

    expect(queryByText('后台写作')).toBeNull();
    expect(queryByText('保持后台运行')).toBeNull();
  });

  it('exposes unfinished continuation runs from Settings', async () => {
    mockWorkspaceMode = 'continuation';
    mockCurrentProject = { id: 3, mode: 'continuation' };
    mockListRunsForProject.mockResolvedValue([
      { state: 'running' },
      { state: 'awaiting_user' },
      { state: 'completed' },
    ]);

    const { findByText, getByTestId } = render(<SettingsScreen />);

    await expect(findByText('执行情况 (2)')).resolves.toBeTruthy();
    fireEvent.press(getByTestId('settings-continuation-pipeline-tasks'));
    expect(mockNavigate).toHaveBeenCalledWith('ContinuationPipelineTask');
  });

  it('uses the same PipelineConfig entry for outline and continuation modes', () => {
    mockWorkspaceMode = 'continuation';
    mockCurrentProject = { id: 3, mode: 'continuation' };

    const { getByTestId } = render(<SettingsScreen />);
    fireEvent.press(getByTestId('settings-pipeline-config'));

    expect(mockNavigate).toHaveBeenCalledWith('PipelineConfig');
  });
});
