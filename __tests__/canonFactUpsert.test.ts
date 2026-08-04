/**
 * Fact upsert returns real row ids and binds evidence correctly across batches.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import {
  upsertWorldRule,
  upsertRelationship,
  upsertPlotThread,
  upsertExperience,
  upsertCharacter,
} from '../src/services/continuation/canon/canonFactUpsert';
import {
  insertEvidenceAndLink,
  buildEvidenceInsertInput,
} from '../src/services/continuation/canon/canonEvidenceService';

async function seed(db: any) {
  await db.executeSql(
    `INSERT INTO projects (id,name,mode,created_at,updated_at) VALUES (1,'t','continuation','t','t')`,
  );
  await db.executeSql(
    `INSERT INTO continuation_sources (id,project_id,version,status,display_name,original_file_name,detected_encoding,raw_sha256,normalized_sha256,normalized_char_count,normalized_byte_count,file_size_bytes,parser_version,normalization_version,created_at,updated_at) VALUES (1,1,1,'ready','s','s.txt','UTF-8','x','y',1000,2000,2000,'v1','v1','t','t')`,
  );
  await db.executeSql(
    `INSERT INTO continuation_source_chapters (id,source_id,position,detected_title,title,content_sha256,char_count,paragraph_count,source_start_offset,content_start_offset,source_end_offset,created_at,updated_at) VALUES (1,1,0,'c','hello world content','c',1000,1,0,0,1000,'t','t')`,
  );
  await db.executeSql(
    `INSERT INTO continuation_canon_snapshots (id,project_id,source_id,analysis_run_id,source_version,source_sha256,parser_version,normalization_version,boundary_chapter_id,boundary_position,boundary_char_offset_exclusive,extraction_version,profile,status,revision,capabilities_json,coverage_json,created_at,updated_at) VALUES ('snap-1',1,1,'run-1',1,'y','v1','v1',1,0,1000,'v1','standard','staging',1,'{}','{}','t','t')`,
  );
  await db.executeSql(
    `INSERT INTO continuation_analysis_runs (id,project_id,source_id,source_version,source_sha256,parser_version,normalization_version,boundary_chapter_id,boundary_position,boundary_char_offset_exclusive,canon_snapshot_id,profile,state,stage,extraction_version,created_at,updated_at) VALUES ('run-1',1,1,1,'y','v1','v1',1,0,1000,'snap-1','standard','running','chapter_extraction','v1','t','t')`,
  );
}

const ctx = {
  projectId: 1,
  sourceId: 1,
  snapshotId: 'snap-1',
  runId: 'run-1',
  fromPos: 0,
  toPos: 0,
};

describe('canonFactUpsert', () => {
  it('upserts the same world rule across batches without unique errors', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await seed(db);
      const id1 = await upsertWorldRule(db as any, ctx, {
        category: 'fundamental',
        title: '灵气复苏',
        description: '短',
        constraintLevel: 'hard',
        confidence: 0.5,
      });
      const id2 = await upsertWorldRule(db as any, { ...ctx, fromPos: 1, toPos: 1 }, {
        category: 'fundamental',
        title: '灵气复苏',
        description: '更长的描述文本',
        constraintLevel: 'hard',
        confidence: 0.9,
      });
      expect(id2).toBe(id1);
      const [rows] = await db.executeSql(
        `SELECT COUNT(*) AS c, MAX(confidence) AS conf FROM canon_world_rules WHERE snapshot_id='snap-1' AND review_status!='superseded'`,
      );
      expect(rows.rows.item(0).c).toBe(1);
      expect(rows.rows.item(0).conf).toBeGreaterThanOrEqual(0.9);
    } finally {
      db.close();
    }
  });

  it('binds evidence to the real upserted id (not last_insert_rowid trap)', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await seed(db);
      const id1 = await upsertWorldRule(db as any, ctx, {
        category: 'fundamental',
        title: '规则A',
        description: 'd1',
        constraintLevel: 'hard',
        confidence: 0.5,
      });
      // Second insert hits IGNORE path; id must still be id1.
      const id2 = await upsertWorldRule(db as any, ctx, {
        category: 'fundamental',
        title: '规则A',
        description: 'd2 longer',
        constraintLevel: 'hard',
        confidence: 0.8,
      });
      expect(id2).toBe(id1);
      const quote = 'hello';
      const evId = await insertEvidenceAndLink(
        db as any,
        buildEvidenceInsertInput(
          {
            projectId: 1,
            sourceId: 1,
            snapshotId: 'snap-1',
            analysisRunId: 'run-1',
            boundaryExclusive: 1000,
            readBackVerifier: async () => quote,
          },
          {
            chapterId: 1,
            chapterPosition: 0,
            charStart: 0,
            charEnd: quote.length,
            quotePreview: quote,
          },
        ),
        'world_rule',
        id2,
      );
      expect(evId).not.toBeNull();
      const [links] = await db.executeSql(
        `SELECT owner_id FROM canon_evidence_links WHERE evidence_id=?`,
        [evId],
      );
      expect(links.rows.item(0).owner_id).toBe(id1);
    } finally {
      db.close();
    }
  });

  it('experience unique conflicts become upserts (no batch failure)', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await seed(db);
      const characterId = await upsertCharacter(db as any, ctx, {
        canonicalName: '张三',
        description: '',
        importance: 'primary',
        confidence: 0.9,
      });
      const a = await upsertExperience(db as any, ctx, {
        characterId,
        eventType: 'breakthrough',
        title: '突破境界',
        description: 'd1',
        importance: 1,
        confidence: 0.8,
        chapterPosition: 0,
      });
      // Same business key again (cross-batch / model duplicate) must not throw.
      const b = await upsertExperience(db as any, ctx, {
        characterId,
        eventType: 'breakthrough',
        title: '突破境界',
        description: 'd2 longer description',
        importance: 3,
        confidence: 0.95,
        chapterPosition: 1,
      });
      expect(b).toBe(a);
      // Near-duplicate title with extra spaces normalizes onto the same row.
      const c = await upsertExperience(db as any, ctx, {
        characterId,
        eventType: ' breakthrough ',
        title: '  突破境界  ',
        description: 'd3',
        importance: 2,
        confidence: 0.7,
        chapterPosition: 2,
      });
      expect(c).toBe(a);
      const [rows] = await db.executeSql(
        `SELECT COUNT(*) AS c, MAX(importance) AS imp FROM canon_character_experiences
          WHERE snapshot_id='snap-1' AND review_status!='superseded'`,
      );
      expect(rows.rows.item(0).c).toBe(1);
      expect(rows.rows.item(0).imp).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
    }
  });

  it('upserts relationships / plot threads / experiences by business key', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await seed(db);
      const a = await upsertCharacter(db as any, ctx, {
        canonicalName: '张三',
        description: '',
        importance: 'primary',
        confidence: 0.9,
      });
      const b = await upsertCharacter(db as any, ctx, {
        canonicalName: '李四',
        description: '',
        importance: 'supporting',
        confidence: 0.8,
      });
      const rel1 = await upsertRelationship(db as any, ctx, {
        sourceCharacterId: a,
        targetCharacterId: b,
        relationType: '朋友',
        attitude: '友好',
        publicStatus: 'public',
        description: 'd',
        confidence: 0.7,
      });
      const rel2 = await upsertRelationship(db as any, ctx, {
        sourceCharacterId: a,
        targetCharacterId: b,
        relationType: '朋友',
        attitude: '亲密',
        publicStatus: 'public',
        description: 'd2',
        confidence: 0.95,
      });
      expect(rel2).toBe(rel1);

      const p1 = await upsertPlotThread(db as any, ctx, {
        title: '主线',
        description: 'd',
        level: 'main',
        status: 'active',
        confidence: 0.8,
        establishedFactsJson: '[]',
      });
      const p2 = await upsertPlotThread(db as any, ctx, {
        title: '主线',
        description: 'longer d',
        level: 'main',
        status: 'active',
        confidence: 0.9,
        establishedFactsJson: '[]',
      });
      expect(p2).toBe(p1);

      const e1 = await upsertExperience(db as any, ctx, {
        characterId: a,
        eventType: 'breakthrough',
        title: '突破',
        description: 'd',
        importance: 1,
        confidence: 0.8,
        chapterPosition: 0,
      });
      const e2 = await upsertExperience(db as any, ctx, {
        characterId: a,
        eventType: 'breakthrough',
        title: '突破',
        description: 'd2',
        importance: 2,
        confidence: 0.9,
        chapterPosition: 0,
      });
      expect(e2).toBe(e1);
    } finally {
      db.close();
    }
  });
});
