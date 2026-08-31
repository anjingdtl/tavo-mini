import { freezeWriterStyle } from '../src/services/writerStyle/compiler';
import type {
  BlindStyleAnnotation,
  NarrativeQualityDimension,
} from '../scripts/qa/writerStyleAdherence';
import {
  assessWriterStyleAcceptance,
  buildNarrativeQualityEvidence,
  evaluateDeterministicWriterStyle,
  evaluateWriterStyleSample,
  fingerprintStyleRequirementProjection,
  projectOriginalStyleProfileRequirements,
  projectWriterStyleRequirements,
  redactWriterStyleEvidence,
} from '../scripts/qa/writerStyleAdherence';

function frozenStyle() {
  return freezeWriterStyle({
    id: 21,
    project_id: 0,
    name: '冷静限知',
    is_default: 0,
    system_prompt: '',
    writing_style: '',
    temperature: 0.7,
    top_p: 1,
    max_tokens: 0,
    extra_instructions: '',
    source_format: 'shinewriter',
    source_fingerprint: 'writer-style-contract-fingerprint',
    semantic_json: JSON.stringify({
      version: 1,
      name: '冷静限知',
      applicability: { tone: '冷静克制' },
      narration: {
        pointOfView: '第三人称限知',
        narratorDistance: '中近距离',
        viewpointSwitching: '只随主角切换',
        interiority: '少量心理直述，以动作承载情绪',
      },
      language: {
        texture: '具体克制',
        syntax: '短句与长句交替，冲突处短句',
        vocabulary: '避免浮夸形容',
        paragraphStructure: '动作与反应分段',
      },
      sceneAndCharacter: {
        sceneEnvironment: '环境只写与人物感知相关的细节',
        characterPresentation: '通过选择和动作呈现人物',
        characterVoice: '人物口吻有区分',
        dialogue: '对白短促，少解释性台词',
      },
      narrativeMechanics: {
        pacing: '冲突逐步升级',
        conflict: '每场至少有一次关系变化',
        informationReveal: '先细节后因果',
        suspense: '保留一个未解问题',
        foreshadowing: '伏笔可回溯',
        chapterStructure: '结尾留余味，不总结主题',
        continuity: '不改变已成立事实',
      },
      literaryTexture: {
        imagery: '意象克制',
        sensory: '优先视觉与听觉',
      },
      prohibitions: ['禁止上帝视角泄露未知信息'],
      extraInstructions: ['不得用作者旁白总结人物应该如何选择'],
    }),
  });
}

function completeAnnotation(
  projection: ReturnType<typeof projectWriterStyleRequirements>,
  assessment: 'satisfied' | 'violated' = 'satisfied',
): BlindStyleAnnotation {
  return {
    source: 'independent_evaluator',
    status: 'complete',
    rules: Object.fromEntries(
      projection.requirements.map(requirement => [
        requirement.id,
        { assessment },
      ]),
    ),
  };
}

function allNarrativePass() {
  const dimensions = Object.fromEntries(
    (
      [
        'sceneCompletion',
        'beatRealization',
        'characterConsistency',
        'causalContinuity',
        'endingEffectiveness',
      ] as NarrativeQualityDimension[]
    ).map(dimension => [
      dimension,
      { status: 'pass' as const, score: 3, evidenceCodes: [`${dimension}_observed`] },
    ]),
  );
  return buildNarrativeQualityEvidence({ dimensions });
}

