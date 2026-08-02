#!/usr/bin/env bash
set -euo pipefail
ROOT=/tmp/tavo-fixture
rm -rf "$ROOT"
mkdir -p "$ROOT/src/services/continuation/generation" "$ROOT/__tests__"
cat > "$ROOT/src/services/continuation/generation/continuationChecker.ts" <<'TS'
import type {
  ContinuationGenerationSettings,
} from './types';

// The product's preferred chapter size is a quality signal, not a safety
// gate. A model may legitimately stop earlier or write longer prose; either
// case must remain reviewable without another LLM call or a retry.
const IDEAL_HAN_CHARACTER_MIN = 2_000;
const IDEAL_HAN_CHARACTER_MAX = 4_000;

function countHanCharacters(text: string): number {
  return (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || [])
    .length;
}
function levelOff(_settings: any, _category: any) { return false; }
export function runDeterministicChecks(artifactText: string, snapshot: any): any[] {
  const issues: any[] = [];
  const settings = snapshot.settingsSnapshot.values;

  const hanCharacters = countHanCharacters(artifactText);
  if (
    hanCharacters < IDEAL_HAN_CHARACTER_MIN ||
    hanCharacters > IDEAL_HAN_CHARACTER_MAX
  ) {
    issues.push({
      category: 'style', subtype: 'target_length', severity: 'warning', confidence: 1,
      generatedStart: null, generatedEnd: null, generatedExcerpt: '',
      description: `正文含汉字 ${hanCharacters} 个`, evidenceIds: [], suggestedFix: `下一次生成`,
    });
  }

  // Future leakage markers
  return issues;
}
export function bindIssuesToArtifact(issues: any[], artifactText: string, allowedEvidenceIds: Set<number>): any[] {
  return issues.map(issue => {
    let { generatedStart, generatedEnd, generatedExcerpt, evidenceIds } = issue;
    const filtered = (evidenceIds ?? []).filter((id: number) => allowedEvidenceIds.has(id));
    let severity = issue.severity;
    const localOverlapGate =
      issue.subtype === 'source_overlap' ||
      issue.subtype === 'continuation_anchor_overlap';
    if (filtered.length === 0 && !localOverlapGate && (severity === 'error' || severity === 'blocking')) severity = 'warning';
    if (!localOverlapGate && (severity === 'error' || severity === 'blocking') && (!generatedExcerpt || generatedStart == null || generatedEnd == null || !issue.description.trim() || !issue.suggestedFix?.trim())) severity = 'warning';
    return { ...issue, generatedStart, generatedEnd, generatedExcerpt, evidenceIds: filtered, severity };
  });
}
export function filterBySettings(issues: any[], settings: ContinuationGenerationSettings): any[] {
  return issues.filter(i => !levelOff(settings, i.category));
}
TS
cat > "$ROOT/src/services/continuation/generation/continuationPromptCompiler.ts" <<'TS'
type ChatMessage = { role: string; content: string };
type ContinuationContextSnapshot = any;
type ContinuationPlan = any;
type ContinuationCheckResult = any;
import {
  renderStyleProfile,
  type StyleRenderLevel,
} from '../styleProfile/styleProfileRenderer';
function displayTargetTitle(_: any) { return '章'; }
function primaryAnchorRule(_: any) { return ''; }
function lockedBlock(_: any) { return ''; }
function canonFactCheckBlock(_: any) { return ''; }
function stateBlock(_: any) { return ''; }
function primaryAnchorBlock(_: any) { return ''; }
function recentBlock(_: any) { return ''; }
function memoryBlock(_: any) { return ''; }
function episodicBlock(_: any) { return ''; }
function historicalDigestBlock(_: any) { return ''; }
function styleBlock(_: any, __: any, ___?: any) { return ''; }
function supplementsBlock(_: any) { return ''; }
export function compileWriterMessages(
  snapshot: any,
  plan?: any,
): any[] {
  return [];
}

export function compileCheckerMessages(
  snapshot: any,
  artifactText: string,
): any[] {
  return [];
}

export function compileRepairMessages(
  snapshot: any,
  artifactText: string,
  openChecks: any[],
  delivery: 'full'|'patch'='full',
): any[] {
  return [];
}

