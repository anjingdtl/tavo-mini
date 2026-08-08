/**
 * Final Reviser (V2 Proof) compiler — hard-constraint integrity tests.
 *
 * Regression for the P1 acceptance defect: hard constraints were spread as
 * iterables, splitting every Chinese character into its own single-char
 * constraint bullet ("硬约束字符串被拆成单字"). Requirements (§6.1 of the
 * default-capabilities plan):
 *   - full module text participates in budget allocation;
 *   - list splitting follows explicit paragraph/line rules, never chars;
 *   - empty-filtered, stable dedup, original order preserved;
 *   - constraints already inside the contract are not re-injected;
 *   - Chinese / multi-line / Emoji / over-budget clipping tests assert no
 *     single-char bullets.
 */
import { compileFinalReviserStageRequest } from '../src/services/pipeline/compileStageRequest';
import type { ChatMessage } from '../src/services/llm';
import type { ProofConstraints } from '../src/types/pipelineContext';

const BASE_CONSTRAINTS: ProofConstraints = {
  presetText: '',
  currentInstructionText: '',
  retrievalUserPrompt: '',
  relevantCharacterConstraints: '',
  relevantWorldRules: '',
  currentStoryState: '',
  episodicMemoryText: '',
  noteText: '',
  recentBridgeText: '',
  outlineText: '',
};

function contractJson(hardConstraints: string[] = []): string {
  return JSON.stringify({
    schemaVersion: 1,
    compilerVersion: 1,
    draftHash: 'draft-hash-abc',
    workItems: [
      {
        id: 'w1',
        scope: 'chapter',
        dimension: '大纲执行',
        severity: 'hard',
        diagnosis: '缺节点',
        rewriteGoal: '补节点',
        preserveMeaning: [],
      },
    ],
    protectedAnchorIds: [],
    protectedFacts: [],
    hardConstraints,
    outlineObligations: {
      fulfilledBeats: [],
      missingBeats: [],
      mustPreserve: [],
      mustNotAdvance: [],
    },
  });
}

function compile(params: {
  constraints?: Partial<ProofConstraints>;
  contractHard?: string[];
  maxTokens?: number;
  contextWindow?: number;
}) {
  return compileFinalReviserStageRequest({
    contractJson: contractJson(params.contractHard),
    workItemCount: 1,
    canonicalDraft: '初稿正文。主角走进了森林。',
    constraints: { ...BASE_CONSTRAINTS, ...(params.constraints || {}) },
    maxTokens: params.maxTokens ?? 2048,
    contextWindow: params.contextWindow ?? 8192,
  });
}

/** Extract the user message of a ready compile result. */
function userMessage(result: ReturnType<typeof compile>): string | null {
  if (!result.ready) return null;
  const user = result.messages.find(m => m.role === 'user') as
    | ChatMessage
    | undefined;
  return user ? String(user.content ?? '') : null;
}

/** Bullet lines inside the 【硬约束】 block (stripped of the `- ` prefix). */
function hardBullets(result: ReturnType<typeof compile>): string[] {
  const content = userMessage(result);
  if (!content) return [];
  const lines = content.split('\n');
  const start = lines.findIndex(l => l.trim() === '【硬约束】');
  if (start < 0) return [];
  const bullets: string[] = [];
  let inBlock = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('- ')) {
      inBlock = true;
      bullets.push(line.slice(2).trim());
      continue;
    }
    if (inBlock) break;
  }
  return bullets;
}

describe('compileFinalReviserStageRequest — hard constraints', () => {
  test('Chinese constraints stay whole sentences (no single-char bullets)', () => {
    const result = compile({
      constraints: {
        relevantCharacterConstraints: '角色「林晚」是女主角，性格冷静果断，擅长推理。',
        relevantWorldRules: '世界规则：灵气复苏初期，普通人类不知道灵气存在。',
      },
    });
    expect(result.ready).toBe(true);
    // eslint-disable-next-line no-console
    console.log('DEBUG bullets:', JSON.stringify(hardBullets(result)));
    const bullets = hardBullets(result);
    expect(bullets).toContain('角色「林晚」是女主角，性格冷静果断，擅长推理。');
    expect(bullets).toContain(
      '世界规则：灵气复苏初期，普通人类不知道灵气存在。',
    );
    for (const b of bullets) {
      expect(b.length).toBeGreaterThan(1);
    }
  });

  test('multi-line constraint blocks keep every line', () => {
    const result = compile({
      constraints: {
        relevantCharacterConstraints:
          '林晚的左眼在十年前失明。\n林晚从不提及失明的原因。',
      },
    });
    expect(result.ready).toBe(true);
    const bullets = hardBullets(result);
    expect(bullets).toEqual([
      '林晚的左眼在十年前失明。',
      '林晚从不提及失明的原因。',
    ]);
  });

  test('Emoji and special characters survive intact', () => {
    const result = compile({
      constraints: {
        relevantCharacterConstraints: '规则：😀 对话中不要出现表情符号（emoji）。',
      },
    });
    expect(result.ready).toBe(true);
    expect(hardBullets(result)).toContain(
      '规则：😀 对话中不要出现表情符号（emoji）。',
    );
  });

  test('over-budget clipping never yields single-char bullets', () => {
    const longConstraint =
      '这条硬约束非常长，反复强调剧情必须沿着大纲主线推进，' +
      '主角不能提前知道后续情节，配角之间不得提前交换关键情报，' +
      '章节结尾必须停留在悬念处，' +
      '并且整章字数需要保持在目标区间之内，不能明显超长也不能明显过短。'.repeat(
        30,
      );
    const result = compile({
      constraints: {
        relevantCharacterConstraints: longConstraint,
        relevantWorldRules: '世界规则：凡人不知灵气存在。',
      },
      maxTokens: 64,
      contextWindow: 4096,
    });
    expect(result.ready).toBe(true);
    const bullets = hardBullets(result);
    for (const b of bullets) {
      expect(b.length).toBeGreaterThan(1);
    }
  });

  test('constraints already inside the contract are not re-injected', () => {
    const shared = '世界规则：灵气复苏初期，普通人类不知道灵气存在。';
    const result = compile({
      constraints: { relevantWorldRules: shared },
      contractHard: [shared],
    });
    expect(result.ready).toBe(true);
    const bullets = hardBullets(result);
    expect(bullets).not.toContain(shared);
  });

  test('duplicate lines across sources are deduped, order preserved', () => {
    const shared = '重复出现的同一条约束。';
    const result = compile({
      constraints: {
        relevantCharacterConstraints: `${shared}\n角色专属约束。`,
        relevantWorldRules: `${shared}\n世界规则。`,
      },
    });
    expect(result.ready).toBe(true);
    const bullets = hardBullets(result);
    expect(bullets).toEqual([
      shared,
      '角色专属约束。',
      '世界规则。',
    ]);
  });

  test('empty constraint blocks produce no hard-constraints section', () => {
    const result = compile({ constraints: {} });
    expect(result.ready).toBe(true);
    expect(userMessage(result)).not.toContain('【硬约束】');
  });

  test('budget allocation still accounts for the full constraint text', () => {
    const text = '这是一段用于预算分配的完整约束文本。';
    const result = compile({
      constraints: { relevantCharacterConstraints: text },
    });
    expect(result.ready).toBe(true);
    expect(result.estimatedInputTokens).toBeGreaterThan(0);
  });
});
