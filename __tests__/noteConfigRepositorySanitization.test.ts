const mockExecute = jest.fn();
const mockOpenDatabase = jest.fn(async () => ({ name: 'note-config-test' }));

jest.mock('../src/data/connection/execute', () => ({
  execute: (...args: any[]) => (mockExecute as any)(...args),
}));
jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: (...args: any[]) => (mockOpenDatabase as any)(...args),
}));

import { getProjectNoteConfig } from '../src/data/repositories/noteConfigRepository';

function rows(items: Array<Record<string, unknown>>) {
  return {
    length: items.length,
    item: (index: number) => items[index],
  };
}

describe('project note config normalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes malformed persisted values before they reach retrieval and style context', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: rows([
        {
          project_id: 7,
          mode: 'unexpected',
          style_weights: '[]',
          retrieval_top_k: 'not-a-number',
          retrieval_fragment_chars: '-1',
          enabled_note_ids: '[1,"2",0,-1,"bad",2]',
          updated_at: '2026-07-23T00:00:00.000Z',
        },
      ]),
    });

    await expect(getProjectNoteConfig(7)).resolves.toEqual({
      projectId: 7,
      mode: 'none',
      styleWeights: {},
      retrievalTopK: 5,
      retrievalFragmentChars: 1000,
      enabledNoteIds: [1, 2],
      updatedAt: '2026-07-23T00:00:00.000Z',
    });
  });
});
