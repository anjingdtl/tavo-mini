/**
 * B6 — QA/State Cutover（§8.5 / §8.6 切换准备）。
 *
 * Red state：QA 的 stateProposals 从未落地到 continuation 提案管道；
 * Revision 契约不含 finalStateProposals / proposalSourceBodyFingerprint。
 *
 * 验收（B6 绿）：
 *   1. resolveQaProposalsToOffsets：evidenceQuote → UTF-16 offset 本地解析，
 *      0/多命中拒绝，1 命中接受并输出录入行所需 offsets。
 *   2. buildQaProposalInsertRows：QA proposals → continuation_state_proposals
 *      同表录入行（pending 状态，复用 legacy 提案管道），带 contentHash。
 *   3. Revision 契约提示 finalStateProposals 与 proposalSourceBodyFingerprint
 *      （§8.5：Final != Draft 时 QA 提案失效，由修订输出最终正文指纹提案）。
 */

import {
  buildQaProposalInsertRows,
  resolveFinalBodyStateProposals,
  resolveQaProposalsToOffsets,
} from '../src/services/writing/prompt/qaStateProposals';
import { sha256Hex } from '../src/services/continuation/hashUtils';
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { outlineRequest } from './helpers/oneShotFixtures';

describe('B6 — resolveQaProposalsToOffsets（§8.4 本地解析 + 过滤）', () => {
  const finalBody = '夜谈将尽，柳如烟把信物放在案上。\n烛火映着她眉间的霜色。';

  test('single quote match accepted; ambiguous & missing rejected', () => {
    const result = resolveQaProposalsToOffsets({
      proposals: [
        {
          proposalType: 'character_state',
          payload: { emotion: '坚定' },
          evidenceQuote: '柳如烟把信物',
          risk: 'normal',
        },
        {
          proposalType: 'plot_advance',
          payload: {},
          evidenceQuote: '霜色',
          risk: 'major',
        },
        {
          proposalType: 'new_location',
          payload: {},
          evidenceQuote: '南境军旗',
          risk: 'normal',
        },
      ],
      finalBody,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rejectedCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      proposalType: 'character_state',
      evidenceStart: 5,
      evidenceEnd: 11,
      risk: 'normal',
    });
    expect(result.rows[1]).toMatchObject({
      proposalType: 'plot_advance',
      evidenceStart: 25,
      evidenceEnd: 27,
      risk: 'major',
    });
  });

  test('empty body or empty proposals → no rows, no rejects', () => {
    expect(
      resolveQaProposalsToOffsets({ proposals: [], finalBody: 'x' }).rows,
    ).toEqual([]);
    expect(
      resolveQaProposalsToOffsets({ proposals: [], finalBody: '' }).rows,
    ).toEqual([]);
  });
});

describe('B6 — buildQaProposalInsertRows（进入 legacy 提案管道）', () => {
  test('maps resolved proposals to pending insert rows with content hash', () => {
    const rows = buildQaProposalInsertRows({
      proposals: [
        {
          proposalType: 'knowledge_change',
          payload: { fact: '信物已移交' },
          evidenceQuote: '柳如烟把信物',
          risk: 'normal',
        },
      ],
      draftBody: '夜谈将尽，柳如烟把信物放在案上。',
      finalBody: '夜谈将尽，柳如烟把信物放在案上。',
      finalBodyFingerprint: sha256Hex('夜谈将尽，柳如烟把信物放在案上。'),
      projectId: 7,
      chapterId: 9001,
      sourceRunId: 'run-1',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].proposalType).toBe('knowledge_change');
    expect(rows[0].evidenceStart).toBe(5);
    expect(rows[0].evidenceEnd).toBe(11);
    expect(rows[0].sourceRunId).toBe('run-1');
    expect(rows[0].payloadJson).toContain('信物已移交');
    // contentHash 绑定最终正文指纹（§8.5）
    expect(rows[0].extractionContentHash).toBe(
      sha256Hex('夜谈将尽，柳如烟把信物放在案上。'),
    );
    expect(rows[0].chapterRevisionHash).toBe(
      sha256Hex('夜谈将尽，柳如烟把信物放在案上。'),
    );
  });

  test('ambiguous evidence drops the row (multi-match exact quote)', () => {
    const rows = buildQaProposalInsertRows({
      proposals: [
        {
          proposalType: 'plot_advance',
          payload: {},
          evidenceQuote: '霜色',
          risk: 'normal',
        },
      ],
      draftBody: '霜色。\n霜色。',
      finalBody: '霜色。\n霜色。',
      finalBodyFingerprint: sha256Hex('霜色。\n霜色。'),
      projectId: 1,
      chapterId: 2,
      sourceRunId: 'run-x',
    });
    expect(rows).toHaveLength(0);
  });
});

