/**
 * ResourceLibrary scroll-ownership regression gate.
 *
 * Invariant under test: every ResourceLibrary tab has exactly ONE vertical
 * scroll owner, and any dynamically growing header (note mode weights, the
 * built-in writer-style catalog with its expandable previews) lives INSIDE
 * that owner's content via FlatList.ListHeaderComponent.
 *
 * History: 资料库 → 笔记 became unreachable when the mode panel grew above an
 * independent FlatList; 资料库 → 作家风格 froze for the same structural reason
 * (catalog + previews in a plain View above the user-style FlatList). These
 * tests lock the fix so the pattern cannot silently come back on any tab.
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { FlatList, ScrollView } from 'react-native';

jest.mock('../src/services/database', () => ({
  getAllCharacters: jest.fn(async () => [
    { id: 1, name: '角色 A', source_type: 'json', data_json: '{}', collection_id: 9, enabled_for_project: 1, max_tokens: 50000, estimated_tokens: 3 },
  ]),
  getAllWorldbookEntries: jest.fn(async () => []),
  getAllNotes: jest.fn(async () => []),
  getNoteContentById: jest.fn(async () => ''),
  getAllPresets: jest.fn(async () => []),
  createPreset: jest.fn(async () => 77),
  updatePreset: jest.fn(async () => undefined),
  deletePreset: jest.fn(async () => undefined),
  updateCharacter: jest.fn(async () => undefined),
  updateCharacterTokenBudget: jest.fn(async () => undefined),
  getProjectActiveWriterStyleId: jest.fn(async () => null),
  setProjectActiveWriterStyle: jest.fn(async () => undefined),
  setProjectResourceEnabled: jest.fn(async () => undefined),
  getCharacterCollections: jest.fn(async () => [
    { id: 9, name: '角色合集 A', enabled: 1, character_count: 1, estimated_tokens: 3, max_tokens: 50000 },
  ]),
  getWorldbookCollections: jest.fn(async () => []),
  getNoteCollections: jest.fn(async () => []),
  updateWorldbookEntry: jest.fn(async () => undefined),
  getProjectNoteConfig: jest.fn(async () => null),
  setProjectNoteConfig: jest.fn(async () => undefined),
  setCharacterCollectionEnabledForProject: jest.fn(async () => undefined),
  setNoteCollectionEnabledForProject: jest.fn(async () => undefined),
  updateNoteCollection: jest.fn(async () => undefined),
  deleteNoteCollection: jest.fn(async () => undefined),
}));

jest.mock('../src/services/fileImport', () => ({
  getCharacterImagePath: jest.fn(() => ''),
  importCharacters: jest.fn(async () => ({ total: 0, success: [], failed: [] })),
  importNotes: jest.fn(async () => ({ total: 0, success: [], failed: [] })),
  importSelectedCharacter: jest.fn(async () => null),
  importSelectedNoteText: jest.fn(async () => null),
  importSelectedWorldBook: jest.fn(async () => null),
  importWorldBooks: jest.fn(async () => ({ total: 0, success: [], failed: [] })),
  pickCharacterFolderFiles: jest.fn(async () => []),
  pickCharacterPngImageReplacement: jest.fn(async () => null),
  pickLocalFiles: jest.fn(async () => []),
  withCharacterImageAsset: jest.fn((data) => data),
  types: { json: 'application/json', images: 'image/*', plainText: 'text/plain', allFiles: '*/*' },
}));

jest.mock('../src/services/exportService', () => ({
  exportCharacterJSON: jest.fn(async () => undefined),
  exportWorldbookCollectionJSON: jest.fn(async () => undefined),
  exportNoteMarkdown: jest.fn(async () => undefined),
  exportPresetJSON: jest.fn(async () => undefined),
}));

jest.mock('../src/services/styleAnalyzer', () => ({
  DEFAULT_STYLE_WEIGHTS: {
    sentence_structure: 2,
    tone_emotion: 2,
    vocabulary: 1,
    character_voice: 2,
    narrative_rhythm: 2,
  },
  analyzeNotesStyle: jest.fn(async () => []),
}));

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: any) => {
    if (typeof cb === 'function') {
      cb();
    }
  },
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
}));

