import type { PipelineStageName } from '../../types/pipeline';

export const WRITER_STYLE_SEMANTIC_VERSION = 1 as const;
export const PRESET_ASSET_CONTRACT_VERSION = 2 as const;
export const TAVERN_OPENAI_COMPATIBILITY_VERSION = 1 as const;
export const WRITER_STYLE_COMPILER_VERSION = 'writer-style-v1';
export const WRITER_STYLE_PROJECTION_COMPILER_VERSION =
  'writer-style-projection-v1';

export type WriterStyleSourceFormat =
  | 'shinewriter'
  | 'legacy_shinewriter'
  | 'sillytavern_openai'
  | 'default_runtime_baseline';

export interface WriterStyleSemanticV1 {
  version: 1;
  name: string;
  description?: string;
  applicability: {
    genres?: string[];
    audience?: string;
    tone?: string;
  };
  narration: {
    pointOfView?: string;
    narratorDistance?: string;
    viewpointSwitching?: string;
    interiority?: string;
  };
  language: {
    texture?: string;
    syntax?: string;
    vocabulary?: string;
    paragraphStructure?: string;
  };
  sceneAndCharacter: {
    sceneEnvironment?: string;
    characterPresentation?: string;
    characterVoice?: string;
    dialogue?: string;
  };
  narrativeMechanics: {
    pacing?: string;
    conflict?: string;
    informationReveal?: string;
    suspense?: string;
    foreshadowing?: string;
    chapterStructure?: string;
    continuity?: string;
  };
  literaryTexture: {
    imagery?: string;
    sensory?: string;
  };
  prohibitions?: string[];
  extraInstructions?: string[];
}

export type TavernRuntimeMapping =
  | 'injected_as_writer_style'
  | 'preserved_not_injected'
  | 'handled_by_shinewriter_module'
  | 'unsupported';

export interface TavernPromptMapping {
  identifier?: string;
  name?: string;
  mapping: TavernRuntimeMapping;
  reason: string;
  resolvedMacros?: string[];
  unresolvedMacros?: string[];
}

export interface PresetCompatibilityEnvelopeV1 {
  version: 1;
  format: 'sillytavern_openai_preset';
  importedAt?: number;
  sourceName?: string;
  rawPreset: Record<string, unknown>;
  sourceFingerprint: string;
  managedPromptIdentifier?: string;
  promptMappings?: TavernPromptMapping[];
  compatibilityNotes?: string[];
  semanticDirty?: boolean;
}

export interface WriterStyleSamplerResolution {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  preservedFields: string[];
  ignoredAtPipeline: string[];
}

export interface FrozenWriterStyleProjection {
  stage: PipelineStageName;
  mode: 'FULL' | 'EVALUATION' | 'HARD' | 'MINIMAL';
  protected: true;
  text: string;
  estimatedTokens: number;
  compilerVersion: string;
}

export interface FrozenWriterStyleV1 {
  semanticVersion: 1;
  assetId: number | null;
  assetName: string;
  sourceFormat: WriterStyleSourceFormat;
  semantic: WriterStyleSemanticV1 | null;
  legacySystemText?: string;
  legacyWritingStyleText?: string;
  legacyExtraInstructionsText?: string;
  sourceFingerprint: string;
  compatibilityFingerprint?: string;
  samplerResolution: WriterStyleSamplerResolution;
  stageProjections: {
    draft: FrozenWriterStyleProjection;
    review: FrozenWriterStyleProjection;
    factCheck: FrozenWriterStyleProjection;
    brief: FrozenWriterStyleProjection;
    proof: FrozenWriterStyleProjection;
  };
  compatibilitySummary?: {
    promptCount: number;
    injectedCount: number;
    handledByModuleCount: number;
    preservedCount: number;
    unknownFieldCount: number;
  };
}

export interface WriterStyleAssetFields {
  semantic_json?: string | null;
  compatibility_json?: string | null;
  source_format?: WriterStyleSourceFormat | null;
  source_fingerprint?: string | null;
  compatibility_fingerprint?: string | null;
  asset_contract_version?: number | null;
}

export interface WriterStyleAsset extends WriterStyleAssetFields {
  id: number;
  project_id: number;
  name: string;
  is_default: number;
  system_prompt: string;
  writing_style: string;
  temperature: number;
  top_p: number;
  max_tokens: number;
  extra_instructions: string;
  enabled_for_project?: number;
}

export interface WriterStylePreview {
  activeStyle: {
    id: number | null;
    name: string;
    source: WriterStyleSourceFormat;
    fingerprint: string;
    status: 'Protected' | 'Default';
  };
  projection: FrozenWriterStyleProjection;
  compatibility?: FrozenWriterStyleV1['compatibilitySummary'];
  sampler: WriterStyleSamplerResolution;
}
