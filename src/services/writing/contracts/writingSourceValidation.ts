import {
  fingerprintWritingSourceBundle,
  writingSourceContentHash,
} from './writingFingerprint';
import type {
  WritingScenario,
  WritingSource,
  WritingSourceBundle,
  WritingSourceValidationIssue,
  WritingSourceValidationResult,
} from './writingSource';

const REVISION_REQUIRED_KINDS = new Set<WritingSource['kind']>([
  'outline',
  'canon',
  'source_boundary',
  'seam',
  'primary_anchor',
  'chapter',
]);

function allSources(bundle: WritingSourceBundle): WritingSource[] {
  return [...bundle.mandatory, ...bundle.preferred, ...bundle.optional];
}

function issue(
  code: WritingSourceValidationIssue['code'],
  message: string,
  candidateId?: string,
): WritingSourceValidationIssue {
  return { code, message, ...(candidateId ? { candidateId } : {}) };
}

export function validateWritingSourceBundle(
  scenario: WritingScenario,
  bundle: WritingSourceBundle,
): WritingSourceValidationResult {
  const issues: WritingSourceValidationIssue[] = [];
  const sources = allSources(bundle);
  const ids = new Set<string>();

  for (const source of sources) {
    const candidateId = String(source.candidateId || '');
    if (!candidateId || ids.has(candidateId)) {
      issues.push(
        issue(
          'DUPLICATE_CANDIDATE',
          `candidateId 必须非空且唯一：${candidateId || '<empty>'}`,
          candidateId || undefined,
        ),
      );
    }
    ids.add(candidateId);

    const expectedHash = writingSourceContentHash(source.content);
    if (!/^[a-f0-9]{64}$/i.test(String(source.contentHash || '')) || source.contentHash.toLowerCase() !== expectedHash) {
      issues.push(
        issue(
          'INVALID_SOURCE_HASH',
          `资料 ${candidateId} 的 contentHash 与内容不一致`,
          candidateId,
        ),
      );
    }

    if (
      REVISION_REQUIRED_KINDS.has(source.kind) &&
      (source.sourceId == null || !String(source.revision || '').trim())
    ) {
      issues.push(
        issue(
          'INVALID_SOURCE_REVISION',
          `资料 ${candidateId} 缺少可验证的 sourceId/revision`,
          candidateId,
        ),
      );
    }

    if (
      source.requirement === 'mandatory' &&
      !String(source.content || '').trim()
    ) {
      issues.push(
        issue(
          'EMPTY_MANDATORY_SOURCE',
          `mandatory 资料 ${candidateId} 不允许为空`,
          candidateId,
        ),
      );
    }

    const scenarioMismatch =
      (scenario === 'outline' &&
        [
          'canon',
          'source_boundary',
          'seam',
          'primary_anchor',
          'structured_continuity_state',
        ].includes(source.kind)) ||
      (scenario === 'continuation' && source.kind === 'outline');
    if (scenarioMismatch) {
      issues.push(
        issue(
          'INVALID_SCENARIO_SOURCE',
          `资料 ${candidateId} 不属于 ${scenario} 场景的输入边界`,
          candidateId,
        ),
      );
    }
  }

  const mandatoryKinds = new Set(bundle.mandatory.map(source => source.kind));
  const requiredKinds =
    scenario === 'outline'
      ? ['instruction', 'chapter', 'outline', 'preset']
      : ['instruction', 'canon', 'source_boundary'];
  for (const kind of requiredKinds) {
    if (!mandatoryKinds.has(kind as WritingSource['kind'])) {
      issues.push(
        issue(
          'MISSING_MANDATORY_SOURCE',
          `${scenario} 缺少 mandatory ${kind} 资料`,
        ),
      );
    }
  }
  if (
    scenario === 'continuation' &&
    !mandatoryKinds.has('seam') &&
    !mandatoryKinds.has('primary_anchor')
  ) {
    issues.push(
      issue(
        'MISSING_MANDATORY_SOURCE',
        'continuation 缺少 mandatory seam/primary_anchor 资料',
      ),
    );
  }

  // Computing the fingerprint here makes accidental unused-import removal
  // impossible and ensures validation always exercises the stable contract.
  fingerprintWritingSourceBundle(bundle);
  return { ok: issues.length === 0, issues };
}

export function assertValidWritingSourceBundle(
  scenario: WritingScenario,
  bundle: WritingSourceBundle,
): void {
  const result = validateWritingSourceBundle(scenario, bundle);
  if (!result.ok) {
    const error = new Error(
      result.issues.map(item => `${item.code}: ${item.message}`).join('; '),
    ) as Error & {
      code: WritingSourceValidationIssue['code'];
      issues: WritingSourceValidationIssue[];
    };
    error.code = result.issues[0]?.code || 'MISSING_MANDATORY_SOURCE';
    error.issues = result.issues;
    throw error;
  }
}
