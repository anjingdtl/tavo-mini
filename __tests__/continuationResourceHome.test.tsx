/**
 * ResourceLibrary 续写 tab + ContinuationHome UI tests (Spec §8.3, §8.4, §18.3).
 *
 * The old ResourceHomeScreen entry-list layer was removed and 续写 is now a
 * first-class tab inside ResourceLibrary's SegmentedControl. These tests verify
 * the flattened structure: the five tabs render, 续写 shows its embedded body,
 * and ContinuationHome still gates non-continuation projects correctly.
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

// Mock the navigation object passed to screens.
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const navigation = {
  navigate: mockNavigate,
  goBack: mockGoBack,
};

// Mock project store so we can switch project modes.
const projectState: { currentProject: any } = {
  currentProject: { id: 1, name: '续写项目', mode: 'continuation' },
};
jest.mock('../src/store/projectStore', () => ({
  useProjectStore: () => projectState,
}));

// Mock the import service so ContinuationHome doesn't hit the DB.
jest.mock('../src/services/continuation/continuationImportService', () => ({
  getActiveContinuationSource: jest.fn(),
  deleteContinuationSource: jest.fn(async () => undefined),
}));

// ResourceLibrary calls into the DB facade on focus (loadData) even when the
// continuation tab is active. Stub the facade so the content-tab loaders resolve
// to empty lists without touching SQLite.
jest.mock('../src/services/database', () => ({
  getAllCharacters: jest.fn(async () => []),
  getAllWorldbookEntries: jest.fn(async () => []),
  getAllNotes: jest.fn(async () => []),
  getAllPresets: jest.fn(async () => []),
  getCharacterCollections: jest.fn(async () => []),
  getWorldbookCollections: jest.fn(async () => []),
  getNoteCollections: jest.fn(async () => []),
  getProjectNoteConfig: jest.fn(async () => null),
}));

// Mock React Navigation hooks so screens mount without a NavigationContainer.
// useFocusEffect runs the callback once on mount (via useEffect); useNavigation
// returns the shared mock so the embedded ContinuationHomeBody can navigate.
jest.mock('@react-navigation/native', () => {
  const { useEffect } = require('react');
  return {
    useFocusEffect: (cb: any) => {
      useEffect(() => {
        if (typeof cb === 'function') {
          cb();
        }
      }, [cb]);
    },
    useNavigation: () => navigation,
  };
});

import { ResourceLibrary } from '../src/screens/ResourceLibrary';
import { ContinuationHomeScreen } from '../src/screens/continuation/ContinuationHomeScreen';

describe('ResourceLibrary 续写 tab (Spec §8.3 flattened)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const importService = jest.requireMock(
      '../src/services/continuation/continuationImportService',
    ) as { getActiveContinuationSource: jest.Mock };
    importService.getActiveContinuationSource.mockResolvedValue(null);
  });

  it('renders all five tabs in the SegmentedControl', () => {
    projectState.currentProject = { id: 1, name: '续写项目', mode: 'continuation' };
    const { getByText } = render(<ResourceLibrary navigation={navigation as any} />);
    expect(getByText('续写')).toBeTruthy();
    expect(getByText('角色')).toBeTruthy();
    expect(getByText('世界书')).toBeTruthy();
    expect(getByText('笔记')).toBeTruthy();
    expect(getByText('预设')).toBeTruthy();
  });

  it('shows the continuation import entry on the 续写 tab', async () => {
    projectState.currentProject = { id: 1, name: '续写项目', mode: 'continuation' };
    const { getAllByText, getByText } = render(
      <ResourceLibrary
        navigation={navigation as any}
        route={{ params: { initialTab: 'continuation' } }}
      />,
    );
    // The import card title + button both read '导入 TXT 原著'; wait for the
    // async getActiveContinuationSource mock to flip loading off.
    await waitFor(() => {
      expect(getAllByText('导入 TXT 原著').length).toBeGreaterThan(0);
    });
    expect(getByText(/原著仅保存在本设备/)).toBeTruthy();
  });

  it('keeps the primary analysis action inside the imported-source card', async () => {
    const importService = jest.requireMock(
      '../src/services/continuation/continuationImportService',
    ) as { getActiveContinuationSource: jest.Mock };
    importService.getActiveContinuationSource.mockResolvedValue({
      id: 'source-1',
      projectId: 1,
      displayName: '白后传',
      originalFileName: '白后传.txt',
      fileSizeBytes: 1024,
      normalizedCharCount: 1000,
      chapterCount: 5,
      detectedEncoding: 'utf-8',
      createdAt: '2026-07-29T00:00:00.000Z',
      activatedAt: '2026-07-29T00:00:00.000Z',
    });
    projectState.currentProject = { id: 1, name: '续写项目', mode: 'continuation' };
    const { getByText } = render(
      <ContinuationHomeScreen
        navigation={{ navigate: mockNavigate } as any}
      />,
    );

    await waitFor(() => expect(getByText('原著分析')).toBeTruthy());
    expect(getByText('查看原著章节')).toBeTruthy();
    expect(getByText('设置续写起点')).toBeTruthy();
    fireEvent.press(getByText('原著分析'));
    expect(mockNavigate).toHaveBeenCalledWith('CanonAnalysisOverview', {});
  });

  it('shows the not-continuation gate on the 续写 tab for an outline project', () => {
    projectState.currentProject = { id: 2, name: '大纲项目', mode: 'outline' };
    const { getByText } = render(
      <ResourceLibrary
        navigation={navigation as any}
        route={{ params: { initialTab: 'continuation' } }}
      />,
    );
    expect(getByText('当前项目不是原著续写项目')).toBeTruthy();
  });
});

describe('ContinuationHome project-mode gating (Spec §8.4, §18.3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the not-continuation gate for an outline project', () => {
    projectState.currentProject = { id: 2, name: '大纲项目', mode: 'outline' };
    const { getByText } = render(<ContinuationHomeScreen navigation={navigation as any} />);
    expect(getByText('当前项目不是原著续写项目')).toBeTruthy();
    expect(getByText(/大纲项目/)).toBeTruthy();
  });

  it('shows the not-continuation gate for a freeform project', () => {
    projectState.currentProject = { id: 3, name: '自由项目', mode: 'freeform' };
    const { getByText } = render(<ContinuationHomeScreen navigation={navigation as any} />);
    expect(getByText('当前项目不是原著续写项目')).toBeTruthy();
  });

  it('shows the import entry for a continuation project with no source', async () => {
    projectState.currentProject = { id: 1, name: '续写项目', mode: 'continuation' };
    const { getAllByText, getByText } = render(<ContinuationHomeScreen navigation={navigation as any} />);
    // Wait for the async effect (getActiveContinuationSource mock resolves to null)
    // to flip loading off and render the not-imported import card. The label
    // '导入 TXT 原著' appears both as the card title and the button text.
    await waitFor(() => {
      expect(getAllByText('导入 TXT 原著').length).toBeGreaterThan(0);
    });
    expect(getByText(/原著仅保存在本设备/)).toBeTruthy();
  });

  it('prompts to select a project when none is active', () => {
    projectState.currentProject = null;
    const { getByText } = render(<ContinuationHomeScreen navigation={navigation as any} />);
    expect(getByText('请先选择项目')).toBeTruthy();
  });
});
