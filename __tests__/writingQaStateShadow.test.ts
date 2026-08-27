/**
 * B5 — QA/State Shadow（§8：QA + State Proposal 合并，Shadow Mode）。
 *
 * Red state：QA 输出契约不含 stateProposals；没有任何
 * evidenceQuote → UTF-16 offset 的本地解析；QA 提案与 legacy
 * State Extraction 提案之间没有影子对比统计。
 *
 * 验收（B5 绿）：
 *   1. resolveEvidenceQuoteLocations：0 命中 reject / 1 命中 accept /
 *      多命中 ambiguous；UTF-16 语义正确（含代理对 emoji）。
 *   2. extractQaStateProposals：从 QA structured 提取合法 stateProposals，
 *      坏字段被过滤；缺省返回 []。
 *   3. buildQaStateProposalShadow：QA 提案 vs legacy 提取提案的影子
 *      统计（数量 / 文本交集 overlap / 指纹失配标志）。
 *   4. QA 契约提示 stateProposals（模型只出 evidenceQuote，禁止手算
 *      UTF-16 offset）。
 */

import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import {
  buildQaStateProposalShadow,
  extractQaStateProposals,
  resolveEvidenceQuoteLocations,
  QA_STATE_PROPOSAL_TYPES,
} from '../src/services/writing/prompt/qaStateProposals';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { continuationRequest } from './helpers/oneShotFixtures';

describe('B5 — resolveEvidenceQuoteLocations（§8.4 exact match → UTF-16 offset）', () => {
  const body = '夜谈将尽，柳如烟把信物放在案上。\n烛火映着她眉间的霜色。';

  test('0 matches → rejected', () => {
    const result = resolveEvidenceQuoteLocations(body, '白虎旗在南境升起。');
    expect(result.status).toBe('rejected');
    expect(result.start).toBeUndefined();
    expect(result.end).toBeUndefined();
  });

  test('1 match → accepted with UTF-16 half-open range', () => {
    const result = resolveEvidenceQuoteLocations(body, '柳如烟把信物');
    expect(result.status).toBe('accepted');
    expect(result.start).toBe(5);
    expect(result.end).toBe(11);
  });

  test('multiple matches → ambiguous', () => {
    const result = resolveEvidenceQuoteLocations('霜色。\n霜色。', '霜色');
    expect(result.status).toBe('ambiguous');
  });

  test('surrogate pairs count as two UTF-16 code units (emoji after symbol)', () => {
    // '😀' 是代理对：JS string.length === 2。
    const result = resolveEvidenceQuoteLocations('柳😀如烟', '如烟');
    expect(result.status).toBe('accepted');
    expect(result.start).toBe(3);
    expect(result.end).toBe(5);
  });

  test('empty quote or empty body → rejected', () => {
    expect(resolveEvidenceQuoteLocations(body, '').status).toBe('rejected');
    expect(resolveEvidenceQuoteLocations('', '柳如烟').status).toBe('rejected');
  });
});

