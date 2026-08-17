/**
 * Architecture regression gates for the 极速档 (V1.0 plan §16):
 * no fast/extreme writer cores, prompt compilers, or context builders may
 * be introduced; the one Shared Writer Core / Prompt Compiler / Kernel stay.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const FORBIDDEN_FILES = [
  'src/services/writing/stages/fastWriter.ts',
  'src/services/writing/stages/extremeWriter.ts',
  'src/services/writing/stages/oneShotWriterCore.ts',
  'src/services/writing/prompt/fastPromptCompiler.ts',
  'src/services/writing/prompt/extremePromptCompiler.ts',
  'src/services/writing/prompt/oneShotPromptCompiler.ts',
  'src/services/writing/context/fastContextBuilder.ts',
  'src/services/writing/context/extremeContextBuilder.ts',
];

describe('One-Shot architecture gates', () => {
  test('no fast/extreme writer, compiler, or context-builder files exist', () => {
    for (const forbidden of FORBIDDEN_FILES) {
      expect(fs.existsSync(path.join(ROOT, forbidden))).toBe(false);
    }
  });

  test('writer core contains no scenario-specific one-shot writer branch', () => {
    const source = read('src/services/writing/stages/writerCore.ts');
    expect(source).toContain('THE one Shared Writer Core');
    expect(source).not.toMatch(/fastWriter|extremeWriter|oneShotWriter/);
  });

  test('prompt compiler remains the single production compiler', () => {
    const source = read(
      'src/services/writing/prompt/sharedPromptCompiler.ts',
    );
    expect(source).toContain('THE one production writer prompt compiler');
    expect(source).not.toMatch(
      /fastPrompt|extremePrompt|oneShotPromptCompiler/,
    );
  });

  test('execution profile contract defines no input token cap', () => {
    const source = read(
      'src/services/writing/contracts/executionProfile.ts',
    );
    expect(source).toContain("id: 'one_shot'");
    expect(source).not.toMatch(
      /inputTokenCap|maxInputTokens|32000|32768|50000|80000|contextLimit/i,
    );
  });

  test('no production module names a fast/extreme writer surface', () => {
    const src = path.join(ROOT, 'src', 'services', 'writing');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          if (/fast|extreme/i.test(entry.name)) offenders.push(full);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
