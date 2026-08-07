/**
 * Structured schema-recovery error codes.
 *
 * The UI layer consumes these codes to render the correct user-facing message
 * (Chinese copy) instead of regex-matching SQLite English error strings.
 */
export type SchemaRecoveryErrorCode =
  | 'SCHEMA_DRIFT_DETECTED'
  | 'RECOVERY_BACKUP_FAILED'
  | 'RECOVERY_BACKUP_INVALID'
  | 'CANON_EVIDENCE_TABLE_MISSING'
  | 'CANON_SOURCE_ORIGIN_MISSING'
  | 'CANON_RESCAN_OPERATION_ID_MISSING'
  | 'CANON_RESCAN_INDEX_MISSING'
  | 'KNOWN_SCHEMA_REPAIR_FAILED'
  | 'USER_DATA_RECALL_MISMATCH'
  // CL-03: content-level fingerprint mismatch across an upgrade — the
  // irreplaceable data (chapter bodies, characters, worldbook, notes) was
  // rewritten while the schema mutated. Blocks startup, keeps the original
  // DB and the schema-recovery backup untouched.
  | 'USER_CONTENT_FINGERPRINT_MISMATCH'
  | 'SCHEMA_RECOVERY_FAILED'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'RESOURCE_RELOAD_FAILED'
  // RB-20 fix (V2.11.34): non-schema-recovery init failure surfaced by
  // App/index.tsx when openDatabase / initializeDatabase throws an
  // unrelated error. The UI surfaces the safe error screen.
  | 'INIT_FAILED';

export interface SchemaRecoveryError extends Error {
  code: SchemaRecoveryErrorCode;
  /**
   * Non-sensitive diagnostic context (counts, paths, drift codes). Never
   * contains character/worldbook/chapter content or API keys.
   */
  diagnostics?: Record<string, unknown>;
}

export function isSchemaRecoveryError(
  error: unknown,
): error is SchemaRecoveryError {
  return (
    error instanceof Error &&
    typeof (error as SchemaRecoveryError).code === 'string'
  );
}

export function makeSchemaRecoveryError(
  code: SchemaRecoveryErrorCode,
  message: string,
  diagnostics?: Record<string, unknown>,
): SchemaRecoveryError {
  const error = new Error(message) as SchemaRecoveryError;
  error.code = code;
  error.name = 'SchemaRecoveryError';
  if (diagnostics) error.diagnostics = diagnostics;
  return error;
}

/**
 * Map a recovery error code to the user-facing Chinese copy shown by the UI.
 * The UI uses this instead of the raw SQLite message.
 */
export const SCHEMA_RECOVERY_ERROR_COPY: Record<
  SchemaRecoveryErrorCode,
  { title: string; detail: string }
> = {
  SCHEMA_DRIFT_DETECTED: {
    title: '检测到数据库结构异常',
    detail: '正在自动修复，不会删除你的角色卡、世界书或章节。',
  },
  RECOVERY_BACKUP_FAILED: {
    title: '修复备份创建失败',
    detail: '未执行任何数据库修改。原数据库已保留，请不要卸载或清除应用数据。',
  },
  RECOVERY_BACKUP_INVALID: {
    title: '修复备份校验失败',
    detail: '备份文件未能通过校验。未执行任何数据库修改，原数据库已保留。',
  },
  CANON_EVIDENCE_TABLE_MISSING: {
    title: 'Canon evidence 表缺失',
    detail: 'canon_evidence 表不存在，可能是数据库损坏。已保留原数据库，未创建空表掩盖问题。',
  },
  CANON_SOURCE_ORIGIN_MISSING: {
    title: '修复 source_origin 字段',
    detail: '正在为 canon_evidence 补充缺失的 provenance 字段。',
  },
  CANON_RESCAN_OPERATION_ID_MISSING: {
    title: '修复 rescan_operation_id 字段',
    detail: '正在为 canon_evidence 补充缺失的 rescan 字段。',
  },
  CANON_RESCAN_INDEX_MISSING: {
    title: '修复索引',
    detail: '正在重建 canon_evidence rescan 索引。',
  },
  KNOWN_SCHEMA_REPAIR_FAILED: {
    title: '数据库结构修复失败',
    detail: '已保留原数据库和恢复备份。未执行清库或删除操作。',
  },
  USER_DATA_RECALL_MISMATCH: {
    title: '资料召回校验失败',
    detail: '修复前后用户资料不一致，已阻止启动以保护数据。原数据库和恢复备份已保留。',
  },
  USER_CONTENT_FINGERPRINT_MISMATCH: {
    title: '内容指纹校验失败',
    detail: '升级前后章节/角色/世界书/笔记内容不一致，已阻止启动以保护数据。原数据库和恢复备份已保留，请勿卸载或清除应用数据。',
  },
  SCHEMA_RECOVERY_FAILED: {
    title: '数据库修复失败',
    detail: '修复流程未能完成。原数据库和恢复备份已保留，请勿卸载或清除应用数据。',
  },
  SCHEMA_VALIDATION_FAILED: {
    title: '数据库 Schema 校验失败',
    detail: '修复后仍存在结构问题。已保留原数据库和恢复备份，请不要卸载应用。',
  },
  RESOURCE_RELOAD_FAILED: {
    title: '资料重新加载失败',
    detail: '修复已完成，但资料页面未能自动刷新。请重启应用。',
  },
  INIT_FAILED: {
    title: '本地资料暂时无法载入',
    detail: '原数据库未删除。请前往设置 → 备份中心查看最近的安全备份。',
  },
};