export function compileStateExtractionMessages(
  finalizedText: string,
  entityIndex: string,
): any[] {
  return [];
}
TS
cat > "$ROOT/src/services/continuation/generation/continuationGenerationRunner.ts" <<'TS'
import { type ContinuationStageBudgets } from './continuationContextBudget';

function countHanCharacters(text: string): number {
  return (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
}

function isRepairCandidateUsable(
  original: string,
  candidate: string,
  targetChapterChars: number,
): boolean {
  return true;
}

function defaultPlan(instruction: string): any { return {}; }

interface RepairPatch {
  start: number;
  end: number;
  replacement: string;
}

export function applyRepairPatches(
  original: string,
  raw: string,
): string | null {
  return null;
}

/**
 * Strict standard-workflow Writer contract
 */
export function parseWriterResult(raw: string): any { return {}; }
function standard() {
  const generationSettings: any = {};
  const snapshot: any = {};
  const a = { targetChapterChars: generationSettings.targetChapterChars, };
  const b = { targetChapterChars: snapshot.settingsSnapshot.values.targetChapterChars, };
  let repaired: string | null = null;
  let repairUsedLlm = false;
  const artifact: any = { content: '' };
  const repairResult: any = { text: '' };
  const tokenUsage: any = {};
          repaired =
            applyRepairPatches(artifact.content, repairResult.text) ??
            repairResult.text.trim();
          repairUsedLlm = Boolean(repaired);
  tokenUsage.repair = { warningMessage:
          'Repair 候选相对 Writer 正文过度缩短或偏离 2500–4000 汉字质量带，已保留 Writer artifact；本次不重试，也不再次调用 Checker。',
  };
}
function extra() {
  const artifact: any = { content: '' };
  const result: any = { text: '' };
    const repaired =
      applyRepairPatches(artifact.content, result.text) ?? result.text.trim();
    if (!repaired) throw new Error('额外 Repair 未返回正文，候选正文保持不变');
  throw new Error(
        '额外 Repair 候选相对当前正文过度缩短，已保留原候选；本次不再重试，也不会调用 LLM Checker。',
      );
}
TS
python /mnt/data/tavo-mini-continuation-length-repair/apply_continuation_length_repair.py "$ROOT"
mkdir -p "$ROOT/src/services/continuation/canon" "$ROOT/src/services/continuation/styleProfile"
cat > "$ROOT/src/services/continuation/canon/canonJsonValidators.ts" <<'TS'
export function stripModelJson(raw: string): string { return raw.trim(); }
TS
cat > "$ROOT/src/services/continuation/generation/types.ts" <<'TS'
export interface ContinuationGenerationSettings { [key: string]: any }
TS
cat > "$ROOT/src/services/continuation/styleProfile/styleProfileRenderer.ts" <<'TS'
export type StyleRenderLevel = string;
export function renderStyleProfile(..._args: any[]): any { return { text: '' }; }
TS
cat > "$ROOT/src/services/continuation/generation/continuationContextBudget.ts" <<'TS'
export interface ContinuationStageBudgets {}
TS
cat > "$ROOT/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "strict": true,
    "noImplicitAny": false,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM"],
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
JSON
python - <<'PY'
from pathlib import Path
root=Path('/tmp/tavo-fixture')
checker=(root/'src/services/continuation/generation/continuationChecker.ts').read_text()
prompt=(root/'src/services/continuation/generation/continuationPromptCompiler.ts').read_text()
runner=(root/'src/services/continuation/generation/continuationGenerationRunner.ts').read_text()
checks = {
    'checker length': 'chapter_length_under_target' in checker,
    'checker gate': 'localDeterministicGate' in checker,
    'writer rule': '正文长度硬约束' in prompt,
    'insert contract': '允许 start=end 表示纯插入' in prompt,
    'no standard fallback': 'repairResult.text.trim()' not in runner,
    'no extra fallback': 'result.text.trim()' not in runner,
    'runner import': 'continuationRepairPatch' in runner,
}
assert all(checks.values()), checks
print('patcher fixture assertions passed')
PY
(cd "$ROOT" && tsc --noEmit)
echo "patcher fixture TypeScript validation passed"
