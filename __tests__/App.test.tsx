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
  // RB-20 fix (V2.11.34): the mock must return a valid database handle, not
  // undefined. Returning undefined caused init() to reach the outer catch
  // path, and the test was depending on legacy behaviour where the catch
  // branch called setReady(true). With the safe error screen, init() must
  // complete via the happy path for tabs to render.
  openDatabase: jest.fn(async () => ({ executeSql: () => undefined })),
}));

test('renders the real ShineWriter workspace tabs', async () => {
  const screen = render(<App />);

  await waitFor(() => {
    expect(screen.getByText('1 项目')).toBeTruthy();
    expect(screen.getByText('2 资料')).toBeTruthy();
    expect(screen.getByText('3 写作')).toBeTruthy();
    expect(screen.getByText('设置')).toBeTruthy();
  }, { timeout: 5000 });
});
