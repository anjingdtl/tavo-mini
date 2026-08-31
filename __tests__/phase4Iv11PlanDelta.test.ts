import { buildContinuationBatchChapterInstruction } from '../src/services/multiChapterBatch/continuationBatchInstruction';
import { buildFrozenWritingContext } from '../src/services/writing/context/buildFrozenWritingContext';
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import type {
  WritingRequest,
  WritingSource,
} from '../src/services/writing/contracts/writingSource';
import { writingSourceContentHash } from '../src/services/writing/contracts/writingFingerprint';
import { sha256Hex } from '../src/services/continuation/hashUtils';
import { estimateMessagesTokens, estimateTokens } from '../src/utils/tokenEstimator';

type BodyFreePlan = {
  title: string;
  synopsis: string;
  keyBeats: string[];
  carryIn: string;
  carryOut: string;
  targetWords: number;
};

const BODY_FREE_BATCH = {
  sourcePrompt: '本实验只验证当前章节计划边界；不得写入实验正文。',
  writingMode: 'continuation' as const,
};

const GOOD_PLAN: BodyFreePlan = {
  title: '第118章·边界记录',
  synopsis:
    '本章只处理一处已定位的记录矛盾：角色确认关键证据，作出封存选择，并以一个可见后果形成自然收束。',
  keyBeats: [
    '确认一处可定位的记录矛盾',
    '与同伴核对关键证据',
    '作出是否封存的选择',
    '留下一个可供下章承接的后果',
  ],
  carryIn: '上一章留下一个已定位、尚未解释的记录矛盾。',
  carryOut: '下一章只承接本章选择造成的后果，不回溯重做本章核对。',
  targetWords: 900,
};

// The original IV-10 body/frozen request is absent on this development
// machine. This is intentionally a body-free structural equivalent, not a
// claim that it is the historical "账册的末行" fixture.
const BAD_EQUIVALENT_PLAN: BodyFreePlan = {
  ...GOOD_PLAN,
  synopsis:
    '本章必须逐项核对记录直到最后一项，任何遗漏都要补齐；每发现异常就继续打开下一项并回到前面复核，直到整组记录全部闭合且没有任何疑点。',
};

function source(
  candidateId: string,
  kind: WritingSource['kind'],
  content: string,
  sourceId: string | null = null,
): WritingSource {
  return {
    candidateId,
    kind,
    sourceId,
    revision: sourceId ? 'body-free-r1' : null,
    contentHash: writingSourceContentHash(content),
    content,
    requirement: 'mandatory',
    activation: 'explicit',
  };
}

function requestFor(plan: BodyFreePlan): WritingRequest {
  const item = {
    ordinal: 118,
    title: plan.title,
    synopsis: plan.synopsis,
    keyBeatsJson: JSON.stringify(plan.keyBeats),
    carryIn: plan.carryIn,
    carryOut: plan.carryOut,
    targetWords: plan.targetWords,
  };
  const userInstruction = buildContinuationBatchChapterInstruction(
    BODY_FREE_BATCH,
    item,
  );
  return {
    writingRunId: 'iv11-body-free-delta-run',
    generationTraceId: 'iv11-body-free-delta-trace',
    projectId: 118,
    chapterId: 118,
    scenario: 'continuation',
    targetChars: 1800,
    instruction: {
      title: plan.title,
      synopsis: userInstruction,
      userInstruction,
      currentContent: '',
      targetPosition: 118,
    },
    sourceBundle: {
      mandatory: [
        source('instruction:current', 'instruction', userInstruction),
        source(
          'canon:body-free',
          'canon',
          '仅允许使用本实验声明的有限事实；不存在可供扩写的正文。',
          'canon-body-free',
        ),
        source(
          'boundary:body-free',
          'source_boundary',
          '当前请求只写第118章；达到本章自然结尾后停止。',
          'boundary-body-free',
        ),
        source('seam:body-free', 'seam', plan.carryIn, 'seam-body-free'),
      ],
      preferred: [],
      optional: [],
    },
    model: {
      configId: 3,
      provider: 'openai_compatible',
      providerAdapterId: 'openai_compatible',
      modelName: 'deepseek-v4-flash',
      contextWindow: 1_000_000,
      maxOutputTokens: 0,
      url: 'https://api.deepseek.com/v1/chat/completions',
      thinking: { type: 'enabled' },
      reasoningEffort: 'high',
    },
    policy: {
      version: 1,
      reviewMode: 'continuation-v5',
      strictness: 'fail-closed',
      values: {
        qualityProfile: 'standard',
        pipelineTopologyVersion: 'compact_standard',
      },
    },
  };
}

