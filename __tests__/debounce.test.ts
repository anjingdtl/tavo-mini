/* eslint-env jest */

import { debounce } from '../src/utils/debounce';

describe('flushable async debounce', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('flush persists the latest pending arguments exactly once', async () => {
    const save = jest.fn(async (_id: number, _text: string) => {});
    const controller = debounce(save, 900);
    controller.call(1, 'a');
    controller.call(1, 'latest');
    expect(controller.pending()).toBe(true);
    await controller.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(1, 'latest');
    expect(controller.pending()).toBe(false);
  });

  test('flush surfaces save failures', async () => {
    const controller = debounce(async () => {
      throw new Error('write failed');
    }, 900);
    controller.call();
    await expect(controller.flush()).rejects.toThrow('write failed');
  });

  test('call triggers execution after delay', async () => {
    const save = jest.fn(async () => {});
    const controller = debounce(save, 500);
    controller.call();
    expect(save).not.toHaveBeenCalled();
    jest.advanceTimersByTime(500);
    // Allow microtask queue to flush
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
  });

  test('cancel clears pending arguments', () => {
    const save = jest.fn(async () => {});
    const controller = debounce(save, 500);
    controller.call('data');
    controller.cancel();
    expect(controller.pending()).toBe(false);
    jest.advanceTimersByTime(500);
    expect(save).not.toHaveBeenCalled();
  });

  test('multiple flush calls share the same execution promise', async () => {
    let resolveSave: () => void;
    const save = jest.fn(async () => {
      await new Promise<void>(r => { resolveSave = r; });
    });
    const controller = debounce(save, 900);
    controller.call();
    const flush1 = controller.flush();
    const flush2 = controller.flush();
    resolveSave!();
    await Promise.all([flush1, flush2]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  test('flush with no pending call does nothing', async () => {
    const save = jest.fn(async () => {});
    const controller = debounce(save, 900);
    await controller.flush();
    expect(save).not.toHaveBeenCalled();
  });

  test('pending returns true while async execution is running', async () => {
    let resolveSave: () => void;
    const save = jest.fn(async () => {
      await new Promise<void>(r => { resolveSave = r; });
    });
    const controller = debounce(save, 500);
    controller.call();
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    expect(controller.pending()).toBe(true);
    resolveSave!();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.pending()).toBe(false);
  });
});
