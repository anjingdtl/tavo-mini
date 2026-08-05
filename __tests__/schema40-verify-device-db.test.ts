/**
 * Verify the repaired device database after overwrite-install.
 * Reads test-logs/repaired_device.db (pulled from emulator-5554) and asserts
 * the Schema 40 repair landed correctly on a real Android SQLite.
 */
import * as fs from 'fs';
import * as path from 'path';
import initSqlJsNs from 'sql.js';

const initSqlJs: any = (initSqlJsNs as any).default ?? initSqlJsNs;

describe('repaired device database (overwrite-install verification)', () => {
  it('schema_version is 40 and canon_evidence has provenance columns', async () => {
    const dbPath = path.join(__dirname, '..', 'test-logs', 'repaired_device.db');
    if (!fs.existsSync(dbPath)) {
      console.warn('repaired_device.db not found — run the emulator overwrite-install test first');
      return;
    }

    const SQL = await initSqlJs({
      locateFile: (file: string) =>
        path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
    });
    const buf = fs.readFileSync(dbPath);
    const db = new SQL.Database(buf);

    // Schema version
    const ver = db.exec("SELECT value FROM settings WHERE key = 'schema_version'");
    const schemaVersion = ver.length > 0 ? Number(ver[0].values[0][0]) : 0;
    expect(schemaVersion).toBe(40);

    // canon_evidence columns
    const cols = db.exec('PRAGMA table_info(canon_evidence)');
    const colNames: string[] = [];
    if (cols.length > 0) {
      for (const row of cols[0].values) {
        colNames.push(row[1] as string);
      }
    }
    expect(colNames).toContain('source_origin');
    expect(colNames).toContain('rescan_operation_id');

    // Index exists
    const idx = db.exec(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_canon_evidence_rescan_op'",
    );
    expect(idx.length).toBeGreaterThan(0);
    expect(idx[0].values.length).toBe(1);

    // User data intact
    const charCount = db.exec('SELECT COUNT(*) FROM characters')[0].values[0][0];
    const wbCount = db.exec('SELECT COUNT(*) FROM worldbook_entries')[0].values[0][0];
    const ccCount = db.exec('SELECT COUNT(*) FROM character_collections')[0].values[0][0];
    const wbcCount = db.exec('SELECT COUNT(*) FROM worldbook_collections')[0].values[0][0];
    expect(charCount).toBe(2);
    expect(wbCount).toBe(2);
    expect(ccCount).toBe(1);
    expect(wbcCount).toBe(1);

    // Character names preserved
    const charNames = db.exec('SELECT name FROM characters ORDER BY id')[0].values.map(
      (v: any[]) => v[0],
    );
    expect(charNames).toEqual(['林小白', '苏雨晴']);

    // source_origin backfilled (no NULL/empty)
    const emptyOrigin = db.exec(
      "SELECT COUNT(*) FROM canon_evidence WHERE source_origin IS NULL OR TRIM(source_origin) = ''",
    );
    expect(Number(emptyOrigin[0].values[0][0])).toBe(0);

    // Note: PRAGMA foreign_keys is a per-connection setting, not persisted in
    // the DB file. The app sets it at runtime in initializeDatabase; a static
    // file inspection will always see 0. Skip this check here.

    console.log('✅ Device DB verified: Schema 40, provenance columns present,');
    console.log(`   characters=${charCount}, worldbook=${wbCount},`);
    console.log(`   char_collections=${ccCount}, worldbook_collections=${wbcCount}`);
    console.log(`   character names: ${JSON.stringify(charNames)}`);

    db.close();
  });
});
