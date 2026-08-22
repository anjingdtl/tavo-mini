import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        accent: '#439EA6',
        danger: '#C94F45',
        warning: '#A06B00',
        textPrimary: '#1D2B28',
        textSecondary: '#52615D',
        textMuted: '#72807C',
        card: '#FFFFFF',
        border: '#D7F1F4',
        accentSoft: '#D7F1F4',
      },
    },
  }),
}));

import { UnifiedPipelineStageView } from '../src/components/UnifiedPipelineStageView';

describe('UnifiedPipelineStageView', () => {
  const items = [
    { id: 'freeze' as const, status: 'success' as const },
    { id: 'draft' as const, status: 'success' as const, body: '正文' },
    {
      id: 'qa' as const,
      status: 'skipped' as const,
      detail: 'profile.one_shot.skip_qa',
    },
    { id: 'revision' as const, status: 'skipped' as const },
    { id: 'finalValidate' as const, status: 'success' as const },
    { id: 'persist' as const, status: 'success' as const },
    { id: 'postWriting' as const, status: 'pending' as const },
    { id: 'memory' as const, status: 'pending' as const },
  ];

  it('uses the same DAG and formal skip presentation for Standard and One-Shot', () => {
    const { getByText, getByTestId } = render(
      <UnifiedPipelineStageView profile="one_shot" items={items} />,
    );

    expect(getByText(/共享 Writing Kernel · One-Shot/)).toBeTruthy();
    expect(
      getByText('Freeze → 生成 → 检查 → 修订 → 校验 → 保存 → PostWriting → ONE Memory'),
    ).toBeTruthy();
    expect(getByText('检查 · 正式跳过')).toBeTruthy();
    expect(getByTestId('unified-pipeline-stage-view-memory')).toBeTruthy();
  });

  it('does not render stage-specific draft versions and expands only the shared stage body', () => {
    const { getByText, queryByText } = render(
      <UnifiedPipelineStageView profile="standard" items={items} />,
    );

    expect(queryByText('V1')).toBeNull();
    expect(queryByText('V2')).toBeNull();
    expect(queryByText('V3')).toBeNull();
    expect(queryByText('正文')).toBeNull();
    fireEvent.press(getByText('生成 · 成功'));
    expect(getByText('正文')).toBeTruthy();
  });
});
