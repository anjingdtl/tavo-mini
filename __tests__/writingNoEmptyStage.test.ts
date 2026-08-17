/**
 * Gate D: skipped stages must be explicit. Fake completed no-op stages are forbidden.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildWritingStagePolicy,
  resolveSharedStageSkip,
} from '../src/services/writing/contracts/writingPolicy';
import { buildWritingRequirements } from '../src/services/writing/contracts/writingRequirement';
import type { WritingRequest } from '../src/services/writing/contracts/writingSource';

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

describe('No fake / empty Shared Stage', () => {
  test('production writing drivers never register async () => undefined stages', () => {
    const files = [
      'src/services/writing/execution/outlineStageDriver.ts',
      'src/services/writing/execution/continuationStageDriver.ts',
      'src/services/writing/stages/writingStageRunner.ts',
      'src/services/writing/stages/sharedStage.ts',
    ];
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(text).not.toMatch(/execute\s*:\s*async\s*\(\s*\)\s*=>\s*undefined/);
      expect(text).not.toMatch(/execute\s*:\s*\(\s*\)\s*=>\s*undefined/);
    }
  });

  test('no production writing module completes a stage with a no-op executor', () => {
    const writingRoot = path.join(SRC, 'services', 'writing');
    for (const file of listFiles(writingRoot)) {
      const name = rel(file);
      if (name.includes('/legacy/')) continue;
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toMatch(/async\s*\(\s*\)\s*=>\s*undefined/);
    }
  });

  test('policy skip is a first-class skipped result with reason and rule id', () => {
    const request = {
      writingRunId: 'wr_skip',
      generationTraceId: 'gt_skip',
      projectId: 1,
      chapterId: 2,
      scenario: 'continuation',
      instruction: {
        title: 't',
        synopsis: 's',
        userInstruction: 'u',
        currentContent: '',
        targetPosition: 3,
      },
      sourceBundle: { mandatory: [], preferred: [], optional: [] },
      model: {
        configId: 1,
        provider: 'openai_compatible',
        modelName: 'fixture',
        contextWindow: 8192,
        maxOutputTokens: 1024,
      },
      policy: {
        version: 1,
        reviewMode: 'continuation-v5',
        strictness: 'fail-closed',
        values: {},
      },
    } as WritingRequest;
    const requirements = buildWritingRequirements(request);
    const policy = buildWritingStagePolicy(request, requirements);
    const skip = resolveSharedStageSkip(policy, 'factCheck');
    expect(skip).toEqual({
      skip: true,
      skipReason: expect.any(String),
      policyRuleId: expect.any(String),
    });
    expect(skip.skip).toBe(true);
    if (skip.skip) {
      expect(skip.skipReason.length).toBeGreaterThan(0);
      expect(skip.policyRuleId.length).toBeGreaterThan(0);
    }
  });
});
