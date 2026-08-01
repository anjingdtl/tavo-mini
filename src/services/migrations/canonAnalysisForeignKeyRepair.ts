import type { SqlStatement } from '../database/transaction';
import { SCHEMA_MANIFEST } from '../database/schemaManifest';
import { buildV19toV20Statements } from './v19-to-v20';

/**
 * Canon tables which were present when continuation_analysis_runs was rebuilt
 * in Schema 30. SQLite rewrites every referencing FK when a parent is renamed,
 * so these tables must be rebuilt alongside that parent rather than left
 * pointing at its temporary name.
 */
const CANON_TABLE_CREATE_ORDER = [
  'canon_evidence',
  'canon_evidence_links',
  'canon_world_rules',
  'canon_characters',
  'canon_character_aliases',
  'canon_character_state_snapshots',
  'canon_relationships',
  'canon_plot_threads',
  'canon_plot_thread_characters',
  'canon_character_experiences',
  'canon_character_knowledge',
  'canon_timeline_events',
] as const;

type CanonTable = (typeof CANON_TABLE_CREATE_ORDER)[number];

// Descendants must be renamed and dropped before their parents so SQLite never
// cascades through a copied replacement table.
const CANON_TABLE_LEAF_FIRST: readonly CanonTable[] = [
  'canon_evidence_links',
  'canon_plot_thread_characters',
  'canon_character_aliases',
  'canon_character_state_snapshots',
  'canon_relationships',
  'canon_character_experiences',
  'canon_character_knowledge',
  'canon_world_rules',
  'canon_plot_threads',
  'canon_timeline_events',
  'canon_characters',
  'canon_evidence',
];

const SCHEMA_20_STATEMENTS = buildV19toV20Statements();

function createSqlFor(table: CanonTable): string {
  const statement = SCHEMA_20_STATEMENTS.find(item =>
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(item.sql),
  );
  if (!statement) {
    throw new Error(`缺少 ${table} 的 Canon 建表定义`);
  }
  return statement.sql;
}

function indexSqlFor(table: CanonTable): SqlStatement[] {
  return SCHEMA_20_STATEMENTS.filter(item =>
    new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \\w+\\s+ON ${table}\\b`, 'i').test(
      item.sql.replace(/\s+/g, ' '),
    ),
  );
}

function columnsFor(table: CanonTable): readonly string[] {
  const columns = SCHEMA_MANIFEST.find(item => item.name === table)?.columns;
  if (!columns) {
    throw new Error(`缺少 ${table} 的 Schema manifest 列定义`);
  }
  return columns;
}

export function buildCanonTableRenameStatements(
  suffix: string,
): SqlStatement[] {
  return CANON_TABLE_LEAF_FIRST.map(table => ({
    sql: `ALTER TABLE ${table} RENAME TO ${table}_${suffix}`,
  }));
}

export function buildCanonTableCreateStatements(): SqlStatement[] {
  return CANON_TABLE_CREATE_ORDER.map(table => ({ sql: createSqlFor(table) }));
}

export function buildCanonTableCopyStatements(suffix: string): SqlStatement[] {
  return CANON_TABLE_CREATE_ORDER.map(table => {
    const columns = columnsFor(table).join(', ');
    return {
      sql: `INSERT INTO ${table} (${columns})
        SELECT ${columns} FROM ${table}_${suffix}`,
    };
  });
}

export function buildCanonTableDropStatements(suffix: string): SqlStatement[] {
  return CANON_TABLE_LEAF_FIRST.map(table => ({
    sql: `DROP TABLE ${table}_${suffix}`,
  }));
}

export function buildCanonTableIndexStatements(): SqlStatement[] {
  return CANON_TABLE_CREATE_ORDER.flatMap(indexSqlFor);
}

/** Rebuild all Canon tables against the current analysis-run parent. */
export function buildCanonAnalysisForeignKeyRepairStatements(
  suffix: string,
): SqlStatement[] {
  return [
    ...buildCanonTableRenameStatements(suffix),
    ...buildCanonTableCreateStatements(),
    ...buildCanonTableCopyStatements(suffix),
    ...buildCanonTableDropStatements(suffix),
    ...buildCanonTableIndexStatements(),
  ];
}