describe('B5 — extractQaStateProposals（§8.3 QA JSON 增加 stateProposals）', () => {
  test('extracts valid proposals and keeps only whitelisted types', () => {
    const qaStructured = {
      verdict: 'needs_revision',
      findings: [],
      stateProposals: [
        {
          proposalType: 'character_state',
          subjectRefType: 'canon_character',
          subjectRefId: '柳如烟',
          payload: { emotion: '坚定' },
          evidenceQuote: '柳如烟把信物放在案上',
          risk: 'normal',
        },
        {
          proposalType: 'not_a_real_type',
          evidenceQuote: 'x',
          risk: 'normal',
        },
        {
          proposalType: 'plot_advance',
          payload: { beat: '信物公开' },
          evidenceQuote: '信物放在案上',
          risk: 'major',
        },
        'garbage',
      ],
    };
    const proposals = extractQaStateProposals(qaStructured);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({
      proposalType: 'character_state',
      evidenceQuote: '柳如烟把信物放在案上',
      risk: 'normal',
    });
    // 非白名单类型被过滤
    expect(proposals.every(p => QA_STATE_PROPOSAL_TYPES.includes(p.proposalType))).toBe(
      true,
    );
  });

  test('missing or malformed stateProposals → []', () => {
    expect(extractQaStateProposals(undefined)).toEqual([]);
    expect(extractQaStateProposals({ verdict: 'pass', findings: [] })).toEqual([]);
    expect(extractQaStateProposals({ stateProposals: 'not-an-array' })).toEqual([]);
    expect(extractQaStateProposals(null)).toEqual([]);
  });

  test('drops proposals without evidenceQuote or with bad risk', () => {
    const proposals = extractQaStateProposals({
      stateProposals: [
        {
          proposalType: 'new_location',
          payload: { name: '北境' },
          evidenceQuote: '北境',
          risk: 'normal',
        },
        { proposalType: 'new_location', payload: {}, risk: 'normal' },
        {
          proposalType: 'new_location',
          payload: {},
          evidenceQuote: '南境',
          risk: 'critical',
        },
      ],
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].evidenceQuote).toBe('北境');
  });
});

describe('B5 — buildQaStateProposalShadow（§8.6 Shadow Mode 对比统计）', () => {
  test('counts qa / extract / overlap by exact evidence text intersection', () => {
    const stats = buildQaStateProposalShadow({
      qaProposals: [
        {
          proposalType: 'character_state',
          payload: { emotion: '坚定' },
          evidenceQuote: '柳如烟把信物放在案上',
          risk: 'normal',
        },
        {
          proposalType: 'plot_advance',
          payload: {},
          evidenceQuote: '烛火映着她眉间的霜色',
          risk: 'major',
        },
      ],
      extractProposals: [
        { proposalType: 'character_state', evidenceStart: 5, evidenceEnd: 12 },
        { proposalType: 'new_world_fact', evidenceStart: 30, evidenceEnd: 40 },
      ],
      extractionContentHash: 'abc',
    });
    expect(stats.qaProposalCount).toBe(2);
    expect(stats.extractProposalCount).toBe(2);
    expect(stats.overlapCount).toBe(0);
    expect(stats.qaOnlyCount).toBe(2);
    expect(stats.extractOnlyCount).toBe(2);
    expect(stats.blockedFingerprintMismatch).toBe(false);
  });

  test('overlapping quotes are counted when extract side carries evidenceQuote', () => {
    const stats = buildQaStateProposalShadow({
      qaProposals: [
        {
          proposalType: 'character_state',
          payload: {},
          evidenceQuote: '柳如烟把信物放在案上',
          risk: 'normal',
        },
      ],
      extractProposals: [
        {
          proposalType: 'character_state',
          evidenceQuote: '柳如烟把信物放在案上',
          evidenceStart: 5,
          evidenceEnd: 12,
        },
        {
          proposalType: 'plot_advance',
          evidenceQuote: '烛火映着她眉间的霜色',
          evidenceStart: 15,
          evidenceEnd: 22,
        },
      ],
      extractionContentHash: 'abc',
    });
    expect(stats.overlapCount).toBe(1);
    expect(stats.qaOnlyCount).toBe(0);
    expect(stats.extractOnlyCount).toBe(1);
  });

  test('flags fingerprint mismatch between extraction hash and final body', () => {
    const stats = buildQaStateProposalShadow({
      qaProposals: [],
      extractProposals: [],
      extractionContentHash: 'abc',
      finalBodyFingerprint: 'def',
    });
    expect(stats.blockedFingerprintMismatch).toBe(true);
  });
});

describe('B5 — QA output contract mentions stateProposals（§8.3）', () => {
  test('QA contract asks for optional stateProposals with evidenceQuote, never offsets', () => {
    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: continuationRequest({ workflowVersion: 5 }),
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
    const user = compiled.messages[1].content;
    expect(user).toContain('stateProposals');
    expect(user).toContain('evidenceQuote');
    // §8.3 终点：禁止模型手算 UTF-16 offset
    expect(user).not.toContain('evidenceStart');
  });
});
