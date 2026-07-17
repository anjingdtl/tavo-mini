/**
 * 上下文自动化配置：在 settings 键值表存两个 key。
 *
 * - context_auto_input：用户最后输入的 maxContextTokens（number）
 * - context_auto_last_applied：最近一次应用记录（JSON）
 *
 * 与 settingsRepository 风格一致（单独 export 异步函数）。
 */

import type { AllocationResult } from '../../services/contextAutoAllocator';
import { getSetting, setSetting } from './settingsRepository';

const KEY_INPUT = 'context_auto_input';
const KEY_LAST_APPLIED = 'context_auto_last_applied';

export interface ContextAutoAppliedRecord {
  maxContextTokens: number;
  appliedAt: number; // Unix 毫秒
  allocation: AllocationResult;
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
 * 应用函数构建 last_applied 记录时的辅助。
 * 仅供 applyContextAutoAllocation 使用。
 */
export function buildAppliedRecord(
  maxContextTokens: number,
  allocation: AllocationResult,
  affectedCounts: ContextAutoAppliedRecord['affectedCounts'],
): ContextAutoAppliedRecord {
  return {
    maxContextTokens,
    appliedAt: Date.now(),
    allocation,
    affectedCounts,
  };
}
