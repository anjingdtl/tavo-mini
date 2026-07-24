import RNFS from 'react-native-fs';
import { saveDocuments } from '@react-native-documents/picker';
import {
  buildConstructionFileName,
  saveConstructionArtifact,
  serializeArtifact,
} from '../src/services/constructionFileService';
import type {
  CharacterArtifact,
  WorldbookArtifact,
} from '../src/services/construction/targets';

const characterArtifact: CharacterArtifact = {
  kind: 'character',
  name: '沈砚',
  card: {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: '沈砚',
      description: '机关师',
      personality: '克制',
      scenario: '',
      first_mes: '',
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      tags: ['反派'],
      alternate_greetings: [],
      creator: 'ShineWriter 构建',
      character_version: '1.0',
    },
  },
};

const worldbookArtifact: WorldbookArtifact = {
  kind: 'worldbook',
  name: '雾港纪事',
  entryCount: 2,
  lorebook: {
    spec: 'lorebook_v3',
    spec_version: '1.0',
    data: {
      name: '雾港纪事',
      entries: [
        {
          keys: ['雾港'],
          secondary_keys: [],
          content: '海雾港口。',
          comment: '地点',
          enabled: true,
          constant: false,
          insertion_order: 0,
        },
        {
          keys: ['机关行会'],
          secondary_keys: [],
          content: '机关术行会。',
          comment: '组织',
          enabled: true,
          constant: false,
          insertion_order: 1,
        },
      ],
    },
  },
};

describe('constructionFileService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('serializeArtifact', () => {
    it('serializes a character card with the v3 envelope', () => {
      const json = serializeArtifact(characterArtifact);
      const parsed = JSON.parse(json);
      expect(parsed.spec).toBe('chara_card_v3');
      expect(parsed.data.name).toBe('沈砚');
    });
    it('serializes a worldbook collection with the lorebook envelope', () => {
      const json = serializeArtifact(worldbookArtifact);
      const parsed = JSON.parse(json);
      expect(parsed.spec).toBe('lorebook_v3');
      expect(parsed.data.entries).toHaveLength(2);
    });
  });

  describe('buildConstructionFileName', () => {
    it('uses the localized suffix per artifact kind', () => {
      expect(buildConstructionFileName(characterArtifact)).toBe('沈砚-角色卡.json');
      expect(buildConstructionFileName(worldbookArtifact)).toBe(
        '雾港纪事-世界书.json',
      );
    });
    it('sanitizes file-system unsafe characters', () => {
      const risky: CharacterArtifact = {
        ...characterArtifact,
        name: 'a/b:c?d',
        card: { ...characterArtifact.card, data: { ...characterArtifact.card.data, name: 'a/b:c?d' } },
      };
      expect(buildConstructionFileName(risky)).toBe('a_b_c_d-角色卡.json');
    });
  });

  describe('saveConstructionArtifact', () => {
    it('returns the saved uri on success and writes the cache file', async () => {
      (saveDocuments as jest.Mock).mockResolvedValue([
        { uri: 'content://saved/1.json', name: '沈砚-角色卡.json', error: null },
      ]);
      const result = await saveConstructionArtifact(characterArtifact);
      expect(result).toEqual({
        saved: true,
        uri: 'content://saved/1.json',
        fileName: '沈砚-角色卡.json',
      });
      expect(RNFS.writeFile).toHaveBeenCalled();
      const cachePath = (RNFS.writeFile as jest.Mock).mock.calls[0][0];
      expect(cachePath).toContain('沈砚-角色卡.json');
    });

    it('returns cancelled (not success) when the user dismisses the save window', async () => {
      const cancelError = Object.assign(new Error('canceled'), {
        code: 'OPERATION_CANCELED',
      });
      (saveDocuments as jest.Mock).mockRejectedValue(cancelError);
      const result = await saveConstructionArtifact(worldbookArtifact);
      expect(result).toEqual({ saved: false, reason: 'cancelled' });
    });

    it('throws on real write errors instead of silently cancelling', async () => {
      (saveDocuments as jest.Mock).mockRejectedValue(new Error('disk full'));
      await expect(
        saveConstructionArtifact(characterArtifact),
      ).rejects.toThrow('disk full');
    });

    it('throws when the picker reports an error field', async () => {
      (saveDocuments as jest.Mock).mockResolvedValue([
        { uri: '', name: null, error: '无法写入该目录' },
      ]);
      await expect(
        saveConstructionArtifact(characterArtifact),
      ).rejects.toThrow('无法写入该目录');
    });
  });
});
