/* eslint-env jest */

import { act, renderHook } from '@testing-library/react-native';
import { Alert } from 'react-native';
import type { DebouncedAsync } from '../src/utils/debounce';
import { useUnsavedChangesGuard } from '../src/screens/chapter-editor/hooks/useUnsavedChangesGuard';

function createAutosave(flush: jest.Mock): DebouncedAsync<[]> {
  return {
    call: jest.fn(),
    flush,
    cancel: jest.fn(),
    pending: jest.fn(() => true),
  };
}

describe('chapter unsaved changes guard', () => {
  let beforeRemove: ((event: any) => void) | undefined;
  let navigation: any;
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    beforeRemove = undefined;
    navigation = {
      addListener: jest.fn((eventName: string, handler: (event: any) => void) => {
        if (eventName === 'beforeRemove') beforeRemove = handler;
        return jest.fn();
      }),
      dispatch: jest.fn(),
    };
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('blocks header close on save failure and retries before closing', async () => {
    const flush = jest
      .fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValue(undefined);
    const onClose = jest.fn();
    const setSaveStatus = jest.fn();
    const autoSaveRef = { current: createAutosave(flush) };
    const { result } = renderHook(() =>
      useUnsavedChangesGuard({
        autoSaveRef,
        navigation,
        onClose,
        setSaveStatus,
      }),
    );

    await act(async () => {
      await result.current.flushAndClose();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(setSaveStatus).toHaveBeenCalledWith('failed');
    expect(alertSpy).toHaveBeenCalledWith(
      '保存失败',
      expect.stringContaining('内容尚未保存'),
      expect.any(Array),
    );

    const buttons = alertSpy.mock.calls[0][2] as any[];
    await act(async () => {
      await buttons.find(button => button.text === '重试保存').onPress();
    });

    expect(flush).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('only closes after the user explicitly chooses force exit', async () => {
    const onClose = jest.fn();
    const autoSaveRef = {
      current: createAutosave(jest.fn().mockRejectedValue(new Error('failed'))),
    };
    const { result } = renderHook(() =>
      useUnsavedChangesGuard({
        autoSaveRef,
        navigation,
        onClose,
        setSaveStatus: jest.fn(),
      }),
    );

    await act(async () => {
      await result.current.flushAndClose();
    });
    expect(onClose).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0][2] as any[];
    act(() => {
      buttons.find(button => button.text === '仍然退出').onPress();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks beforeRemove on failure and offers retry before dispatch', async () => {
    const flush = jest
      .fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValue(undefined);
    const autoSaveRef = { current: createAutosave(flush) };
    renderHook(() =>
      useUnsavedChangesGuard({
        autoSaveRef,
        navigation,
        onClose: jest.fn(),
        setSaveStatus: jest.fn(),
      }),
    );
    const action = { type: 'GO_BACK' };
    const event = { preventDefault: jest.fn(), data: { action } };

    await act(async () => {
      beforeRemove?.(event);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(navigation.dispatch).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      '保存失败',
      expect.stringContaining('内容尚未保存'),
      expect.any(Array),
    );

    const buttons = alertSpy.mock.calls[0][2] as any[];
    await act(async () => {
      await buttons.find(button => button.text === '重试保存').onPress();
    });

    expect(flush).toHaveBeenCalledTimes(2);
    expect(navigation.dispatch).toHaveBeenCalledWith(action);
  });
});