function summarize(
  variant: string,
  frozen: ReturnType<typeof buildFrozenWritingContext>,
  prompt: ReturnType<typeof compileSharedWritingPrompt>,
) {
  const allPromptText = prompt.messages.map(message => message.content).join('\n');
  const userPrompt = prompt.messages.find(message => message.role === 'user')?.content || '';
  const mandatoryTokens = frozen.materials
    .filter(material => material.source.requirement === 'mandatory')
    .reduce((total, material) => total + material.demandTokens, 0);
  const preferredTokens = frozen.materials
    .filter(material => material.source.requirement === 'preferred')
    .reduce((total, material) => total + material.demandTokens, 0);
  const optionalTokens = frozen.materials
    .filter(material => material.source.requirement === 'optional')
    .reduce((total, material) => total + material.demandTokens, 0);
  return {
    variant,
    provider: frozen.model.provider,
    model: frozen.model.modelName,
    endpointClass: 'official-deepseek-api',
    thinking: frozen.model.thinking,
    reasoningEffort: frozen.model.reasoningEffort,
    qualityProfile: frozen.stagePolicy.values.qualityProfile,
    targetChars: frozen.targetChars,
    actualPromptTokens: estimateMessagesTokens(prompt.messages),
    mandatoryTokens,
    preferredTokens,
    optionalTokens,
    compiledPromptTokens: estimateTokens(allPromptText),
    inputTokenLimit: frozen.allocation.inputTokenLimit,
    wireMaxOutputTokens: prompt.maxTokens,
    responseFormat: prompt.responseFormat,
    contextComposition: {
      mandatoryCount: frozen.sourceBundle.mandatory.length,
      preferredCount: frozen.sourceBundle.preferred.length,
      optionalCount: frozen.sourceBundle.optional.length,
      renderedItemCount: frozen.rendered.items.length,
      renderedIncludedCount: frozen.rendered.items.filter(item => item.included).length,
    },
    requestFingerprint: sha256Hex(
      JSON.stringify({
        instruction: frozen.instruction,
        sourceFingerprint: frozen.sourceFingerprint,
        requirements: frozen.requirements.fingerprint,
      }),
    ),
    freezeFingerprint: frozen.freezeFingerprint,
    renderedContextHash: frozen.rendered.fingerprint,
    compiledPromptHash: sha256Hex(allPromptText),
    compiledPromptSectionHashes: userPrompt
      .split('\n\n')
      .map(section => ({
        hash: sha256Hex(section),
        chars: section.length,
        tokens: estimateTokens(section),
      })),
  };
}

describe('IV-11 body-free pathological plan delta', () => {
  it('isolates one synopsis-field delta under the current DeepSeek ON contract', () => {
    const badRequest = requestFor(BAD_EQUIVALENT_PLAN);
    const goodRequest = requestFor(GOOD_PLAN);
    const badFrozen = buildFrozenWritingContext(badRequest);
    const goodFrozen = buildFrozenWritingContext(goodRequest);
    const badPrompt = compileSharedWritingPrompt({
      stage: 'draft',
      frozenContext: badFrozen,
      artifacts: {},
      requirements: badFrozen.requirements,
      stagePolicy: badFrozen.stagePolicy,
    });
    const goodPrompt = compileSharedWritingPrompt({
      stage: 'draft',
      frozenContext: goodFrozen,
      artifacts: {},
      requirements: goodFrozen.requirements,
      stagePolicy: goodFrozen.stagePolicy,
    });

    expect(badRequest.instruction.title).toBe(goodRequest.instruction.title);
    expect(badRequest.instruction.targetPosition).toBe(
      goodRequest.instruction.targetPosition,
    );
    expect(badRequest.model).toEqual(goodRequest.model);
    expect(badPrompt.responseFormat).toBe('json_object');
    expect(goodPrompt.responseFormat).toBe('json_object');
    expect(badPrompt.messages).not.toEqual(goodPrompt.messages);

    // Evidence is deliberately metadata-only: no prompt body, API key, or
    // generated prose is emitted. The next Android phase can attach latency,
    // usage, finishReason, and failure classification to these hashes.
    console.log(
      JSON.stringify({
        fixture: 'body-free-equivalent-not-historical-iv10-plan',
        changedField: 'currentItem.synopsis only',
        invariant: {
          chapterId: badRequest.chapterId,
          targetPosition: badRequest.instruction.targetPosition,
          model: badFrozen.model.modelName,
          thinking: badFrozen.model.thinking,
          reasoningEffort: badFrozen.model.reasoningEffort,
          wireMaxOutputTokens: badPrompt.maxTokens,
        },
        variants: [
          summarize('bad-equivalent-open-ended-synopsis', badFrozen, badPrompt),
          summarize('good-replan-finite-synopsis', goodFrozen, goodPrompt),
        ],
      }),
    );
  });

  it('exposes the missing universal current-chapter completion boundary as RED', () => {
    const frozen = buildFrozenWritingContext(requestFor(BAD_EQUIVALENT_PLAN));
    const prompt = compileSharedWritingPrompt({
      stage: 'draft',
      frozenContext: frozen,
      artifacts: {},
      requirements: frozen.requirements,
      stagePolicy: frozen.stagePolicy,
    });
    const promptText = prompt.messages.map(message => message.content).join('\n');

    expect(promptText).toContain('当前章节完成边界');
    expect(promptText).toContain('不要继续下一章');
    expect(promptText).toContain('最终正文必须放在 content 字段中');
    expect(promptText).toContain('reasoning_content 仅作内部推理');
  });
});
