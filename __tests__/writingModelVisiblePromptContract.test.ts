import { sha256Hex } from '../src/services/continuation/hashUtils';
import {
  buildWritingRequestReceipt,
  fingerprintWritingMessages,
} from '../src/services/writing/contracts/writingRequestReceipt';
import { resolveQaEvidenceProjection } from '../src/services/writing/prompt/evidenceQaProjection';
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import type { WritingSource } from '../src/services/writing/contracts/writingSource';
import { continuationRequest } from './helpers/oneShotFixtures';

function extraSource(
  kind: WritingSource['kind'],
  candidateId: string,
  content: string,
): WritingSource {
  return {
    kind,
    candidateId,
    content,
    contentHash: sha256Hex(content),
    sourceId: `prompt-contract:${candidateId}`,
    revision: 'prompt-contract-v1',
    requirement: 'preferred',
    activation: 'automatic',
  };
}

describe('model-visible frozen writing prompt contract', () => {
  test('Draft/QA/Revision messages carry frozen truth, current materials, checklist and receipt identity', () => {
    const request = continuationRequest({
      pipelineTopologyVersion: 'compact_standard',
    });
    request.sourceBundle.preferred.push(
      extraSource(
        'character',
        'characters:prompt-contract',
        '角色「陆沉」当前处于警戒状态。CHARACTER_CURRENT_ONLY',
      ),
      extraSource(
        'worldbook',
        'worldbook:prompt-contract',
        '北境规则：钟楼只在夜半开启。WORLDBOOK_CURRENT_ONLY',
      ),
      extraSource(
        'note',
        'notes:prompt-contract',
        '笔记：本章必须保留旧钟线索。NOTE_CURRENT_ONLY',
      ),
      extraSource(
        'episodic_memory',
        'episodic:prompt-contract',
        '旧事：陆沉曾在北境失约。EPISODIC_CURRENT_ONLY',
      ),
      extraSource(
        'structured_continuity_state',
        'state:prompt-contract',
        '结构化状态：陆沉=警戒；信物=已获得。STATE_CURRENT_ONLY',
      ),
    );
    const { frozenContext } = buildWritingKernelFreezeTrace({ request });

    const draft = compileSharedWritingPrompt({
      stage: 'draft',
      frozenContext,
      artifacts: {},
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
    });
    const draftBody = '陆沉在北境翻看笔记，旧事与信物状态同时浮现。';
    const qaEvidence = resolveQaEvidenceProjection({
      stage: 'qa',
      frozenContext,
      artifacts: { draft: { stage: 'draft', body: draftBody } },
      requirements: frozenContext.requirements,
    });
    expect(qaEvidence.enabled).toBe(true);
    const qa = compileSharedWritingPrompt({
      stage: 'qa',
      frozenContext,
      artifacts: { draft: { stage: 'draft', body: draftBody } },
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
      qaEvidence,
    });
    const revision = compileSharedWritingPrompt({
      stage: 'revision',
      frozenContext,
      artifacts: {
        draft: { stage: 'draft', body: draftBody },
        qa: {
          stage: 'qa',
          body: JSON.stringify({
            schemaVersion: 1,
            verdict: 'needs_revision',
            findings: [
              {
                findingId: 'qa-1',
                severity: 'blocking',
                target: '陆沉',
                issue: '需要修正',
                instruction: '保留当前资料',
              },
            ],
          }),
        },
      },
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
    });

    for (const [stage, compiled] of [
      ['draft', draft],
      ['qa', qa],
      ['revision', revision],
    ] as const) {
      const visible = compiled.messages.map(message => message.content).join('\n');
      expect(visible).toContain('【Chapter Truth Projection】');
      expect(visible).toContain('【写作要求】');
      expect(visible).toContain('Canon：主角已获得信物。');
      expect(visible).toContain('边界：止于第 2 章。');
      expect(visible).toContain('接缝：夜谈未完。');
      expect(visible).toContain('锚点：信物真相。');
      expect(visible).toContain('原著画风画像。');
      expect(visible).toContain('故事记忆：仇敌在北境。');
      expect(visible).toContain('CHARACTER_CURRENT_ONLY');
      expect(visible).toContain('WORLDBOOK_CURRENT_ONLY');
      expect(visible).toContain('NOTE_CURRENT_ONLY');
      expect(visible).toContain('EPISODIC_CURRENT_ONLY');
      expect(visible).toContain('STATE_CURRENT_ONLY');

      const receipt = buildWritingRequestReceipt({
        generationTraceId: frozenContext.generationTraceId,
        stage,
        frozenContext,
        compiled,
        thinking: { type: 'enabled' },
      });
      expect(receipt.messagesFingerprint).toBe(
        fingerprintWritingMessages(compiled.messages),
      );
      expect(receipt.truthProjectionFingerprint).toBe(
        frozenContext.truthProjection?.fingerprint,
      );
    }

    // Freeze is authoritative: mutating the caller's live source object after
    // the snapshot exists cannot alter any model-visible message.
    request.sourceBundle.preferred[0].content = 'LIVE_DRIFT_AFTER_FREEZE';
    const afterFreeze = compileSharedWritingPrompt({
      stage: 'revision',
      frozenContext,
      artifacts: { draft: { stage: 'draft', body: draftBody } },
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
    });
    expect(afterFreeze.messages.map(message => message.content).join('\n')).not.toContain(
      'LIVE_DRIFT_AFTER_FREEZE',
    );
  });
});
