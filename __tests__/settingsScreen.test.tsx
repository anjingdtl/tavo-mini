import React from 'react';
import { render } from '@testing-library/react-native';

const mockLoadFromDB = jest.fn();
const mockNavigate = jest.fn();

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: (selector: any) =>
    selector({
      getUnresolvedCount: () => 0,
      loadFromDB: mockLoadFromDB,
    }),
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
});
