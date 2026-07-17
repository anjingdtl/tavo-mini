/* eslint-env jest */

// 在 import 之前 mock settingsRepository
jest.mock('../src/data/repositories/settingsRepository', () => ({
  __esModule: true,
  getSetting: jest.fn(),
  setSetting: jest.fn(),
}));

import {
  getContextAutoInput,
  setContextAutoInput,
  getContextAutoLastApplied,
  setContextAutoLastApplied,
  buildAppliedRecord,
} from '../src/data/repositories/contextAutoRepository';
import {
  getSetting,
  setSetting,
} from '../src/data/repositories/settingsRepository';

const mockedGetSetting = getSetting as jest.Mock;
const mockedSetSetting = setSetting as jest.Mock;

describe('contextAutoRepository', () => {
  beforeEach(() => {
    mockedGetSetting.mockReset();
    mockedSetSetting.mockReset();
  });

  describe('getContextAutoInput', () => {
    test('未配置时返回 null', async () => {
      mockedGetSetting.mockResolvedValue(null);
      expect(await getContextAutoInput()).toBeNull();
    });

    test('空字符串返回 null', async () => {
      mockedGetSetting.mockResolvedValue('');
      expect(await getContextAutoInput()).toBeNull();
    });

    test('合法数值返回 number', async () => {
      mockedGetSetting.mockResolvedValue('200000');
      expect(await getContextAutoInput()).toBe(200000);
    });

    test('非法值（0/负数/NaN）返回 null', async () => {
      mockedGetSetting.mockResolvedValue('0');
      expect(await getContextAutoInput()).toBeNull();
      mockedGetSetting.mockResolvedValue('-1');
      expect(await getContextAutoInput()).toBeNull();
      mockedGetSetting.mockResolvedValue('not-a-number');
      expect(await getContextAutoInput()).toBeNull();
    });
  });

  describe('setContextAutoInput', () => {
    test('合法值写入字符串', async () => {
      await setContextAutoInput(200000);
      expect(mockedSetSetting).toHaveBeenCalledWith(
        'context_auto_input',
        '200000',
      );
    });

    test('小数会被取整', async () => {
      await setContextAutoInput(200000.7);
      expect(mockedSetSetting).toHaveBeenCalledWith(
        'context_auto_input',
        '200001',
      );
    });

    test('非正数抛错', async () => {
      await expect(setContextAutoInput(0)).rejects.toThrow(/正数/);
      await expect(setContextAutoInput(-1)).rejects.toThrow(/正数/);
      await expect(setContextAutoInput(NaN)).rejects.toThrow(/正数/);
    });
  });

  describe('getContextAutoLastApplied', () => {
    test('未配置返回 null', async () => {
      mockedGetSetting.mockResolvedValue(null);
      expect(await getContextAutoLastApplied()).toBeNull();
    });

    test('合法 JSON 返回 record', async () => {
      const record = {
        maxContextTokens: 200000,
        appliedAt: 1234567890,
        allocation: { slidingWindowSize: 104000 } as any,
        affectedCounts: {
          llmConfigs: 1,
          presets: 2,
          characters: 3,
          notes: 4,
          worldbookEntries: 5,
          worldbookCollections: 6,
        },
      };
      mockedGetSetting.mockResolvedValue(JSON.stringify(record));
      const result = await getContextAutoLastApplied();
      expect(result).toEqual(record);
    });

    test('非法 JSON 返回 null', async () => {
      mockedGetSetting.mockResolvedValue('{not valid json');
      expect(await getContextAutoLastApplied()).toBeNull();
    });
  });

  describe('setContextAutoLastApplied', () => {
    test('写入 JSON 字符串', async () => {
      const record = buildAppliedRecord(
        200000,
        { slidingWindowSize: 104000 } as any,
        {
          llmConfigs: 1,
          presets: 2,
          characters: 3,
          notes: 4,
          worldbookEntries: 5,
          worldbookCollections: 6,
        },
      );
      await setContextAutoLastApplied(record);
      expect(mockedSetSetting).toHaveBeenCalled();
      const [key, value] = mockedSetSetting.mock.calls[0];
      expect(key).toBe('context_auto_last_applied');
      const parsed = JSON.parse(value);
      expect(parsed.maxContextTokens).toBe(200000);
      expect(parsed.appliedAt).toBeGreaterThan(0);
      expect(parsed.affectedCounts.characters).toBe(3);
    });
  });

  describe('buildAppliedRecord', () => {
    test('生成完整记录', () => {
      const record = buildAppliedRecord(
        100000,
        { slidingWindowSize: 52000 } as any,
        {
          llmConfigs: 2,
          presets: 3,
          characters: 4,
          notes: 5,
          worldbookEntries: 6,
          worldbookCollections: 7,
        },
      );
      expect(record.maxContextTokens).toBe(100000);
      expect(record.appliedAt).toBeGreaterThan(0);
      expect(record.allocation.slidingWindowSize).toBe(52000);
      expect(record.affectedCounts).toEqual({
        llmConfigs: 2,
        presets: 3,
        characters: 4,
        notes: 5,
        worldbookEntries: 6,
        worldbookCollections: 7,
      });
    });
  });
});