describe('Phase IV-12A Writer Style Adherence Contract', () => {
  test('projects the frozen semantic Writer Style with traceable strengths', () => {
    const projection = projectWriterStyleRequirements(frozenStyle());
    expect(projection.completeness).toBe('complete');
    expect(projection.styleFingerprint).toBe('writer-style-contract-fingerprint');
    expect(projection.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'style:narration.pointOfView',
          category: 'POV',
          strength: 'MANDATORY',
        }),
        expect.objectContaining({
          id: 'style:narrativeMechanics.chapterStructure',
          category: 'ENDING',
          strength: 'PREFERRED',
        }),
        expect.objectContaining({
          id: 'style:prohibitions.0',
          category: 'PROHIBITION',
          strength: 'AVOID',
        }),
        expect.objectContaining({
          id: 'style:extraInstructions.0',
          strength: 'MANDATORY',
        }),
      ]),
    );
    expect(fingerprintStyleRequirementProjection(projection)).toBe(
      fingerprintStyleRequirementProjection(projectWriterStyleRequirements(frozenStyle())),
    );
  });

  test('does not turn a legacy or missing style into a vacuous PASS', () => {
    const legacy = projectWriterStyleRequirements(
      freezeWriterStyle({
        id: 22,
        project_id: 0,
        name: '旧风格',
        is_default: 0,
        system_prompt: '冷静叙事',
        writing_style: '少总结',
        extra_instructions: '',
        temperature: 0.7,
        top_p: 1,
        max_tokens: 0,
      }),
    );
    expect(legacy.completeness).toBe('legacy_unparsed');
    const legacySample = evaluateWriterStyleSample({
      projection: legacy,
      text: '正文',
      blindAnnotation: completeAnnotation(legacy),
    });
    expect(legacySample.writerStyle.evaluationStatus).toBe('incomplete_contract');
    expect(
      assessWriterStyleAcceptance({
        sample: legacySample,
        narrativeQuality: allNarrativePass(),
      }).status,
    ).toBe('hold');

    const missing = projectWriterStyleRequirements(null);
    expect(missing.completeness).toBe('missing');
  });

  test('deterministic POV check ignores dialogue but catches narrator drift and forbidden text', () => {
    const projection = projectWriterStyleRequirements(frozenStyle());
    const clean = evaluateDeterministicWriterStyle({
      projection,
      text: '他盯着门缝。\n“我知道你会来。”她说。',
    });
    expect(clean.findings).toEqual([]);

    const drift = evaluateDeterministicWriterStyle({
      projection,
      text: '我看见门缝里的光，随后作者告诉读者真相。',
    });
    expect(drift.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ findingType: 'pov_drift', hardStyleViolation: true }),
      ]),
    );

    const forbidden = evaluateDeterministicWriterStyle({
      projection,
      text: '他用上帝视角泄露未知信息。',
    });
    expect(forbidden.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          findingType: 'forbidden_pattern',
          hardStyleViolation: true,
        }),
      ]),
    );
  });

  test('combines blind rule assessments with the five narrative dimensions', () => {
    const projection = projectWriterStyleRequirements(frozenStyle());
    const sample = evaluateWriterStyleSample({
      projection,
      text: '他停在门前。\n“我知道你会来。”她说。',
      blindAnnotation: completeAnnotation(projection),
    });
    expect(sample.writerStyle.mandatoryPass).toBe(true);
    expect(sample.writerStyle.hardStyleViolationCount).toBe(0);
    expect(sample.writerStyle.writerStyleAdherenceRate).toBe(1);
    expect(sample.writerStyle.styleDriftCount).toBe(0);

    const acceptance = assessWriterStyleAcceptance({
      sample,
      narrativeQuality: allNarrativePass(),
    });
    expect(acceptance.status).toBe('pass');

    const redacted = redactWriterStyleEvidence(sample);
    expect(redacted.bodyPolicy).toContain('no prompts');
    expect(JSON.stringify(redacted)).not.toContain('第三人称限知');
    expect(JSON.stringify(redacted)).not.toContain('他停在门前');
    expect(redacted.writerStyle.mandatoryRuleIds).toContain(
      'style:narration.pointOfView',
    );
  });

  test('requires complete blind assessment and records a violated preferred rule as drift', () => {
    const projection = projectWriterStyleRequirements(frozenStyle());
    const annotation = completeAnnotation(projection);
    annotation.rules['style:narrativeMechanics.chapterStructure'] = {
      assessment: 'violated',
      evidenceCodes: ['template_ending_detected'],
    };
    const sample = evaluateWriterStyleSample({
      projection,
      text: '他停在门前。',
      blindAnnotation: annotation,
    });
    expect(sample.writerStyle.hardStyleViolationCount).toBe(0);
    expect(sample.writerStyle.styleDriftCount).toBe(1);
    expect(sample.writerStyle.writerStyleAdherenceRate).toBeLessThan(1);
    expect(sample.writerStyle.evaluationStatus).toBe('pass');

    const partial = evaluateWriterStyleSample({
      projection,
      text: '他停在门前。',
      blindAnnotation: {
        source: 'human',
        status: 'partial',
        rules: {},
      },
    });
    expect(partial.writerStyle.evaluationStatus).toBe('manual_required');
    expect(partial.writerStyle.writerStyleAdherenceRate).toBeNull();
  });

  test('projects the continuation Original Style Profile without changing production rendering', () => {
    const projection = projectOriginalStyleProfileRequirements({
      profile: {
        global: {
          narrative: {
            person: '第三人称限知',
            narrativeDistance: '中近距离',
            focalization: '跟随主角',
          },
          tone: { baseline: '冷静' },
          diction: { expressionsToAvoid: ['总而言之'] },
        },
        globalAvoid: ['作者总结'],
      },
      profileId: 'style-profile-1',
      styleFingerprint: 'profile-fingerprint',
    });
    expect(projection.completeness).toBe('complete');
    expect(projection.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'style:global.narrative.person', strength: 'MANDATORY' }),
        expect.objectContaining({ category: 'PROHIBITION', strength: 'AVOID' }),
      ]),
    );
  });
});
