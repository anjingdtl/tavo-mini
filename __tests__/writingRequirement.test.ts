import {
  buildWritingRequirements,
  evaluateWritingRequirements,
} from '../src/services/writing/contracts/writingRequirement';
import type { WritingRequest } from '../src/services/writing/contracts/writingSource';

function request(): WritingRequest {
  return {
    writingRunId: 'wr-test',
    generationTraceId: 'gt-test',
    projectId: 1,
    chapterId: 2,
    scenario: 'continuation',
    instruction: {
      title: '测试章',
      synopsis: '推进冲突',
      userInstruction: '保持接缝连续',
      currentContent: '',
      targetPosition: 1,
    },
    sourceBundle: {
      mandatory: [
        {
          candidateId: 'canon:1',
          kind: 'canon',
          sourceId: 1,
          revision: 'r1',
          contentHash: 'h1',
          content: '世界规则',
          requirement: 'mandatory',
          activation: 'automatic',
        },
        {
          candidateId: 'boundary:1',
          kind: 'source_boundary',
          sourceId: 1,
          revision: 'r1',
          contentHash: 'h2',
          content: 'boundary=10',
          requirement: 'mandatory',
          activation: 'automatic',
        },
        {
          candidateId: 'seam:1',
          kind: 'seam',
          sourceId: 1,
          revision: 'r1',
          contentHash: 'h3',
          content: '门后脚步',
          requirement: 'mandatory',
          activation: 'automatic',
        },
        {
          candidateId: 'anchor:1',
          kind: 'primary_anchor',
          sourceId: 1,
          revision: 'r1',
          contentHash: 'h4',
          content: 'position=1',
          requirement: 'mandatory',
          activation: 'automatic',
        },
        {
          candidateId: 'style:1',
          kind: 'writer_style',
          sourceId: 1,
          revision: 'r1',
          contentHash: 'h5',
          content: '克制叙事',
          requirement: 'mandatory',
          activation: 'system',
        },
      ],
      preferred: [],
      optional: [],
    },
    model: {
      configId: 1,
      provider: 'test',
      modelName: 'test',
      contextWindow: 65536,
      maxOutputTokens: 4096,
    },
    policy: {
      version: 1,
      reviewMode: 'full',
      strictness: 'fail-closed',
      values: {
        requirements: [
          {
            id: 'obligation:no-future-leak',
            kind: 'obligation',
            severity: 'blocking',
            validation: 'semantic',
            text: '不得引入边界之后的事实',
          },
        ],
      },
    },
  };
}

describe('Unified WritingRequirement contract', () => {
  test('preserves scenario constraints and produces a deterministic fingerprint', () => {
    const first = buildWritingRequirements(request());
    const second = buildWritingRequirements(request());
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.items.map(item => item.kind)).toEqual(
      expect.arrayContaining(['canon', 'boundary', 'seam', 'anchor', 'style', 'obligation']),
    );
    expect(first.items.find(item => item.kind === 'canon')?.severity).toBe('mandatory');
    expect(first.items.find(item => item.kind === 'obligation')?.severity).toBe('blocking');
  });

  test('rejects false applied requirements locally', () => {
    const requirements = buildWritingRequirements(request());
    const result = evaluateWritingRequirements({
      requirements,
      satisfiedIds: requirements.items.map(item => item.id),
      appliedIds: ['missing-requirement'],
    });
    expect(result.ok).toBe(false);
    expect(result.falseAppliedIds).toEqual(['missing-requirement']);
  });
});
