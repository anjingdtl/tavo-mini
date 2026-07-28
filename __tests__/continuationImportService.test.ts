/**
 * Continuation import service — pure-helper + state-machine tests (Spec §13, §14, §19).
 *
 * The DB-backed orchestration is exercised via the bounded-reader invariant
 * suite (continuationSourceReader.test.ts) and the migration suite. Here we
 * lock down the pure helpers that drive error classification, sanitization
 * and filename handling — all of which are part of the Spec §19 observability
 * contract.
 */
import {
  classifyError,
  sanitizeError,
  stripExtension,
  MAX_IMPORT_FILE_BYTES,
  getActiveImportJob,
  recoverInterruptedJobs,
  resumeContinuationImport,
  cancelContinuationImport,
} from '../src/services/continuation/continuationImportService';

describe('continuation import service helpers (Spec §13, §19)', () => {
  describe('stripExtension', () => {
    it('removes a trailing extension', () => {
      expect(stripExtension('novel.txt')).toBe('novel');
      expect(stripExtension('a.b.c.txt')).toBe('a.b.c');
    });

    it('returns the name unchanged when there is no extension', () => {
      expect(stripExtension('README')).toBe('README');
    });

    it('does not strip a leading dot (hidden files)', () => {
      expect(stripExtension('.gitignore')).toBe('.gitignore');
    });
  });

  describe('classifyError (Spec §19 UI error categories)', () => {
    it('classifies encoding errors', () => {
      expect(classifyError(new Error('编码不匹配'))).toBe('unsupported_encoding');
      expect(classifyError(new Error('unsupported encoding detected'))).toBe(
        'unsupported_encoding',
      );
    });

    it('classifies file-too-large errors', () => {
      expect(classifyError(new Error('文件过大'))).toBe('file_too_large');
    });

    it('classifies chunk integrity failures', () => {
      expect(classifyError(new Error('分块完整性校验失败'))).toBe(
        'chunk_integrity_failed',
      );
    });

    it('classifies parse failures', () => {
      expect(classifyError(new Error('解析章节失败'))).toBe('parse_failed');
    });

    it('classifies storage-full errors', () => {
      expect(classifyError(new Error('磁盘空间不足'))).toBe('storage_full');
    });

    it('falls back to decode_failed for unrecognized errors', () => {
      expect(classifyError(new Error('something else'))).toBe('decode_failed');
      expect(classifyError(null)).toBe('decode_failed');
    });
  });

  describe('sanitizeError (Spec §16 privacy, §19 length cap)', () => {
    it('strips absolute file:// paths so private paths never reach UI logs', () => {
      const result = sanitizeError(
        '读取失败：file:///data/user/0/com.shinewriter/files/x.txt',
      );
      expect(result).not.toContain('/data/user/0');
      expect(result).not.toContain('com.shinewriter');
      expect(result).toContain('<file>');
    });

    it('caps message length at 200 chars + ellipsis', () => {
      const long = '错误：' + 'x'.repeat(300);
      const result = sanitizeError(long);
      expect(result.length).toBeLessThanOrEqual(202); // 200 + '…'
      expect(result.endsWith('…')).toBe(true);
    });

    it('leaves short messages untouched', () => {
      expect(sanitizeError('编码不匹配')).toBe('编码不匹配');
    });

    it('handles non-string input gracefully', () => {
      expect(sanitizeError(undefined as unknown as string)).toBe('');
    });
  });

  describe('import recovery + size-ceiling contract (Spec §14.2, §16)', () => {
    it('exports the 200 MB size ceiling matching the native MAX_FILE_BYTES', () => {
      expect(MAX_IMPORT_FILE_BYTES).toBe(200 * 1024 * 1024);
    });

    it('exports the recovery/resume/cancel/query API the UI relies on', () => {
      // These were previously dead code (no callers). The flattened import UI
      // now wires them up, so they must be importable from the service entry.
      expect(typeof getActiveImportJob).toBe('function');
      expect(typeof recoverInterruptedJobs).toBe('function');
      expect(typeof resumeContinuationImport).toBe('function');
      expect(typeof cancelContinuationImport).toBe('function');
    });
  });
});
