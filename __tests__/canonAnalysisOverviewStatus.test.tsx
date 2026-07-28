/**
 * S2 component-level regression (spec §2 acceptance).
 *
 * The overview used to render "正在汇总结果" forever once a run reached
 * awaiting_review. We mock the canon barrel to drive the screen into each
 * terminal state and assert the progress label follows run.state × run.stage
 * rather than work-item state alone.
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

const projectState: { currentProject: any } = {
  currentProject: { id: 1, name: '续写项目', mode: 'continuation' },
};
jest.mock('../src/store/projectStore', () => ({
  useProjectStore: () => projectState,
}));

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      mode: 'light',
      colors: {
        accent: '#439EA6',
        accentSoft: '#B0E0E3',
        background: '#D7F1F4',
        textPrimary: '#111',
        textSecondary: '#444',
        textMuted: '#888',
        border: '#ccc',
        danger: '#c00',
        warning: '#b45309',
      },
    },
  }),
}));

jest.mock('@react-navigation/native', () => {
  const { useEffect } = require('react');
  return {
    useFocusEffect: (cb: any) => {
      useEffect(() => {
        if (typeof cb === 'function') cb();
      }, [cb]);
    },
  };
});

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

// Canon barrel mock — controllable per-test via overviewState.
const overviewState: {
  active: any;
  latestRun: any;
  workItems: any[];
  boundaryReady: boolean;
} = {
  active: null,
  latestRun: null,
  workItems: [],
  boundaryReady: true,
};

jest.mock('../src/services/continuation/canon', () => ({
  getAnalysisOverview: jest.fn(async () => ({
    activeSnapshot: overviewState.active,
    latestRun: overviewState.latestRun,
    runs: overviewState.latestRun ? [overviewState.latestRun] : [],
  })),
  getAnalysisWorkItems: jest.fn(async () => overviewState.workItems),
  ANALYSIS_MATERIAL_LABELS: {
    world_rules: '世界观',
    characters: '人物画像',
    relationships: '人物关系',
    plot_threads: '主线剧情',
    experiences: '人物经历',
    character_state: '人物与状态',
    world_plot: '世界观与剧情',
  },
}));

jest.mock('../src/services/continuation/continuationSettingsService', () => ({
  isBoundaryReady: jest.fn(async () => overviewState.boundaryReady),
}));

jest.mock('../src/native/PipelineForegroundModule', () => ({
  PipelineForeground: {
    start: jest.fn(),
    stop: jest.fn(),
    updateProgress: jest.fn(),
    notifyComplete: jest.fn(),
    notifyFailed: jest.fn(),
  },
}));

jest.mock('../src/utils/notificationPermission', () => ({
  requestNotificationPermission: jest.fn(async () => false),
}));

import { CanonAnalysisOverviewScreen } from '../src/screens/continuation/canon/CanonAnalysisOverviewScreen';

function makeRun(state: any, stage: any, total = 4) {
  return {
    id: 'run-1',
    projectId: 1,
    sourceId: 1,
    sourceVersion: 1,
    sourceSha256: 'hash',
    parserVersion: 'p',
    normalizationVersion: 'n',
    boundaryChapterId: 1,
    boundaryPosition: 0,
    boundaryCharOffsetExclusive: 0,
    canonSnapshotId: 'snap',
    profile: 'standard',
    modelConfigId: 1,
    state,
    stage,
    progressCurrent: total,
    progressTotal: total,
    extractionVersion: 'v1',
    checkpointJson: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '',
    updatedAt: '',
    completedAt: '',
  };
}

function completedWorkItems(total = 4) {
  return Array.from({ length: total }, (_, i) => ({
    runId: 'run-1',
    batchIndex: i,
    materialType: i % 2 === 0 ? 'character_state' : 'world_plot',
    state: 'completed',
    attemptCount: 1,
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '',
    updatedAt: '',
    completedAt: '',
  }));
}

describe('CanonAnalysisOverviewScreen status label (S2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    overviewState.active = null;
    overviewState.boundaryReady = true;
  });

  it('shows 分析完成，等待审核激活 for awaiting_review (not 正在汇总结果)', async () => {
    overviewState.latestRun = makeRun('awaiting_review', 'finalizing');
    overviewState.workItems = completedWorkItems();
    const { queryByText, getByText } = render(
      <CanonAnalysisOverviewScreen navigation={{ navigate: jest.fn(), goBack: jest.fn() }} />,
    );
    await waitFor(() =>
      expect(getByText(/分析完成，等待审核激活/)).toBeTruthy(),
    );
    expect(queryByText(/正在汇总结果/)).toBeNull();
  });

  it('shows 分析失败 for failed terminal state', async () => {
    overviewState.latestRun = makeRun('failed', 'chapter_extraction');
    overviewState.latestRun.errorMessage = '模型不可用';
    overviewState.workItems = completedWorkItems();
    const { getByText } = render(
      <CanonAnalysisOverviewScreen navigation={{ navigate: jest.fn(), goBack: jest.fn() }} />,
    );
    await waitFor(() => expect(getByText(/分析失败/)).toBeTruthy());
  });

  it('shows 已暂停，可继续 for paused terminal state', async () => {
    overviewState.latestRun = makeRun('paused', 'chapter_extraction');
    overviewState.workItems = completedWorkItems();
    const { getByText } = render(
      <CanonAnalysisOverviewScreen navigation={{ navigate: jest.fn(), goBack: jest.fn() }} />,
    );
    await waitFor(() => expect(getByText(/已暂停，可继续/)).toBeTruthy());
  });

  it('shows 正在汇总结果 for running + finalizing only', async () => {
    overviewState.latestRun = makeRun('running', 'finalizing');
    overviewState.workItems = completedWorkItems();
    const { getByText } = render(
      <CanonAnalysisOverviewScreen navigation={{ navigate: jest.fn(), goBack: jest.fn() }} />,
    );
    await waitFor(() => expect(getByText(/正在汇总结果/)).toBeTruthy());
  });
});
