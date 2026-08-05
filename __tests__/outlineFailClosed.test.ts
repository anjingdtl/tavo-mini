/**
 * Fail-closed outline read + packing error surface tests.
 */
jest.mock('../src/data/repositories/outlineRepository', () => ({
  getEnabledOutlinesByProject: jest.fn(),
}));

import {
  buildOutlineContext,
  OutlineContextError,
} from '../src/services/outlineContextBuilder';
import { getEnabledOutlinesByProject } from '../src/data/repositories/outlineRepository';

const mockedGetEnabled = getEnabledOutlinesByProject as jest.MockedFunction<
  typeof getEnabledOutlinesByProject
>;

beforeEach(() => {
  mockedGetEnabled.mockReset();
});

describe('outline read fail-closed', () => {
  test('repository throw becomes OutlineContextError (not empty context)', async () => {
    mockedGetEnabled.mockRejectedValue(new Error('sqlite locked'));
    await expect(
      buildOutlineContext({
        projectId: 1,
        projectMode: 'outline',
        outlineBudgetTokens: 10000,
      }),
    ).rejects.toBeInstanceOf(OutlineContextError);

    try {
      await buildOutlineContext({
        projectId: 1,
        projectMode: 'outline',
        outlineBudgetTokens: 10000,
      });
    } catch (error: any) {
      expect(error.code).toBe('OUTLINE_READ_FAILED');
      expect(error.message).toContain('读取项目大纲失败');
    }
  });

  test('non-outline mode still returns empty legally', async () => {
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'continuation',
      outlineBudgetTokens: 10000,
    });
    expect(result.text).toBe('');
    expect(result.complete).toBe(true);
    expect(mockedGetEnabled).not.toHaveBeenCalled();
  });

  test('outline mode with no enabled outlines returns empty legally', async () => {
    mockedGetEnabled.mockResolvedValue([]);
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'outline',
      outlineBudgetTokens: 10000,
    });
    expect(result.text).toBe('');
    expect(result.complete).toBe(true);
  });
});
