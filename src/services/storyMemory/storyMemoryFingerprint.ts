import type { StoryMemoryState } from './storyMemoryTypes';

const PRIME_A = 4294967291;
const PRIME_B = 4294967279;

export function stableTextFingerprint(text: string): string {
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = (first * 16777619 + code + index) % PRIME_A;
    second = (second * 3266489917 + code * 131) % PRIME_B;
  }
  return `${first.toString(36).padStart(7, '0')}${second
    .toString(36)
    .padStart(7, '0')}`;
}

const SET_ARRAY_KEYS = new Set([
  'aliases',
  'stableTraits',
  'affiliations',
  'knowledge',
  'possessions',
  'secrets',
  'evidenceChapterIds',
  'parties',
  'ownerCharacterIds',
  'keywords',
]);

function canonicalize(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) {
    const values = value.map(item => canonicalize(item));
    if (SET_ARRAY_KEYS.has(parentKey)) {
      return Array.from(new Set(values.map(item => JSON.stringify(item))))
        .sort()
        .map(item => JSON.parse(item));
    }
    return values;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    Object.keys(value as Record<string, unknown>)
      .sort()
      .forEach(key => {
        result[key] = canonicalize(
          (value as Record<string, unknown>)[key],
          key,
        );
      });
    return result;
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function fingerprintStoryMemoryState(state: StoryMemoryState): string {
  const businessState = {
    schemaVersion: state.schemaVersion,
    projectId: state.projectId,
    throughChapterId: state.throughChapterId,
    throughChapterPosition: state.throughChapterPosition,
    characters: state.characters,
    relationships: state.relationships,
    mainline: state.mainline,
  };
  return stableTextFingerprint(canonicalStringify(businessState));
}

export function fingerprintChapterSource(input: {
  title: string;
  synopsis: string;
  content: string;
}): string {
  return stableTextFingerprint(
    `${input.title}\n${input.synopsis}\n${input.content}`,
  );
}
