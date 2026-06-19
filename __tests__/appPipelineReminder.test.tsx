import React from 'react';
import { Alert, AppState } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { App } from '../src/main';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';

jest.mock('../src/services/database', () => ({
  getAllProjects: jest.fn(async () => []),
  getSetting: jest.fn(async () => null),
  openDatabase: jest.fn(),
}));

describe('App pipeline running reminder', () => {
  let appStateHandlers: Array<(state: string) => void>;
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    appStateHandlers = [];
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler: any) => {
      appStateHandlers.push(handler);
      return { remove: jest.fn() } as any;
    });
    usePipelineTaskStore.setState({
      _loaded: true,
      tasks: [{
        id: 'pt_running',
        targetType: 'chapter',
        targetId: 1,
        status: 'drafting',
        stageResults: [],
        finalText: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      }],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not show a modal warning when returning to the app with a running pipeline', () => {
    render(<App />);

    act(() => {
      appStateHandlers.forEach(handler => handler('active'));
    });

    expect(alertSpy).not.toHaveBeenCalledWith(
      '流水线任务提醒',
      expect.any(String),
      expect.any(Array),
    );
  });
});
