import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildSchema34ArtifactsCreateSql,
  buildSchema34RunCreateSql,
  buildSchema34StageResultsCreateSql,
  buildV33toV34Statements,
} from '../src/services/migrations/v33-to-v34';

describe('Schema 33 → 34 Continuation V5 CHECK expansion', () => {
  it('reports SCHEMA_VERSION as 34', () => {
    expect(SCHEMA_VERSION).toBe(34);
  });

  it('widens run state/stage, stage_results stage, artifact stage/eligibility', () => {
    const runSql = buildSchema34RunCreateSql();
    expect(runSql).toContain("'awaiting_regeneration'");
    expect(runSql).toContain("'draft_writer'");
    expect(runSql).toContain("'final_validate'");
    expect(runSql).toContain("'round1'");

    const stageSql = buildSchema34StageResultsCreateSql();
    expect(stageSql).toContain("'narrative_architect'");
    expect(stageSql).toContain("'adversarial_auditor'");
    expect(stageSql).toContain("'final_reviser'");
    // V4 stages retained
    expect(stageSql).toContain("'writer'");
    expect(stageSql).toContain("'local_verify'");

    const artifactSql = buildSchema34ArtifactsCreateSql();
    expect(artifactSql).toContain("'draft'");
    expect(artifactSql).toContain("'revision_1'");
    expect(artifactSql).toContain("'final'");
    expect(artifactSql).toContain("'intermediate'");
    // V4 stages retained
    expect(artifactSql).toContain("'writer'");
    expect(artifactSql).toContain("'repair'");

    const migrationSql = buildV33toV34Statements()
      .map(item => item.sql)
      .join('\n');
    expect(migrationSql).toContain('continuation_generation_runs_v33');
    expect(migrationSql).toContain('continuation_generation_artifacts_v33');
    expect(migrationSql).toContain(
      'continuation_generation_stage_results_v33',
    );
  });
});
