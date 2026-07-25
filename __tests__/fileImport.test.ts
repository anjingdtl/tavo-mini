import {
  getCharacterImagePath,
  parseCharacterCardPNG,
  parseCharacterCardJSON,
  parseWorldBookJSON,
  withCharacterImageAsset,
} from '../src/services/fileImport';
import RNFS from 'react-native-fs';

declare const Buffer: any;

/* eslint-disable no-bitwise */

test('parses a character card v2 JSON into a normalized character payload', () => {
  const payload = parseCharacterCardJSON(
    JSON.stringify({
      spec: 'chara_card_v2',
      data: {
        name: '林夏',
        description: '城市奇幻主角',
        personality: '谨慎、敏锐',
      },
    }),
    'linxia.json',
  );

  expect(payload).toEqual({
    name: '林夏',
    sourceType: 'json',
    data: expect.objectContaining({
      spec: 'chara_card_v2',
      data: expect.objectContaining({ name: '林夏' }),
    }),
  });
});

test('parses lorebook_v3 entries from object maps and arrays', () => {
  const result = parseWorldBookJSON(
    JSON.stringify({
      spec: 'lorebook_v3',
      data: {
        name: '城市场景',
        entries: {
          a: { keys: ['旧城区', '钟楼'], content: '雨夜会触发钟声。', enabled: true },
          b: { key: ['地铁'], content: '末班车后站台关闭。', enabled: false },
        },
      },
    }),
  );

  expect(result.name).toBe('城市场景');
  expect(result.entries).toEqual([
    expect.objectContaining({
      keyword_primary: '旧城区, 钟楼',
      keyword_secondary: '',
      content: '雨夜会触发钟声。',
      enabled: 1,
      constant: 1, // 导入默认常驻
    }),
    expect.objectContaining({
      keyword_primary: '地铁',
      keyword_secondary: '',
      content: '末班车后站台关闭。',
      enabled: 0,
      constant: 1,
    }),
  ]);
});

test('import worldbook only keeps non-constant when source explicitly sets constant false', () => {
  const result = parseWorldBookJSON(
    JSON.stringify({
      spec: 'lorebook_v3',
      data: {
        name: '可选触发',
        entries: [
          { keys: ['雨夜'], content: '关键词触发条目。', constant: false },
          { keys: ['法则'], content: '常驻法则。', constant: true },
        ],
      },
    }),
  );
  expect(result.entries[0]).toMatchObject({
    keyword_primary: '雨夜',
    constant: 0,
  });
  expect(result.entries[1]).toMatchObject({
    keyword_primary: '法则',
    constant: 1,
  });
});

test('stores an editable PNG image path without losing character card metadata', () => {
  const data = {
    spec: 'chara_card_v2',
    data: { name: '林夏', description: '城市奇幻主角' },
  };

  const updated = withCharacterImageAsset(data, '/app/documents/character-images/linxia.png', 'linxia.png');

  expect(updated.data.name).toBe('林夏');
  expect(getCharacterImagePath(JSON.stringify(updated))).toBe('/app/documents/character-images/linxia.png');
});

test('parses character metadata from PNG iTXt chunks', async () => {
  const card = JSON.stringify({ spec: 'chara_card_v2', data: { name: '林夏' } });
  const metadata = bytes('chara')
    .concat([0, 0, 0])
    .concat([0])
    .concat([0])
    .concat(bytes(card));
  (RNFS.readFile as jest.Mock).mockResolvedValue(makePngBase64('iTXt', metadata));

  await expect(parseCharacterCardPNG('/tmp/linxia.png')).resolves.toMatchObject({
    name: '林夏',
    sourceType: 'png',
  });
});

function bytes(text: string): number[] {
  return Array.from(Buffer.from(text, 'utf8'));
}

function makePngBase64(type: string, data: number[]): string {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const length = data.length;
  const header = [(length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255];
  const chunk = header.concat(bytes(type), data, [0, 0, 0, 0]);
  const end = [0, 0, 0, 0].concat(bytes('IEND'), [0, 0, 0, 0]);
  return Buffer.from(signature.concat(chunk, end)).toString('base64');
}
