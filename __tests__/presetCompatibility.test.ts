jest.mock('../src/services/database', () => ({
  getAllPresets: jest.fn(async () => [
    {
      id: 7,
      name: '旧版作家预设',
      system_prompt: '保持叙事视角稳定。',
      writing_style: '克制、具体。',
      extra_instructions: '不要跳过关键因果。',
      temperature: 0.72,
      top_p: 0.91,
      max_tokens: 2400,
    },
  ]),
}));

import RNFS from 'react-native-fs';
import { saveDocuments } from '@react-native-documents/picker';
import { exportPresetJSON } from '../src/services/exportService';

test('exports the legacy shinewriter-preset-v1 envelope without losing fields', async () => {
  (RNFS.writeFile as jest.Mock).mockResolvedValue(undefined);
  (saveDocuments as jest.Mock).mockResolvedValue([{ uri: 'content://preset-export' }]);

  await expect(exportPresetJSON(7)).resolves.toBe('content://preset-export');

  const [, serialized] = (RNFS.writeFile as jest.Mock).mock.calls.at(-1);
  expect(JSON.parse(serialized)).toEqual({
    spec: 'shinewriter-preset-v1',
    name: '旧版作家预设',
    system_prompt: '保持叙事视角稳定。',
    writing_style: '克制、具体。',
    extra_instructions: '不要跳过关键因果。',
    temperature: 0.72,
    top_p: 0.91,
    max_tokens: 2400,
  });
});
