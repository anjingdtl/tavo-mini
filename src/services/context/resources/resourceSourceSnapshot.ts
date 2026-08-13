import * as db from '../../database';
import type { Preset } from '../../../types/novel';
import { computeResourceSourceFingerprint, stableJson } from './resourceFingerprint';
import { ResourceContextError } from './resourceContextErrors';
import type {
  FrozenNoteConfig,
  FrozenSourceRecord,
  ResourceContextWarning,
  ResourceSourceSnapshot,
} from './resourceAwarenessTypes';
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
import { PRESET_CONTEXT_COMPILER_VERSION } from './presetContextCompiler';

const SOURCE_SNAPSHOT_COMPILER = 'resource-source-snapshot-v1';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function createNoteWarning(
  code: ResourceContextWarning['code'],
  message: string,
  source?: { id?: number | null; title?: string },
): ResourceContextWarning {
  return {
    code,
    sourceKind: 'note',
    sourceId: source?.id,
    title: source?.title,
    message,
    action: code === 'NOTE_DETAIL_COMPILE_FAILED' ? 'retry' : 'open_resources',
  };
}

function normalizeFrozenNoteConfig(raw: unknown): FrozenNoteConfig | undefined {
  const record = asRecord(raw);
  if (Object.keys(record).length === 0) return undefined;
  const mode =
    record.mode === 'style' || record.mode === 'retrieval' || record.mode === 'none'
      ? record.mode
      : 'none';
  const styleWeights = asRecord(record.styleWeights);
  const normalizedWeights = Object.fromEntries(
    Object.entries(styleWeights).filter(
      ([, value]) => typeof value === 'number' && Number.isFinite(value),
    ),
  ) as Record<string, number>;
  const enabledNoteIds = Array.isArray(record.enabledNoteIds)
    ? Array.from(
        new Set(
          record.enabledNoteIds
            .map(value => Number(value))
            .filter(value => Number.isSafeInteger(value) && value > 0),
        ),
      )
    : undefined;
  const retrievalTopK = Number(record.retrievalTopK);
  const retrievalFragmentChars = Number(record.retrievalFragmentChars);
  return {
    mode,
    ...(Object.keys(normalizedWeights).length > 0
      ? { styleWeights: normalizedWeights }
      : {}),
    ...(Number.isFinite(retrievalTopK) && retrievalTopK >= 0
      ? { retrievalTopK: Math.floor(retrievalTopK) }
      : {}),
    ...(Number.isFinite(retrievalFragmentChars) && retrievalFragmentChars > 0
      ? { retrievalFragmentChars: Math.floor(retrievalFragmentChars) }
      : {}),
    ...(enabledNoteIds ? { enabledNoteIds } : {}),
  };
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

function freezeNote(
  raw: unknown,
  content: string,
  contentAvailable: boolean,
  index: number,
): FrozenSourceRecord {
  const record = asRecord(raw);
  const id = Number(record.id) || index + 1;
  const title = String(record.title || `笔记#${id}`);
  // `getNotesByProject()` only returns a list preview. If the full-content
  // read failed, never promote that preview to a supposedly complete frozen
  // detail body. The warning is carried alongside the source view and the
  // pure note compiler will skip this record.
  const body = contentAvailable ? content : '';
  return {
    kind: 'note',
    id,
    title,
    updatedAt: (record.updated_at ?? record.updatedAt) as string | number | undefined,
    payload: JSON.stringify({
      ...record,
      content: body,
      __contentAvailable: contentAvailable,
    }),
    fingerprint: computeResourceSourceFingerprint({
      kind: 'note',
      id,
      semanticContent: `${title}\n${body}`,
      compilerVersion: SOURCE_SNAPSHOT_COMPILER,
    }),
  };
}

function freezePreset(preset: Preset): FrozenSourceRecord {
  const systemText = String(preset.system_prompt || '').trim();
  const writingStyleText = String(preset.writing_style || '').trim();
  const extraInstructionsText = String(preset.extra_instructions || '').trim();
  const semantic = [
    systemText,
    writingStyleText,
    extraInstructionsText,
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
      compilerVersion: PRESET_CONTEXT_COMPILER_VERSION,
    }),
  };
}

