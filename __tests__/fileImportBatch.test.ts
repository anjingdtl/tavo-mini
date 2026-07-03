import { pickLocalFiles, importCharacters, importWorldBooks, importNotes } from '../src/services/fileImport';
import * as picker from '@react-native-documents/picker';
import * as db from '../src/services/database';
import RNFS from 'react-native-fs';

jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(),
  keepLocalCopy: jest.fn(),
  types: {
    json: 'application/json',
    images: 'image/*',
    plainText: 'text/plain',
    allFiles: '*/*',
  },
}));

jest.mock('../src/services/database', () => ({
  createCharacter: jest.fn(async () => 42),
  createWorldbookCollection: jest.fn(async () => 1),
  createWorldbookEntry: jest.fn(async () => 1),
  updateWorldbookCollectionTokenEstimate: jest.fn(async () => undefined),
  createNotesFromTextChunks: jest.fn(async () => ({ firstId: 1, createdCount: 1 })),
}));

jest.mock('react-native-fs', () => ({
  readFile: jest.fn(async () => '{"spec":"chara_card_v2","data":{"name":"x"}}'),
  DocumentDirectoryPath: '/app/docs',
  mkdir: jest.fn(async () => undefined),
  copyFile: jest.fn(async () => undefined),
}));

jest.mock('../src/native/PngMetadataModule', () => ({
  PngMetadata: null,
}));

describe('pickLocalFiles', () => {
  beforeEach(() => jest.clearAllMocks());

  test('user cancel returns null', async () => {
    (picker.pick as jest.Mock).mockResolvedValueOnce([]);
    const result = await pickLocalFiles(['application/json']);
    expect(result).toBeNull();
  });

  test('multi-select happy path returns array of local files', async () => {
    (picker.pick as jest.Mock).mockResolvedValueOnce([
      { uri: 'content://a', name: 'a.json', type: 'application/json' },
      { uri: 'content://b', name: 'b.json', type: 'application/json' },
    ]);
    (picker.keepLocalCopy as jest.Mock).mockResolvedValueOnce([
      { status: 'success', localUri: 'file:///cache/a.json' },
      { status: 'success', localUri: 'file:///cache/b.json' },
    ]);
    const result = await pickLocalFiles(['application/json'], 50);
    expect(result).toEqual([
      { localPath: '/cache/a.json', name: 'a.json', mimeType: 'application/json' },
      { localPath: '/cache/b.json', name: 'b.json', mimeType: 'application/json' },
    ]);
  });

  test('individual copy failure is filtered out, others kept', async () => {
    (picker.pick as jest.Mock).mockResolvedValueOnce([
      { uri: 'content://a', name: 'a.json', type: 'application/json' },
      { uri: 'content://b', name: 'b.json', type: 'application/json' },
    ]);
    (picker.keepLocalCopy as jest.Mock).mockResolvedValueOnce([
      { status: 'error', copyError: 'disk full' },
      { status: 'success', localUri: 'file:///cache/b.json' },
    ]);
    const result = await pickLocalFiles(['application/json'], 50);
    expect(result).toEqual([
      { localPath: '/cache/b.json', name: 'b.json', mimeType: 'application/json' },
    ]);
  });
});

describe('importCharacters', () => {
  beforeEach(() => jest.clearAllMocks());

  test('all files succeed', async () => {
    let idCounter = 1;
    (db.createCharacter as jest.Mock).mockImplementation(async () => idCounter++);
    const files = [
      { localPath: '/c/a.json', name: 'a.json', mimeType: 'application/json' },
      { localPath: '/c/b.json', name: 'b.json', mimeType: 'application/json' },
    ];
    const result = await importCharacters(1, files);
    expect(result.total).toBe(2);
    expect(result.success).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.success[0]).toEqual({ fileName: 'a.json', id: 1 });
    expect(result.success[1]).toEqual({ fileName: 'b.json', id: 2 });
  });

  test('partial failure returns both success and failed', async () => {
    let call = 0;
    (db.createCharacter as jest.Mock).mockImplementation(async () => {
      call += 1;
      if (call === 1) return 100;
      throw new Error('DB error');
    });
    const files = [
      { localPath: '/c/a.json', name: 'a.json', mimeType: 'application/json' },
      { localPath: '/c/b.json', name: 'b.json', mimeType: 'application/json' },
    ];
    const result = await importCharacters(1, files);
    expect(result.success).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toEqual({ fileName: 'b.json', error: 'DB error' });
  });

  test('empty file list returns empty result', async () => {
    const result = await importCharacters(1, []);
    expect(result).toEqual({ success: [], failed: [], total: 0 });
  });
});

describe('importWorldBooks', () => {
  beforeEach(() => jest.clearAllMocks());

  test('all files create separate collections', async () => {
    let colId = 1;
    (db.createWorldbookCollection as jest.Mock).mockImplementation(async () => colId++);

    const files = [
      { localPath: '/c/a.json', name: 'a.json', mimeType: 'application/json' },
      { localPath: '/c/b.json', name: 'b.json', mimeType: 'application/json' },
    ];
    (RNFS.readFile as jest.Mock).mockImplementation(async (path: string) => {
      if (String(path).endsWith('a.json')) {
        return JSON.stringify({ spec: 'lorebook_v3', data: { name: 'A', entries: [{ keys: ['k1'], content: 'c1' }] } });
      }
      return JSON.stringify({ spec: 'lorebook_v3', data: { name: 'B', entries: [{ keys: ['k2'], content: 'c2' }] } });
    });

    const result = await importWorldBooks(1, files);
    expect(result.success).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.success[0].id.collectionId).toBe(1);
    expect(result.success[1].id.collectionId).toBe(2);
  });

  test('file with no entries goes to failed', async () => {
    (RNFS.readFile as jest.Mock).mockResolvedValueOnce(
      JSON.stringify({ spec: 'lorebook_v3', data: { name: 'X', entries: [] } }),
    );
    const result = await importWorldBooks(1, [
      { localPath: '/c/x.json', name: 'x.json', mimeType: 'application/json' },
    ]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain('未找到');
  });
});

describe('importNotes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('all files create notes', async () => {
    let firstId = 100;
    (db.createNotesFromTextChunks as jest.Mock).mockImplementation(async () => {
      const ret = { firstId, createdCount: 3 };
      firstId += 3;
      return ret;
    });
    (RNFS.readFile as jest.Mock).mockResolvedValue('第一段\n\n第二段\n\n第三段');

    const files = [
      { localPath: '/c/a.txt', name: 'a.txt', mimeType: 'text/plain' },
      { localPath: '/c/b.txt', name: 'b.txt', mimeType: 'text/plain' },
    ];
    const result = await importNotes(1, files);
    expect(result.success).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.success[0].id).toEqual({ firstId: 100, createdCount: 3 });
  });

  test('DB error on one file goes to failed', async () => {
    let call = 0;
    (db.createNotesFromTextChunks as jest.Mock).mockImplementation(async () => {
      call += 1;
      if (call === 1) return { firstId: 1, createdCount: 2 };
      throw new Error('empty content');
    });
    const result = await importNotes(1, [
      { localPath: '/c/a.txt', name: 'a.txt', mimeType: 'text/plain' },
      { localPath: '/c/b.txt', name: 'b.txt', mimeType: 'text/plain' },
    ]);
    expect(result.success).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toEqual({ fileName: 'b.txt', error: 'empty content' });
  });
});