describe('B6 — Revision contract posts final-state proposals（§8.5）', () => {
  test('compact QA prompt bounds findings density so JSON can close in budget', () => {
    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    const compiled = compileSharedWritingPrompt({
      stage: 'qa',
      frozenContext,
      artifacts: {
        draft: { stage: 'draft', body: '正文' },
      },
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
    });
    expect(compiled.messages[1].content).toContain('最多 3 条最高优先级问题');
    expect(compiled.messages[1].content).toContain('确保 JSON 在本次输出预算内完整结束');
  });

  test('revision prompt includes finalStateProposals + proposalSourceBodyFingerprint', () => {
    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    const compiled = compileSharedWritingPrompt({
      stage: 'revision',
      frozenContext,
      artifacts: {
        draft: { stage: 'draft', body: '正文' },
        qa: {
          stage: 'qa',
          body: JSON.stringify({ verdict: 'needs_revision', findings: [] }),
        },
      },
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
    });
    const user = compiled.messages[1].content;
    expect(user).toContain('finalStateProposals');
    expect(user).toContain('proposalSourceBodyFingerprint');
    expect(user).toContain('proposalType 只能是 character_state / relationship_change / plot_advance');
    expect(user).toContain(
      '非空时每项 payload 必须是 JSON object（键值对象），例如 {"status":"已受伤"}；不能是字符串、数组或 null',
    );
    expect(user).toContain(
      '默认必须输出 finalStateProposals: []；冻结需求未明确要求时禁止输出非空数组',
    );
    expect(user).toContain(
      'risk 只能是 normal 或 major；不要输出 low / medium / high / critical 等其他值',
    );
    expect(user).toContain('stateProposals');
  });
});

describe('B6 — cutover stays shadow-safe on outline scenarios', () => {
  test('outline QA proposals resolve against the draft the same way', () => {
    const body = '纸上一行字，墨色未干。';
    const rows = buildQaProposalInsertRows({
      proposals: [
        {
          proposalType: 'other',
          payload: {},
          evidenceQuote: '墨色未干',
          risk: 'normal',
        },
      ],
      draftBody: body,
      finalBody: body,
      finalBodyFingerprint: sha256Hex(body),
      projectId: 1,
      chapterId: 2,
      sourceRunId: 'run-o',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].evidenceStart).toBe(body.indexOf('墨色未干'));
  });
});

describe('B6 — Final-Body State Proposal authority', () => {
  test('Final==Draft admits QA proposals and ignores Revision candidates', () => {
    const body = '柳如烟收起信物，决定暂不回城。';
    const result = resolveFinalBodyStateProposals({
      draftBody: body,
      finalBody: body,
      qaStructured: {
        stateProposals: [
          {
            proposalType: 'character_state',
            payload: { decision: '暂不回城' },
            evidenceQuote: '决定暂不回城',
            risk: 'normal',
          },
        ],
      },
      revisionStructured: {
        finalStateProposals: [
          {
            proposalType: 'plot_advance',
            payload: { wrongSource: true },
            evidenceQuote: '收起信物',
            risk: 'major',
          },
        ],
        proposalSourceBodyFingerprint: sha256Hex(body),
      },
    });
    expect(result.finalEqualsDraft).toBe(true);
    expect(result.source).toBe('qa');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].payload).toEqual({ decision: '暂不回城' });
  });

  test('Final!=Draft discards QA even when its quote still matches Final', () => {
    const draft = '柳如烟收起信物。';
    const finalBody = '柳如烟收起信物，决定暂不回城。';
    const result = resolveFinalBodyStateProposals({
      draftBody: draft,
      finalBody,
      qaStructured: {
        stateProposals: [
          {
            proposalType: 'character_state',
            payload: { staleQa: true },
            evidenceQuote: '收起信物',
            risk: 'normal',
          },
        ],
      },
      revisionStructured: {
        finalStateProposals: [],
        // Deliberately absent: a matching QA quote cannot revive QA.
      },
    });
    expect(result.finalEqualsDraft).toBe(false);
    expect(result.source).toBe('none');
    expect(result.rows).toEqual([]);
    expect(result.rejectionReason).toBe(
      'revision_final_body_fingerprint_mismatch',
    );
  });

  test('Final!=Draft admits only fingerprint-matched Revision proposals', () => {
    const draft = '柳如烟收起信物。';
    const finalBody = '柳如烟收起信物，决定暂不回城。';
    const result = resolveFinalBodyStateProposals({
      draftBody: draft,
      finalBody,
      qaStructured: {
        stateProposals: [
          {
            proposalType: 'character_state',
            payload: { staleQa: true },
            evidenceQuote: '收起信物',
            risk: 'normal',
          },
        ],
      },
      revisionStructured: {
        finalStateProposals: [
          {
            proposalType: 'character_state',
            payload: { decision: '暂不回城' },
            evidenceQuote: '决定暂不回城',
            risk: 'normal',
          },
        ],
        proposalSourceBodyFingerprint: sha256Hex(finalBody),
      },
    });
    expect(result.source).toBe('revision');
    expect(result.fingerprintMatched).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].payload).toEqual({ decision: '暂不回城' });
  });

  test('fingerprint mismatch rejects Revision proposals even when quote matches', () => {
    const draft = '原稿。';
    const finalBody = '终稿，新增事实。';
    const result = resolveFinalBodyStateProposals({
      draftBody: draft,
      finalBody,
      qaStructured: {
        stateProposals: [
          {
            proposalType: 'other',
            payload: { staleQa: true },
            evidenceQuote: '新增事实',
            risk: 'normal',
          },
        ],
      },
      revisionStructured: {
        finalStateProposals: [
          {
            proposalType: 'other',
            payload: { staleRevision: true },
            evidenceQuote: '新增事实',
            risk: 'normal',
          },
        ],
        proposalSourceBodyFingerprint: sha256Hex('another body'),
      },
    });
    expect(result.rows).toEqual([]);
    expect(result.fingerprintMatched).toBe(false);
  });
});
