/**
 * Continuation import error-messaging unit tests (2026-08-01 fix).
 *
 * Verifies `mapImportErrorToUserMessage` maps every known errorCode to a
 * user-facing Chinese title + suggestion, and `formatFailedFilesList` renders
 * a capped file list for Alert bodies.
 */
import {
  mapImportErrorToUserMessage,
  formatFailedFilesList,
} from '../src/services/continuation/errorMessaging';

describe('mapImportErrorToUserMessage', () => {
  it('maps unsupported_encoding to an actionable suggestion', () => {
    const msg = mapImportErrorToUserMessage('unsupported_encoding', '');
    expect(msg.title).toContain('编码');
    expect(msg.suggestion).toBeTruthy();
  });

  it('maps file_too_large with a split-file suggestion', () => {
    const msg = mapImportErrorToUserMessage('file_too_large', '');
    expect(msg.title).toContain('200MB');
    expect(msg.suggestion).toContain('拆分');
  });

  it('maps decode_failed with a manual-encoding hint', () => {
    const msg = mapImportErrorToUserMessage('decode_failed', '');
    expect(msg.title).toContain('解码失败');
    expect(msg.suggestion).toContain('编码');
  });

  it('maps parse_failed and preserves the raw message as suggestion', () => {
    const msg = mapImportErrorToUserMessage('parse_failed', '第 3 行解析异常');
    expect(msg.title).toContain('解析失败');
    expect(msg.suggestion).toContain('第 3 行解析异常');
  });

  it('maps chunk_integrity_failed and storage_full', () => {
    expect(
      mapImportErrorToUserMessage('chunk_integrity_failed', '').title,
    ).toContain('分块校验失败');
    expect(
      mapImportErrorToUserMessage('storage_full', '').title,
    ).toContain('存储空间不足');
  });

  it('maps source_changed and job_interrupted', () => {
    expect(
      mapImportErrorToUserMessage('source_changed', '').title,
    ).toContain('源文件已变更');
    expect(
      mapImportErrorToUserMessage('job_interrupted', '').title,
    ).toContain('中断');
  });

  it('falls back to the raw message for unknown error codes', () => {
    const msg = mapImportErrorToUserMessage('weird_code', '自定义错误详情');
    expect(msg.title).toBe('自定义错误详情');
  });

  it('falls back to a generic label when both errorCode and message are empty', () => {
    const msg = mapImportErrorToUserMessage(null, '');
    expect(msg.title).toBe('未知错误');
  });
});

describe('formatFailedFilesList', () => {
  it('lists all failed files when under the cap', () => {
    const list = formatFailedFilesList([
      { fileName: 'a.txt', message: '解码失败' },
      { fileName: 'b.txt', message: '文件过大' },
    ]);
    expect(list).toContain('a.txt');
    expect(list).toContain('b.txt');
    expect(list).not.toContain('其余');
  });

  it('caps the list and reports the remaining count', () => {
    const failed = Array.from({ length: 8 }, (_, i) => ({
      fileName: `f${i}.txt`,
      message: `错误 ${i}`,
    }));
    const list = formatFailedFilesList(failed, 3);
    const lines = list.split('\n');
    expect(lines.filter(l => l.startsWith('•')).length).toBe(3);
    expect(list).toContain('其余 5 个文件失败');
  });
});
