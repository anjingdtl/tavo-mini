import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import {
  executeSharedWriterStage,
  parseSharedWriterOutput,
} from '../src/services/writing/stages/writerCore';
import { isAdoptableStructuredReport } from '../src/services/writing/stages/writerRecovery';

function stageInput(outputContract: 'prose' | 'json_envelope' = 'prose') {
  const requirements = { items: [], fingerprint: 'requirements-fingerprint' };
  const frozenContext = {
    projectId: 1,
    writingRunId: 'writing-run-1',
    instruction: {
      title: '测试章',
      synopsis: '测试梗概',
      userInstruction: '完成测试',
      currentContent: '',
      targetPosition: 1,
    },
    rendered: { text: '' },
    requirements,
    stagePolicy: {
      version: 1,
      reviewMode: 'full',
      strictness: 'fail-closed',
      semanticApplyRequired: true,
      stageOrder: [],
      outputContract,
      skipRules: {},
      values: {},
      requirementsFingerprint: requirements.fingerprint,
    },
    model: {
      configId: null,
      provider: 'openai_compatible',
      modelName: 'fixture',
      contextWindow: 8192,
      maxOutputTokens: 1024,
    },
    freezeFingerprint: 'freeze-fingerprint',
  } as any;

  return {
    frozenContext,
    artifacts: {},
    requirements,
    stagePolicy: frozenContext.stagePolicy,
    modelConfig: {
      configId: null,
      name: 'fixture',
      providerType: 'openai_compatible',
      url: '',
      modelName: 'fixture',
      contextWindow: 8192,
      maxOutputTokens: 1024,
    },
    trace: {
      freezeFingerprint: 'freeze-fingerprint',
      requirementsFingerprint: requirements.fingerprint,
    },
  } as any;
}

describe('Shared Writer report contract', () => {
  it('forces report stages to JSON even for the outline prose policy', () => {
    const result = compileSharedWritingPrompt({
      stage: 'review',
      ...stageInput('prose'),
    });

    expect(result.outputContract).toBe('json_envelope');
    expect(result.responseFormat).toBe('json_object');
    expect(result.messages[1].content).toContain('verdict');
    expect(result.messages[1].content).toContain('findings');
    expect(result.messages[1].content).toContain('没有问题时必须输出 []');
  });

  it('keeps prose stages on the prose contract', () => {
    const result = compileSharedWritingPrompt({
      stage: 'draft',
      ...stageInput('prose'),
    });

    expect(result.outputContract).toBe('prose');
    expect(result.responseFormat).toBe('text');
    expect(result.messages[1].content).toContain('不要输出标题、分析、JSON');
  });

  it('accepts an explicit empty findings report and rejects content-only JSON', async () => {
    const invalid = stageInput('prose');
    invalid.callStage = async () => ({
      text: JSON.stringify({ schemaVersion: 1, content: '报告摘要' }),
    });
    await expect(
      executeSharedWriterStage({ stage: 'review', stageInput: invalid }),
    ).rejects.toMatchObject({
      code: 'SHARED_WRITER_INVALID_REPORT',
      writerDiagnostics: expect.objectContaining({
        parseFailureCode: 'SHARED_WRITER_INVALID_REPORT',
        responseChannel: 'content',
        responseCandidateChannel: 'content',
        validationDetailsJson: expect.stringContaining('candidateRootKeys'),
      }),
    });

    const valid = stageInput('prose');
    valid.callStage = async () => ({
      text: JSON.stringify({
        schemaVersion: 1,
        content: '未发现需要修改的问题',
        verdict: 'pass',
        findings: [],
      }),
    });
    const artifact = await executeSharedWriterStage({
      stage: 'review',
      stageInput: valid,
    });
    expect(artifact.structured).toEqual(
      expect.objectContaining({ verdict: 'pass', findings: [] }),
    );
    expect(parseSharedWriterOutput('review', JSON.stringify(artifact.structured)))
      .toEqual(expect.objectContaining({ body: '未发现需要修改的问题' }));
  });
});

