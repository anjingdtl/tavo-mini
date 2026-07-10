/* eslint-env jest */

import { closePipelineResult } from '../src/screens/PipelineResultScreen';

function createNavigation(index: number, routeNames: string[]) {
  return {
    dispatch: jest.fn(),
    getState: jest.fn(() => ({ index, routeNames })),
    goBack: jest.fn(),
  };
}

test('uses the supplied modal close callback without changing navigation', () => {
  const navigation = createNavigation(0, ['SettingsMain', 'PipelineResult']);
  const onClose = jest.fn();

  closePipelineResult(navigation as any, onClose);

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(navigation.goBack).not.toHaveBeenCalled();
  expect(navigation.dispatch).not.toHaveBeenCalled();
});

test('goes back when the result screen has stack history', () => {
  const navigation = createNavigation(1, ['SettingsMain', 'PipelineResult']);

  closePipelineResult(navigation as any);

  expect(navigation.goBack).toHaveBeenCalledTimes(1);
  expect(navigation.dispatch).not.toHaveBeenCalled();
});

test('resets a cold-start Settings result screen to SettingsMain', () => {
  const navigation = createNavigation(0, ['SettingsMain', 'PipelineResult']);

  closePipelineResult(navigation as any);

  const action = navigation.dispatch.mock.calls[0][0];
  expect(action.type).toBe('RESET');
  expect(action.payload).toMatchObject({
    index: 0,
    routes: [{ name: 'SettingsMain' }],
  });
  expect(navigation.goBack).not.toHaveBeenCalled();
});

test('resets a cold-start Editor result screen to EditorMain', () => {
  const navigation = createNavigation(0, ['EditorMain', 'PipelineResult']);

  closePipelineResult(navigation as any);

  const action = navigation.dispatch.mock.calls[0][0];
  expect(action.payload.routes).toEqual([{ name: 'EditorMain' }]);
  expect(navigation.goBack).not.toHaveBeenCalled();
});
