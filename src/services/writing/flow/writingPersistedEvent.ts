/**
 * Unique Pipeline → Memory handoff (plan §6.2).
 *
 * Memory must not read unfinished Pipeline stage products. Only a
 * successfully persisted chapter body may start PostWriting
 * (Story Memory / Continuity State extraction).
 *
 * Pipeline persist-stage artifacts are not this event. Outline Memory
 * starts at finalizeChapterMemory; Continuation Memory starts at
 * finalizeContinuationChapter (user adopt / batch finalize).
 */
import { sha256Hex } from '../../continuation/hashUtils';
import type { WritingScenario } from '../contracts/writingSource';

export const WRITING_PERSISTED_EVENT_KIND = 'writing_persisted' as const;

export type WritingPersistedExecutionProfile = 'standard' | 'one_shot';

export interface WritingPersistedEvent {
  kind: typeof WRITING_PERSISTED_EVENT_KIND;
  contractVersion: 1;
  generationTraceId: string;
  freezeFingerprint: string;
  projectId: number;
  chapterId: number;
  chapterPosition: number;
  finalBodyFingerprint: string;
  executionProfile: WritingPersistedExecutionProfile;
  appliedRequirementIds: string[];
  scenario: WritingScenario;
  persistedAt: string;
}

export interface BuildWritingPersistedEventInput {
  generationTraceId: string;
  freezeFingerprint: string;
  projectId: number;
  chapterId: number;
  chapterPosition: number;
  finalBody: string;
  executionProfile?: WritingPersistedExecutionProfile | string | null;
  appliedRequirementIds?: string[];
  scenario: WritingScenario;
  persistedAt?: string;
}

export function fingerprintPersistedBody(body: string): string {
  return sha256Hex(String(body ?? ''));
}

export function buildWritingPersistedEvent(
  input: BuildWritingPersistedEventInput,
): WritingPersistedEvent {
  const event: WritingPersistedEvent = {
    kind: WRITING_PERSISTED_EVENT_KIND,
    contractVersion: 1,
    generationTraceId: String(input.generationTraceId || '').trim(),
    freezeFingerprint: String(input.freezeFingerprint || '').trim(),
    projectId: Number(input.projectId),
    chapterId: Number(input.chapterId),
    chapterPosition: Number(input.chapterPosition),
    finalBodyFingerprint: fingerprintPersistedBody(input.finalBody),
    executionProfile:
      input.executionProfile === 'one_shot' ? 'one_shot' : 'standard',
    appliedRequirementIds: Array.isArray(input.appliedRequirementIds)
      ? input.appliedRequirementIds.filter(
          id => typeof id === 'string' && id.trim(),
        )
      : [],
    scenario: input.scenario,
    persistedAt: input.persistedAt || new Date().toISOString(),
  };
  assertWritingPersistedEvent(event);
  return event;
}

export function assertWritingPersistedEvent(
  event: WritingPersistedEvent | null | undefined,
): asserts event is WritingPersistedEvent {
  if (!event || event.kind !== WRITING_PERSISTED_EVENT_KIND) {
    throw persistedEventError('WRITING_PERSISTED_EVENT_MISSING', '缺少 WritingPersistedEvent');
  }
  if (event.contractVersion !== 1) {
    throw persistedEventError(
      'WRITING_PERSISTED_EVENT_INVALID',
      `不支持的 WritingPersistedEvent 版本：${String(event.contractVersion)}`,
    );
  }
  if (!event.generationTraceId) {
    throw persistedEventError(
      'WRITING_PERSISTED_EVENT_INVALID',
      'WritingPersistedEvent 缺少 generationTraceId',
    );
  }
  if (!event.freezeFingerprint) {
    throw persistedEventError(
      'WRITING_PERSISTED_EVENT_INVALID',
      'WritingPersistedEvent 缺少 freezeFingerprint',
    );
  }
  if (!Number.isFinite(event.projectId) || event.projectId <= 0) {
    throw persistedEventError(
      'WRITING_PERSISTED_EVENT_INVALID',
      'WritingPersistedEvent 缺少合法 projectId',
    );
  }
  if (!Number.isFinite(event.chapterId) || event.chapterId <= 0) {
    throw persistedEventError(
      'WRITING_PERSISTED_EVENT_INVALID',
      'WritingPersistedEvent 缺少合法 chapterId',
    );
  }
  if (!Number.isFinite(event.chapterPosition)) {
    throw persistedEventError(
      'WRITING_PERSISTED_EVENT_INVALID',
      'WritingPersistedEvent 缺少 chapterPosition',
    );
  }
  if (!/^[a-f0-9]{64}$/i.test(event.finalBodyFingerprint)) {
    throw persistedEventError(
      'WRITING_PERSISTED_EVENT_INVALID',
      'WritingPersistedEvent 缺少 finalBodyFingerprint',
    );
  }
  if (event.scenario !== 'outline' && event.scenario !== 'continuation') {
    throw persistedEventError(
      'WRITING_PERSISTED_EVENT_INVALID',
      `WritingPersistedEvent 场景非法：${String(event.scenario)}`,
    );
  }
}

export function assertWritingPersistedEventAllowsMemoryUpdate(
  event: WritingPersistedEvent,
): void {
  assertWritingPersistedEvent(event);
  if (!event.finalBodyFingerprint) {
    throw persistedEventError(
      'WRITING_PERSISTED_EVENT_BLOCKED',
      '正文尚未 durable persist，禁止进入 Memory Update',
    );
  }
}

function persistedEventError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}
