/**
 * S2 component-level regression (spec §2 acceptance).
 *
 * The overview used to render "正在汇总结果" forever once a run reached
 * awaiting_review. We mock the canon barrel to drive the screen into each
 * terminal state and assert the progress label follows run.state × run.stage
 * rather than work-item state alone.
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

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
  historicalCoverage: any;
} = {
  active: null,
  latestRun: null,
  workItems: [],
  boundaryReady: true,
  historicalCoverage: { readyDigestCount: 0, readyChapterCount: 0, ranges: [] },
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
    full_extraction: '原著全维度分析',
  },
  queueHistoricalDigests: jest.fn(async () => ({
    digestIds: ['digest-1', 'digest-2'],
    indexedChapterCount: 60,
  })),
  processHistoricalDigest: jest.fn(async () => ({})),
  getHistoricalDigestCoverage: jest.fn(
    async () => overviewState.historicalCoverage,
  ),
}));

jest.mock('../src/services/continuation/continuationSettingsService', () => ({
  isBoundaryReady: jest.fn(async () => overviewState.boundaryReady),
}));

jest.mock(
  '../src/services/continuation/styleProfile/styleProfileRepository',
  () => ({
    getActiveStyleProfileId: jest.fn(async () => null),
    listStyleProfilesForProject: jest.fn(async () => []),
    updateStyleProfileReviewStatus: jest.fn(async () => undefined),
  }),
);

jest.mock(
  '../src/services/continuation/styleProfile/styleAnalysisService',
  () => ({
    retryStyleAnalysis: jest.fn(async () => undefined),
  }),
);

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
  it('uses plain Chinese for the complete-analysis action', () => {
    // Regression guard for the user-facing entry point: internal Canon names
    // must not leak into the action and confirmation title.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        '../src/screens/continuation/canon/CanonAnalysisOverviewScreen.tsx',
      ),
      'utf8',
    );
    expect(source).not.toContain("'开始完整 Canon 分析'");
  });

  beforeEach(() => {
    jest.clearAllMocks();
    overviewState.active = null;
    overviewState.boundaryReady = true;
    overviewState.historicalCoverage = {
      readyDigestCount: 0,
      readyChapterCount: 0,
      ranges: [],
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the activate action next to a completed analysis', async () => {
    overviewState.latestRun = makeRun('awaiting_review', 'finalizing');
    overviewState.workItems = completedWorkItems();
    const { queryByText, getByText } = render(
      <CanonAnalysisOverviewScreen
        navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
      />,
    );
    await waitFor(() =>
      expect(getByText(/分析完成，可在此审核并激活/)).toBeTruthy(),
    );
    expect(getByText('审核并启用原著资料')).toBeTruthy();
    expect(queryByText(/正在汇总结果/)).toBeNull();
  });

  it('also provides the same-page activation action for a completed run', async () => {
    overviewState.latestRun = makeRun('completed', 'finalizing');
    overviewState.workItems = completedWorkItems();
    overviewState.historicalCoverage = {
      readyDigestCount: 1,
      readyChapterCount: 0,
      ranges: [],
    };
    const { getByText } = render(
      <CanonAnalysisOverviewScreen
        navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
      />,
    );
    await waitFor(() => expect(getByText('审核并启用原著资料')).toBeTruthy());
  });

  it('shows that a completed run is already enabled instead of asking to activate it again', async () => {
    overviewState.active = {
      id: 'snap',
      revision: 1,
      profile: 'standard',
      boundaryPosition: 0,
      boundaryCharOffsetExclusive: 0,
      coverage: {
        analyzedChapterCount: 3,
        sourceChapterCount: 4,
        analyzedRanges: [],
        incompleteReasons: [],
      },
    };
    overviewState.latestRun = makeRun('completed', 'finalizing');
    overviewState.workItems = completedWorkItems();
    overviewState.historicalCoverage = {
      readyDigestCount: 1,
      readyChapterCount: 1,
      ranges: [{ startPosition: 0, endPosition: 1 }],
    };
    const { getByText, queryByText } = render(
      <CanonAnalysisOverviewScreen
        navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
      />,
    );
    await waitFor(() =>
      expect(getByText(/分析完成，已启用为当前原著资料/)).toBeTruthy(),
    );
    expect(getByText('当前启用的原著资料')).toBeTruthy();
    expect(getByText(/快照 snap… · 版本 1 · 标准分析/)).toBeTruthy();
    expect(getByText('分析边界：第 1 章')).toBeTruthy();
    expect(getByText('完整原著分析')).toBeTruthy();
    expect(getByText(/历史概览：已覆盖 1\/1 个未精读章节/)).toBeTruthy();
    expect(queryByText('审核并启用原著资料')).toBeNull();
  });

  it('shows group progress and starts foreground retention for historical digests', async () => {
    overviewState.active = {
      id: 'active-snapshot',
      revision: 1,
      profile: 'standard',
      boundaryPosition: 269,
      boundaryCharOffsetExclusive: 0,
      coverage: {
        analyzedChapterCount: 30,
        sourceChapterCount: 299,
        analyzedRanges: [],
        incompleteReasons: [],
      },
    };
    overviewState.latestRun = null;
    overviewState.workItems = [];
    jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title, _message, actions) => {
        const start = actions?.find(action => action.text === '开始生成');
        start?.onPress?.();
      });
    const { getByText } = render(
      <CanonAnalysisOverviewScreen
        navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
      />,
    );
    await waitFor(() => expect(getByText('生成历史概览')).toBeTruthy());
    fireEvent.press(getByText('生成历史概览'));
    expect(Alert.alert).toHaveBeenCalledWith(
      '生成历史概览',
      expect.stringContaining('自动分组'),
      expect.any(Array),
    );
    await waitFor(() => {
      const {
        PipelineForeground,
      } = require('../src/native/PipelineForegroundModule');
      expect(PipelineForeground.start).toHaveBeenCalledWith(
        expect.stringMatching(/^history:1:/),
        '历史概览生成中',
        expect.stringContaining('0/2'),
        0,
      );
      expect(PipelineForeground.updateProgress).toHaveBeenCalledWith(
        expect.stringMatching(/^history:1:/),
        '第 1/2 组历史概览',
        50,
      );
      expect(PipelineForeground.notifyComplete).toHaveBeenCalled();
    });
  });

  it('shows 分析失败 for failed terminal state', async () => {
    overviewState.latestRun = makeRun('failed', 'chapter_extraction');
    overviewState.latestRun.errorMessage = '模型不可用';
    overviewState.workItems = completedWorkItems();
    const { getByText } = render(
      <CanonAnalysisOverviewScreen
        navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
      />,
    );
    await waitFor(() => expect(getByText(/分析失败/)).toBeTruthy());
  });

  it('shows 已暂停，可继续 for paused terminal state', async () => {
    overviewState.latestRun = makeRun('paused', 'chapter_extraction');
    overviewState.workItems = completedWorkItems();
    const { getByText } = render(
      <CanonAnalysisOverviewScreen
        navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
      />,
    );
    await waitFor(() => expect(getByText(/已暂停，可继续/)).toBeTruthy());
  });

  it('shows 正在分析原著写作风格 for running + style_analysis', async () => {
    overviewState.latestRun = makeRun('running', 'style_analysis');
    overviewState.workItems = completedWorkItems();
    const { getAllByText } = render(
      <CanonAnalysisOverviewScreen
        navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
      />,
    );
    await waitFor(() =>
      expect(
        getAllByText(/正在分析原著写作风格/).length,
      ).toBeGreaterThan(0),
    );
  });

  it('shows 正在校验风格画像 for running + style_validation', async () => {
    overviewState.latestRun = makeRun('running', 'style_validation');
    overviewState.workItems = completedWorkItems();
    const { getAllByText } = render(
      <CanonAnalysisOverviewScreen
        navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
      />,
    );
    await waitFor(() =>
      expect(getAllByText(/正在校验风格画像/).length).toBeGreaterThan(0),
    );
  });

  it('shows 正在汇总结果 for running + finalizing only', async () => {
    overviewState.latestRun = makeRun('running', 'finalizing');
    overviewState.workItems = completedWorkItems();
    const { getByText } = render(
      <CanonAnalysisOverviewScreen
        navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
      />,
    );
    await waitFor(() => expect(getByText(/正在汇总结果/)).toBeTruthy());
  });
});
