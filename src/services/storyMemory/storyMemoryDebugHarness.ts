import type { LLMRequestConfig, LLMResult } from '../llm';
import { PipelineForeground } from '../../native/PipelineForegroundModule';
import { parseStoryMemoryObservationCandidate } from './storyMemoryObservationFormatter';
import {
  STORY_MEMORY_V2_REQUEST_KINDS,
  type StoryMemoryV2RequestKind,
} from './storyMemoryProtocolVersion';
import type { FrozenStoryMemoryLLMConfig } from './storyMemoryRequestBudget';

/**
 * Real-model QA seams for the Debug APK only.
 *
 * The intent/native whitelist is the security boundary. These helpers never
 * manufacture a successful patch and never enter the Release APK path: they
 * only alter the in-memory LLM result after a real provider response so the
 * existing Formatter/Fresh Retry/Normalizer/Compiler paths can be measured.
 */
export const STORY_MEMORY_DEBUG_SCENARIOS = [
  'invalid_observation',
  'formatter',
  'fresh_retry',
  'small_window_64k',
] as const;

export type StoryMemoryDebugScenario =
  (typeof STORY_MEMORY_DEBUG_SCENARIOS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStoryMemoryDebugScenario(
  value: unknown,
): value is StoryMemoryDebugScenario {
  return (
    typeof value === 'string' &&
    (STORY_MEMORY_DEBUG_SCENARIOS as readonly string[]).includes(value)
  );
}

function debugLog(message: string): void {
  // Deliberately log only the scenario and bounded counters, never prompt,
  // chapter text, API credentials, or model response content.
  console.info(`[StoryMemoryDebug] ${message}`);
}

let testOverride: StoryMemoryDebugScenario | null | undefined;

/** Consume one pending native Debug APK scenario at logical-batch start. */
export async function consumeStoryMemoryDebugScenario(): Promise<
  StoryMemoryDebugScenario | null
> {
  if (testOverride !== undefined) return testOverride;
  const raw = await PipelineForeground.consumeStoryMemoryDebugScenario();
  const scenario = isStoryMemoryDebugScenario(raw) ? raw : null;
  if (scenario) debugLog(`armed scenario=${scenario}`);
  return scenario;
}

/** Test-only override; production callers never set this. */
export function setStoryMemoryDebugScenarioForTest(
  scenario: StoryMemoryDebugScenario | null,
): void {
  testOverride = scenario;
}

/** Clear the test-only override. */
export function clearStoryMemoryDebugScenarioForTest(): void {
  testOverride = undefined;
}

function findObservationChapters(
  raw: unknown,
): Record<string, unknown>[] | null {
  if (!isRecord(raw)) return null;
  if (Array.isArray(raw.chapters)) {
    return raw.chapters.filter(isRecord);
  }
  for (const value of Object.values(raw)) {
    if (isRecord(value) && Array.isArray(value.chapters)) {
      return value.chapters.filter(isRecord);
    }
  }
  return null;
}

function invalidObservationResult(result: LLMResult): LLMResult {
  const text = result.text?.trim() || '';
  if (!text) return result;
  try {
    const parsed = parseStoryMemoryObservationCandidate(text);
    const chapters = findObservationChapters(parsed);
    const chapter = chapters?.[0];
    if (!chapter) {
      debugLog('scenario=invalid_observation injected=false reason=no_chapters');
      return result;
    }
    const observations = Array.isArray(chapter.observations)
      ? chapter.observations
      : [];
    chapter.observations = [
      ...observations,
      {
        kind: 'character_state',
        op: 'set',
        ref: 'INVALID_HANDLE',
        field: 'location',
        value: 'debug-invalid-observation',
        evidence: ['INVALID_ANCHOR'],
      },
    ];
    debugLog(
      `scenario=invalid_observation injected=true original_observations=${observations.length}`,
    );
    return { ...result, text: JSON.stringify(parsed) };
  } catch {
    debugLog('scenario=invalid_observation injected=false reason=unparseable');
    return result;
  }
}

function invalidJsonResult(result: LLMResult, scenario: StoryMemoryDebugScenario, requestKind: string): LLMResult {
  debugLog(`scenario=${scenario} request_kind=${requestKind} injected=true`);
  return { ...result, text: '{"chapters":[' };
}

/**
 * Inject a deterministic failure after a real HTTP response. The request
 * ledger still records the real HTTP status and physical request kind.
 */
export function injectStoryMemoryDebugResult(
  result: LLMResult,
  requestKind: StoryMemoryV2RequestKind | string,
  scenario: StoryMemoryDebugScenario | null | undefined,
): LLMResult {
  if (!scenario) return result;
  if (
    scenario === 'invalid_observation' &&
    requestKind === STORY_MEMORY_V2_REQUEST_KINDS.primary
  ) {
    return invalidObservationResult(result);
  }
  if (
    scenario === 'formatter' &&
    requestKind === STORY_MEMORY_V2_REQUEST_KINDS.primary
  ) {
    return invalidJsonResult(result, scenario, requestKind);
  }
  if (
    scenario === 'fresh_retry' &&
    (requestKind === STORY_MEMORY_V2_REQUEST_KINDS.primary ||
      requestKind === STORY_MEMORY_V2_REQUEST_KINDS.formatter)
  ) {
    return invalidJsonResult(result, scenario, requestKind);
  }
  if (scenario === 'small_window_64k') {
    debugLog(`scenario=${scenario} request_kind=${requestKind} injected=false`);
  }
  return result;
}

/**
 * Debug-only capability override used to exercise the real 64K planner and
 * whole-item packing against the active provider/key/model.
 */
export function applyStoryMemoryDebugConfig(
  config: FrozenStoryMemoryLLMConfig,
  scenario: StoryMemoryDebugScenario | null | undefined,
): FrozenStoryMemoryLLMConfig {
  if (scenario !== 'small_window_64k') return config;
  const requestConfig: LLMRequestConfig | undefined = config.requestConfig
    ? {
        ...config.requestConfig,
        context_window: 65536,
        max_output_tokens: 32768,
      }
    : undefined;
  debugLog('scenario=small_window_64k context_window=65536 max_output_tokens=32768');
  return {
    ...config,
    contextWindow: 65536,
    maxOutputTokens: 32768,
    requestConfig,
  };
}

export function recordStoryMemoryDebugObservationStats(input: {
  scenario: StoryMemoryDebugScenario | null | undefined;
  requestKind: string;
  observationsReceived: number;
  observationsAccepted: number;
  warningCount: number;
}): void {
  if (!input.scenario) return;
  debugLog(
    `scenario=${input.scenario} request_kind=${input.requestKind} observations_received=${input.observationsReceived} observations_accepted=${input.observationsAccepted} warnings=${input.warningCount}`,
  );
}
