/**
 * Smoke test: verify the sql.js in-memory Canon test DB loads the full fresh
 * schema and can INSERT/SELECT evidence rows with real SQLite semantics.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';

describe('canonInMemoryDb smoke', () => {
  it('creates all Canon tables and supports real SQL round-trip', async () => {
    const db = await createCanonInMemoryDb();
    const close = db.close.bind(db);
    try {
      // Insert a project + source first (FK chain).
      await db.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at)
         VALUES (1, 't', 'outline', 't', 't')`,
      );
      await db.executeSql(
        `INSERT INTO continuation_sources
          (id, project_id, version, status, display_name, original_file_name,
           detected_encoding, raw_sha256, normalized_sha256,
           normalized_char_count, normalized_byte_count, file_size_bytes,
           parser_version, normalization_version, created_at, updated_at)
         VALUES (1, 1, 1, 'ready', 'src', 'src.txt', 'UTF-8', 'x', 'y', 1000,
                 2000, 2000, 'v1', 'v1', 't', 't')`,
      );
      // Seed a chapter row first — it is the FK target of both snapshots
      // (boundary_chapter_id) and canon_evidence (chapter_id).
      await db.executeSql(
        `INSERT INTO continuation_source_chapters
          (id, source_id, position, detected_title, title, content_sha256,
           char_count, paragraph_count, source_start_offset,
           content_start_offset, source_end_offset, created_at, updated_at)
         VALUES (1, 1, 0, '第一章', '第一章', 'ch', 1000, 1, 0, 0, 1000, 't', 't')`,
      );
      await db.executeSql(
        `INSERT INTO continuation_canon_snapshots
          (id, project_id, source_id, analysis_run_id, source_version,
           source_sha256, parser_version, normalization_version,
           boundary_chapter_id, boundary_position, boundary_char_offset_exclusive,
           extraction_version, profile, status, revision,
           capabilities_json, coverage_json, created_at, updated_at)
         VALUES ('snap-1', 1, 1, 'run-1', 1, 'y', 'v1', 'v1', 1, 0, 1000,
                 'v1', 'standard', 'staging', 1, '{}', '{}', 't', 't')`,
      );
      // Insert evidence, read back (skip the evidence_links FK chain here;
      // that is exercised by the dedicated rescan-isolation integration test).
      const [evRes] = await db.executeSql(
        `INSERT INTO canon_evidence
          (project_id, source_id, snapshot_id, chapter_id, chapter_position,
           paragraph_start, paragraph_end, char_start, char_end, quote_preview,
           quote_sha256, analysis_run_id, created_at)
         VALUES (1, 1, 'snap-1', 1, 0, NULL, NULL, 500, 510, '原文片段',
                 'hash1', 'run-1', 't')`,
      );
      const evId = evRes.insertId;
      expect(typeof evId).toBe('number');

      const [sel] = await db.executeSql(
        'SELECT char_start AS cs, quote_preview AS qp FROM canon_evidence WHERE id = ?',
        [evId],
      );
      expect(sel.rows.length).toBe(1);
      expect(sel.rows.item(0).cs).toBe(500);
      expect(sel.rows.item(0).qp).toBe('原文片段');
    } finally {
      close();
    }
  });

  it('executes a multi-statement transaction atomically', async () => {
    const db = await createCanonInMemoryDb();
    const close = db.close.bind(db);
    try {
      await db.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at)
         VALUES (2, 't2', 'outline', 't', 't')`,
      );
      // A transaction that throws midway must roll back.
      await new Promise<void>((resolve, reject) => {
        db.transaction(
          tx => {
            tx.executeSql(
              `INSERT INTO projects (id, name, mode, created_at, updated_at)
               VALUES (3, 't3', 'outline', 't', 't')`,
            );
            throw new Error('boom');
          },
          err => {
            expect(String(err)).toMatch(/boom/);
            resolve();
          },
          () => reject(new Error('should not succeed')),
        );
      });
      const [sel] = await db.executeSql('SELECT COUNT(*) AS c FROM projects WHERE id = 3');
      expect(sel.rows.item(0).c).toBe(0);
    } finally {
      close();
    }
  });
});
