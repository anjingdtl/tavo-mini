import fixture from './fixtures/sillytavern/Default.json';
import {
  exportNewWriterStyleAsTavern,
  exportSillyTavernOpenAIPreset,
  isSillyTavernOpenAIPreset,
  parseSillyTavernOpenAIPreset,
  patchManagedWriterStylePrompt,
} from '../src/services/writerStyle/tavernAdapter';

describe('SillyTavern openai_preset compatibility', () => {
  it('preserves official-shaped prompts, order and unknown fields untouched', () => {
    expect(isSillyTavernOpenAIPreset(fixture)).toBe(true);
    const parsed = parseSillyTavernOpenAIPreset(fixture, 'Default.json');
    const exported = exportSillyTavernOpenAIPreset(parsed.envelope);
    expect(exported).toEqual(fixture);
    expect(parsed.envelope.rawPreset.prompt_order).toEqual(fixture.prompt_order);
    expect(parsed.envelope.rawPreset.stream_openai).toBe(fixture.stream_openai);
    expect(parsed.envelope.promptMappings?.map(item => item.mapping)).toEqual([
      'preserved_not_injected',
      'preserved_not_injected',
      'handled_by_shinewriter_module',
      'preserved_not_injected',
      'handled_by_shinewriter_module',
      'handled_by_shinewriter_module',
      'handled_by_shinewriter_module',
      'handled_by_shinewriter_module',
      'handled_by_shinewriter_module',
      'handled_by_shinewriter_module',
      'handled_by_shinewriter_module',
      'handled_by_shinewriter_module',
    ]);
  });

  it('patches only a managed prompt and preserves all existing prompt fields', () => {
    const parsed = parseSillyTavernOpenAIPreset(fixture, 'Default.json');
    const next = patchManagedWriterStylePrompt(parsed.envelope, {
      ...parsed.semantic,
      name: '新作家风格',
    });
    const exported = exportSillyTavernOpenAIPreset(next, {
      ...parsed.semantic,
      name: '新作家风格',
    });
    expect(exported.stream_openai).toBe(fixture.stream_openai);
    expect((exported.prompt_order as any[])[0].order).toEqual([
      ...(fixture.prompt_order as any[])[0].order,
      { identifier: 'shinewriterWriterStyle', enabled: true },
    ]);
    expect((exported.prompts as any[]).some(item => item.identifier === 'shinewriterWriterStyle')).toBe(true);
    expect((exported.prompts as any[]).find(item => item.identifier === 'charDescription')).toEqual(
      (fixture.prompts as any[]).find(item => item.identifier === 'charDescription'),
    );
  });

  it('exports a new semantic style that can be imported again', () => {
    const parsed = parseSillyTavernOpenAIPreset(fixture, 'Default.json');
    const exported = exportNewWriterStyleAsTavern(parsed.semantic);
    const roundTrip = parseSillyTavernOpenAIPreset(exported, 'generated.json');
    expect(roundTrip.semantic.version).toBe(1);
    expect(roundTrip.envelope.rawPreset.prompt_order).toHaveLength(1);
  });

  it('rejects unsupported preset types without writing an asset', () => {
    expect(() => parseSillyTavernOpenAIPreset({ type: 'instruct', prompts: [], prompt_order: [] })).toThrow(
      'TAVERN_PRESET_UNSUPPORTED',
    );
  });
});
