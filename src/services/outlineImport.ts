/**
 * Outline TXT multi-file import (大纲创作模式升级).
 *
 * Reuses the existing DocumentPicker + native encoding-detection infrastructure
 * (fileImport.pickLocalFiles + textFileReader.readTextFileWithAutoEncoding) so
 * outline import behaves identically to note TXT import for encoding, BOM and
 * large-file handling.
 *
 * Semantics:
 *  - Each selected TXT becomes ONE independent outline (1 file = 1 outline).
 *  - The file name (extension stripped) is the outline title.
 *  - Empty files (after trim) are rejected as failures, not created.
 *  - Per-file try/catch: one bad file never fails the whole batch.
 *  - Imported outlines default to disabled (enabled=0), matching the plan and
 *    the existing resource-import behaviour.
 *  - Re-importing a same-named file creates a NEW outline (id auto-increments);
 *    it never silently overwrites an existing one.
 */
import * as db from './database';
import { pickLocalFiles } from './fileImport';
import { readTextFileWithAutoEncoding } from './textFileReader';
import { types } from '@react-native-documents/picker';

/** Result of a multi-file outline import batch. */
export interface OutlineImportResult {
  /** Number of outlines successfully created. */
  successCount: number;
  /** Number of files that failed (empty / read error / write error). */
  failureCount: number;
  /** Per-file failure details so the UI can show exactly what went wrong. */
  failures: Array<{ fileName: string; reason: string }>;
}

/**
 * Open a multi-select picker for TXT files and import each as an independent
 * outline for the project. Returns null when the user cancels the picker.
 */
export async function importOutlinesFromTxt(
  projectId: number,
): Promise<OutlineImportResult | null> {
  const files = await pickLocalFiles([types.plainText, types.allFiles]);
  if (!files || files.length === 0) return null;

  let successCount = 0;
  const failures: Array<{ fileName: string; reason: string }> = [];

  for (const file of files) {
    try {
      const content = await readTextFileWithAutoEncoding(file.localPath);
      if (!content || !content.trim()) {
        failures.push({ fileName: file.name, reason: '文件为空' });
        continue;
      }
      const title = file.name.replace(/\.[^.]+$/, '').trim() || '导入的大纲';
      await db.createOutline(projectId, {
        title,
        content,
        sourceType: 'txt',
        sourceFileName: file.name,
      });
      successCount += 1;
    } catch (error: any) {
      failures.push({
        fileName: file.name,
        reason: error?.message ? String(error.message) : '读取或写入失败',
      });
    }
  }

  return {
    successCount,
    failureCount: failures.length,
    failures,
  };
}
