/**
 * Final Unified Writer Kernel gates.
 *
 * These gates intentionally inspect production source rather than only the
 * public entry. A single scheduler is not enough: every post-Freeze writer
 * stage must have one shared implementation and both durable substrates must
 * enter that same stage set.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const WRITING = path.join(SRC, 'services', 'writing');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function relativeName(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

const files = productionFiles(SRC).filter(file => {
  const name = relativeName(file);
  return !name.includes('/legacy/') && !name.includes('/__tests__/');
});
const source = files.map(file => ({
  file,
  name: relativeName(file),
  text: read(relativeName(file)),
}));

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

describe('Unified Writer Kernel — one shared post-Freeze stage set', () => {
  test('one production implementation exists for every shared stage', () => {
    for (const stage of SHARED_STAGES) {
      const pattern = new RegExp(
        `(?:export\\s+)?(?:async\\s+)?function\\s+run${stage}Stage\\b`,
      );
      const definitions = source.filter(item => pattern.test(item.text));
      expect(definitions.map(item => item.name)).toEqual([
        `src/services/writing/stages/${stage.charAt(0).toLowerCase()}${stage.slice(1)}.ts`,
      ]);
    }
  });

  test('outline and continuation drivers enter the same shared stage runner', () => {
    const outline = read('src/services/writing/execution/outlineStageDriver.ts');
    const continuation = read(
      'src/services/writing/execution/continuationStageDriver.ts',
    );
    expect(outline).toMatch(/runWritingStages/);
    expect(continuation).toMatch(/runWritingStages/);
  });

  test('post-Freeze production code has no old scenario writer core imports', () => {
    const outline = read('src/services/writing/execution/outlineStageDriver.ts');
    const continuation = read(
      'src/services/writing/execution/continuationStageDriver.ts',
    );
    expect(outline).not.toMatch(/from ['"][^'"]*pipeline\/reconcile['"]/);
    expect(continuation).not.toMatch(/continuationV5StageMachine/);
  });

  test('pipeline/reconcile is orchestration-only', () => {
    const reconcile = read('src/services/pipeline/reconcile.ts');
    expect(reconcile).not.toMatch(/callLLMResult\s*\(/);
    expect(reconcile).not.toMatch(/async function actionRun(?:Draft|Review|FactCheck|Brief|Proof)\b/);
    expect(reconcile).not.toMatch(/async function actionFinalizeFrom(?:Draft|Proof)\b/);
    expect(reconcile).not.toMatch(/async function actionComplete\b/);
  });

  test('requirement and policy contracts are shared inputs, not scenario branches', () => {
    expect(fs.existsSync(path.join(WRITING, 'contracts', 'writingRequirement.ts'))).toBe(true);
    expect(fs.existsSync(path.join(WRITING, 'contracts', 'writingPolicy.ts'))).toBe(true);
    const stageFiles = SHARED_STAGES.map(stage =>
      source.find(
        item =>
          item.name ===
          `src/services/writing/stages/${stage.charAt(0).toLowerCase()}${stage.slice(1)}.ts`,
      ),
    );
    expect(stageFiles.every(Boolean)).toBe(true);
    expect(read('src/services/writing/stages/sharedStage.ts')).toMatch(
      /WritingRequirement/,
    );
    expect(read('src/services/writing/stages/writingStageRunner.ts')).toMatch(
      /requirements: input\.frozenContext\.requirements/,
    );
  });

  test('both production drivers bind Semantic Apply to shared Final Validate', () => {
    const outline = read('src/services/writing/execution/outlineStageDriver.ts');
    const continuation = read(
      'src/services/writing/execution/continuationStageDriver.ts',
    );
    expect(outline).toMatch(/semanticApply:\s*async/);
    expect(continuation).toMatch(/semanticApply:\s*async/);
    expect(read('src/services/writing/stages/finalValidate.ts')).toMatch(
      /checkSemanticRequirementApplication/,
    );
  });

  test('continuation emits every shared stage before terminal settlement', () => {
    const continuation = read(
      'src/services/writing/execution/continuationStageDriver.ts',
    );
    for (const stage of [
      'draft',
      'review',
      'audit',
      'factCheck',
      'revision',
      'proof',
      'finalValidate',
      'persist',
    ]) {
      expect(continuation).toMatch(new RegExp(`stage: ['"]${stage}['"]`));
    }
    const pendingDrain = continuation.indexOf(
      'if (pendingOutcomes.length > 0)',
    );
    const terminalGuard = continuation.indexOf('if (done)');
    expect(pendingDrain).toBeGreaterThanOrEqual(0);
    expect(terminalGuard).toBeGreaterThanOrEqual(0);
    expect(pendingDrain).toBeLessThan(terminalGuard);
  });

  test('ContinuationV5StageMachine and outline writer core have zero production callers', () => {
    for (const item of source) {
      expect(item.text).not.toMatch(/continuationV5StageMachine/);
    }
    const oldImports = source.filter(item =>
      /from ['"][^'"]*continuationV5StageMachine['"]/.test(item.text),
    );
    expect(oldImports).toEqual([]);
  });
});
