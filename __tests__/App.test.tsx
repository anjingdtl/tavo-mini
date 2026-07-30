import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { App } from '../src/main';

jest.mock('../src/services/database', () => ({
  getAllProjects: jest.fn(async () => []),
  getAllPipelineTasks: jest.fn(async () => []),
  getBackgroundPipelineEnabled: jest.fn(async () => true),
  getLLMConfigs: jest.fn(async () => []),
  getContextConfig: jest.fn(async () => ({
    strategy: 'sliding',
    slidingWindowSize: 4000,
    recentChapterCount: 3,
    summaryBudgetTokens: 20000,
    memoryTopK: 10,
    resourceBudget: 2000,
    worldbookScanDepth: 4,
    customRangeStart: 0,
    customRangeEnd: -1,
    includeResources: true,
    worldbookRecursive: true,
  })),
  getSetting: jest.fn(async () => null),
  openDatabase: jest.fn(),
}));

test('renders the real ShineWriter workspace tabs', async () => {
  const screen = render(<App />);

  await waitFor(() => {
    expect(screen.getByText('1 项目')).toBeTruthy();
    expect(screen.getByText('2 资料')).toBeTruthy();
    expect(screen.getByText('3 写作')).toBeTruthy();
    expect(screen.getByText('设置')).toBeTruthy();
  }, { timeout: 2500 });
});
