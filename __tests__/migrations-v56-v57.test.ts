import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  ARTIFACT_CONTENT_UNIQUE_V57,
  buildSchema57ArtifactsCreateSql,
  buildV56ToV57Statements,
} from '../src/services/migrations/v56-to-v57';

describe('Schema 56 → 57 Final-body artifact hash binding', () => {
  it('keeps uniqueness within a stage while allowing exact cross-stage bodies', () => {
    expect(SCHEMA_VERSION).toBe(58);
    const ddl = buildSchema57ArtifactsCreateSql();
    expect(ddl).toContain(ARTIFACT_CONTENT_UNIQUE_V57);
    expect(ddl).not.toContain('UNIQUE(run_id, content_hash),');
  });

  it('rebuilds the artifact table without changing its columns', () => {
    const sql = buildV56ToV57Statements()
      .map(statement => statement.sql)
      .join('\n');
    expect(sql).toContain(
      'ALTER TABLE continuation_generation_artifacts\n        RENAME TO continuation_generation_artifacts__v57',
    );
    expect(sql).toContain(
      'INSERT INTO continuation_generation_artifacts (id, run_id, stage, repair_round, parent_artifact_id, content, content_hash, eligibility_status, rejection_code, created_at)',
    );
    expect(sql).toContain('DROP TABLE continuation_generation_artifacts__v57');
    expect(sql).toContain(ARTIFACT_CONTENT_UNIQUE_V57);
  });
});
