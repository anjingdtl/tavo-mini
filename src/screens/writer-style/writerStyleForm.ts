import { normalizeWriterStyleSemantic } from '../../services/writerStyle/semantic';
import type {
  WriterStyleAsset,
  WriterStyleSemanticV1,
} from '../../services/writerStyle/types';
import { semanticForWriterStyleEditor } from '../../services/writerStyle/editor';

export type WriterStyleFormState = {
  name: string;
  description: string;
  genresText: string;
  audience: string;
  tone: string;
  pointOfView: string;
  narratorDistance: string;
  viewpointSwitching: string;
  interiority: string;
  texture: string;
  syntax: string;
  vocabulary: string;
  paragraphStructure: string;
  sceneEnvironment: string;
  characterPresentation: string;
  characterVoice: string;
  dialogue: string;
  pacing: string;
  conflict: string;
  informationReveal: string;
  suspense: string;
  foreshadowing: string;
  chapterStructure: string;
  continuity: string;
  imagery: string;
  sensory: string;
  prohibitions: string[];
  extraInstructions: string[];
  temperature: string;
  topP: string;
  maxTokens: string;
  isDefault: boolean;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function formFromWriterStyleAsset(
  asset: Pick<
    WriterStyleAsset,
    | 'name'
    | 'semantic_json'
    | 'system_prompt'
    | 'writing_style'
    | 'extra_instructions'
    | 'temperature'
    | 'top_p'
    | 'max_tokens'
    | 'is_default'
  >,
): WriterStyleFormState {
  const semantic = semanticForWriterStyleEditor(asset);
  return {
    name: semantic.name || asset.name || '',
    description: text(semantic.description),
    genresText: (semantic.applicability.genres || []).join('、'),
    audience: text(semantic.applicability.audience),
    tone: text(semantic.applicability.tone),
    pointOfView: text(semantic.narration.pointOfView),
    narratorDistance: text(semantic.narration.narratorDistance),
    viewpointSwitching: text(semantic.narration.viewpointSwitching),
    interiority: text(semantic.narration.interiority),
    texture: text(semantic.language.texture),
    syntax: text(semantic.language.syntax),
    vocabulary: text(semantic.language.vocabulary),
    paragraphStructure: text(semantic.language.paragraphStructure),
    sceneEnvironment: text(semantic.sceneAndCharacter.sceneEnvironment),
    characterPresentation: text(semantic.sceneAndCharacter.characterPresentation),
    characterVoice: text(semantic.sceneAndCharacter.characterVoice),
    dialogue: text(semantic.sceneAndCharacter.dialogue),
    pacing: text(semantic.narrativeMechanics.pacing),
    conflict: text(semantic.narrativeMechanics.conflict),
    informationReveal: text(semantic.narrativeMechanics.informationReveal),
    suspense: text(semantic.narrativeMechanics.suspense),
    foreshadowing: text(semantic.narrativeMechanics.foreshadowing),
    chapterStructure: text(semantic.narrativeMechanics.chapterStructure),
    continuity: text(semantic.narrativeMechanics.continuity),
    imagery: text(semantic.literaryTexture.imagery),
    sensory: text(semantic.literaryTexture.sensory),
    prohibitions: [...(semantic.prohibitions || [])],
    extraInstructions: [...(semantic.extraInstructions || [])],
    temperature: String(asset.temperature ?? 0.8),
    topP: String(asset.top_p ?? 0.9),
    maxTokens: String(asset.max_tokens ?? 4000),
    isDefault: asset.is_default === 1,
  };
}

export function formToWriterStyleSemantic(
  form: WriterStyleFormState,
): WriterStyleSemanticV1 {
  const genres = form.genresText
    .split(/[、,，]/)
    .map(item => item.trim())
    .filter(Boolean);
  return normalizeWriterStyleSemantic(
    {
      name: form.name.trim() || '未命名作家风格',
      description: form.description,
      applicability: {
        genres,
        audience: form.audience,
        tone: form.tone,
      },
      narration: {
        pointOfView: form.pointOfView,
        narratorDistance: form.narratorDistance,
        viewpointSwitching: form.viewpointSwitching,
        interiority: form.interiority,
      },
      language: {
        texture: form.texture,
        syntax: form.syntax,
        vocabulary: form.vocabulary,
        paragraphStructure: form.paragraphStructure,
      },
      sceneAndCharacter: {
        sceneEnvironment: form.sceneEnvironment,
        characterPresentation: form.characterPresentation,
        characterVoice: form.characterVoice,
        dialogue: form.dialogue,
      },
      narrativeMechanics: {
        pacing: form.pacing,
        conflict: form.conflict,
        informationReveal: form.informationReveal,
        suspense: form.suspense,
        foreshadowing: form.foreshadowing,
        chapterStructure: form.chapterStructure,
        continuity: form.continuity,
      },
      literaryTexture: {
        imagery: form.imagery,
        sensory: form.sensory,
      },
      prohibitions: form.prohibitions,
      extraInstructions: form.extraInstructions,
    },
    form.name.trim() || '未命名作家风格',
  );
}

export function writerStyleFormSnapshot(form: WriterStyleFormState): string {
  return JSON.stringify(form);
}
