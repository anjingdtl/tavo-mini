import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { WriterStyleEditor } from '../src/screens/writer-style/WriterStyleEditor';

jest.mock('../src/services/database', () => ({
  updatePreset: jest.fn(async () => undefined),
  setProjectResourceEnabled: jest.fn(async () => undefined),
  setProjectActiveWriterStyle: jest.fn(async () => undefined),
}));

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        background: '#F6F8FA',
        surface: '#FFFFFF',
        card: '#FFFFFF',
        border: '#D8E0E7',
        textPrimary: '#172026',
        textSecondary: '#52616B',
        textMuted: '#84919A',
        accent: '#2563EB',
        accentSoft: '#DBEAFE',
        danger: '#DC2626',
      },
    },
  }),
}));

import * as db from '../src/services/database';

const asset = {
  id: 21,
  project_id: 1,
  name: '限知悬疑',
  is_default: 0,
  system_prompt: '旧系统',
  writing_style: '旧文风',
  extra_instructions: '旧约束',
  temperature: 0.74,
  top_p: 0.88,
  max_tokens: 4000,
  semantic_json: JSON.stringify({
    version: 1,
    name: '限知悬疑',
    applicability: { tone: '克制' },
    narration: { pointOfView: '限知' },
    language: { texture: '冷色' },
    sceneAndCharacter: {},
    narrativeMechanics: {},
    literaryTexture: {},
    prohibitions: ['作者旁白'],
  }),
  source_format: 'shinewriter' as const,
};

describe('WriterStyleEditor', () => {
  it('shows grouped Semantic fields and compiles runtime text from the same compiler', async () => {
    const onSaved = jest.fn();
    const { getByTestId, getByText } = render(
      <WriterStyleEditor
        visible
        asset={asset as any}
        projectId={1}
        activeWriterStyleId={null}
        onClose={jest.fn()}
        onSaved={onSaved}
      />,
    );

    expect(getByTestId('writer-style-group-positioning')).toBeTruthy();
    expect(getByTestId('writer-style-group-narration')).toBeTruthy();
    expect(getByTestId('writer-style-group-language')).toBeTruthy();
    expect(getByTestId('writer-style-group-scene')).toBeTruthy();
    expect(getByTestId('writer-style-group-mechanics')).toBeTruthy();
    expect(getByTestId('writer-style-group-literary')).toBeTruthy();
    expect(getByTestId('writer-style-group-prohibitions')).toBeTruthy();
    expect(getByText('来源：AI/结构化')).toBeTruthy();
    expect(getByText('作者旁白')).toBeTruthy();

    fireEvent.changeText(getByTestId('writer-style-field-texture'), '长短句交替');
    expect(getByTestId('writer-style-save-status').props.children).toBe('未保存');

    fireEvent.press(getByTestId('writer-style-advanced-toggle'));
    expect(getByTestId('writer-style-compiled-style').props.children).toContain(
      '长短句交替',
    );

    fireEvent.press(getByTestId('writer-style-save'));
    await waitFor(() => expect(db.updatePreset).toHaveBeenCalled());
    expect(db.updatePreset).toHaveBeenCalledWith(
      21,
      expect.objectContaining({
        name: '限知悬疑',
        writing_style: expect.stringContaining('长短句交替'),
        asset_contract_version: 2,
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('protects unsaved edits when leaving', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const onClose = jest.fn();
    const { getByTestId } = render(
      <WriterStyleEditor
        visible
        asset={asset as any}
        projectId={1}
        activeWriterStyleId={null}
        onClose={onClose}
        onSaved={jest.fn()}
      />,
    );
    fireEvent.changeText(getByTestId('writer-style-field-tone'), '更冷');
    fireEvent.press(getByTestId('writer-style-cancel'));
    expect(onClose).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      '作家风格尚未保存',
      expect.any(String),
      expect.any(Array),
    );
    alertSpy.mockRestore();
  });

  it('can set the current project writer style', async () => {
    const { getByTestId } = render(
      <WriterStyleEditor
        visible
        asset={asset as any}
        projectId={1}
        activeWriterStyleId={null}
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />,
    );
    fireEvent.press(getByTestId('writer-style-set-active'));
    await waitFor(() =>
      expect(db.setProjectActiveWriterStyle).toHaveBeenCalledWith(1, 21),
    );
  });
});
