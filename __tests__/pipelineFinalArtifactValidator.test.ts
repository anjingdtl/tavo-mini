/**
 * Local Final Artifact Validator tests (V5-Lite Phase 6 / §18.5).
 * Hard-fails ONLY technical delivery errors; never literary quality.
 */
import { validateFinalArtifact } from '../src/services/pipeline/finalArtifactValidator';

const DRAFT = Array(8)
  .fill('主角走进了森林，在溪边遇到老者。老者警告他不要靠近古井。他点头应下，继续赶路。')
  .join('\n\n');

describe('validateFinalArtifact — hard fails', () => {
  test('empty body fails', () => {
    const r = validateFinalArtifact({ text: '   ' });
    expect(r.valid).toBe(false);
    expect(r.code).toBe('empty');
  });

  test('reasoning-only fails', () => {
    const r = validateFinalArtifact({ text: '', reasoningText: '思考……' });
    expect(r.valid).toBe(false);
    expect(r.code).toBe('reasoning_only');
  });

  test('<think> leak fails', () => {
    const r = validateFinalArtifact({
      text: '<think>先分析再写</think>\n主角走向森林。',
    });
    expect(r.valid).toBe(false);
    expect(r.code).toBe('think_leak');
  });

  test('prompt leak fails', () => {
    const r = validateFinalArtifact({
      text: '你是终稿修订员。现在开始写：\n主角走向森林。',
    });
    expect(r.valid).toBe(false);
    expect(r.code).toBe('prompt_leak');
  });

  test('anchor marker leak fails', () => {
    const r = validateFinalArtifact({
      text: '主角走向森林。[draft-p-001]',
    });
    expect(r.valid).toBe(false);
    expect(r.code).toBe('anchor_marker_leak');
  });

  test('contract JSON echo fails', () => {
    const contractJson = JSON.stringify({
      schemaVersion: 1,
      compilerVersion: 1,
      draftHash: 'abc',
      workItems: [
        {
          id: 'r1',
          scope: 'chapter',
          dimension: '大纲',
          severity: 'hard',
          diagnosis: '缺节点',
          rewriteGoal: '补节点',
          preserveMeaning: [],
        },
      ],
    });
    const r = validateFinalArtifact({
      text: contractJson,
      contractJson,
    });
    expect(r.valid).toBe(false);
    expect(r.code).toBe('contract_json_leak');
  });

  test('patch / change-note leak fails', () => {
    for (const text of [
      '其余内容不变。主角走向森林。',
      '修改说明：已调整节奏。\n主角走向森林。',
    ]) {
      const r = validateFinalArtifact({ text });
      expect(r.valid).toBe(false);
      expect(r.code).toBe('patch_leak');
    }
  });

  test('whole-paragraph duplicate is a soft warning', () => {
    const longPara =
      '主角走向森林，风吹动树叶沙沙作响，光线透过树冠洒下来，他加快了脚步继续赶路。远处的鸟鸣声回荡在山谷之中，他深吸一口气，握紧了手中的行囊。'.repeat(
        2,
      );
    expect(longPara.length).toBeGreaterThanOrEqual(100);
    const para = Array(4).fill(longPara).join('\n');
    const r = validateFinalArtifact({ text: para });
    expect(r.valid).toBe(true);
    expect(r.code).toBe('ok');
    expect(r.warnings).toContain('whole_paragraph_duplicate');
  });

  test('finishReason=length with complete ellipsis-ending body passes', () => {
    const r = validateFinalArtifact({
      text: '主角走向森林……',
      finishReason: 'length',
    });
    expect(r.valid).toBe(true);
    expect(r.code).toBe('ok');
  });

  test('finishReason=length with full chapter body passes', () => {
    const r = validateFinalArtifact({
      text: DRAFT,
      finishReason: 'length',
      canonicalDraft: DRAFT,
    });
    expect(r.valid).toBe(true);
    expect(r.code).toBe('ok');
  });

  test('finishReason=length + cut sentence tail fails', () => {
    const r = validateFinalArtifact({
      text: '主角加快了脚步，穿过树林，绕过溪流，向着远处的山脊前进，风声在耳边呼啸',
      finishReason: 'length',
    });
    expect(r.valid).toBe(false);
    expect(r.code).toBe('finish_length_incomplete');
  });

  test('finishReason=length + unclosed quote fails', () => {
    const r = validateFinalArtifact({
      text: '老者抬头说道：“你终于来了，我等了你十年',
      finishReason: 'length',
    });
    expect(r.valid).toBe(false);
    expect(r.code).toBe('finish_length_incomplete');
  });

  test('finishReason=length + omission marker fails', () => {
    const r = validateFinalArtifact({
      text: '他们一路向北走了三天三夜，途中经历了不少艰险，其余内容省略',
      finishReason: 'length',
    });
    expect(r.valid).toBe(false);
    expect(r.code).toBe('finish_length_incomplete');
  });

  test('finishReason=length + unclosed fence fails', () => {
    const r = validateFinalArtifact({
      text: '主角走向森林。\n```',
      finishReason: 'length',
    });
    expect(r.valid).toBe(false);
    expect(r.code).toBe('finish_length_incomplete');
  });

  test('catastrophic collapse + summary signal is a soft warning', () => {
    const r = validateFinalArtifact({
      text: '以上为本章内容摘要，其余内容省略。',
      canonicalDraft: DRAFT,
    });
    expect(r.valid).toBe(true);
    expect(r.code).toBe('ok');
    expect(r.warnings).toContain('catastrophic_collapse');
  });

  test('tail stops at unclosed fence fails', () => {
    const r = validateFinalArtifact({ text: '主角走向森林。\n```' });
    expect(r.valid).toBe(false);
    expect(r.code).toBe('finish_length_incomplete');
  });
});

describe('validateFinalArtifact — soft heuristics never fail', () => {
  test('short but complete chapter passes', () => {
    const r = validateFinalArtifact({ text: '主角走向森林。' });
    expect(r.valid).toBe(true);
    expect(r.code).toBe('ok');
  });

  test('novel words 总结/最终 do not trip collapse', () => {
    const r = validateFinalArtifact({
      text: '最终，他抵达森林，回头总结此行所见。',
      canonicalDraft: DRAFT,
    });
    expect(r.valid).toBe(true);
  });

  test('slightly short ratio without summary signals passes', () => {
    const r = validateFinalArtifact({
      text: '他抵达森林。',
      canonicalDraft: DRAFT,
    });
    expect(r.valid).toBe(true);
  });

  test('normal full chapter passes', () => {
    const r = validateFinalArtifact({
      text: DRAFT,
      finishReason: 'stop',
      canonicalDraft: DRAFT,
    });
    expect(r.valid).toBe(true);
  });

  test('repeated short paragraphs are not duplicates', () => {
    const r = validateFinalArtifact({
      text: '走吧。\n走吧。\n走吧。',
    });
    expect(r.valid).toBe(true);
  });
});
