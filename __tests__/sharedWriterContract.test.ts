import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import {
  executeSharedWriterStage,
  parseSharedWriterOutput,
} from '../src/services/writing/stages/writerCore';

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
    ).rejects.toMatchObject({ code: 'SHARED_WRITER_INVALID_REPORT' });

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
