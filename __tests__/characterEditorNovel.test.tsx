import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { CharacterEditor } from '../src/components/CharacterEditor';

describe('CharacterEditor novel profile mode', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('shows novel fields first and keeps legacy chat fields collapsed but editable', () => {
    const onChange = jest.fn();
    const source = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: '沈砚',
        description: '兼容描述',
        personality: '克制',
        scenario: '',
        first_mes: '旧开场白',
        mes_example: '{{char}}: 你好',
        system_prompt: '旧系统指令',
        post_history_instructions: '旧后置指令',
        tags: ['雾港'],
        alternate_greetings: ['旧问候'],
        creator: '旧作者',
        character_version: '1',
        extensions: {
          shinewriter_novel_character_v1: {
            role: '机关师',
            identity: '工会修理师',
            personality: '克制而记仇',
            relationships: ['妹妹'],
          },
          unknown_extension: { keep: true },
        },
      },
    };
    const screen = render(
      <CharacterEditor dataJson={JSON.stringify(source)} onChange={onChange} />,
    );

    expect(screen.getByText('小说角色档案')).toBeTruthy();
    expect(screen.getByDisplayValue('机关师')).toBeTruthy();
    expect(screen.queryByText('旧开场白')).toBeNull();

    fireEvent.press(screen.getByText('展开 CCv3 兼容字段'));
    const legacyInput = screen.getByDisplayValue('旧开场白');
    fireEvent.changeText(legacyInput, '修改后的旧开场白');
    act(() => jest.advanceTimersByTime(350));

    const emitted = JSON.parse(onChange.mock.calls.at(-1)?.[0] || '{}');
    expect(emitted.data.first_mes).toBe('修改后的旧开场白');
    expect(emitted.data.extensions.unknown_extension).toEqual({ keep: true });
    expect(emitted.data.extensions.shinewriter_novel_character_v1.role).toBe('机关师');
  });

  test('legacy cards remain editable and preserve unknown envelope data', () => {
    const onChange = jest.fn();
    const source = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: '旧卡',
        description: '旧描述',
        personality: '旧性格',
        scenario: '',
        first_mes: '旧开场',
        mes_example: '',
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        alternate_greetings: [],
        creator: 'legacy',
        character_version: '1',
        unknown_field: { preserved: true },
      },
      unknown_outer: 'preserved',
    };
    const screen = render(
      <CharacterEditor dataJson={JSON.stringify(source)} onChange={onChange} />,
    );
    fireEvent.changeText(screen.getByDisplayValue('旧开场'), '新开场');
    act(() => jest.advanceTimersByTime(350));
    const emitted = JSON.parse(onChange.mock.calls.at(-1)?.[0] || '{}');
    expect(emitted.unknown_outer).toBe('preserved');
    expect(emitted.data.unknown_field).toEqual({ preserved: true });
    expect(emitted.data.first_mes).toBe('新开场');
  });
});
