/**
 * Runtime (post-Freeze) skip decisions that cannot live in frozen skipRules
 * because they depend on earlier-stage artifacts.
 *
 * Frozen One-Shot / scenario skipRules still win first.
 */
import { aggregateStageFindings } from '../context/findingsAggregator';
import { isCompactPipelineTopology } from '../../pipeline/outlineWorkflowVersion';
import type { SharedWritingStageName } from '../contracts/writingPolicy';
import type {
  SharedWritingArtifact,
  WritingStageArtifacts,
} from '../contracts/writingStage';

export const CONDITIONAL_REVISION_RULE_ID =
  'policy.one_pipeline.conditional_revision_no_findings';
export const CONDITIONAL_PROOF_RULE_ID =
  'policy.one_pipeline.conditional_proof_no_residual';

const EMPTY_ISSUE = /^(未发现|没有必须|无需修改|pass|ok|无问题|总体不错|略显平淡|可以更生动|建议加强)/i;

// Phase 5 §5.1: QA verdict that authoritatively says "no change needed".
const PASS_VERDICTS = new Set([
  'pass',
  'ok',
  'clean',
  'clear',
  'nochange',
  'no_change',
  'keep',
  'accept',
  'accepted',
  'good',
  'fine',
]);

const REPORT_STAGES = ['qa', 'review', 'audit', 'factCheck'] as const;

/** Loose gate (legacy proof / one-flow): any non-empty, non-void issue. */
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

/**
 * Phase 5 §5.1 / §5.2 — the Revision trigger contract.
 *
 * Revision may dispatch only when:
 *   - no report stage carries a pass-like verdict (authoritative "no change"),
 *     AND
 *   - at least one Executable Finding exists:
 *       issue non-empty (not generic / void)
 *       && severity ∈ {blocking, warning}          (info never triggers)
 *       && (target OR requirementIds) non-empty    (locatable)
 *       && (instruction OR target) non-empty       (actionable / fix target)
 *
 * A missing verdict is treated as "review findings", not "no change", so a
 * blocking executable finding still triggers even if the model omitted
 * `verdict`. This keeps production behavior while failing closed on any
 * explicit pass verdict or on non-executable / info / generic input.
 */
export function hasExecutableRevisionFindings(
  artifacts: WritingStageArtifacts,
): boolean {
  if (readPassVerdict(artifacts)) return false;
  return aggregateStageFindings(artifacts).some(isExecutableRevisionFinding);
}

/**
 * Phase IV pre-seal correction.  An incomplete ONE-QA result
 * (`finishReason=length` truncation or an invalid structured contract) is
 * Advisory: it never hard-blocks the chapter and never spends an extra LLM
 * call.  But the Mandatory / Canon / State Safety checks the unified QA was
 * supposed to cover are then UNRESOLVED, so the revision skip must never be
 * recorded under the ordinary "QA 无可执行问题" clean rule.
 */
export const QA_INCOMPLETE_NOT_CLEAN_RULE_ID =
  'policy.phase4.qa_incomplete_not_clean' as const;

const QA_INCOMPLETE_DIAGNOSTICS = [
  'qa_truncated_advisory',
  'qa_contract_advisory',
] as const;

export function qaIncompleteAdvisory(
  artifacts: WritingStageArtifacts,
): string | null {
  const value = artifacts.qa;
  if (!value || typeof value !== 'object') return null;
  const diagnostics = (value as SharedWritingArtifact).diagnostics;
  if (!Array.isArray(diagnostics)) return null;
  for (const diagnostic of QA_INCOMPLETE_DIAGNOSTICS) {
    if (diagnostics.includes(diagnostic)) return diagnostic;
  }
  return null;
}

function isExecutableRevisionFinding(finding: {
  issue: string;
  severity: string;
  target: string;
  instruction: string;
  requirementIds: string[];
}): boolean {
  const issue = finding.issue.trim();
  if (!issue || issue === '（无摘要）') return false;
  if (EMPTY_ISSUE.test(issue)) return false;
  if (finding.severity !== 'blocking' && finding.severity !== 'warning') {
    return false;
  }
  const locatable =
    Boolean(finding.target.trim()) || finding.requirementIds.length > 0;
  const actionable =
    Boolean(finding.instruction.trim()) || Boolean(finding.target.trim());
  return locatable && actionable;
}

function readPassVerdict(artifacts: WritingStageArtifacts): boolean {
  for (const stage of REPORT_STAGES) {
    const value = artifacts[stage];
    if (!value || typeof value !== 'object') continue;
    const artifact = value as SharedWritingArtifact;
    const verdict = readArtifactVerdict(artifact);
    if (verdict && PASS_VERDICTS.has(verdict.toLowerCase())) return true;
  }
  return false;
}

function readArtifactVerdict(artifact: SharedWritingArtifact): string | null {
  const structured =
    artifact.structured && typeof artifact.structured === 'object'
      ? (artifact.structured as Record<string, unknown>)
      : null;
  if (structured && typeof structured.verdict === 'string') {
    return structured.verdict;
  }
  const body =
    typeof artifact.body === 'string' && artifact.body.trim() ? artifact.body : '';
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const verdict = (parsed as Record<string, unknown>).verdict;
      return typeof verdict === 'string' ? verdict : null;
    }
  } catch {
    /* not JSON — no verdict */
  }
  return null;
}

export function evaluateRuntimeStageSkip(input: {
  stage: SharedWritingStageName;
  artifacts: WritingStageArtifacts;
  proofPolicy?: unknown;
  pipelineTopologyVersion?: unknown;
}): { skip: false } | { skip: true; skipReason: string; policyRuleId: string } {
  if (input.stage === 'revision') {
    // Phase 5 §5.1/§5.2: the stricter Revision Trigger contract applies to the
    // compact ONE-QA Standard path only (verdict gate + severity ∈ {blocking,
    // warning} + locatable/actionable). Legacy topologies keep the historical
    // loose Review/Audit/FactCheck-driven brief so legacy resume semantics
    // (§2.3 / §4.2C) are never altered.
    const executable = isCompactPipelineTopology(input.pipelineTopologyVersion)
      ? hasExecutableRevisionFindings(input.artifacts)
      : hasExecutableFindings(input.artifacts);
    if (executable) return { skip: false };
    const incompleteQa = qaIncompleteAdvisory(input.artifacts);
    if (incompleteQa) {
      return {
        skip: true,
        skipReason:
          `QA 未完成（${incompleteQa}）：Mandatory / Canon / State Safety 检查未决，` +
          '结果不得记为 Clean；纯质量检查未完成仅 Advisory，不追加 LLM 调用',
        policyRuleId: QA_INCOMPLETE_NOT_CLEAN_RULE_ID,
      };
    }
    return {
      skip: true,
      skipReason: isCompactPipelineTopology(input.pipelineTopologyVersion)
        ? 'QA 无可执行问题（verdict=pass 或无 blocking/warning 可定位修订项：info/generic 不触发）'
        : 'QA 没有可定位、可执行的问题（Review / Audit / FactCheck 同样汇总于此）',
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
