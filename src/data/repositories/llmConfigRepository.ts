import type { LLMConfig } from '../../types/novel';
import {
  clearSecureLLMApiKey,
  getSecureLLMApiKey,
  migrateLegacyLLMApiKey,
  setSecureLLMApiKey,
} from '../../services/secureStorage';
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import { openDatabase } from '../connection/openDatabase';
import { executeTransaction } from '../connection/transaction';

function normalizeLLMConfig(row?: Partial<LLMConfig> | null): LLMConfig {
  return {
    id: Number(row?.id || 1),
    name: row?.name || '默认配置',
    provider_type: row?.provider_type || 'openai_compatible',
    base_url: row?.base_url || '',
    api_key: row?.api_key || '',
    model_name: row?.model_name || '',
    is_active: Number(row?.is_active ?? 1),
    context_window: Number(row?.context_window ?? 4096),
    max_output_tokens: Number(row?.max_output_tokens ?? 4000),
  };
}

async function hydrateLLMConfig(row: LLMConfig): Promise<LLMConfig> {
  let apiKey = await getSecureLLMApiKey(row.id);
  if (!apiKey && row.id === 1) {
    apiKey = await migrateLegacyLLMApiKey(row.id);
  }
  if (row.api_key && !apiKey) {
    apiKey = row.api_key;
    await setSecureLLMApiKey(row.api_key, row.id);
  }
  if (row.api_key) {
    await execute(
      await openDatabase(),
      'UPDATE llm_config SET api_key = ? WHERE id = ?',
      ['', row.id],
    );
  }
  return { ...row, api_key: apiKey };
}

export async function getLLMConfigs(): Promise<LLMConfig[]> {
  const rows = await all<LLMConfig>(
    'SELECT * FROM llm_config ORDER BY is_active DESC, id ASC',
  );
  if (rows.length === 0) {
    await execute(
      await openDatabase(),
      `INSERT INTO llm_config (
        name, provider_type, base_url, api_key, model_name, is_active,
        context_window, max_output_tokens
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ['默认配置', 'openai_compatible', '', '', '', 4096, 4000],
    );
    return getLLMConfigs();
  }
  return Promise.all(
    rows.map(row => hydrateLLMConfig(normalizeLLMConfig(row))),
  );
}

export async function getActiveLLMConfig(): Promise<LLMConfig> {
  let config = await one<LLMConfig>(
    'SELECT * FROM llm_config WHERE is_active = 1 ORDER BY id ASC LIMIT 1',
  );
  if (!config) {
    const candidates = await all<LLMConfig>(
      'SELECT * FROM llm_config ORDER BY id ASC',
    );
    let fallback: LLMConfig | null = null;
    fallback = candidates[0] || null;
    if (!fallback) {
      const id = await saveLLMConfig({
        name: '默认配置',
        base_url: '',
        api_key: '',
        model_name: '',
        is_active: 1,
      });
      config = await one<LLMConfig>('SELECT * FROM llm_config WHERE id = ?', [
        id,
      ]);
    } else {
      await setActiveLLMConfig(fallback.id);
      config = await one<LLMConfig>('SELECT * FROM llm_config WHERE id = ?', [
        fallback.id,
      ]);
    }
  }
  return hydrateLLMConfig(normalizeLLMConfig(config));
}

export async function saveLLMConfig(
  config: Partial<LLMConfig>,
): Promise<number> {
  const name = (config.name || '').trim() || '未命名配置';
  const providerType = config.provider_type || 'openai_compatible';
  const baseUrl = (config.base_url || '').trim();
  const modelName = (config.model_name || '').trim();
  const contextWindow = Number(config.context_window ?? 4096);
  const maxOutputTokens = Number(config.max_output_tokens ?? 4000);
  const database = await openDatabase();
  // 修复#A: UPDATE 不再写 is_active 字段，避免用过时的 draft.is_active 把刚被 setActiveLLMConfig
  // 激活的配置又写回 0。is_active 的写入权专属 setActiveLLMConfig / INSERT 初始值。
  // 仅当用户显式要求 is_active=1 时，才在 INSERT 写入并在保存后调用 setActiveLLMConfig 激活。
  const shouldActivate = Number(config.is_active ?? 0) === 1;

  let id = Number(config.id || 0);
  if (id > 0) {
    await execute(
      database,
      `UPDATE llm_config SET
        name = ?, provider_type = ?, base_url = ?, api_key = ?, model_name = ?,
        context_window = ?, max_output_tokens = ?
      WHERE id = ?`,
      [
        name,
        providerType,
        baseUrl,
        '',
        modelName,
        contextWindow,
        maxOutputTokens,
        id,
      ],
    );
  } else {
    const result = await execute(
      database,
      `INSERT INTO llm_config (
        name, provider_type, base_url, api_key, model_name, is_active,
        context_window, max_output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        providerType,
        baseUrl,
        '',
        modelName,
        shouldActivate ? 1 : 0,
        contextWindow,
        maxOutputTokens,
      ],
    );
    id = Number(result.insertId);
    // V2.2.1 修复：react-native-sqlite-storage 6.0.1 在部分机型/事务场景下
    // result.insertId 可能是 undefined 或 0，导致上层 setSelectedId(0) 触发
    // LLMSettingsScreen useEffect 的「selectedId === 0 时提前 return」分支，
    // draft 永远不更新，"设为当前"按钮一直弹"请先保存"。
    // 用 last_insert_rowid() 显式查询新行 rowid 作为后备。
    if (!Number.isFinite(id) || id <= 0) {
      const row = await one<{ id: number }>('SELECT last_insert_rowid() AS id');
      id = Number(row?.id || 0);
    }
  }

  if (config.api_key !== undefined) {
    await setSecureLLMApiKey(config.api_key, id);
  }
  if (shouldActivate) {
    await setActiveLLMConfig(id);
  }
  return id;
}

