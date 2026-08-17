/**
 * Architecture-level hard gates for the Writing Kernel Final Closure
 * (plan §13 / §27). These tests statically enforce the production call
 * graph: ONE kernel, ONE entry, ZERO legacy runner callers, ZERO
 * post-Freeze scenario execution branches, ZERO live-source reads inside
 * the execution layer.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Legacy/test/migration scope — banned symbols may exist here only. */
function isAllowedScope(rel: string): boolean {
  const norm = rel.split(path.sep).join('/');
  return (
    norm.includes('/__tests__/') ||
    norm.includes('/legacy/') ||
    norm.startsWith('legacy/') ||
    norm.includes('/migration') ||
    norm.startsWith('__tests__/') ||
    /\.(test|spec)\.[jt]sx?$/.test(norm) ||
    // e2e/maestro fixtures are not production code
    norm.startsWith('e2e/') ||
    // Migration-scope pure re-export shims (Kernel Final Closure §8.1/§8.2):
    // these contain ONLY `export * from '...writing/...'` re-exports; they
    // are importable by legacy files only (enforced by the module gates).
    norm === 'src/services/continuation/generation/continuationContextBuilder.ts' ||
    norm === 'src/services/continuation/generation/continuationContextBudget.ts' ||
    // Historical V5 import shim; the implementation is quarantined under
    // generation/legacy and no production module may import this shim.
    norm === 'src/services/continuation/generation/continuationV5Runner.ts'
  );
}

