import React from 'react';
import { render } from '@testing-library/react-native';

const mockLoadFromDB = jest.fn();
const mockNavigate = jest.fn();

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: (selector: any) => selector({
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

describe('SettingsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the developer signature in About', () => {
    const { getByText } = render(<SettingsScreen />);

    expect(getByText('软件作者：ShineHe')).toBeTruthy();
  });
});