export function snapshotFingerprint(snapshot: ResourceSourceSnapshot): string {
  const parts = [
    ...snapshot.characters.map(item => item.fingerprint),
    ...snapshot.worldbookEntries.map(item => item.fingerprint),
    ...snapshot.notes.map(item => item.fingerprint),
    snapshot.preset?.fingerprint || '',
    stableJson(snapshot.noteConfig || null),
    ...(snapshot.warnings || []).map(warning =>
      [warning.code, warning.sourceId ?? '', warning.title ?? '', warning.message].join('\\u001f'),
    ),
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

  const warnings: ResourceContextWarning[] = [];
  let noteConfig: FrozenNoteConfig | undefined;
  if (typeof db.getProjectNoteConfig === 'function') {
    try {
      noteConfig = normalizeFrozenNoteConfig(
        await db.getProjectNoteConfig(projectId),
      );
    } catch {
      warnings.push(
        createNoteWarning(
          'NOTE_LIST_READ_FAILED',
          '笔记配置本轮读取失败，已跳过可选笔记详情，不影响角色/世界书全局设定。',
        ),
      );
    }
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
  let notesRead = true;
  try {
    notes = (await db.getNotesByProject(projectId)) as unknown[];
  } catch {
    notes = [];
    notesRead = false;
    warnings.push(
      createNoteWarning(
        'NOTE_LIST_READ_FAILED',
        '笔记资料本轮读取失败，已跳过，不影响角色/世界书全局设定。',
      ),
    );
  }

  let contents: Record<number, string> = {};
  const contentReadAvailable = typeof db.getNotesContentByIds === 'function';
  const contentReadFailedIds = new Set<number>();
  try {
    const ids = notes.map(note => Number(asRecord(note).id)).filter(Boolean);
    if (ids.length > 0 && contentReadAvailable) {
      contents = await db.getNotesContentByIds(ids);
    }
  } catch {
    contents = {};
    notes.forEach(note => {
      const id = Number(asRecord(note).id);
      if (id > 0) contentReadFailedIds.add(id);
    });
  }

  if (!contentReadAvailable && notes.length > 0) {
    for (const row of notes) {
      const record = asRecord(row);
      const id = Number(record.id);
      contentReadFailedIds.add(id);
      warnings.push(
        createNoteWarning(
          'NOTE_CONTENT_READ_FAILED',
          '笔记正文读取能力不可用，相关笔记已跳过，不影响角色/世界书全局设定。',
          { id, title: String(record.title || `笔记#${id}`) },
        ),
      );
    }
  } else if (contentReadFailedIds.size > 0) {
    for (const row of notes) {
      const record = asRecord(row);
      const id = Number(record.id);
      if (!contentReadFailedIds.has(id)) continue;
      warnings.push(
        createNoteWarning(
          'NOTE_CONTENT_READ_FAILED',
          '笔记正文本轮读取失败，相关笔记已跳过，不影响角色/世界书全局设定。',
          { id, title: String(record.title || `笔记#${id}`) },
        ),
      );
    }
  } else if (notesRead && contentReadAvailable) {
    for (const row of notes) {
      const record = asRecord(row);
      const id = Number(record.id);
      if (id <= 0 || Object.prototype.hasOwnProperty.call(contents, id)) continue;
      contentReadFailedIds.add(id);
      warnings.push(
        createNoteWarning(
          'NOTE_CONTENT_READ_FAILED',
          '笔记正文本轮读取失败，相关笔记已跳过，不影响角色/世界书全局设定。',
          { id, title: String(record.title || `笔记#${id}`) },
        ),
      );
    }
  }

  return {
    characters: characters.map((row, index) => freezeCharacter(row, index)),
    worldbookEntries: worldbookEntries.map((row, index) =>
      freezeWorldbook(row, index),
    ),
    notes: notes.map((row, index) => {
      const id = Number(asRecord(row).id);
      const contentAvailable =
        contentReadAvailable &&
        !contentReadFailedIds.has(id) &&
        Object.prototype.hasOwnProperty.call(contents, id);
      return freezeNote(
        row,
        contentAvailable ? String(contents[id] ?? asRecord(row).content ?? '') : '',
        contentAvailable,
        index,
      );
    }),
    preset: preset ? freezePreset(preset) : undefined,
    noteConfig,
    warnings: warnings.length > 0 ? warnings : undefined,
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
