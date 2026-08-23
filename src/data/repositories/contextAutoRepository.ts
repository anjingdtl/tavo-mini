/**
 * 上下文自动化配置：在 settings 键值表存两个 key。
 *
 * - context_auto_input：用户最后输入的 maxContextTokens（number）
 * - context_auto_last_applied：最近一次应用记录（JSON）
 *
 * 与 settingsRepository 风格一致（单独 export 异步函数）。
 */

import type { AllocationResult } from '../../services/contextAutoAllocator';
import {
  buildContinuationPolicyPreview,
  cloneDefaultContextAutomationPolicy,
  cloneDefaultContextAutomationPolicyV3,
  hashContextAutomationPolicy,
  isContextAutomationPolicyV2,
  isContextAutomationPolicyV3,
  serializeContextAutomationPolicy,
  type ContextAutomationPolicyV2,
  type ContextAutomationPolicyV3,
  type ContinuationPolicyPreview,
} from '../../services/contextAutomationPolicy';
import { getSetting, setSetting } from './settingsRepository';

const KEY_INPUT = 'context_auto_input';
const KEY_LAST_APPLIED = 'context_auto_last_applied';
const KEY_POLICY = 'context_auto_policy_v2';
// Context Budget V3 (Plan §10): persist Policy + mode marker, not runtime
// numbers. The marker is retained for historical settings compatibility;
// new outline tasks/batches now freeze V3 directly and do not consult it.
const KEY_MODE = 'context_auto_mode';
const KEY_POLICY_V3 = 'context_auto_policy_v3';

export type ContextAutoMode = 'v2' | 'v3';

export interface ContextAutoAppliedRecord {
  /** Schema 1 records predate the versioned Continuation policy. */
  schemaVersion?: 1 | 2;
  maxContextTokens: number;
  appliedAt: number; // Unix 毫秒
  allocation: AllocationResult;
  policySchemaVersion?: number;
  policyVersion?: string;
  policyHash?: string;
  policy?: ContextAutomationPolicyV2;
  continuationPreview?: ContinuationPolicyPreview;
  /**
   * Present when the user chose "apply and sync model window": the saved
   * LLM config whose real context_window / max_output_tokens were written
   * to the 80/20 elastic envelope of maxContextTokens.
   * Absent for simulation-only applies. `maxOutputTokens` is optional for
   * records written before the envelope sync existed.
   */
  syncedContextWindow?: {
    configId: number;
    contextWindow: number;
    maxOutputTokens?: number;
  } | null;
  affectedCounts: {
    llmConfigs: number;
    presets: number;
    characters: number;
    notes: number;
    worldbookEntries: number;
    worldbookCollections: number;
  };
}

export async function getContextAutoInput(): Promise<number | null> {
  const raw = await getSetting(KEY_INPUT);
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function setContextAutoInput(value: number): Promise<void> {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`setContextAutoInput: value 必须为正数，收到 ${value}`);
  }
  await setSetting(KEY_INPUT, String(Math.round(value)));
}

export async function getContextAutomationPolicy(): Promise<ContextAutomationPolicyV2 | null> {
  const raw = await getSetting(KEY_POLICY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isContextAutomationPolicyV2(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function setContextAutomationPolicy(
  policy: ContextAutomationPolicyV2,
): Promise<void> {
  if (!isContextAutomationPolicyV2(policy)) {
    throw new Error('setContextAutomationPolicy: policy schema 无效');
  }
  await setSetting(KEY_POLICY, serializeContextAutomationPolicy(policy));
}

// ---------------------------------------------------------------------------
// Context Budget V3 mode + policy persistence (Plan §10 / §12).
// ---------------------------------------------------------------------------

export async function getContextAutoMode(): Promise<ContextAutoMode> {
  const raw = await getSetting(KEY_MODE);
  return raw === 'v3' ? 'v3' : 'v2';
}

export async function setContextAutoMode(mode: ContextAutoMode): Promise<void> {
  if (mode !== 'v2' && mode !== 'v3') {
    throw new Error(`setContextAutoMode: unsupported mode ${mode}`);
  }
  await setSetting(KEY_MODE, mode);
}

export async function getContextAutomationPolicyV3(): Promise<ContextAutomationPolicyV3 | null> {
  const raw = await getSetting(KEY_POLICY_V3);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isContextAutomationPolicyV3(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function setContextAutomationPolicyV3(
  policy: ContextAutomationPolicyV3,
): Promise<void> {
  if (!isContextAutomationPolicyV3(policy)) {
    throw new Error('setContextAutomationPolicyV3: policy schema 无效');
  }
  // Persist as deterministic JSON (sorted keys) so policyHash is stable across
  // read/write rounds — V3 snapshot fingerprints rely on this (Plan §16).
  await setSetting(KEY_POLICY_V3, JSON.stringify(policy));
}

export async function ensureContextAutomationPolicyV3(): Promise<ContextAutomationPolicyV3> {
  const persisted = await getContextAutomationPolicyV3();
  if (persisted) return persisted;
  const policy = cloneDefaultContextAutomationPolicyV3();
  await setContextAutomationPolicyV3(policy);
  return policy;
}

export async function getContextAutoLastApplied(): Promise<ContextAutoAppliedRecord | null> {
  const raw = await getSetting(KEY_LAST_APPLIED);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ContextAutoAppliedRecord;
  } catch {
    return null;
  }
}

export async function setContextAutoLastApplied(
  record: ContextAutoAppliedRecord,
): Promise<void> {
  await setSetting(KEY_LAST_APPLIED, JSON.stringify(record));
}

/**
 * 历史 V2 last_applied 记录的兼容构建辅助；当前运行时只应用 V3 策略。
 */
export function buildAppliedRecord(
  maxContextTokens: number,
  allocation: AllocationResult,
  affectedCounts: ContextAutoAppliedRecord['affectedCounts'],
  policy: ContextAutomationPolicyV2 = cloneDefaultContextAutomationPolicy(),
): ContextAutoAppliedRecord {
  const policyHash = hashContextAutomationPolicy(policy);
  return {
    schemaVersion: 2,
    maxContextTokens,
    appliedAt: Date.now(),
    allocation,
    policySchemaVersion: policy.schemaVersion,
    policyVersion: policy.allocatorVersion,
    policyHash,
    policy,
    continuationPreview: buildContinuationPolicyPreview(policy),
    affectedCounts,
  };
}
