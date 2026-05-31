import RNFS from 'react-native-fs';
import type SQLite from 'react-native-sqlite-storage';

const BACKUP_DIR = `${RNFS.ExternalDirectoryPath}/backups`;
const MAX_BACKUPS = 3;

const ALL_TABLES = [
  'projects',
  'chapters',
  'fragments',
  'plotlines',
  'project_plotlines',
  'characters',
  'worldbook_collections',
  'worldbook_entries',
  'notes',
  'presets',
  'llm_config',
  'settings',
  'project_resources',
  'llm_usage_logs',
  'pipeline_tasks',
  'freeform_documents',
];

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

async function allRows(db: SQLite.SQLiteDatabase, table: string): Promise<Record<string, any>[]> {
  const result = await execute(db, `SELECT * FROM ${table}`);
  const items: Record<string, any>[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    items.push(result.rows.item(i));
  }
  return items;
}

export async function createBackup(
  db: SQLite.SQLiteDatabase,
  appVersion: string,
  schemaVersion: string,
): Promise<string> {
  await RNFS.mkdir(BACKUP_DIR);

  const tables: Record<string, any[]> = {};
  for (const table of ALL_TABLES) {
    tables[table] = await allRows(db, table);
  }

  const backup = {
    meta: {
      app_version: appVersion,
      schema_version: schemaVersion,
      backup_date: new Date().toISOString(),
      table_count: ALL_TABLES.length,
    },
    tables,
  };

  const timestamp = Date.now();
  const fileName = `backup_v${appVersion}_${timestamp}.json`;
  const filePath = `${BACKUP_DIR}/${fileName}`;

  await RNFS.writeFile(filePath, JSON.stringify(backup), 'utf8');
  await cleanupOldBackups();

  return filePath;
}

export async function restoreFromBackup(
  db: SQLite.SQLiteDatabase,
  backupPath: string,
): Promise<void> {
  const content = await RNFS.readFile(backupPath, 'utf8');
  const backup = JSON.parse(content);

  for (const table of ALL_TABLES) {
    await execute(db, `DELETE FROM ${table}`);
  }

  for (const table of ALL_TABLES) {
    const rows: Record<string, any>[] = backup.tables?.[table] || [];
    for (const row of rows) {
      const keys = Object.keys(row);
      const placeholders = keys.map(() => '?').join(', ');
      const values = keys.map(k => row[k]);
      await execute(
        db,
        `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
        values,
      );
    }
  }
}

export async function cleanupOldBackups(): Promise<void> {
  try {
    const files = await RNFS.readDir(BACKUP_DIR);
    const backups = files
      .filter(f => f.name.startsWith('backup_') && f.name.endsWith('.json'))
      .sort((a, b) => {
        const timeA = a.mtime ? new Date(a.mtime).getTime() : 0;
        const timeB = b.mtime ? new Date(b.mtime).getTime() : 0;
        return timeB - timeA;
      });

    for (let i = MAX_BACKUPS; i < backups.length; i++) {
      await RNFS.unlink(backups[i].path);
    }
  } catch {
    // 目录不存在或读取失败，忽略
  }
}
