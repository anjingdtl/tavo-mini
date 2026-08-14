import RNFS from 'react-native-fs';

jest.mock('../src/services/database', () => ({
  getAllPresets: jest.fn(async () => [{ name: '限知悬疑' }]),
  createPreset: jest.fn(async () => 88),
  updatePreset: jest.fn(async () => undefined),
}));

jest.mock('../src/services/fileImport', () => ({
  importCharacterFromJSON: jest.fn(),
  importWorldBookFromJSON: jest.fn(),
  pickSourceFile: jest.fn(),
}));

import * as db from '../src/services/database';
import {
  avoidPresetNameCollision,
  buildConstructionFileName,
  importPresetFromJSON,
  parsePresetArtifactJSON,
  serializeArtifact,
} from '../src/services/constructionFileService';

const artifact = {
  kind: 'preset' as const,
  name: '限知悬疑',
  preset: {
    spec: 'shinewriter-preset-v1' as const,
    name: '限知悬疑',
    system_prompt: '作者身份。',
    writing_style: '叙述视角与对白。',
    extra_instructions: '禁止流水账。',
    temperature: 0.8,
    top_p: 0.9,
    max_tokens: 4000,
  },
};

describe('preset construction file service', () => {
  beforeEach(() => jest.clearAllMocks());

  it('serializes and reads the existing v1 envelope', () => {
    const json = serializeArtifact(artifact);
    expect(JSON.parse(json)).toMatchObject({ spec: 'shinewriter-preset-v1' });
    expect(parsePresetArtifactJSON(json).preset).toEqual(artifact.preset);
    expect(buildConstructionFileName(artifact)).toBe('限知悬疑-作家风格.json');
  });

  it('avoids same-name overwrite', () => {
    expect(avoidPresetNameCollision('限知悬疑', ['限知悬疑'])).toBe('限知悬疑 (2)');
    expect(
      avoidPresetNameCollision('限知悬疑', ['限知悬疑', '限知悬疑 (2)']),
    ).toBe('限知悬疑 (3)');
  });

  it('imports a round-tripped file into my presets with metadata preserved', async () => {
    const result = await importPresetFromJSON(7, serializeArtifact(artifact));
    expect(result).toEqual({ kind: 'preset', id: 88, name: '限知悬疑 (2)' });
    expect(db.createPreset).toHaveBeenCalledWith(7, '限知悬疑 (2)');
    expect(db.updatePreset).toHaveBeenCalledWith(
      88,
      expect.objectContaining({
        is_default: 0,
        temperature: 0.8,
        top_p: 0.9,
        max_tokens: 4000,
      }),
    );
  });

  it('does not need a native cache path to parse the round-trip payload', () => {
    expect(RNFS.readFile).not.toHaveBeenCalled();
  });
});
