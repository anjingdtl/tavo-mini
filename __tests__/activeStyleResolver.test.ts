import type { WriterStyleAsset } from '../src/services/writerStyle/types';
import {
  ACTIVE_WRITER_STYLE_ERROR_CODE,
  resolveWriterStyleSelection,
} from '../src/services/writerStyle/activeStyleResolver';

function asset(): WriterStyleAsset {
  return {
    id: 7,
    project_id: 1,
    name: '冷峻悬疑',
    is_default: 0,
    system_prompt: '保持冷峻',
    writing_style: '',
    temperature: 0.7,
    top_p: 1,
    max_tokens: 0,
    extra_instructions: '不写超自然',
    semantic_json: '',
    compatibility_json: '',
    source_format: 'legacy_shinewriter',
    source_fingerprint: 'fp',
    asset_contract_version: 2,
  };
}

test('active writer style resolver has one decision for empty, missing and normal states', () => {
  const empty = resolveWriterStyleSelection({ projectId: 1, activeStyleId: null, asset: null });
  expect(empty.writerStyle.assetId).toBe(0);
  expect(empty.draftPreset).toBeNull();

  try {
    resolveWriterStyleSelection({ projectId: 1, activeStyleId: 7, asset: null });
    throw new Error('expected missing active writer style to throw');
  } catch (error) {
    expect(error).toMatchObject({ code: ACTIVE_WRITER_STYLE_ERROR_CODE });
  }

  const normal = resolveWriterStyleSelection({ projectId: 1, activeStyleId: 7, asset: asset() });
  expect(normal.writerStyle.assetId).toBe(7);
  expect(normal.draftPreset?.id).toBe(7);
  expect(normal.draftPreset?.system_prompt).toContain('WRITER_STYLE_PROTECTED_V5');
});
