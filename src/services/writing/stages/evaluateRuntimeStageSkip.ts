/**
 * Runtime (post-Freeze) skip decisions that cannot live in frozen skipRules
 * because they depend on earlier-stage artifacts.
 *
 * Frozen One-Shot / scenario skipRules still win first.
 */
import { aggregateStageFindings } from '../context/findingsAggregator';
import type { SharedWritingStageName } from '../contracts/writingPolicy';
import type { WritingStageArtifacts } from '../contracts/writingStage';

export const CONDITIONAL_REVISION_RULE_ID =
  'policy.one_pipeline.conditional_revision_no_findings';
export const CONDITIONAL_PROOF_RULE_ID =
  'policy.one_pipeline.conditional_proof_no_residual';

const EMPTY_ISSUE = /^(未发现|没有必须|无需修改|pass|ok|无问题)/i;

export function hasExecutableFindings(
  artifacts: WritingStageArtifacts,
): boolean {
  return aggregateStageFindings(artifacts).some(finding => {
    const issue = finding.issue.trim();
    if (!issue || issue === '（无摘要）') return false;
    if (EMPTY_ISSUE.test(issue)) return false;
    return true;
  });
}

export function evaluateRuntimeStageSkip(input: {
  stage: SharedWritingStageName;
  artifacts: WritingStageArtifacts;
  proofPolicy?: unknown;
}): { skip: false } | { skip: true; skipReason: string; policyRuleId: string } {
  if (input.stage === 'revision') {
    // Phase 4 §7.2: ONE QA is the unique findings source. The Revision
    // trigger looks at `qa` artifacts (plus any legacy review/audit/factCheck
    // artifacts carried by legacy resume).
    if (hasExecutableFindings(input.artifacts)) return { skip: false };
    return {
      skip: true,
      skipReason:
        'QA 没有可定位、可执行的问题（Review / Audit / FactCheck 同样汇总于此）',
      policyRuleId: CONDITIONAL_REVISION_RULE_ID,
    };
  }
  if (input.stage === 'proof' && input.proofPolicy === 'conditional') {
    if (hasExecutableFindings(input.artifacts)) return { skip: false };
    return {
      skip: true,
      skipReason: '无残余 findings，条件校对跳过',
      policyRuleId: CONDITIONAL_PROOF_RULE_ID,
    };
  }
  return { skip: false };
}
