import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildSchema34ArtifactsCreateSql,
  buildSchema34CreateSqls,
  buildSchema34RunCreateSql,
  buildSchema34StageResultsCreateSql,
  buildV33toV34Statements,
  migrateV33ToV34,
} from '../src/services/migrations/v33-to-v34';

function fakeDb(foreignKeyOrphans = 0) {
  const executeSql = jest.fn(async (sql: string) => {
    if (sql.includes('PRAGMA foreign_key_check')) {
      return [
        {
          rows: {
            length: foreignKeyOrphans,
            item: (i: number) => ({ table: `orphan_${i}` }),
          },
        },
      ];
    }
    return [{ rows: { length: 0, item: () => ({}) } }];
  });
  const transaction = jest.fn(
    (scope: any, _onError: any, onSuccess: () => void) => {
      scope({ executeSql: jest.fn() });
      onSuccess();
    },
  );
  return { executeSql, transaction } as any;
}

describe('Schema 33 → 34 Continuation V5 CHECK expansion', () => {
  it('is superseded by a later current SCHEMA_VERSION', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(34);
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

  it('fresh-install helper wraps rebuild with rename-safe PRAGMAs', () => {
    const sqls = buildSchema34CreateSqls();
    expect(sqls[0]).toContain('PRAGMA foreign_keys = OFF');
    expect(sqls[1]).toContain('PRAGMA legacy_alter_table = ON');
    expect(sqls[sqls.length - 2]).toContain('PRAGMA legacy_alter_table = OFF');
    expect(sqls[sqls.length - 1]).toContain('PRAGMA foreign_keys = ON');
    expect(sqls.some(s => s.includes('continuation_generation_runs_v33'))).toBe(
      true,
    );
  });

  it('migrateV33ToV34 toggles rename-safe PRAGMAs and accepts clean FK check', async () => {
    const db = fakeDb(0);
    await expect(migrateV33ToV34(db)).resolves.toBeUndefined();
    const sqls = db.executeSql.mock.calls.map((c: string[]) => c[0]);
    expect(sqls[0]).toContain('PRAGMA foreign_keys = OFF');
    expect(sqls[1]).toContain('PRAGMA legacy_alter_table = ON');
    expect(sqls.some((s: string) => s.includes('PRAGMA foreign_key_check'))).toBe(
      true,
    );
    expect(sqls).toContainEqual(expect.stringContaining('legacy_alter_table = OFF'));
    expect(sqls).toContainEqual(expect.stringContaining('foreign_keys = ON'));
  });

  it('migrateV33ToV34 rejects when foreign_key_check reports orphans', async () => {
    const db = fakeDb(2);
    await expect(migrateV33ToV34(db)).rejects.toThrow(/外键孤儿/);
  });
});
