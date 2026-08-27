/* eslint-env jest */

type Row = Record<string, any>;

const mockStore: {
  runs: Row[];
  artifacts: Row[];
  checks: Row[];
  stageResults: Row[];
} = {
  runs: [],
  artifacts: [],
  checks: [],
  stageResults: [],
};

function mockResult(rows: Row[] = [], rowsAffected = rows.length ? 1 : 0) {
  return [
    {
      rows: {
        length: rows.length,
        item: (index: number) => rows[index],
      },
      rowsAffected,
    },
  ];
}

function mockCloneStore() {
  return JSON.parse(JSON.stringify(mockStore)) as typeof mockStore;
}

const mockExecuteSql = jest.fn(async (sql: string, params: any[] = []) => {
  const normalized = sql.replace(/\s+/g, ' ').trim();

  const payloadRead = normalized.match(
    /SELECT (length|substr)\((content|output_json)\).* FROM (continuation_generation_artifacts|continuation_generation_stage_results)/i,
  );
  if (payloadRead) {
    const table = payloadRead[3].toLowerCase();
    const column = payloadRead[2].toLowerCase();
    const id = params[params.length - 1];
    const row = table === 'continuation_generation_artifacts'
      ? mockStore.artifacts.find(item => item.id === id)
      : mockStore.stageResults.find(item => item.id === id);
    const value = row?.[column] == null ? null : String(row[column]);
    if (payloadRead[1].toLowerCase() === 'length') {
      return mockResult(value == null ? [] : [{ payload_length: value.length }]);
    }
    const offset = Number(params[0] || 1) - 1;
    const size = Number(params[1] || 0);
    return mockResult(
      value == null ? [] : [{ payload_chunk: value.slice(offset, offset + size) }],
    );
  }

  if (/FROM continuation_generation_stage_results/i.test(normalized)) {
    const rows = mockStore.stageResults.filter(row => {
      if (/WHERE run_id = \? AND stage = \?/i.test(normalized)) {
        return row.run_id === params[0] && row.stage === params[1];
      }
      return row.run_id === params[0];
    });
    return mockResult(rows);
  }

  if (/INSERT INTO continuation_generation_stage_results/i.test(normalized)) {
    mockStore.stageResults.push({
      id: params[0],
      run_id: params[1],
      stage: params[2],
      status: 'running',
      request_reserved: 1,
      request_count: 1,
      model_config_id: params[3],
      input_tokens: params[4],
      min_output_tokens: params[5],
      max_output_tokens: params[6],
      output_json: null,
      artifact_id: null,
      error_code: null,
      error_message: null,
      started_at: params[7],
      completed_at: null,
      created_at: params[8],
      updated_at: params[9],
    });
    return mockResult([], 1);
  }

  if (/UPDATE continuation_generation_stage_results SET/i.test(normalized)) {
    const id = params[params.length - 2];
    const runId = params[params.length - 1];
    const row = mockStore.stageResults.find(
      item => item.id === id && item.run_id === runId,
    );
    if (!row) return mockResult([], 0);
    if (/status = 'success'/i.test(normalized)) {
      row.status = 'success';
      row.output_json = params[0];
      row.artifact_id = params[1];
      row.completed_at = params[2];
      row.updated_at = params[3];
    } else if (/stage = 'local_verify'/i.test(normalized)) {
      row.status = params[0];
      row.output_json = params[1];
      row.artifact_id = params[2];
      row.completed_at = params[3];
      row.updated_at = params[4];
    } else {
      row.status = params[0];
      row.output_json = params[1];
      row.artifact_id = params[2];
      row.output_tokens = params[3];
      row.error_code = params[4];
      row.error_message = params[5];
      row.completed_at = params[6];
      row.updated_at = params[7];
    }
    return mockResult([], 1);
  }

  if (/FROM continuation_generation_artifacts/i.test(normalized)) {
    if (/WHERE id = \?/i.test(normalized)) {
      return mockResult(mockStore.artifacts.filter(row => row.id === params[0]));
    }
    const rows = mockStore.artifacts
      .filter(
        row =>
          row.run_id === params[0] && row.eligibility_status === 'eligible',
      )
      .sort((left, right) =>
        String(right.created_at).localeCompare(String(left.created_at)),
      )
      .slice(0, 1);
    return mockResult(rows);
  }

  if (/INSERT INTO continuation_generation_artifacts/i.test(normalized)) {
    const row = {
      id: params[0],
      run_id: params[1],
      stage: 'repair',
      repair_round: params[2],
      parent_artifact_id: params[3],
      content: params[4],
      content_hash: params[5],
      eligibility_status: params[6],
      rejection_code: params[7],
      created_at: params[8],
    };
    mockStore.artifacts.push(row);
    return mockResult([], 1);
  }

  if (/INSERT INTO continuation_check_results/i.test(normalized)) {
    const runId = params[0];
    const run = mockStore.runs.find(row => row.id === runId);
    mockStore.checks.push({
      id: mockStore.checks.length + 1,
      run_id: runId,
      chapter_id: run?.chapter_id ?? 0,
      artifact_id: params[1],
      artifact_hash: params[2],
      category: params[3],
      subtype: params[4],
      severity: params[5],
      confidence: params[6],
      resolution_status: 'open',
      created_at: params[16],
      updated_at: params[17],
    });
    return mockResult([], 1);
  }

  if (/UPDATE continuation_check_results SET resolution_status = 'obsolete'/i.test(normalized)) {
    for (const row of mockStore.checks) {
      if (
        row.run_id === params[1] &&
        row.artifact_id === params[2] &&
        row.resolution_status === 'open'
      ) {
        row.resolution_status = 'obsolete';
        row.updated_at = params[0];
      }
    }
    return mockResult([], 1);
  }

  if (/UPDATE continuation_generation_runs SET/i.test(normalized)) {
    const runId = params[2];
    const run = mockStore.runs.find(row => row.id === runId);
    if (!run || !['running'].includes(run.state)) return mockResult([], 0);
    run.state = 'awaiting_user';
    run.stage = 'awaiting_user';
    run.token_usage_json = params[0];
    run.updated_at = params[1];
    return mockResult([], 1);
  }

  return mockResult();
});

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn(async () => ({ executeSql: mockExecuteSql })),
}));

