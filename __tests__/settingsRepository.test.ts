const mockSetSetting = jest.fn();

jest.mock('../src/data/connection/query', () => ({
  one: jest.fn(),
}));
jest.mock('../src/data/connection/execute', () => ({
  execute: jest.fn(),
}));
jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn(),
}));

describe('story memory context settings compatibility', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('derives two-layer budgets from the legacy summary key', async () => {
    const repository = require('../src/data/repositories/settingsRepository');
    // getContextConfig closes over its local binding, so mock the query layer by key.
    const query = require('../src/data/connection/query');
    query.one.mockImplementation(async (_sql: string, params: string[]) =>
      params[0] === 'summary_budget_tokens' ? { value: '20000' } : null,
    );
    const config = await repository.getContextConfig();
    expect(config.storyStateBudgetTokens).toBe(12000);
    expect(config.episodicMemoryBudgetTokens).toBe(8000);
    expect(config.memoryPatchMaxTokens).toBe(1200);
  });

  it('writes new keys and the combined legacy compatibility key', async () => {
    const repository = require('../src/data/repositories/settingsRepository');
    const execute = require('../src/data/connection/execute').execute;
    const openDatabase = require('../src/data/connection/openDatabase').openDatabase;
    openDatabase.mockResolvedValue({});
    execute.mockImplementation(async (_db: unknown, _sql: string, params: string[]) => {
      mockSetSetting(params[0], params[1]);
    });
    await repository.setContextConfig({
      strategy: 'sliding', slidingWindowSize: 1000, customRangeStart: 0,
      customRangeEnd: -1, resourceBudget: 500, includeResources: true,
      storyStateBudgetTokens: 32000, episodicMemoryBudgetTokens: 16000,
      memoryPatchMaxTokens: 3200,
    });
    expect(mockSetSetting).toHaveBeenCalledWith('story_state_budget_tokens', '32000');
    expect(mockSetSetting).toHaveBeenCalledWith('episodic_memory_budget_tokens', '16000');
    expect(mockSetSetting).toHaveBeenCalledWith('memory_patch_max_tokens', '3200');
    expect(mockSetSetting).toHaveBeenCalledWith('summary_budget_tokens', '48000');
  });

  it('defaults the rollback feature flag on and persists an explicit disable', async () => {
    const repository = require('../src/data/repositories/settingsRepository');
    const query = require('../src/data/connection/query');
    const execute = require('../src/data/connection/execute').execute;
    const openDatabase = require('../src/data/connection/openDatabase').openDatabase;
    query.one.mockResolvedValue(null);
    await expect(repository.getStructuredStoryMemoryEnabled()).resolves.toBe(true);
    openDatabase.mockResolvedValue({});
    execute.mockResolvedValue(undefined);
    await repository.setStructuredStoryMemoryEnabled(false);
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.stringContaining('INSERT OR REPLACE INTO settings'),
      ['structured_story_memory_enabled', 'false'],
    );
  });
});
