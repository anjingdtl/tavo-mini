import fixture from './fixtures/sillytavern/Default.json';
import {
  buildWriterStyleSemanticUpdate,
  semanticForWriterStyleEditor,
} from '../src/services/writerStyle/editor';
import { parseSillyTavernOpenAIPreset } from '../src/services/writerStyle/tavernAdapter';

describe('Writer Style Semantic editor contract', () => {
  it('upgrades legacy rows and makes Semantic plus runtime projection authoritative', () => {
    const legacy = {
      name: '旧风格',
      semantic_json: null,
      system_prompt: '克制叙述',
      writing_style: '短句、冷色调',
      extra_instructions: '不要解释创作过程',
      source_format: 'legacy_shinewriter' as const,
      compatibility_json: null,
      compatibility_fingerprint: null,
    };
    const semantic = semanticForWriterStyleEditor(legacy);
    semantic.name = '新风格';
    semantic.language.texture = '长短句交替';
    const update = buildWriterStyleSemanticUpdate({ asset: legacy, semantic });
    expect(JSON.parse(update.semantic_json)).toEqual(semantic);
    expect(update.name).toBe('新风格');
    expect(update.writing_style).toContain('长短句交替');
    expect(update.source_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(update.asset_contract_version).toBe(2);
  });

  it('marks Tavern semanticDirty and patches only the owned compatibility prompt', () => {
    const parsed = parseSillyTavernOpenAIPreset(fixture, 'Default.json');
    const asset = {
      name: parsed.semantic.name,
      semantic_json: JSON.stringify(parsed.semantic),
      system_prompt: parsed.legacy.systemPrompt,
      writing_style: parsed.legacy.writingStyle,
      extra_instructions: parsed.legacy.extraInstructions,
      source_format: 'sillytavern_openai' as const,
      compatibility_json: JSON.stringify(parsed.envelope),
      compatibility_fingerprint: parsed.envelope.sourceFingerprint,
    };
    const semantic = semanticForWriterStyleEditor(asset);
    semantic.narrativeMechanics.pacing = '快节奏';
    const update = buildWriterStyleSemanticUpdate({ asset, semantic });
    const envelope = JSON.parse(update.compatibility_json!);
    expect(envelope.semanticDirty).toBe(true);
    expect(envelope.managedPromptIdentifier).toBe('shinewriterWriterStyle');
    expect(update.compatibility_fingerprint).toBe(parsed.envelope.sourceFingerprint);
  });
});
