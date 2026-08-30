import {
  resolvePersistenceBoundaryCandidate,
  resolveFinalWritingCandidate,
} from '../src/services/writing/stages/finalCandidate';
import { sanitizePhase4RevisionSidecar } from '../src/services/writing/stages/writerRecovery';

describe('Phase IV-5 Persistence Boundary', () => {
  test('the validated Final Candidate is the only persistence body', () => {
    const candidate = resolvePersistenceBoundaryCandidate(
      {
        finalValidate: {
          stage: 'finalValidate',
          body: 'VALIDATED-FINAL',
          sourceStage: 'revision',
        },
        revision: { stage: 'revision', body: 'REVISION' },
        draft: { stage: 'draft', body: 'DRAFT' },
      },
      { mode: 'compact' },
    );
    expect(candidate.body).toBe('VALIDATED-FINAL');
    expect(candidate.sourceStage).toBe('revision');
  });

  test('an empty non-skipped Final Validate result fails closed', () => {
    const candidate = resolvePersistenceBoundaryCandidate(
      {
        finalValidate: { stage: 'finalValidate', body: '' },
        revision: { stage: 'revision', body: 'REVISION' },
        draft: { stage: 'draft', body: 'DRAFT' },
      },
      { mode: 'compact' },
    );
    expect(candidate.body).toBe('');
    expect(candidate.sourceStage).toBeNull();
  });

  test('malformed optional state sidecar is dropped while prose survives', () => {
    const result = sanitizePhase4RevisionSidecar({
      parsed: {
        content: '完整正文',
        finalStateProposals: 'not-an-array',
        proposalSourceBodyFingerprint: 'model-guessed-hash',
      },
      finalBody: '完整正文',
    });
    expect(result.parsed.content).toBe('完整正文');
    expect(result.parsed.finalStateProposals).toBeUndefined();
    expect(result.parsed.proposalSourceBodyFingerprint).toBeUndefined();
    expect(result.dropped).toBe(true);
  });

  test('a valid phase4 body remains compatible with the compact final candidate', () => {
    const candidate = resolveFinalWritingCandidate(
      { revision: { stage: 'revision', body: 'REVISION' } },
      { mode: 'compact' },
    );
    expect(candidate.body).toBe('REVISION');
  });
});
