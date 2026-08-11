import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { DEFAULT_CONTEXT_CONFIG } from '../src/constants/defaults';
import { ContextConfigScreen } from '../src/screens/ContextConfig';
import { useSettingsStore } from '../src/store/settingsStore';

describe('ContextConfig strategy-specific fields', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      contextConfig: { ...DEFAULT_CONTEXT_CONFIG, strategy: 'custom' },
      loadSettings: jest.fn(async () => undefined),
      setContextConfig: jest.fn(async () => undefined),
    });
  });

  it('shows only the chapter selector used by the active strategy', () => {
    const screen = render(<ContextConfigScreen />);

    expect(screen.queryByText(/最近正文章数/)).toBeNull();
    expect(screen.getByText('自定义开始章节序号')).toBeTruthy();

    fireEvent.press(screen.getAllByText('完整前文')[0]);
    expect(screen.queryByText(/最近正文章数/)).toBeNull();
    expect(screen.queryByText('自定义开始章节序号')).toBeNull();

    fireEvent.press(screen.getAllByText('滑动窗口')[0]);
    expect(screen.getByText('最近正文章数（1–10 章）')).toBeTruthy();
    expect(screen.queryByText('自定义开始章节序号')).toBeNull();
  });

  it('allows clearing 10 before entering a different recent chapter count', () => {
    useSettingsStore.setState({
      contextConfig: { ...DEFAULT_CONTEXT_CONFIG, strategy: 'sliding' },
    });
    const screen = render(<ContextConfigScreen />);
    const input = screen.getAllByDisplayValue('10')[0];

    fireEvent.changeText(input, '');
    expect(input.props.value).toBe('');

    fireEvent.changeText(input, '3');
    expect(input.props.value).toBe('3');
  });
});
