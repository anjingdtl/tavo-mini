/**
 * Phase 3 A2: Chapter Truth Projection lives inside ONE FrozenWritingContext.
 * It is not a second Context, budget, or database round-trip.
 */
import {
  buildChapterTruthProjection,
  resolveChapterTruthProjection,
} from '../src/services/writing/contracts/chapterTruthProjection';
import { gateSharedStageInput } from '../src/services/writing/stages/writerCore';
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import {
  continuationRequest,
  outlineRequest,
} from './helpers/oneShotFixtures';

describe('Chapter Truth Projection', () => {
  test('reconstructs the same fingerprint from FrozenWritingContext for Draft/QA/Revision', () => {
    const { frozenContext, trace } = buildWritingKernelFreezeTrace({
      request: continuationRequest({
        pipelineTopologyVersion: 'compact_standard',
        qualityProfile: 'standard',
      }),
    });
    const built = buildChapterTruthProjection(frozenContext);
    expect(built.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(built.canonSnapshotFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(built.sourceBoundaryFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(built.seamFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(built.anchorFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(built.storyMemoryFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(built.writerStyleFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(frozenContext.truthProjection?.fingerprint).toBe(built.fingerprint);
    expect(buildChapterTruthProjection(frozenContext).fingerprint).toBe(
      built.fingerprint,
    );

    for (const stage of ['draft', 'qa', 'revision'] as const) {
      const resolved = resolveChapterTruthProjection(frozenContext, stage);
      expect(resolved.fingerprint).toBe(built.fingerprint);
      expect(
        gateSharedStageInput({
          stage,
          frozenContext,
          trace,
          requirements: frozenContext.requirements,
          stagePolicy: frozenContext.stagePolicy,
          artifacts: {},
          modelConfig: {
            configId: frozenContext.model.configId,
            name: frozenContext.model.name || 'cfg',
            providerType: frozenContext.model.provider,
            url: frozenContext.model.url || '',
            modelName: frozenContext.model.modelName,
            contextWindow: frozenContext.model.contextWindow,
            maxOutputTokens: frozenContext.model.maxOutputTokens,
          },
        } as any),
      ).toBeNull();
      const compiled = compileSharedWritingPrompt({
        stage,
        frozenContext,
        artifacts: {},
        requirements: frozenContext.requirements,
        stagePolicy: frozenContext.stagePolicy,
      });
      expect(compiled.messages.length).toBeGreaterThan(0);
    }
  });

  test('does not change freezeFingerprint identity of historical-shaped requests', () => {
    const historical = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    expect(historical.frozenContext.freezeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(historical.frozenContext.truthProjection?.fingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
    const rebuilt = buildChapterTruthProjection({
      ...historical.frozenContext,
      truthProjection: undefined,
    });
    expect(rebuilt.fingerprint).toBe(
      historical.frozenContext.truthProjection?.fingerprint,
    );
  });

  test('fail-closed when a stage sees a drifted truth fingerprint', () => {
    const { frozenContext, trace } = buildWritingKernelFreezeTrace({
      request: outlineRequest({
        pipelineTopologyVersion: 'compact_standard',
        qualityProfile: 'quality',
      }),
    });
    const drifted = {
      ...frozenContext,
      truthProjection: {
        ...frozenContext.truthProjection!,
        fingerprint: '0'.repeat(64),
      },
    };
    expect(
      gateSharedStageInput({
        stage: 'qa',
        frozenContext: drifted,
        trace,
        requirements: drifted.requirements,
        stagePolicy: drifted.stagePolicy,
        artifacts: {},
        modelConfig: {
          configId: drifted.model.configId,
          name: drifted.model.name || 'cfg',
          providerType: drifted.model.provider,
          url: drifted.model.url || '',
          modelName: drifted.model.modelName,
          contextWindow: drifted.model.contextWindow,
          maxOutputTokens: drifted.model.maxOutputTokens,
        },
      } as any),
    ).toBe('WRITING_TRUTH_PROJECTION_DRIFT');
  });
});