describe('Shared Writer revision brief contract', () => {
  it('adopts a full revision brief with strategy/actions/preserve/ending', () => {
    expect(
      isAdoptableStructuredReport('revision', {
        strategy: '受控修订',
        actions: [{ covers: 'x', instruction: 'y' }],
        preserve: ['人物设定'],
        ending: '保持原结尾',
      }),
    ).toBe(true);
  });

  it('adopts a no-op brief (empty actions, no content)', () => {
    expect(
      isAdoptableStructuredReport('revision', {
        strategy: '无需改写',
        actions: [],
        preserve: ['人物设定'],
        ending: '保持原结尾',
      }),
    ).toBe(true);
  });

  it('accepts a legacy report-only Brief and keeps the Draft as the body', async () => {
    const input = stageInput('prose');
    input.artifacts = {
      draft: { stage: 'draft', body: '沿用的初稿正文' },
    } as any;
    input.callStage = async () => ({
      text: JSON.stringify({ report: '建议保持人物动机与结尾落点' }),
    });

    const artifact = await executeSharedWriterStage({
      stage: 'revision',
      stageInput: input,
    });

    expect(artifact.body).toBe('沿用的初稿正文');
    expect(artifact.structured).toEqual(
      expect.objectContaining({ report: '建议保持人物动机与结尾落点' }),
    );
  });

  it('adopts a brief whose only populated fields are preserve/ending', () => {
    expect(
      isAdoptableStructuredReport('revision', {
        preserve: ['人物设定', '因果'],
        ending: '保持原结尾',
      }),
    ).toBe(true);
  });

  it('rejects a bare prose object with no brief signal', () => {
    expect(isAdoptableStructuredReport('revision', { schemaVersion: 1 })).toBe(
      false,
    );
  });

  it('normalizes compatible revision envelopes and body aliases at the writer boundary', () => {
    const artifact = parseSharedWriterOutput(
      'revision',
      '网关包装后的结果：{"data":{"mode":"full_revision","revisedBody":"修订后的正文"}}',
    );

    expect(artifact.body).toBe('修订后的正文');
    expect(artifact.structured).toEqual(
      expect.objectContaining({
        strategy: 'full_revision',
        content: '修订后的正文',
      }),
    );
    expect(isAdoptableStructuredReport('revision', artifact.structured)).toBe(
      true,
    );
  });

  it('adopts a double-encoded or single-item-array revision without a second call', async () => {
    const input = stageInput('prose');
    input.artifacts = {
      draft: { stage: 'draft', body: '初稿正文' },
    } as any;
    input.callStage = async () => ({
      text: JSON.stringify([
        {
          strategy: 'full_revision',
          revisedBody: '网关变体正文',
        },
      ]),
    });

    const artifact = await executeSharedWriterStage({
      stage: 'revision',
      stageInput: input,
    });

    expect(artifact.body).toBe('网关变体正文');
    expect(artifact.structured).toEqual(
      expect.objectContaining({
        strategy: 'full_revision',
        content: '网关变体正文',
      }),
    );
  });

  it('end-to-end revision stage accepts a brief without content', async () => {
    const input = stageInput('prose');
    input.artifacts = {
      draft: { stage: 'draft', body: '初稿正文' },
    } as any;
    input.callStage = async () => ({
      text: JSON.stringify({
        schemaVersion: 1,
        strategy: '局部修订',
        actions: [],
        preserve: ['保留节奏'],
        ending: '维持原结尾',
      }),
    });

    const artifact = await executeSharedWriterStage({
      stage: 'revision',
      stageInput: input,
    });

    expect(artifact.structured).toEqual(
      expect.objectContaining({ preserve: ['保留节奏'], ending: '维持原结尾' }),
    );
    expect(artifact.body).toBe('初稿正文');
  });
});
