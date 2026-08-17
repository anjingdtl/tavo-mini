/**
 * Gate A: Shared stages must not accept a generic Scenario Writer executor.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('No Scenario execute() escape hatch', () => {
  test('SharedWritingStageInput has no execute callback', () => {
    const contract = read('src/services/writing/contracts/writingStage.ts');
    const stripped = stripComments(contract);
    expect(stripped).not.toMatch(/\bexecute\s*:\s*\(/);
    expect(stripped).not.toMatch(/\bexecute\s*\?\s*:\s*\(/);
  });

  test('production stage runner does not thread a scenario execute callback', () => {
    const runner = stripComments(
      read('src/services/writing/stages/writingStageRunner.ts'),
    );
    const shared = stripComments(
      read('src/services/writing/stages/sharedStage.ts'),
    );
    expect(runner).not.toMatch(/\bexecute\s*:/);
    expect(shared).not.toMatch(/stageInput\.execute\s*\(/);
  });

  test('production drivers do not inject scenario writers through execute()', () => {
    const outline = stripComments(
      read('src/services/writing/execution/outlineStageDriver.ts'),
    );
    const continuation = stripComments(
      read('src/services/writing/execution/continuationStageDriver.ts'),
    );
    expect(outline).not.toMatch(/\bexecute\s*:/);
    expect(continuation).not.toMatch(/\bexecute\s*:/);
    expect(outline).not.toMatch(/\brunOutlineStageOperation\b/);
    expect(outline).not.toMatch(/\brunOutlineWritingCapability\b/);
    expect(continuation).not.toMatch(/\brunContinuationDraftCapability\b/);
    expect(continuation).not.toMatch(/\brunContinuationRevisionAndAuditCapability\b/);
    expect(continuation).not.toMatch(/\brunContinuationProofCapability\b/);
  });

  test('no production multi-stage Writer Capability remains', () => {
    const capabilities = read(
      'src/services/writing/stages/continuationStageCapabilities.ts',
    );
    const stripped = stripComments(capabilities);
    expect(stripped).not.toMatch(
      /export\s+async\s+function\s+runContinuation(?:Draft|RevisionAndAudit|Proof)Capability\b/,
    );
    expect(stripped).not.toMatch(/RevisionAndAudit/);
  });
});
