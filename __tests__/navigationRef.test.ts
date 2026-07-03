// 回归测试：navigateToPipelineTaskCenter / navigateToPipelineResult
// 必须使用嵌套 CommonActions.navigate 才能跨 Tab 命中子 Stack 里的 screen。
// 修复前直接调用 navigationRef.navigate('PipelineTask') 会抛 "not handled"。

const mockDispatch = jest.fn();
const mockIsReady = jest.fn(() => true);
const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => {
  // 避免 hoist 提升到 import 之上时无法访问 mock* 变量；
  // 通过闭包延迟访问（jest.mock factory 本身就是 lazy 求值）。
  const actual = jest.requireActual('@react-navigation/native');
  const ref = {
    isReady: () => true,
    navigate: (...args: unknown[]) => mockNavigate(...args),
    dispatch: (...args: unknown[]) => mockDispatch(...args),
  };
  return {
    ...actual,
    createNavigationContainerRef: () => ref,
    __setReady: (v: boolean) => {
      ref.isReady = () => v;
    },
  };
});

import { navigateToPipelineTaskCenter, navigateToPipelineResult } from '../src/navigation/navigationRef';

beforeEach(() => {
  mockDispatch.mockClear();
  mockNavigate.mockClear();
  mockIsReady.mockClear();
  mockDispatch.mockReset();
  mockDispatch.mockImplementation(() => undefined);
  // 恢复 isReady 默认 true
  const rn = require('@react-navigation/native');
  rn.__setReady(true);
});

test('navigateToPipelineTaskCenter 走 Settings → PipelineTask 嵌套路由', () => {
  navigateToPipelineTaskCenter();
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  const action = mockDispatch.mock.calls[0][0];
  expect(action.type).toBe('NAVIGATE');
  expect(action.payload.name).toBe('Settings');
  expect(action.payload.params).toEqual({ screen: 'PipelineTask' });
});

test('navigateToPipelineResult 优先走 Settings → PipelineResult，params 携带 taskId', () => {
  navigateToPipelineResult('pt_test_123');
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  const action = mockDispatch.mock.calls[0][0];
  expect(action.payload.name).toBe('Settings');
  expect(action.payload.params).toEqual({
    screen: 'PipelineResult',
    params: { taskId: 'pt_test_123' },
  });
});

test('navigateToPipelineResult 退化到 Editor → PipelineResult', () => {
  mockDispatch.mockImplementationOnce(() => {
    throw new Error('Settings path unavailable');
  });
  navigateToPipelineResult('pt_test_fallback');
  expect(mockDispatch).toHaveBeenCalledTimes(2);
  const firstAction = mockDispatch.mock.calls[0][0];
  const secondAction = mockDispatch.mock.calls[1][0];
  expect(firstAction.payload.name).toBe('Settings');
  expect(secondAction.payload.name).toBe('Editor');
  expect(secondAction.payload.params).toEqual({
    screen: 'PipelineResult',
    params: { taskId: 'pt_test_fallback' },
  });
});

test('isReady=false 时不直接 dispatch，缓存 taskId', () => {
  const rn = require('@react-navigation/native');
  rn.__setReady(false);
  navigateToPipelineResult('pt_queued');
  expect(mockDispatch).not.toHaveBeenCalled();
});