jest.mock('../src/services/database/transaction', () => ({
  executeTransaction: jest.fn(async (_db: unknown, statements: any[], options: any = {}) => {
    const snapshot = mockCloneStore();
    try {
      for (let index = 0; index < statements.length; index += 1) {
        const [result] = await mockExecuteSql(
          statements[index].sql,
          statements[index].params || [],
        );
        options.onStatementComplete?.(index + 1, result.rowsAffected ?? 0);
      }
    } catch (error) {
      mockStore.runs = snapshot.runs;
      mockStore.artifacts = snapshot.artifacts;
      mockStore.checks = snapshot.checks;
      mockStore.stageResults = snapshot.stageResults;
      throw error;
    }
  }),
}));

import {
  finalizeContinuationV4Repair,
  getLatestEligibleArtifact,
  reserveContinuationStage,
} from '../src/services/continuation/generation/generationRepository';

function seedRun(state: string = 'running') {
  mockStore.runs = [
    {
      id: 'ct_v4_repository',
      chapter_id: 8,
      state,
      stage: 'repair',
      token_usage_json: '{}',
    },
  ];
  mockStore.artifacts = [
    {
      id: 'writer_artifact',
      run_id: 'ct_v4_repository',
      stage: 'writer',
      repair_round: 0,
      parent_artifact_id: null,
      content: 'Writer 初稿',
      content_hash: 'writer-hash',
      eligibility_status: 'eligible',
      rejection_code: null,
      created_at: '2026-08-03T00:00:00.000Z',
    },
  ];
  mockStore.checks = [
    {
      id: 1,
      run_id: 'ct_v4_repository',
      artifact_id: 'writer_artifact',
      resolution_status: 'open',
    },
  ];
  mockStore.stageResults = [
    {
      id: 'repair_result',
      run_id: 'ct_v4_repository',
      stage: 'repair',
      status: 'running',
      request_reserved: 1,
      request_count: 1,
    },
    {
      id: 'local_verify_result',
      run_id: 'ct_v4_repository',
      stage: 'local_verify',
      status: 'queued',
      request_reserved: 0,
      request_count: 0,
    },
  ];
}

