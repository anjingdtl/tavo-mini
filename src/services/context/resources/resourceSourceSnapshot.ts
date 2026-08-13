import * as db from '../../database';
import type { Preset } from '../../../types/novel';
import { computeResourceSourceFingerprint } from './resourceFingerprint';
import { ResourceContextError } from './resourceContextErrors';
import type { FrozenSourceRecord, ResourceSourceSnapshot } from './resourceAwarenessTypes';
import {
  characterSemanticSource,
  parseCharacterSourcePayload,
} from './characterAwarenessCompiler';
import {
  parseWorldbookSourcePayload,
  worldbookSemanticSource,
} from './worldbookAwarenessCompiler';
import { CHARACTER_AWARENESS_COMPILER_VERSION } from './resourceAwarenessTypes';
import { WORLDBOOK_AWARENESS_COMPILER_VERSION } from './resourceAwarenessTypes';

const SOURCE_SNAPSHOT_COMPILER = 'resource-source-snapshot-v1';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function freezeCharacter(raw: unknown, index: number): FrozenSourceRecord {
  const parsed = parseCharacterSourcePayload(raw);
  const payload = JSON.stringify(raw ?? {});
  return {
    kind: 'character',
    id: parsed.id || index + 1,
    title: parsed.name || `角色#${parsed.id || index + 1}`,
    updatedAt: parsed.updatedAt,
    payload,
    fingerprint: computeResourceSourceFingerprint({
      kind: 'character',
      id: parsed.id || index + 1,
      semanticContent: characterSemanticSource(parsed.dataJson, parsed.name),
      compilerVersion: CHARACTER_AWARENESS_COMPILER_VERSION,
    }),
  };
}

function freezeWorldbook(raw: unknown, index: number): FrozenSourceRecord {
  const parsed = parseWorldbookSourcePayload(raw);
  return {
    kind: 'worldbook',
    id: parsed.id || index + 1,
    title: parsed.title,
    updatedAt: parsed.updatedAt,
    payload: JSON.stringify(raw ?? {}),
    fingerprint: computeResourceSourceFingerprint({
      kind: 'worldbook',
      id: parsed.id || index + 1,
      semanticContent: worldbookSemanticSource(parsed),
      compilerVersion: WORLDBOOK_AWARENESS_COMPILER_VERSION,
    }),
  };
}

function freezeNote(raw: unknown, content: string, index: number): FrozenSourceRecord {
  const record = asRecord(raw);
  const id = Number(record.id) || index + 1;
  const title = String(record.title || `笔记#${id}`);
  const body = content || String(record.content || '');
  return {
    kind: 'note',
    id,
    title,
    updatedAt: (record.updated_at ?? record.updatedAt) as string | number | undefined,
    payload: JSON.stringify({ ...record, content: body }),
    fingerprint: computeResourceSourceFingerprint({
      kind: 'note',
      id,
      semanticContent: `${title}\n${body}`,
      compilerVersion: SOURCE_SNAPSHOT_COMPILER,
    }),
  };
}

function freezePreset(preset: Preset): FrozenSourceRecord {
  const semantic = [
    preset.system_prompt || '',
    preset.writing_style || '',
    preset.extra_instructions || '',
  ].join('\n');
  return {
    kind: 'preset',
    id: Number(preset.id),
    title: preset.name || '预设',
    payload: JSON.stringify(preset),
    fingerprint: computeResourceSourceFingerprint({
      kind: 'preset',
      id: Number(preset.id),
      semanticContent: semantic,
      compilerVersion: 'preset-context-v1',
    }),
  };
}

export function snapshotFingerprint(snapshot: ResourceSourceSnapshot): string {
  const parts = [
    ...snapshot.characters.map(item => item.fingerprint),
    ...snapshot.worldbookEntries.map(item => item.fingerprint),
    ...snapshot.notes.map(item => item.fingerprint),
    snapshot.preset?.fingerprint || '',
    snapshot.includeResources ? '1' : '0',
  ];
  return computeResourceSourceFingerprint({
    kind: 'resource-source-snapshot',
    id: 'view',
    semanticContent: parts.join('|'),
    compilerVersion: SOURCE_SNAPSHOT_COMPILER,
  });
}

async function readSourcePayloads(
  projectId: number,
  includeResources: boolean,
  preset?: Preset | null,
): Promise<ResourceSourceSnapshot> {
  if (!includeResources) {
    return {
      characters: [],
      worldbookEntries: [],
      notes: [],
      preset: preset ? freezePreset(preset) : undefined,
      capturedAt: Date.now(),
      includeResources: false,
    };
  }

  let characters: unknown[] = [];
  let worldbookEntries: unknown[] = [];
  let notes: unknown[] = [];
  try {
    characters = (await db.getCharactersByProject(projectId)) as unknown[];
  } catch (error) {
    throw new ResourceContextError(
      'RESOURCE_AWARENESS_READ_FAILED',
      '项目已启用角色资料，但读取失败，已阻止生成，以免把“没读到”伪装成“没有资料”。',
      'open_resources',
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  try {
    worldbookEntries = (await db.getWorldbookEntriesByProject(
      projectId,
    )) as unknown[];
  } catch (error) {
    throw new ResourceContextError(
      'RESOURCE_AWARENESS_READ_FAILED',
      '项目已启用世界书，但读取失败，已阻止生成，以免把“没读到”伪装成“没有资料”。',
      'open_resources',
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  try {
    notes = (await db.getNotesByProject(projectId)) as unknown[];
  } catch {
    notes = [];
  }

  let contents: Record<number, string> = {};
  try {
    const ids = notes.map(note => Number(asRecord(note).id)).filter(Boolean);
    if (ids.length > 0 && typeof db.getNotesContentByIds === 'function') {
      contents = await db.getNotesContentByIds(ids);
    }
  } catch {
    contents = {};
  }

  return {
    characters: characters.map((row, index) => freezeCharacter(row, index)),
    worldbookEntries: worldbookEntries.map((row, index) =>
      freezeWorldbook(row, index),
    ),
    notes: notes.map((row, index) =>
      freezeNote(row, contents[Number(asRecord(row).id)] || '', index),
    ),
    preset: preset ? freezePreset(preset) : undefined,
    capturedAt: Date.now(),
    includeResources: true,
  };
}

/**
 * Capture one atomic source view. Retries once if sources change mid-build.
 */
export async function captureResourceSourceSnapshot(
  projectId: number,
  options: { includeResources: boolean; preset?: Preset | null } = {
    includeResources: true,
  },
): Promise<ResourceSourceSnapshot> {
  const first = await readSourcePayloads(
    projectId,
    options.includeResources,
    options.preset,
  );
  const second = await readSourcePayloads(
    projectId,
    options.includeResources,
    options.preset,
  );
  if (snapshotFingerprint(first) === snapshotFingerprint(second)) {
    return first;
  }
  const third = await readSourcePayloads(
    projectId,
    options.includeResources,
    options.preset,
  );
  if (snapshotFingerprint(second) === snapshotFingerprint(third)) {
    return second;
  }
  throw new ResourceContextError(
    'RESOURCE_SOURCE_CHANGED_DURING_BUILD',
    '构建上下文时资料正在被修改，已阻止把两个版本拼进同一次冻结。请稍后重试。',
    'restart_task',
  );
}

export function parseFrozenSourcePayload(record: FrozenSourceRecord): unknown {
  try {
    return JSON.parse(record.payload);
  } catch {
    return { id: record.id, title: record.title, content: record.payload };
  }
}