function isProduction(rel: string): boolean {
  return !isAllowedScope(rel);
}

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (exts.some(ext => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

const productionFiles = listFiles(SRC, ['.ts', '.tsx']);

/** Strips block comments and line comments (protocol colons are protected). */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const production = productionFiles
  .map(file => ({
    file,
    // Normalize to forward slashes so Windows backslashes never break
    // equality checks below.
    rel: path.relative(ROOT, file).split(path.sep).join('/'),
    text: readIfExists(file) ?? '',
  }))
  .filter(item => item.text.length > 0 && isProduction(item.rel))
  .map(item => ({ ...item, stripped: stripComments(item.text) }));

// Unlike the broader production scan above, this graph includes the
// quarantined legacy directory. A retired Writer is only truly detached when
// no runtime module (including compatibility-only runtime modules) imports it.
const runtimeSource = productionFiles
  .map(file => ({
    file,
    rel: path.relative(ROOT, file).split(path.sep).join('/'),
    text: readIfExists(file) ?? '',
  }))
  .filter(item => item.text.length > 0)
  .map(item => ({ ...item, stripped: stripComments(item.text) }));

const BANNED_MODULES = [
  'continuation/generation/legacy/continuationGenerationRunner',
  'continuation/generation/continuationContextBuilder',
  'continuation/generation/continuationContextBudget',
  'continuation/generation/legacy/continuationPromptCompiler',
  'continuation/generation/legacy/continuationV4Runner',
  'continuation/generation/continuationV5Runner',
];

const BANNED_OUTLINE_SYMBOLS = [
  'runChapterPipeline',
  'resumePipeline',
  'runFreeformPipeline',
];

const BANNED_CONTINUATION_SYMBOLS = [
  'startContinuationRun',
  'startContinuationV4Run',
  'resumeContinuationV4Run',
  'startContinuationV5Run',
  'resumeContinuationV5Run',
];

describe('Writing Production Call Graph — hard architecture gates', () => {
  test('G1: exactly ONE production Writing Kernel engine', () => {
    const definitions = production.filter(item =>
      /export\s+(async\s+)?function\s+runWritingKernel\b/.test(item.text),
    );
    expect(definitions.map(item => item.rel)).toEqual([
      'src/services/writing/unifiedWritingKernel.ts',
    ]);
  });

  test('G2: exactly ONE production writing entry module', () => {
    const entries = production.filter(item =>
      /export\s+(async\s+)?function\s+(runOutlineWritingKernel|resumeOutlineWritingKernel|runContinuationWritingKernel)\b/.test(
        item.text,
      ),
    );
    expect(entries.map(item => item.rel)).toEqual([
      'src/services/writing/productionWritingEntry.ts',
    ]);
  });

  test('G3: old outline pipeline runner has ZERO production callers', () => {
    for (const item of production) {
      for (const symbol of BANNED_OUTLINE_SYMBOLS) {
        const pattern = new RegExp(`\\b${symbol}\\b`);
        if (item.rel === 'src/services/pipelineRunner.ts') continue; // definition site
        // Symbol scan runs on comment-stripped text: comments mentioning a
        // banned symbol are documentation, not a production caller.
        if (pattern.test(item.stripped)) {
          throw new Error(
            `Production file ${item.rel} references banned outline runner symbol ${symbol}`,
          );
        }
      }
    }
  });

  test('G3b: pipeline public entry delegates to the unified Outline Kernel', () => {
    const runner = readIfExists(path.join(SRC, 'services', 'pipelineRunner.ts')) || '';
    expect(runner).not.toMatch(/from ['"][^'"]*pipeline\/reconcile['"]/);
    expect(runner).not.toMatch(/\breconcilePipelineTask\s*\(/);
    expect(runner).toMatch(/runOutlineWritingKernel/);
    expect(runner).toMatch(/resumeOutlineWritingKernel/);
  });

  test('G4: legacy continuation runner modules have ZERO production importers', () => {
    for (const item of production) {
      for (const mod of BANNED_MODULES) {
        const base = path.basename(mod);
        const pattern = new RegExp(`from\\s+['"][^'"]*${base}['"]`);
        if (pattern.test(item.text)) {
          throw new Error(
            `Production file ${item.rel} imports banned module ${mod}`,
          );
        }
      }
    }
  });

  test('G4b: the retired V5 Writer has ZERO runtime importers', () => {
    const importers = runtimeSource.filter(item =>
      /from\s+['"][^'"]*continuationV5Writers/.test(item.stripped),
    );
    expect(importers.map(item => item.rel)).toEqual([]);
  });

  test('G5: legacy continuation runner symbols have ZERO production callers', () => {
    // Definition sites: V5 wrappers live in the legacy shim; V4 / historical
    // runners live under generation/legacy/ (excluded from the production
    // scan entirely).
    const definitionSites = new Set([
      'src/services/continuation/generation/continuationV5Runner.ts',
      'src/services/continuation/generation/legacy/continuationGenerationRunner.ts',
      'src/services/continuation/generation/legacy/continuationV4Runner.ts',
    ]);
    for (const item of production) {
      for (const symbol of BANNED_CONTINUATION_SYMBOLS) {
        if (definitionSites.has(item.rel)) {
          continue; // definition site (legacy scope)
        }
        const pattern = new RegExp(`\\b${symbol}\\b`);
        // Symbol scan runs on comment-stripped text (see G3).
        if (pattern.test(item.stripped)) {
          throw new Error(
            `Production file ${item.rel} references banned continuation symbol ${symbol}`,
          );
        }
      }
    }
  });

  test('G6: ZERO post-Freeze scenario execution branches in the kernel execution layer', () => {
    const executionLayer = production.filter(item => {
      const norm = item.rel.split(path.sep).join('/');
      return (
        norm.startsWith('src/services/writing/execution/') ||
        norm === 'src/services/writing/unifiedWritingKernel.ts' ||
        norm === 'src/services/writing/productionWritingEntry.ts' ||
        norm.startsWith('src/services/writing/stages/')
      );
    });
    expect(executionLayer.length).toBeGreaterThan(0);
    // Scenario may appear only in comments or scenario-type definitions —
    // never as an execution branch (`=== 'continuation'` / switch).
    const branchPatterns = [
      /scenario\s*===?\s*['"]continuation['"]/,
      /scenario\s*!==?\s*['"]continuation['"]/,
      /scenario\s*===?\s*['"]outline['"]/,
      /scenario\s*!==?\s*['"]outline['"]/,
      /case\s+['"]continuation['"]/,
      /case\s+['"]outline['"]/,
    ];
    for (const item of executionLayer) {
      for (const pattern of branchPatterns) {
        if (pattern.test(item.text)) {
          throw new Error(
            `Kernel execution file ${item.rel} branches on the writing scenario after Freeze: ${pattern}`,
          );
        }
      }
    }
  });

  test('G7: execution layer performs ZERO live-source reads', () => {
    const executionLayer = production.filter(item => {
      const norm = item.rel.split(path.sep).join('/');
      return (
        norm.startsWith('src/services/writing/execution/') ||
        norm.startsWith('src/services/writing/stages/')
      );
    });
    const sourceCollectorImports = [
      'continuationSourceCollection',
      'outlineContextBuilder',
      'contextBuilder',
      'collectGenerationMaterials',
    ];
    for (const item of executionLayer) {
      for (const collector of sourceCollectorImports) {
        const pattern = new RegExp(`from\\s+['"][^'"]*${collector}['"]`);
        if (pattern.test(item.text)) {
          throw new Error(
            `Kernel execution file ${item.rel} imports live source collector ${collector}`,
          );
        }
      }
    }
  });

  test('G8: scenario adapters stay pre-Freeze only (no stage execution imports)', () => {
    const adapters = production.filter(item => {
      const norm = item.rel.split(path.sep).join('/');
      return norm.startsWith('src/services/writing/scenario/');
    });
    for (const item of adapters) {
      const pattern = /from\s+['"][^'"]*writing\/execution\//;
      if (pattern.test(item.text)) {
        throw new Error(
          `Scenario adapter ${item.rel} must not import the execution layer`,
        );
      }
    }
  });
});
