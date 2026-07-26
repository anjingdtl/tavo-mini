import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import RNFS from 'react-native-fs';
import Toast from 'react-native-toast-message';

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      mode: 'light',
      colors: {
        background: '#F6F8FA',
        surface: '#FFFFFF',
        card: '#FFFFFF',
        border: '#D8E0E7',
        textPrimary: '#172026',
        textSecondary: '#52616B',
        textMuted: '#84919A',
        accent: '#439EA6',
        accentSoft: '#B0E0E3',
        danger: '#C0392B',
      },
    },
  }),
}));

let mockLlmConfig: any = {
  id: 1,
  name: '在线',
  provider_type: 'openai_compatible',
  base_url: 'https://api.example.com',
  api_key: 'sk-test',
  model_name: 'gpt-test',
  is_active: 1,
  context_window: 32768,
  max_output_tokens: 4096,
};
jest.mock('../src/store/settingsStore', () => ({
  useSettingsStore: () => ({ llmConfig: mockLlmConfig }),
}));

let mockCurrentProject: { id: number; name: string } | null = {
  id: 7,
  name: '测试小说',
};
jest.mock('../src/store/projectStore', () => ({
  useProjectStore: (selector?: (s: any) => any) => {
    const state = { currentProject: mockCurrentProject };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

jest.mock('../src/navigation/navigationRef', () => ({
  navigateToLLMSettings: jest.fn(),
}));

jest.mock('../src/services/constructionAiGenerator', () => ({
  generateConstruction: jest.fn(),
  estimateConstructionInputTokens: jest.fn(() => 42),
  buildWorldbookSourceSnapshot: jest.fn(() => '世界书快照'),
  buildCharacterSourceSnapshot: jest.fn(() => '角色卡快照'),
}));

jest.mock('../src/services/constructionFileService', () => ({
  saveConstructionArtifact: jest.fn(),
  importConstructionArtifactToLibrary: jest.fn(),
}));

jest.mock('../src/services/fileImport', () => ({
  pickSourceFile: jest.fn(),
  parseWorldBookJSON: jest.fn(),
  parseCharacterCardJSON: jest.fn(),
  parseCharacterCardPNG: jest.fn(),
}));

import { navigateToLLMSettings } from '../src/navigation/navigationRef';
import { generateConstruction } from '../src/services/constructionAiGenerator';
import {
  importConstructionArtifactToLibrary,
  saveConstructionArtifact,
} from '../src/services/constructionFileService';
import {
  parseCharacterCardJSON,
  parseWorldBookJSON,
  pickSourceFile,
} from '../src/services/fileImport';
import { BuildScreen } from '../src/screens/BuildScreen';

const characterArtifact = {
  kind: 'character' as const,
  name: '沈砚',
  card: {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: '沈砚',
      description: '机关师',
      personality: '克制',
      scenario: '',
      first_mes: '你推开门。',
      mes_example: '{{char}}: 你好',
      system_prompt: '',
      post_history_instructions: '',
      tags: ['反派'],
      alternate_greetings: [],
      creator: 'ShineWriter 构建',
      character_version: '1.0',
    },
  },
};

const worldbookArtifact = {
  kind: 'worldbook' as const,
  name: '雾港纪事',
  entryCount: 2,
  lorebook: {
    spec: 'lorebook_v3',
    spec_version: '1.0',
    data: {
      name: '雾港纪事',
      entries: [
        { keys: ['雾港'], secondary_keys: [], content: '海雾港口。', comment: '地点', enabled: true, constant: false, insertion_order: 0 },
        { keys: ['机关行会'], secondary_keys: [], content: '机关术行会。', comment: '组织', enabled: true, constant: false, insertion_order: 1 },
      ],
    },
  },
};

function resetLLM(overrides: Partial<typeof mockLlmConfig> = {}) {
  mockLlmConfig = {
    id: 1,
    name: '在线',
    provider_type: 'openai_compatible',
    base_url: 'https://api.example.com',
    api_key: 'sk-test',
    model_name: 'gpt-test',
    is_active: 1,
    context_window: 32768,
    max_output_tokens: 4096,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetLLM();
  (RNFS.readFile as jest.Mock).mockResolvedValue('{}');
});

describe('BuildScreen', () => {
  it('shows the go-to-LLM-settings gate when the active config is a local model', () => {
    resetLLM({ provider_type: 'llama_cpp', local_model_id: 'm1' });
    const { getByText, queryByTestId } = render(<BuildScreen />);
    expect(getByText('前往 LLM 设置')).toBeTruthy();
    expect(queryByTestId('build-generate')).toBeNull();
    fireEvent.press(getByText('前往 LLM 设置'));
    expect(navigateToLLMSettings).toHaveBeenCalled();
  });

  it('flags an incomplete online config and gates generation', () => {
    resetLLM({ api_key: '' });
    const { getByText } = render(<BuildScreen />);
    expect(getByText(/配置不完整/)).toBeTruthy();
    expect(getByText('前往 LLM 设置')).toBeTruthy();
  });

  it('keeps generate disabled until an independent-character field is filled', () => {
    const { getByTestId, queryByText } = render(<BuildScreen />);
    const generate = getByTestId('build-generate');
    expect(generate.props.accessibilityState?.disabled).toBe(true);
    expect(queryByText(/请至少填写一个有效的角色设定字段/)).toBeTruthy();
  });

  it('generates an independent character card and shows the preview', async () => {
    (generateConstruction as jest.Mock).mockResolvedValue(characterArtifact);
    const { getByTestId, getByPlaceholderText, findByText } = render(<BuildScreen />);
    fireEvent.changeText(
      getByPlaceholderText('例如：反派机关师'),
      '反派机关师',
    );
    fireEvent.press(getByTestId('build-generate'));
    expect(await findByText('沈砚')).toBeTruthy();
    expect(generateConstruction).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'character_independent' }),
      expect.objectContaining({ maxTokens: expect.any(Number) }),
    );
  });

  it('switches to worldbook target and generates a multi-entry collection', async () => {
    (generateConstruction as jest.Mock).mockResolvedValue(worldbookArtifact);
    const { getByText, findByText } = render(<BuildScreen />);
    // 默认目标：角色卡 → 切到世界书
    fireEvent.press(getByText('世界书'));
    // 独立世界书无需必填字段即可生成
    fireEvent.press(await findByText('生成'));
    expect(await findByText(/雾港纪事 · 2 条/)).toBeTruthy();
    expect(generateConstruction).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'worldbook_independent' }),
      expect.any(Object),
    );
  });

  it('cancels an in-flight generation without producing an artifact', async () => {
    let capturedSignal: AbortSignal | undefined;
    let rejectGen: ((e: unknown) => void) | undefined;
    (generateConstruction as jest.Mock).mockImplementation(
      (_input: unknown, opts: { signal?: AbortSignal }) => {
        capturedSignal = opts.signal;
        return new Promise((_res, rej) => {
          rejectGen = rej;
        });
      },
    );
    const { getByTestId, getByPlaceholderText, findByText } = render(<BuildScreen />);
    fireEvent.changeText(getByPlaceholderText('例如：反派机关师'), '反派');
    fireEvent.press(getByTestId('build-generate'));
    const cancelBtn = await findByText('取消生成');
    fireEvent.press(cancelBtn);
    expect(capturedSignal?.aborted).toBe(true);
    await act(async () => {
      rejectGen?.(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', text1: '已取消生成' }),
    );
  });

  it('keeps a recoverable error card visible on invalid model JSON and returns to idle', async () => {
    (generateConstruction as jest.Mock).mockRejectedValue(
      new Error('模型没有返回有效 JSON。'),
    );
    const { getByTestId, getByPlaceholderText, findByText } = render(<BuildScreen />);
    fireEvent.changeText(getByPlaceholderText('例如：反派机关师'), '反派');
    fireEvent.press(getByTestId('build-generate'));
    await waitFor(() => {
      expect(Toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text1: '生成失败',
          text2: '模型没有返回有效 JSON。',
        }),
      );
    });
    expect(await findByText('模型没有返回有效 JSON。')).toBeTruthy();
    expect(getByTestId('build-generation-error')).toBeTruthy();
    // 失败后回到 idle，生成按钮再次可见
    expect(await findByText('生成')).toBeTruthy();
  });

  it('turns API authentication errors into an actionable LLM-settings recovery card', async () => {
    (generateConstruction as jest.Mock).mockRejectedValue(
      new Error('API 请求失败 (401, invalid_request_error): Authentication Fails'),
    );
    const { getByTestId, getByPlaceholderText, findByText } = render(<BuildScreen />);
    fireEvent.changeText(getByPlaceholderText('例如：反派机关师'), '反派');
    fireEvent.press(getByTestId('build-generate'));
    expect(await findByText(/API 认证失败/)).toBeTruthy();
    fireEvent.press(getByTestId('build-generation-error-settings'));
    expect(navigateToLLMSettings).toHaveBeenCalled();
  });

  it('reports a source format error when a picked worldbook file is invalid', async () => {
    (pickSourceFile as jest.Mock).mockResolvedValue({
      localPath: '/tmp/wb.json',
      name: 'wb.json',
    });
    (RNFS.readFile as jest.Mock).mockResolvedValue('not-json');
    (parseWorldBookJSON as jest.Mock).mockImplementation(() => {
      throw new Error('文件内容不是有效的 JSON 格式。');
    });
    const { getByText, findByText } = render(<BuildScreen />);
    fireEvent.press(getByText('由世界书'));
    fireEvent.press(await findByText('选择世界书 JSON'));
    await waitFor(() => {
      expect(Toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text1: '来源格式错误',
          text2: '文件内容不是有效的 JSON 格式。',
        }),
      );
    });
    expect(RNFS.unlink).toHaveBeenCalledWith('/tmp/wb.json');
  });

  it('reads a character-card source (JSON) and shows the source summary', async () => {
    (pickSourceFile as jest.Mock).mockResolvedValue({
      localPath: '/tmp/c.json',
      name: 'c.json',
    });
    (RNFS.readFile as jest.Mock).mockResolvedValue('{}');
    (parseCharacterCardJSON as jest.Mock).mockReturnValue({
      name: '沈砚',
      sourceType: 'json',
      data: { name: '沈砚' },
    });
    const { getByText, findByText } = render(<BuildScreen />);
    fireEvent.press(getByText('由角色卡'));
    fireEvent.press(await findByText('选择角色卡 JSON / PNG'));
    expect(await findByText('沈砚')).toBeTruthy();
    expect(RNFS.unlink).toHaveBeenCalledWith('/tmp/c.json');
  });

  it('does not show a success toast when the user cancels the save window', async () => {
    (generateConstruction as jest.Mock).mockResolvedValue(characterArtifact);
    (saveConstructionArtifact as jest.Mock).mockResolvedValue({
      saved: false,
      reason: 'cancelled',
    });
    const { getByTestId, getByPlaceholderText, findByText } = render(<BuildScreen />);
    fireEvent.changeText(getByPlaceholderText('例如：反派机关师'), '反派');
    fireEvent.press(getByTestId('build-generate'));
    const saveBtn = await findByText('保存到手机');
    fireEvent.press(saveBtn);
    await waitFor(() => {
      expect(saveConstructionArtifact).toHaveBeenCalled();
    });
    const calls = (Toast.show as jest.Mock).mock.calls;
    expect(
      calls.some(c => c[0]?.text1 === '已保存到手机'),
    ).toBe(false);
  });

  it('shows a success toast on save success', async () => {
    (generateConstruction as jest.Mock).mockResolvedValue(characterArtifact);
    (saveConstructionArtifact as jest.Mock).mockResolvedValue({
      saved: true,
      uri: 'content://x',
      fileName: '沈砚-角色卡.json',
    });
    const { getByTestId, getByPlaceholderText, findByText } = render(<BuildScreen />);
    fireEvent.changeText(getByPlaceholderText('例如：反派机关师'), '反派');
    fireEvent.press(getByTestId('build-generate'));
    fireEvent.press(await findByText('保存到手机'));
    await waitFor(() => {
      expect(Toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
          text1: '已保存到手机',
        }),
      );
    });
  });

  it('imports the artifact into the current project library', async () => {
    mockCurrentProject = { id: 7, name: '测试小说' };
    (generateConstruction as jest.Mock).mockResolvedValue(characterArtifact);
    (importConstructionArtifactToLibrary as jest.Mock).mockResolvedValue({
      kind: 'character',
      id: 99,
      name: '沈砚',
    });
    const { getByTestId, getByPlaceholderText, findByText } = render(<BuildScreen />);
    fireEvent.changeText(getByPlaceholderText('例如：反派机关师'), '反派');
    fireEvent.press(getByTestId('build-generate'));
    fireEvent.press(await findByText('导入资料库'));
    await waitFor(() => {
      expect(importConstructionArtifactToLibrary).toHaveBeenCalledWith(
        characterArtifact,
        7,
      );
      expect(Toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
          text1: '已导入资料库',
          text2: expect.stringContaining('沈砚'),
        }),
      );
    });
  });

  it('blocks library import when no project is selected', async () => {
    mockCurrentProject = null;
    (generateConstruction as jest.Mock).mockResolvedValue(characterArtifact);
    const { getByTestId, getByPlaceholderText, findByText } = render(<BuildScreen />);
    fireEvent.changeText(getByPlaceholderText('例如：反派机关师'), '反派');
    fireEvent.press(getByTestId('build-generate'));
    fireEvent.press(await findByText('导入资料库'));
    await waitFor(() => {
      expect(importConstructionArtifactToLibrary).not.toHaveBeenCalled();
      expect(Toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text1: '请先选择项目',
        }),
      );
    });
  });

  it('raises the default reserve to the full-detail minimum and renders budget cells', () => {
    mockCurrentProject = { id: 7, name: '测试小说' };
    const { getByText } = render(<BuildScreen />);
    // 丰满档最低 2,800，C=32768 时自动升至 9%，outputReserve=2949。
    expect(getByText('9')).toBeTruthy(); // 滑块数值
    expect(getByText(/2,949 Token/)).toBeTruthy();
    expect(getByText('丰满档最低生成')).toBeTruthy();
    expect(getByText('32,768')).toBeTruthy();
  });

  it('exposes TXT construction with an explicit target selector', () => {
    const { getByText } = render(<BuildScreen />);
    fireEvent.press(getByText('由 TXT'));
    expect(getByText('TXT 素材来源')).toBeTruthy();
    expect(getByText('选择 TXT')).toBeTruthy();
    expect(getByText('目标类型')).toBeTruthy();
  });
});
