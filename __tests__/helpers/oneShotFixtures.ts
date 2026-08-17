/**
 * Shared fixtures for the One-Shot (极速) gate tests.
 *
 * Builds WritingRequest objects whose source bundles pass the production
 * WritingSourceContract validation (real sha256 content hashes, required
 * mandatory kinds per scenario). Continuation fixtures deliberately include
 * canon/boundary/seam/anchor so the "one paid call never bypasses context
 * governance" invariant is exercised on realistic inputs.
 */
import { sha256Hex } from '../../src/services/continuation/hashUtils';
import type {
  WritingRequest,
  WritingSource,
  WritingSourceKind,
} from '../../src/services/writing/contracts/writingSource';

let seq = 0;

/** Deterministic ids per kind so two requests with the same content compare equal. */
const KIND_SEQ: Record<string, number> = {};

export function makeSource(input: {
  kind: WritingSourceKind;
  content: string;
  requirement?: WritingSource['requirement'];
}): WritingSource {
  seq += 1;
  KIND_SEQ[input.kind] = (KIND_SEQ[input.kind] || 0) + 1;
  const kindSeq = KIND_SEQ[input.kind];
  const needsRevision = [
    'outline',
    'canon',
    'source_boundary',
    'seam',
    'primary_anchor',
    'chapter',
  ].includes(input.kind);
  return {
    candidateId: `c-${input.kind}-${kindSeq}`,
    kind: input.kind,
    sourceId: needsRevision ? kindSeq : null,
    revision: needsRevision ? `rev-${input.kind}-${kindSeq}` : null,
    contentHash: sha256Hex(input.content),
    content: input.content,
    requirement: input.requirement || 'mandatory',
    activation: 'explicit',
  };
}

/** Reset the deterministic id counters (used between scenario fixtures). */
export function resetFixtureIds(): void {
  for (const key of Object.keys(KIND_SEQ)) delete KIND_SEQ[key];
  seq = 0;
  void seq;
}

export function outlineRequest(
  values: Record<string, unknown>,
  overrides?: { contextWindow?: number; sourceScale?: number },
): WritingRequest {
  resetFixtureIds();
  const scale = overrides?.sourceScale ?? 1;
  return {
    writingRunId: 'wr-one-shot-outline',
    generationTraceId: 'gt-one-shot-outline',
    projectId: 1,
    chapterId: 2,
    scenario: 'outline',
    instruction: {
      title: '第一章',
      synopsis: '写完本章主要冲突',
      userInstruction: '写完本章主要冲突',
      currentContent: '',
      targetPosition: 1,
    },
    sourceBundle: {
      mandatory: [
        makeSource({ kind: 'instruction', content: '完成本章写作指令。' }),
        makeSource({
          kind: 'chapter',
          content: '上一章结尾：主角推门而入。'.repeat(4 * scale),
        }),
        makeSource({
          kind: 'outline',
          content: '当前章节大纲：雨夜对决。'.repeat(10 * scale),
        }),
        makeSource({ kind: 'preset', content: '作家风格预设。' }),
      ],
      preferred: [
        makeSource({
          kind: 'writer_style',
          content: '冷峻克制的白描文风。'.repeat(6 * scale),
          requirement: 'preferred',
        }),
        makeSource({
          kind: 'story_memory',
          content: '故事记忆：主角背负旧债。'.repeat(4 * scale),
          requirement: 'preferred',
        }),
      ],
      optional: [
        makeSource({
          kind: 'worldbook',
          content: '世界观：北境雪原设定。'.repeat(20 * scale),
          requirement: 'optional',
        }),
      ],
    },
    model: {
      configId: 7,
      provider: 'openai_compatible',
      modelName: 'one-shot-model',
      contextWindow: overrides?.contextWindow ?? 65536,
      maxOutputTokens: 4096,
      url: 'https://one-shot.example/v1/chat/completions',
      name: 'one-shot-cfg',
      thinking: { type: 'enabled' },
      reasoningEffort: 'low',
      credentialRef: { kind: 'llm-config-api-key', configId: 7 },
    },
    policy: {
      version: 1,
      reviewMode: 'full',
      strictness: 'fail-closed',
      values,
    },
  };
}

export function continuationRequest(
  values: Record<string, unknown>,
): WritingRequest {
  resetFixtureIds();
  return {
    writingRunId: 'wr-one-shot-continuation',
    generationTraceId: 'gt-one-shot-continuation',
    projectId: 1,
    chapterId: 2,
    scenario: 'continuation',
    instruction: {
      title: 'Continuation chapter 3',
      synopsis: '续写指令：推进主线',
      userInstruction: '续写指令：推进主线',
      currentContent: '前文最后一段节选。',
      targetPosition: 3,
    },
    sourceBundle: {
      mandatory: [
        makeSource({ kind: 'instruction', content: '续写本章指令。' }),
        makeSource({ kind: 'canon', content: 'Canon：主角已获得信物。' }),
        makeSource({ kind: 'source_boundary', content: '边界：止于第 2 章。' }),
        makeSource({ kind: 'seam', content: '接缝：夜谈未完。' }),
        makeSource({ kind: 'primary_anchor', content: '锚点：信物真相。' }),
      ],
      preferred: [
        makeSource({
          kind: 'writer_style',
          content: '原著画风画像。',
          requirement: 'preferred',
        }),
        makeSource({
          kind: 'story_memory',
          content: '故事记忆：仇敌在北境。',
          requirement: 'preferred',
        }),
      ],
      optional: [],
    },
    model: {
      configId: 7,
      provider: 'openai_compatible',
      modelName: 'one-shot-model',
      contextWindow: 65536,
      maxOutputTokens: 4096,
      url: 'https://one-shot.example/v1/chat/completions',
      name: 'one-shot-cfg',
      thinking: { type: 'disabled' },
      reasoningEffort: undefined,
      credentialRef: { kind: 'llm-config-api-key', configId: 7 },
    },
    policy: {
      version: 1,
      reviewMode: 'continuation-v5',
      strictness: 'fail-closed',
      values: { workflowVersion: 5, ...values },
    },
  };
}