jest.mock('../src/store/projectStore', () => ({
  useProjectStore: () => ({
    currentProject: { id: 1, name: '测试项目' },
  }),
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

import { ResourceLibrary } from '../src/screens/ResourceLibrary';
import * as db from '../src/services/database';
import * as exportService from '../src/services/exportService';
import { PRESET_CATALOG } from '../src/services/presets/catalog';

function makePresets(total: number) {
  return Array.from({ length: total }, (_, index) => ({
    id: index + 1,
    name: `用户风格${index + 1}`,
    source_format: 'shinewriter',
    enabled_for_project: 1,
    temperature: 0.8,
    top_p: 0.9,
    max_tokens: 4000,
    system_prompt: `系统${index + 1}`,
    writing_style: `文风${index + 1}`,
    extra_instructions: `约束${index + 1}`,
    semantic_json: '',
  }));
}

function makeNotes(total: number) {
  return Array.from({ length: total }, (_, index) => ({
    id: index + 1,
    title: `笔记${index + 1}`,
    content: `内容${index + 1}`,
    enabled_for_project: 1,
    collection_enabled_for_project: 1,
  }));
}

/** Walk a React element tree (not the rendered host tree) looking for testID. */
function elementTreeHasTestId(node: any, testID: string, depth = 0): boolean {
  if (!node || depth > 60) return false;
  if (Array.isArray(node)) {
    return node.some(child => elementTreeHasTestId(child, testID, depth + 1));
  }
  if (typeof node !== 'object') return false;
  if (node.props?.testID === testID) return true;
  return elementTreeHasTestId(node.props?.children, testID, depth + 1);
}

/** True when any ancestor of the rendered instance is a vertical ScrollView. */
function hasVerticalScrollViewAncestor(instance: any): boolean {
  let node = instance.parent;
  while (node) {
    if (node.type === ScrollView && !node.props.horizontal) return true;
    node = node.parent;
  }
  return false;
}

const STRUCTURED_PRESET = {
  id: 21,
  name: '限知悬疑',
  source_format: 'shinewriter',
  enabled_for_project: 1,
  temperature: 0.74,
  top_p: 0.88,
  max_tokens: 4000,
  system_prompt: '系统',
  writing_style: '文风',
  extra_instructions: '约束',
  semantic_json: JSON.stringify({
    version: 1,
    name: '限知悬疑',
    applicability: { tone: '克制' },
    narration: {},
    language: { texture: '冷色' },
    sceneAndCharacter: {},
    narrativeMechanics: {},
    literaryTexture: {},
    prohibitions: ['作者旁白'],
  }),
};

async function openWriterStyleTab(utils: ReturnType<typeof render>) {
  fireEvent.press(await utils.findByTestId('resource-tab-writer-style'));
  await utils.findByTestId('resource-writer-style-list');
}

afterEach(() => {
  (db.getAllPresets as jest.Mock).mockResolvedValue([]);
  (db.getProjectActiveWriterStyleId as jest.Mock).mockResolvedValue(null);
  (db.getAllNotes as jest.Mock).mockResolvedValue([]);
  (db.getNoteCollections as jest.Mock).mockResolvedValue([]);
  (db.getWorldbookCollections as jest.Mock).mockResolvedValue([]);
  (db.getAllWorldbookEntries as jest.Mock).mockResolvedValue([]);
  (db.getProjectNoteConfig as jest.Mock).mockResolvedValue(null);
  jest.clearAllMocks();
});

describe('Writer Style tab — single vertical scroll owner', () => {
  it('WS-1 renders one FlatList (resource-writer-style-list) whose header holds catalog, import and create', async () => {
    const utils = render(<ResourceLibrary />);
    await openWriterStyleTab(utils);

    const lists = utils.UNSAFE_getAllByType(FlatList);
    expect(lists).toHaveLength(1);
    const list = lists[0];
    expect(list.props.testID).toBe('resource-writer-style-list');
    expect(list.props.scrollEnabled).not.toBe(false);
    expect(list.props.ListHeaderComponent).toBeTruthy();
    expect(list.props.ListHeaderComponent.props.testID).toBe(
      'resource-writer-style-header',
    );
    expect(hasVerticalScrollViewAncestor(list)).toBe(false);

    const header = list.props.ListHeaderComponent;
    expect(elementTreeHasTestId(header, 'writer-style-catalog-list')).toBe(true);
    expect(elementTreeHasTestId(header, 'writer-style-import')).toBe(true);
    expect(elementTreeHasTestId(header, 'writer-style-add-name')).toBe(true);
    expect(elementTreeHasTestId(header, 'writer-style-add')).toBe(true);
    for (const item of PRESET_CATALOG) {
      expect(
        elementTreeHasTestId(header, `writer-style-catalog-item-${item.id}`),
      ).toBe(true);
    }

    expect(utils.getByText('内置作家风格目录')).toBeTruthy();
    expect(utils.getByText('导入作家风格')).toBeTruthy();
    expect(utils.getByText('添加')).toBeTruthy();
    expect(utils.getByText('长篇连贯叙事')).toBeTruthy();
  });

  it('WS-2 keeps an expanded built-in preview inside the ListHeaderComponent, not in a fixed View above the list', async () => {
    const utils = render(<ResourceLibrary />);
    await openWriterStyleTab(utils);

    const target = PRESET_CATALOG[0];
    fireEvent.press(utils.getByTestId(`writer-style-catalog-preview-${target.id}`));
    expect(await utils.findByText('高级设置 · 运行时编译结果')).toBeTruthy();
    expect(utils.getByText(target.preset.system_prompt)).toBeTruthy();

    const list = utils.UNSAFE_getByType(FlatList);
    const header = list.props.ListHeaderComponent;
    expect(header.props.testID).toBe('resource-writer-style-header');
    expect(
      elementTreeHasTestId(header, `writer-style-catalog-preview-view-${target.id}`),
    ).toBe(true);
    // Still exactly one vertical owner after the header grew.
    expect(utils.UNSAFE_getAllByType(FlatList)).toHaveLength(1);
    expect(hasVerticalScrollViewAncestor(list)).toBe(false);

    fireEvent.press(utils.getByText('收起预览'));
    await waitFor(() =>
      expect(utils.queryByText('高级设置 · 运行时编译结果')).toBeNull(),
    );
  });

  it('WS-3 keeps 100 user writer styles in the virtualized data source, not flattened into the header', async () => {
    (db.getAllPresets as jest.Mock).mockResolvedValue(makePresets(100));
    const utils = render(<ResourceLibrary />);
    await openWriterStyleTab(utils);

    const list = utils.UNSAFE_getByType(FlatList);
    await waitFor(() => expect(list.props.data).toHaveLength(100));
    const header = list.props.ListHeaderComponent;
    expect(elementTreeHasTestId(header, 'writer-style-item-1')).toBe(false);
    expect(elementTreeHasTestId(header, 'writer-style-item-100')).toBe(false);
    expect(utils.getByText('用户作家风格（100）')).toBeTruthy();
  });

  it('WS-4 exposes the 100th user writer style as data[99]', async () => {
    (db.getAllPresets as jest.Mock).mockResolvedValue(makePresets(100));
    const utils = render(<ResourceLibrary />);
    await openWriterStyleTab(utils);

    const list = utils.UNSAFE_getByType(FlatList);
    await waitFor(() => expect(list.props.data).toHaveLength(100));
    expect(list.props.data[99]).toEqual(
      expect.objectContaining({ id: 100, name: '用户风格100' }),
    );
    expect(list.props.keyExtractor(list.props.data[99])).toBe('100');
  });

  it('WS-5 still opens the structured WriterStyleEditor from a list row', async () => {
    (db.getAllPresets as jest.Mock).mockResolvedValue([STRUCTURED_PRESET]);
    (db.getProjectActiveWriterStyleId as jest.Mock).mockResolvedValue(21);
    const utils = render(<ResourceLibrary />);
    await openWriterStyleTab(utils);

    expect(await utils.findByText('限知悬疑')).toBeTruthy();
    expect(await utils.findByText('当前项目正在使用')).toBeTruthy();
    expect(utils.getByTestId('writer-style-item-21')).toBeTruthy();
    fireEvent.press(utils.getByTestId('writer-style-edit-21'));
    expect(await utils.findByText('基本定位')).toBeTruthy();
    expect(utils.getByTestId('writer-style-editor')).toBeTruthy();
  });

  it('WS-6 wires 设为当前作家风格 and 导出 on a list row to the same services', async () => {
    (db.getAllPresets as jest.Mock).mockResolvedValue(makePresets(3));
    const utils = render(<ResourceLibrary />);
    await openWriterStyleTab(utils);

    await utils.findByTestId('writer-style-item-3');
    fireEvent.press(utils.getByTestId('writer-style-set-active-3'));
    await waitFor(() =>
      expect(db.setProjectActiveWriterStyle).toHaveBeenCalledWith(1, 3),
    );
    expect(db.setProjectResourceEnabled).toHaveBeenCalledWith(1, 'preset', 3, true);

    fireEvent.press(utils.getByTestId('writer-style-export-3'));
    await waitFor(() =>
      expect(exportService.exportPresetJSON).toHaveBeenCalledWith(3),
    );
    expect(utils.getByTestId('writer-style-delete-3')).toBeTruthy();
  });

  it('WS-7 copies a catalog item into the DB from the header', async () => {
    const utils = render(<ResourceLibrary />);
    await openWriterStyleTab(utils);

    const target = PRESET_CATALOG[0];
    fireEvent.press(utils.getByTestId(`writer-style-catalog-add-${target.id}`));
    await waitFor(() =>
      expect(db.createPreset).toHaveBeenCalledWith(1, target.name),
    );
    expect(db.updatePreset).toHaveBeenCalledWith(
      77,
      expect.objectContaining({
        name: target.name,
        system_prompt: target.preset.system_prompt,
      }),
    );
  });
});

describe('ResourceLibrary — per-tab scroll ownership matrix', () => {
  it('R-1 characters: collection list and opened collection both use one FlatList owner', async () => {
    const utils = render(<ResourceLibrary />);
    await utils.findByText('角色合集 A');

    let lists = utils.UNSAFE_getAllByType(FlatList);
    expect(lists).toHaveLength(1);
    expect(lists[0].props.testID).toBe('resource-characters-list');
    expect(lists[0].props.scrollEnabled).not.toBe(false);
    expect(hasVerticalScrollViewAncestor(lists[0])).toBe(false);

    act(() => {
      fireEvent.press(utils.getByText('打开'));
    });
    await utils.findByText('角色 A');
    lists = utils.UNSAFE_getAllByType(FlatList);
    expect(lists).toHaveLength(1);
    expect(lists[0].props.testID).toBe('resource-characters-list');
    expect(hasVerticalScrollViewAncestor(lists[0])).toBe(false);
  });

  it('R-2 worldbook: collection list and opened collection both use one FlatList owner', async () => {
    (db.getWorldbookCollections as jest.Mock).mockResolvedValue([
      { id: 5, name: '港口设定', enabled: 1, entry_count: 1, estimated_tokens: 12, max_tokens: 50000 },
    ]);
    (db.getAllWorldbookEntries as jest.Mock).mockResolvedValue([
      {
        id: 7,
        collection_id: 5,
        keyword_primary: '雾港',
        keyword_secondary: '',
        content: '终年被海雾笼罩的港口。',
        comment: '',
        enabled: 1,
        constant: 0,
        enabled_for_project: 1,
        collection_enabled: 1,
        max_tokens: 2000,
        estimated_tokens: 12,
      },
    ]);
    const utils = render(<ResourceLibrary />);
    await utils.findByText('导入角色卡');
    fireEvent.press(utils.getByTestId('resource-tab-worldbook'));
    await utils.findByText('港口设定');

    let lists = utils.UNSAFE_getAllByType(FlatList);
    expect(lists).toHaveLength(1);
    expect(lists[0].props.testID).toBe('resource-worldbook-list');
    expect(hasVerticalScrollViewAncestor(lists[0])).toBe(false);

    fireEvent.press(utils.getByText('打开'));
    await utils.findByText('雾港');
    lists = utils.UNSAFE_getAllByType(FlatList);
    expect(lists).toHaveLength(1);
    expect(lists[0].props.testID).toBe('resource-worldbook-list');
    expect(hasVerticalScrollViewAncestor(lists[0])).toBe(false);
  });

  it('R-3 notes: resource-notes-list stays the single owner with the mode panel inside its header', async () => {
    (db.getAllNotes as jest.Mock).mockResolvedValue(makeNotes(120));
    (db.getProjectNoteConfig as jest.Mock).mockResolvedValue({
      mode: 'style',
      styleWeights: {},
      retrievalTopK: 5,
      retrievalFragmentChars: 1000,
      enabledNoteIds: [],
    });
    const utils = render(<ResourceLibrary />);
    fireEvent.press(await utils.findByTestId('resource-tab-notes'));
    await utils.findByTestId('resource-notes-list');

    const lists = utils.UNSAFE_getAllByType(FlatList);
    expect(lists).toHaveLength(1);
    const list = lists[0];
    expect(list.props.testID).toBe('resource-notes-list');
    expect(list.props.scrollEnabled).not.toBe(false);
    expect(hasVerticalScrollViewAncestor(list)).toBe(false);
    await waitFor(() => expect(list.props.data).toHaveLength(120));

    const header = list.props.ListHeaderComponent;
    expect(header.props.testID).toBe('resource-notes-header');
    expect(elementTreeHasTestId(header, 'resource-note-mode-panel')).toBe(true);
    expect(elementTreeHasTestId(header, 'resource-note-import')).toBe(true);
    expect(await utils.findByText('参与仿写：120 / 120 篇')).toBeTruthy();
  });

  it('R-4 writer style: resource-writer-style-list stays the single owner with the catalog inside its header', async () => {
    (db.getAllPresets as jest.Mock).mockResolvedValue(makePresets(40));
    const utils = render(<ResourceLibrary />);
    await openWriterStyleTab(utils);

    const lists = utils.UNSAFE_getAllByType(FlatList);
    expect(lists).toHaveLength(1);
    const list = lists[0];
    expect(list.props.testID).toBe('resource-writer-style-list');
    expect(hasVerticalScrollViewAncestor(list)).toBe(false);
    await waitFor(() => expect(list.props.data).toHaveLength(40));
    expect(list.props.ListHeaderComponent.props.testID).toBe(
      'resource-writer-style-header',
    );
    expect(
      elementTreeHasTestId(list.props.ListHeaderComponent, 'writer-style-catalog-list'),
    ).toBe(true);
  });

  it('R-5 dynamic regions are never rendered outside their tab owner, across tab switches', async () => {
    (db.getAllPresets as jest.Mock).mockResolvedValue(makePresets(5));
    (db.getAllNotes as jest.Mock).mockResolvedValue(makeNotes(5));
    (db.getProjectNoteConfig as jest.Mock).mockResolvedValue({
      mode: 'style',
      styleWeights: {},
      retrievalTopK: 5,
      retrievalFragmentChars: 1000,
      enabledNoteIds: [],
    });
    const utils = render(<ResourceLibrary />);
    await utils.findByText('角色合集 A');

    const expectSingleOwner = (testID: string) => {
      const lists = utils.UNSAFE_getAllByType(FlatList);
      expect(lists).toHaveLength(1);
      expect(lists[0].props.testID).toBe(testID);
      expect(hasVerticalScrollViewAncestor(lists[0])).toBe(false);
      return lists[0];
    };

    // characters → worldbook → notes → writer style → characters → writer style
    expectSingleOwner('resource-characters-list');

    fireEvent.press(utils.getByTestId('resource-tab-worldbook'));
    await utils.findByText('导入世界书');
    // Worldbook with no collections renders an empty state, so no list here —
    // but there must be no stray vertical owner either.
    expect(utils.UNSAFE_queryAllByType(FlatList)).toHaveLength(0);
    expect(
      utils
        .UNSAFE_queryAllByType(ScrollView)
        .filter(sv => !sv.props.horizontal),
    ).toHaveLength(0);

    fireEvent.press(utils.getByTestId('resource-tab-notes'));
    await utils.findByTestId('resource-notes-list');
    const notes = expectSingleOwner('resource-notes-list');
    expect(
      elementTreeHasTestId(notes.props.ListHeaderComponent, 'resource-note-mode-panel'),
    ).toBe(true);
    // The mode panel must not exist anywhere outside the notes header.
    expect(utils.getAllByTestId('resource-note-mode-panel')).toHaveLength(1);

    fireEvent.press(utils.getByTestId('resource-tab-writer-style'));
    await utils.findByTestId('resource-writer-style-list');
    const styles = expectSingleOwner('resource-writer-style-list');
    expect(
      elementTreeHasTestId(styles.props.ListHeaderComponent, 'writer-style-catalog-list'),
    ).toBe(true);
    expect(utils.getAllByTestId('writer-style-catalog-list')).toHaveLength(1);
    expect(utils.queryByTestId('resource-note-mode-panel')).toBeNull();

    fireEvent.press(utils.getByTestId('resource-tab-characters'));
    await utils.findByText('角色合集 A');
    expectSingleOwner('resource-characters-list');
    expect(utils.queryByTestId('writer-style-catalog-list')).toBeNull();

    fireEvent.press(utils.getByTestId('resource-tab-writer-style'));
    await utils.findByTestId('resource-writer-style-list');
    expectSingleOwner('resource-writer-style-list');
    expect(utils.getByText('用户作家风格（5）')).toBeTruthy();
  });
});
