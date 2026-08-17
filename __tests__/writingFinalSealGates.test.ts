/**
 * Final-seal hard gates for the last two Writing Kernel tail items:
 *  - production frozenStageMessages Writer bypass = 0
 *  - post-Freeze live model-setting read = 0
 *  - shared Draft prompt compiler production implementation = 1
 *
 * These inspect production source. Renames, facades, or restoring the old
 * Outline Draft ChatMessage[] path must fail.
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

const POST_FREEZE_WRITER_LAYER = new Set([
  'src/services/writing/unifiedWritingKernel.ts',
  'src/services/writing/productionWritingEntry.ts',
]);

function isPostFreezeWriterLayer(name: string): boolean {
  return (
    POST_FREEZE_WRITER_LAYER.has(name) ||
    name.startsWith('src/services/writing/stages/') ||
    name.startsWith('src/services/writing/execution/') ||
    name.startsWith('src/services/writing/prompt/')
  );
}

describe('Writing Kernel final seal — Draft prompt + frozen model', () => {
  test('production frozenStageMessages Writer bypass is zero', () => {
    const violations = files.filter(item => {
      if (
        !isPostFreezeWriterLayer(item.name) &&
        item.name !== 'src/services/pipeline/outlineStageRuntime.ts'
      ) {
        return false;
      }
      return /\bfrozenStageMessages\b/.test(item.stripped);
    });
    expect(violations.map(item => item.name)).toEqual([]);
  });

  test('shared Draft compiler never returns a frozen ChatMessage[] bypass', () => {
    const compiler = files.find(
      item => item.name === 'src/services/writing/prompt/sharedPromptCompiler.ts',
    );
    expect(compiler).toBeTruthy();
    expect(compiler!.stripped).not.toMatch(/\breadFrozenMessages\b/);
    expect(compiler!.stripped).not.toMatch(/\bfrozenStageMessages\b/);
    expect(compiler!.stripped).toMatch(
      /export\s+function\s+compileSharedWritingPrompt\b/,
    );
    expect(compiler!.stripped).toMatch(/projectRequirementsForStage/);
    expect(compiler!.stripped).toMatch(/instructionBlock/);
  });

  test('there is exactly one production Draft prompt compiler implementation', () => {
    const definitions = files.filter(item =>
      /export\s+function\s+compileSharedWritingPrompt\b/.test(item.text),
    );
    expect(definitions.map(item => item.name)).toEqual([
      'src/services/writing/prompt/sharedPromptCompiler.ts',
    ]);
  });

  test('post-Freeze writer layer performs zero live model-config reads', () => {
    const violations = files.filter(
      item =>
        isPostFreezeWriterLayer(item.name) &&
        /\bresolveLLMRequestConfig(?:ById)?\b/.test(item.stripped),
    );
    expect(violations.map(item => item.name)).toEqual([]);
  });

  test('writerCore builds the request from frozen model + credentialRef only', () => {
    const writer = files.find(
      item => item.name === 'src/services/writing/stages/writerCore.ts',
    );
    expect(writer).toBeTruthy();
    expect(writer!.stripped).not.toMatch(/\bresolveLLMRequestConfig(?:ById)?\b/);
    expect(writer!.stripped).toMatch(/\bresolveWritingCredential\b/);
    expect(writer!.stripped).toMatch(/\bcredentialRef\b/);
  });

  test('Continuation Freeze persists thinking; Writer Core has no DeepSeek fallback', () => {
    const prep = files.find(
      item =>
        item.name ===
        'src/services/writing/scenario/continuationRunPreparation.ts',
    );
    const v5 = files.find(
      item =>
        item.name ===
        'src/services/continuation/generation/continuationV5Models.ts',
    );
    const writer = files.find(
      item => item.name === 'src/services/writing/stages/writerCore.ts',
    );
    expect(prep).toBeTruthy();
    expect(v5).toBeTruthy();
    expect(writer).toBeTruthy();
    expect(prep!.stripped).toMatch(/\bthinking\s*:/);
    expect(v5!.stripped).toMatch(/\bthinking\s*:/);
    expect(writer!.stripped).not.toMatch(/deepseek-v4-\(flash\|pro\)/);
    expect(writer!.stripped).not.toMatch(/\bresolveLLMRequestConfig(?:ById)?\b/);
  });
});
