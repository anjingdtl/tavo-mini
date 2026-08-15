import { fingerprintWritingSourceBundle } from '../contracts/writingFingerprint';
import type {
  WritingScenario,
  WritingSourceBundle,
  WritingSourceTrace,
} from '../contracts/writingSource';

export function createWritingSourceTrace(input: {
  scenario: WritingScenario;
  sourceAdapter: string;
  bundle: WritingSourceBundle;
  rejectedSources?: string[];
  missingSources?: string[];
  legacyRestart?: WritingSourceTrace['legacyRestart'];
}): WritingSourceTrace {
  return {
    scenario: input.scenario,
    sourceAdapter: input.sourceAdapter,
    sourceCandidateCount:
      input.bundle.mandatory.length +
      input.bundle.preferred.length +
      input.bundle.optional.length,
    mandatoryCount: input.bundle.mandatory.length,
    preferredCount: input.bundle.preferred.length,
    optionalCount: input.bundle.optional.length,
    sourceFingerprint: fingerprintWritingSourceBundle(input.bundle),
    rejectedSources: [...(input.rejectedSources || [])],
    missingSources: [...(input.missingSources || [])],
    ...(input.legacyRestart
      ? { legacyRestart: input.legacyRestart }
      : {}),
  };
}
