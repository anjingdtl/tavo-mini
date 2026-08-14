/**
 * Verify the real device database after overwrite-install.
 *
 * The artifact is intentionally local-only: a connected emulator produces it
 * under test-logs/repaired_device.db. CI without an Android data artifact
 * skips this evidence test, while SHINE_WRITER_REQUIRE_DEVICE_DB=1 makes a
 * missing artifact a hard failure for the local Final Seal.
 */
import * as fs from 'fs';
import * as path from 'path';
import initSqlJsNs from 'sql.js';
import { SCHEMA_VERSION } from '../src/services/migrations';

const initSqlJs: any = (initSqlJsNs as any).default ?? initSqlJsNs;
const requireDeviceDb = process.env.SHINE_WRITER_REQUIRE_DEVICE_DB === '1';
const deviceDbPath =
  process.env.SHINE_WRITER_DEVICE_DB_PATH ||
  path.join(__dirname, '..', 'test-logs', 'repaired_device.db');
const beforeDbPath =
  process.env.SHINE_WRITER_PRE_DEVICE_DB_PATH ||
  path.join(
    __dirname,
    '..',
    'test-logs',
    'phase1-closure',
    'overwrite-pre',
    'pre-upgrade-device.db',
  );

// Device evidence is opt-in for CI. Historical local artifacts can represent
// a previous product schema and must not turn a fresh schema migration into a
// false regression; the Android audit enables SHINE_WRITER_REQUIRE_DEVICE_DB
// with an artifact captured after the current install.
const runDeviceDbTest = requireDeviceDb ? it : it.skip;

function rows(db: any, sql: string): unknown[][] {
  const result = db.exec(sql);
  return result.length > 0 ? result[0].values : [];
}

function scalar(db: any, sql: string): number {
  const result = rows(db, sql);
  return Number(result[0]?.[0] || 0);
}

function assertPreRowsRemain(
  before: any,
  after: any,
  label: string,
  sql: string,
): void {
  const beforeRows = rows(before, sql);
  const afterRows = rows(after, sql);
  expect(afterRows).toEqual(expect.arrayContaining(beforeRows));
  console.log(`   ${label}: before=${beforeRows.length}, after=${afterRows.length}`);
}

describe('real device database (overwrite-install verification)', () => {
  runDeviceDbTest(
    'keeps Schema 52 and preserves pre-upgrade user rows',
    async () => {
      if (!fs.existsSync(deviceDbPath)) {
        throw new Error(
          `device DB evidence is required but missing: ${deviceDbPath}`,
        );
      }
      if (!fs.existsSync(beforeDbPath)) {
        throw new Error(
          `pre-upgrade device DB evidence is required but missing: ${beforeDbPath}`,
        );
      }

      const SQL = await initSqlJs({
        locateFile: (file: string) =>
          path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
      });
      const after = new SQL.Database(fs.readFileSync(deviceDbPath));
      const before = new SQL.Database(fs.readFileSync(beforeDbPath));

      try {
        const schemaVersion = scalar(
          after,
          "SELECT value FROM settings WHERE key = 'schema_version'",
        );
        expect(SCHEMA_VERSION).toBe(52);
        expect(schemaVersion).toBe(SCHEMA_VERSION);

        const columnNames = rows(
          after,
          'PRAGMA table_info(canon_evidence)',
        ).map(row => String(row[1]));
        expect(columnNames).toContain('source_origin');
        expect(columnNames).toContain('rescan_operation_id');
        expect(
          scalar(
            after,
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_canon_evidence_rescan_op'",
          ),
        ).toBe(1);

        const preservedTables: Array<[string, string]> = [
          ['projects', 'SELECT id, name FROM projects ORDER BY id'],
          [
            'chapters',
            'SELECT id, project_id, title, status, length(content) FROM chapters ORDER BY id',
          ],
          [
            'characters',
            'SELECT id, project_id, collection_id, name, data_json FROM characters ORDER BY id',
          ],
          [
            'worldbook_entries',
            'SELECT id, project_id, collection_id, keyword_primary, keyword_secondary, constant, content FROM worldbook_entries ORDER BY id',
          ],
          [
            'presets',
            'SELECT id, name, is_default, system_prompt, writing_style, temperature, top_p, max_tokens, extra_instructions FROM presets ORDER BY id',
          ],
          [
            'project_resources',
            'SELECT project_id, resource_type, resource_id, enabled FROM project_resources ORDER BY project_id, resource_type, resource_id',
          ],
          [
            'outlines',
            'SELECT id, project_id, title, content, source_type, enabled, position, estimated_tokens, content_hash FROM outlines ORDER BY id',
          ],
        ];
        for (const [label, sql] of preservedTables) {
          assertPreRowsRemain(before, after, label, sql);
        }

        expect(scalar(after, 'SELECT COUNT(*) FROM projects')).toBeGreaterThan(0);
        expect(scalar(after, 'SELECT COUNT(*) FROM chapters')).toBeGreaterThan(0);
        expect(scalar(after, 'SELECT COUNT(*) FROM characters')).toBeGreaterThan(0);
        expect(scalar(after, 'SELECT COUNT(*) FROM worldbook_entries')).toBeGreaterThan(0);
        expect(scalar(after, 'SELECT COUNT(*) FROM presets')).toBeGreaterThan(0);
        expect(scalar(after, 'SELECT COUNT(*) FROM project_resources')).toBeGreaterThan(0);

        const emptyOrigin = scalar(
          after,
          "SELECT COUNT(*) FROM canon_evidence WHERE source_origin IS NULL OR TRIM(source_origin) = ''",
        );
        expect(emptyOrigin).toBe(0);
        console.log(`✅ Device DB verified: schema=${schemaVersion}`);
        console.log(
          `   characters=${scalar(after, 'SELECT COUNT(*) FROM characters')}, worldbook=${scalar(after, 'SELECT COUNT(*) FROM worldbook_entries')}, presets=${scalar(after, 'SELECT COUNT(*) FROM presets')}`,
        );
      } finally {
        before.close();
        after.close();
      }
    },
  );
});