describe('continuation V4 generation persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedRun();
  });

  it('reserves one physical request and never reserves the same stage twice', async () => {
    const first = await reserveContinuationStage({
      runId: 'ct_v4_repository',
      stage: 'checker',
      modelConfigId: 3,
      inputTokens: 1200,
      minOutputTokens: 80,
      maxOutputTokens: 180,
    });
    const second = await reserveContinuationStage({
      runId: 'ct_v4_repository',
      stage: 'checker',
      modelConfigId: 99,
      inputTokens: 9999,
      minOutputTokens: 1,
      maxOutputTokens: 2,
    });

    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(false);
    expect(second.result.requestCount).toBe(1);
    expect(mockStore.stageResults.filter(row => row.stage === 'checker')).toHaveLength(1);
  });

  it('atomically persists Repair, local checks, stage results and awaiting_user', async () => {
    const result = await finalizeContinuationV4Repair({
      runId: 'ct_v4_repository',
      repairStageResultId: 'repair_result',
      localVerifyStageResultId: 'local_verify_result',
      parentArtifactId: 'writer_artifact',
      content: '完整 Repair 终稿',
      eligibilityStatus: 'eligible',
      writerArtifactId: 'writer_artifact',
      markWriterChecksObsolete: true,
      tokenUsageJson: '{"workflowVersion":4,"requestCount":4}',
      repairOutputJson: '{"kind":"full_final"}',
      localVerifyOutputJson: '{"hanCount":8,"passed":true}',
      localChecks: [
        {
          category: 'style',
          subtype: 'local_gate',
          severity: 'info',
          confidence: 1,
          generatedStart: null,
          generatedEnd: null,
          generatedExcerpt: '',
          description: '本地门禁通过',
        },
      ],
    });

    expect(result.artifact.eligibilityStatus).toBe('eligible');
    expect(result.repairStageResult.status).toBe('success');
    expect(result.localVerifyStageResult.status).toBe('success');
    expect(mockStore.runs[0].state).toBe('awaiting_user');
    expect(mockStore.checks[0].resolution_status).toBe('obsolete');
    expect(mockStore.checks[1].artifact_id).toBe(result.artifact.id);
  });

  it('rolls back a rejected CAS finalize instead of leaving a partial artifact', async () => {
    seedRun('awaiting_user');
    const before = mockCloneStore();

    await expect(
      finalizeContinuationV4Repair({
        runId: 'ct_v4_repository',
        repairStageResultId: 'repair_result',
        localVerifyStageResultId: 'local_verify_result',
        parentArtifactId: 'writer_artifact',
        content: '不会提交的终稿',
        eligibilityStatus: 'rejected',
        rejectionCode: 'duplicate_blocked',
        writerArtifactId: 'writer_artifact',
        markWriterChecksObsolete: false,
        tokenUsageJson: '{}',
      }),
    ).rejects.toThrow('事务回滚');

    expect(mockStore).toEqual(before);
  });

  it('keeps rejected Repair outside the latest eligible query', async () => {
    mockStore.artifacts.push({
      id: 'rejected_repair',
      run_id: 'ct_v4_repository',
      stage: 'repair',
      content: '拒绝终稿',
      content_hash: 'rejected-hash',
      eligibility_status: 'rejected',
      rejection_code: 'length_out_of_range',
      created_at: '2026-08-03T00:01:00.000Z',
    });

    const latest = await getLatestEligibleArtifact('ct_v4_repository');

    // The SQL contract, rather than created_at, decides this result. The mock
    // deliberately models the same filter to make the adoption invariant
    // explicit in the test.
    expect(latest?.id).toBe('writer_artifact');
  });
});
