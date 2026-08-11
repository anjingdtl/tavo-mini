import { execute } from '../connection/execute';
import { openDatabase } from '../connection/openDatabase';
import { now } from './shared';

export async function logLLMUsage(fields: {
  scenario: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  status: string;
  errorCode?: string;
  modelName?: string;
  projectId?: number;
  // V2.2.0 (schema 10): 按配置区分用量，便于多 LLM 场景下识别来源
  llmConfigId?: number;
  llmConfigName?: string;
  // Schema 51: provider-reported prompt-cache telemetry. null when the provider
  // did not report it (never fabricated as 0). Observation-only metadata.
  promptCacheHitTokens?: number | null;
  promptCacheMissTokens?: number | null;
}): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO llm_usage_logs (scenario, input_tokens, output_tokens, total_tokens, status, error_code, model_name, project_id, llm_config_id, llm_config_name, prompt_cache_hit_tokens, prompt_cache_miss_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.scenario,
      fields.inputTokens,
      fields.outputTokens,
      fields.totalTokens,
      fields.status,
      fields.errorCode || '',
      fields.modelName || '',
      fields.projectId ?? 0,
      fields.llmConfigId ?? 0,
      fields.llmConfigName || '',
      fields.promptCacheHitTokens ?? null,
      fields.promptCacheMissTokens ?? null,
      now(),
    ],
  );
}

// ---------------------------------------------------------------------------
// LLM Usage Stats
// ---------------------------------------------------------------------------

export async function getLLMUsageStats(
  projectId: number | null,
): Promise<any[]> {
  const database = await openDatabase();
  const projectFilter = projectId ? 'WHERE project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const [result] = await database.executeSql(
    `SELECT
      DATE(created_at) as date,
      COUNT(*) as call_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(total_tokens) as total_tokens,
      GROUP_CONCAT(DISTINCT model_name) as models
    FROM llm_usage_logs ${projectFilter}
    GROUP BY DATE(created_at)
    ORDER BY date DESC
    LIMIT 30`,
    params,
  );
  const rows: any[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    rows.push(result.rows.item(i));
  }
  return rows;
}

export async function getLLMUsageSummary(
  projectId: number | null,
): Promise<any> {
  const database = await openDatabase();
  const projectFilter = projectId ? 'WHERE project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const [result] = await database.executeSql(
    `SELECT
      COUNT(*) as total_calls,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens
    FROM llm_usage_logs ${projectFilter}`,
    params,
  );
  return result.rows.length > 0
    ? result.rows.item(0)
    : {
        total_calls: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_tokens: 0,
      };
}

// V2.2.0 (schema 10): 按 LLM 配置分组返回调用量。
// 兼容旧数据（llm_config_id = 0 时回退到 model_name 作标识），
// 让 UsageStatsScreen 能在多 LLM 配置场景下识别每个配置的调用量。
export async function getLLMUsageByConfig(
  projectId: number | null,
): Promise<any[]> {
  const database = await openDatabase();
  const projectFilter = projectId ? 'WHERE project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const [result] = await database.executeSql(
    `SELECT
      llm_config_id,
      COALESCE(NULLIF(llm_config_name, ''), '未命名配置') as llm_config_name,
      COUNT(*) as call_count,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      GROUP_CONCAT(DISTINCT model_name) as models,
      MAX(created_at) as last_used_at
    FROM llm_usage_logs ${projectFilter}
    GROUP BY llm_config_id, llm_config_name
    ORDER BY call_count DESC, last_used_at DESC`,
    params,
  );
  const rows: any[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    rows.push(result.rows.item(i));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Schema 51: DeepSeek prompt-cache telemetry aggregation (read-only).
//
// These queries aggregate provider-reported prompt_cache_hit_tokens /
// prompt_cache_miss_tokens. Rows written before Schema 51 (or by providers
// that do not report cache usage) keep NULL columns and are excluded from the
// reported-call count. cache_hit_ratio is derived as hit/(hit+miss) and is
// NULL when no telemetry was reported — it is never fabricated as 0. These are
// observation/diagnostic helpers only; they never feed pipeline branching.
// ---------------------------------------------------------------------------

const CACHE_SUMMARY_SELECT = `
  SUM(CASE
        WHEN prompt_cache_hit_tokens IS NOT NULL
          OR prompt_cache_miss_tokens IS NOT NULL
        THEN 1 ELSE 0 END) as reported_call_count,
  SUM(prompt_cache_hit_tokens) as cache_hit_tokens,
  SUM(prompt_cache_miss_tokens) as cache_miss_tokens,
  COALESCE(SUM(prompt_cache_hit_tokens), 0)
    + COALESCE(SUM(prompt_cache_miss_tokens), 0) as cache_total_input_tokens,
  SUM(prompt_cache_hit_tokens) * 1.0
    / NULLIF(
        SUM(prompt_cache_hit_tokens) + SUM(prompt_cache_miss_tokens),
        0
      ) as cache_hit_ratio`;

export async function getLLMCacheUsageSummary(
  projectId: number | null,
): Promise<any> {
  const database = await openDatabase();
  const projectFilter = projectId ? 'WHERE project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const [result] = await database.executeSql(
    `SELECT ${CACHE_SUMMARY_SELECT}
     FROM llm_usage_logs ${projectFilter}`,
    params,
  );
  return result.rows.length > 0
    ? result.rows.item(0)
    : {
        reported_call_count: 0,
        cache_hit_tokens: null,
        cache_miss_tokens: null,
        cache_total_input_tokens: 0,
        cache_hit_ratio: null,
      };
}

export async function getLLMCacheUsageByScenario(
  projectId: number | null,
): Promise<any[]> {
  const database = await openDatabase();
  const projectFilter = projectId ? 'WHERE project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const [result] = await database.executeSql(
    `SELECT
       scenario,
       COUNT(*) as total_call_count,
       ${CACHE_SUMMARY_SELECT}
     FROM llm_usage_logs ${projectFilter}
     GROUP BY scenario
     ORDER BY scenario ASC`,
    params,
  );
  const rows: any[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    rows.push(result.rows.item(i));
  }
  return rows;
}

export async function getLLMCacheUsageByConfig(
  projectId: number | null,
): Promise<any[]> {
  const database = await openDatabase();
  const projectFilter = projectId ? 'WHERE project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const [result] = await database.executeSql(
    `SELECT
       llm_config_id,
       COALESCE(NULLIF(llm_config_name, ''), '未命名配置') as llm_config_name,
       COUNT(*) as total_call_count,
       ${CACHE_SUMMARY_SELECT}
     FROM llm_usage_logs ${projectFilter}
     GROUP BY llm_config_id, llm_config_name
     ORDER BY cache_total_input_tokens DESC, llm_config_name ASC`,
    params,
  );
  const rows: any[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    rows.push(result.rows.item(i));
  }
  return rows;
}
