/**
 * ResourceHome + ContinuationHome UI tests (Spec §8.3, §8.4, §18.3).
 *
 * Verifies the new 资料 stack entry list renders the five resource entries and
 * that ContinuationHome gates non-continuation projects correctly.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

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
  getActiveContinuationSource: jest.fn(async () => null),
  deleteContinuationSource: jest.fn(async () => undefined),
}));

import { ResourceHomeScreen } from '../src/screens/continuation/ResourceHomeScreen';
import { ContinuationHomeScreen } from '../src/screens/continuation/ContinuationHomeScreen';

describe('ResourceHome (Spec §8.3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders all five resource entries', () => {
    const { getByText } = render(<ResourceHomeScreen navigation={navigation as any} />);
    expect(getByText('续写')).toBeTruthy();
    expect(getByText('角色')).toBeTruthy();
    expect(getByText('世界书')).toBeTruthy();
    expect(getByText('笔记')).toBeTruthy();
    expect(getByText('预设')).toBeTruthy();
  });

  it('navigates to ContinuationHome when 续写 is tapped', () => {
    const { getByText } = render(<ResourceHomeScreen navigation={navigation as any} />);
    fireEvent.press(getByText('续写'));
    expect(mockNavigate).toHaveBeenCalledWith('ContinuationHome', {});
  });

  it('navigates to ResourceLibrary with initialTab when a content entry is tapped', () => {
    const { getByText } = render(<ResourceHomeScreen navigation={navigation as any} />);
    fireEvent.press(getByText('世界书'));
    expect(mockNavigate).toHaveBeenCalledWith('ResourceLibrary', {
      initialTab: 'worldbook',
    });
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