export async function setActiveLLMConfig(id: number): Promise<void> {
  const database = await openDatabase();
  // V2.2.1 修复：react-native-sqlite-storage 6.0.1 的 transaction 在 async 回调下
  // 可能只执行第一个 executeSql 就提前提交，导致第二个 UPDATE is_active=1 WHERE id=?
  // 丢失，UI 标题显示"当前：未选择"。改为两个独立 execute，确保两个 UPDATE 都执行。
  // 非原子操作，但切换激活状态不需要严格原子性（最坏情况是短暂的全 is_active=0，
  // 下次 loadSettings 的自愈逻辑会兜底）。
  await execute(database, 'UPDATE llm_config SET is_active = 0');
  await execute(database, 'UPDATE llm_config SET is_active = 1 WHERE id = ?', [
    id,
  ]);
}

export async function deleteLLMConfig(id: number): Promise<void> {
  const configs = await getLLMConfigs();
  if (configs.length <= 1) {
    throw new Error('至少需要保留一个 LLM 配置。');
  }

  const target = configs.find(config => config.id === id);
  const database = await openDatabase();
  // Read the replacement before entering the synchronous transaction scope.
  // clearSecureLLMApiKey remains outside SQLite because Android Keystore work
  // is asynchronous and must not be mixed into a transaction callback.
  const nextActive =
    target?.is_active === 1
      ? await one<{ id: number }>(
          'SELECT id FROM llm_config WHERE id <> ? ORDER BY id ASC LIMIT 1',
          [id],
        )
      : null;
  const statements: Array<{ sql: string; params?: any[] }> = [
    { sql: 'DELETE FROM llm_config WHERE id = ?', params: [id] },
  ];
  if (nextActive) {
    statements.push(
      { sql: 'UPDATE llm_config SET is_active = 0' },
      {
        sql: 'UPDATE llm_config SET is_active = 1 WHERE id = ?',
        params: [nextActive.id],
      },
    );
  }
  await executeTransaction(database, statements);
  await clearSecureLLMApiKey(id);
}

export async function getLLMConfig(): Promise<LLMConfig> {
  return getActiveLLMConfig();
}

export async function setLLMConfig(
  baseUrl: string,
  apiKey: string,
  modelName: string,
): Promise<void> {
  const active = await getActiveLLMConfig();
  await saveLLMConfig({
    ...active,
    base_url: baseUrl,
    api_key: apiKey,
    model_name: modelName,
    is_active: 1,
  });
}
