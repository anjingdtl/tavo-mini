import { semanticFingerprint, semanticToRuntimeText, normalizeWriterStyleSemantic } from './semantic';
import { patchManagedWriterStylePrompt } from './tavernAdapter';
import type {
  PresetCompatibilityEnvelopeV1,
  WriterStyleAsset,
  WriterStyleSemanticV1,
  WriterStyleSourceFormat,
} from './types';

export interface WriterStyleSemanticUpdate {
  name: string;
  semantic_json: string;
  system_prompt: string;
  writing_style: string;
  extra_instructions: string;
  source_format: WriterStyleSourceFormat;
  source_fingerprint: string;
  compatibility_json?: string | null;
  compatibility_fingerprint?: string | null;
  asset_contract_version: 2;
}
function parseCompatibility(value: string | null | undefined):
  | PresetCompatibilityEnvelopeV1
  | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as PresetCompatibilityEnvelopeV1;
    return parsed && parsed.format === 'sillytavern_openai_preset'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Return the authoritative Semantic model shown by the library editor.
 * Legacy rows are upgraded deterministically from their three compatibility
 * fields; those fields are never treated as the runtime source after save.
 */
export function semanticForWriterStyleEditor(
  asset: Pick<WriterStyleAsset, 'name' | 'semantic_json' | 'system_prompt' | 'writing_style' | 'extra_instructions'>,
): WriterStyleSemanticV1 {
  if (asset.semantic_json) {
    try {
      return normalizeWriterStyleSemantic(JSON.parse(asset.semantic_json), asset.name);
    } catch {
      // Fall through to a safe legacy upgrade instead of exposing invalid JSON.
    }
  }
  return normalizeWriterStyleSemantic(
    {
      name: asset.name,
      applicability: { tone: asset.system_prompt },
      language: { texture: asset.writing_style },
      extraInstructions: asset.extra_instructions
        ? [asset.extra_instructions]
        : undefined,
    },
    asset.name,
  );
}

/**
 * Compile one Semantic edit into the DB projection contract. The returned
 * legacy columns are deterministic previews only; Semantic, its fingerprint,
 * and the patched Tavern compatibility envelope are the runtime authority.
 */
export function buildWriterStyleSemanticUpdate(params: {
  asset: Pick<WriterStyleAsset, 'name' | 'semantic_json' | 'system_prompt' | 'writing_style' | 'extra_instructions' | 'source_format' | 'compatibility_json' | 'compatibility_fingerprint'>;
  semantic: unknown;
}): WriterStyleSemanticUpdate {
  const semantic = normalizeWriterStyleSemantic(
    params.semantic,
    params.asset.name || '未命名作家风格',
  );
  const runtime = semanticToRuntimeText(semantic);
  const sourceFormat =
    (params.asset.source_format as WriterStyleSourceFormat | null | undefined) ||
    'shinewriter';
  const runtimeText = [
    runtime.systemPrompt,
    runtime.writingStyle,
    runtime.extraInstructions,
  ]
    .filter(Boolean)
    .join('\n\n');
  const compatibility = parseCompatibility(params.asset.compatibility_json);
  const patchedCompatibility = compatibility
    ? patchManagedWriterStylePrompt(compatibility, semantic)
    : null;

  return {
    name: semantic.name,
    semantic_json: JSON.stringify(semantic),
    system_prompt: runtime.systemPrompt,
    writing_style: runtime.writingStyle,
    extra_instructions: runtime.extraInstructions,
    source_format: sourceFormat,
    source_fingerprint: semanticFingerprint(
      semantic,
      runtimeText,
      sourceFormat,
    ),
    ...(patchedCompatibility
      ? {
          compatibility_json: JSON.stringify(patchedCompatibility),
          compatibility_fingerprint:
            params.asset.compatibility_fingerprint ||
            patchedCompatibility.sourceFingerprint,
        }
      : params.asset.compatibility_json
        ? {
            compatibility_json: params.asset.compatibility_json,
            compatibility_fingerprint:
              params.asset.compatibility_fingerprint || null,
          }
        : { compatibility_json: null, compatibility_fingerprint: null }),
    asset_contract_version: 2,
  };
}
