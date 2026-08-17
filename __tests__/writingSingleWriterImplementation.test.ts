/**
 * Hard gates for ONE concrete production Writer implementation.
 *
 * These tests inspect the production call graph and stage bodies. A rename,
 * facade, Capability wrapper, or `execute()` callback that still reaches a
 * scenario-owned Writer Core must fail.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function isProduction(name: string): boolean {
  return (
    !name.includes('/legacy/') &&
    !name.includes('/__tests__/') &&
    !/\.(test|spec)\.[jt]sx?$/.test(name)
  );
}

const files = listFiles(SRC)
  .map(file => ({ file, name: rel(file), text: fs.readFileSync(file, 'utf8') }))
  .filter(item => isProduction(item.name))
  .map(item => ({ ...item, stripped: stripComments(item.text) }));

const SHARED_STAGES = [
  'Draft',
  'Review',
  'Audit',
  'FactCheck',
  'Revision',
  'Proof',
  'FinalValidate',
  'Persist',
] as const;

const SCENARIO_WRITER_CORE_SYMBOLS = [
  'runOutlineWritingCapability',
  'runContinuationDraftCapability',
  'runContinuationRevisionAndAuditCapability',
  'runContinuationProofCapability',
  'startContinuationRun',
  'runChapterPipeline',
  'resumePipeline',
];

const WRITER_LLM_OWNERS_FORBIDDEN = [
  'src/services/pipeline/outlineStageRuntime.ts',
  'src/services/writing/stages/continuationStageCapabilities.ts',
  'src/services/writing/stages/outlineWritingCapability.ts',
  'src/services/writing/stages/outlineStageOperation.ts',
];

describe('ONE concrete Shared Writer implementation', () => {
  test('each shared stage has exactly one concrete production implementation', () => {
    for (const stage of SHARED_STAGES) {
      const pattern = new RegExp(
        `(?:export\\s+)?(?:async\\s+)?function\\s+run${stage}Stage\\b`,
      );
      const definitions = files.filter(item => pattern.test(item.text));
      expect(definitions.map(item => item.name)).toEqual([
        `src/services/writing/stages/${stage.charAt(0).toLowerCase()}${stage.slice(1)}.ts`,
      ]);
    }
  });

  test('shared stage files own the writer work instead of delegating through execute()', () => {
    const writerStages = SHARED_STAGES.filter(stage => stage !== 'Persist');
    for (const stage of writerStages) {
      const item = files.find(
        file =>
          file.name ===
          `src/services/writing/stages/${stage.charAt(0).toLowerCase()}${stage.slice(1)}.ts`,
      );
      expect(item).toBeTruthy();
      expect(item!.stripped).not.toMatch(/stageInput\.execute\s*\(/);
      expect(item!.stripped).not.toMatch(/input\.execute\s*\(/);
    }
    const persist = files.find(
      file => file.name === 'src/services/writing/stages/persist.ts',
    );
    expect(persist).toBeTruthy();
    expect(persist!.stripped).not.toMatch(/stageInput\.execute\s*\(/);
  });

  test('Scenario Writer Core production callers are zero', () => {
    const allowedDefinitions = new Set([
      'src/services/pipelineRunner.ts',
      'src/services/pipeline/outlineStageRuntime.ts',
    ]);
    const violations: string[] = [];
    for (const item of files) {
      for (const symbol of SCENARIO_WRITER_CORE_SYMBOLS) {
        const definedHere = new RegExp(
          `(?:export\\s+)?(?:async\\s+)?function\\s+${symbol}\\b`,
        ).test(item.text);
        if (definedHere) continue;
        if (allowedDefinitions.has(item.name) && symbol !== 'runOutlineWritingCapability') {
          continue;
        }
        if (new RegExp(`\\b${symbol}\\b`).test(item.stripped)) {
          violations.push(`${item.name} -> ${symbol}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('old outline/continuation modules do not own Writer LLM or full prompt compilation', () => {
    for (const name of WRITER_LLM_OWNERS_FORBIDDEN) {
      const item = files.find(file => file.name === name);
      if (!item) continue;
      expect(item.stripped).not.toMatch(/\bcallWritingStageLLM\s*\(/);
      expect(item.stripped).not.toMatch(/\bcallLLMResult\s*\(/);
      expect(item.stripped).not.toMatch(/\bcompileContinuationV5\w+Messages\b/);
      expect(item.stripped).not.toMatch(/\bcompileContinuationV5FinalReviserWithinBudget\b/);
      expect(item.stripped).not.toMatch(/\bcompileDraftFromFrozenRequest\b/);
      expect(item.stripped).not.toMatch(/\bactionRun(?:Draft|Review|FactCheck|Brief|Proof)\b/);
    }
  });

  test('post-Freeze writer LLM calls originate from the shared stage layer', () => {
    const allowed = new Set([
      'src/services/writing/stages/stageLlmCall.ts',
      'src/services/writing/stages/writerCore.ts',
    ]);
    const violations = files.filter(
      item =>
        !allowed.has(item.name) &&
        item.name.startsWith('src/services/writing/') &&
        /\bcallWritingStageLLM\s*\(/.test(item.stripped),
    );
    expect(violations.map(item => item.name)).toEqual([]);
  });

  test('there is exactly one shared prompt compiler entry', () => {
    const definitions = files.filter(item =>
      /export\s+function\s+compileSharedWritingPrompt\b/.test(item.text),
    );
    expect(definitions.map(item => item.name)).toEqual([
      'src/services/writing/prompt/sharedPromptCompiler.ts',
    ]);
  });
});
