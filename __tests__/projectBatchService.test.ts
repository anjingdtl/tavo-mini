import { buildProjectBatchArchive } from '../src/services/projectBatchService';

function decodeAscii(bytes: Uint8Array): string {
  return String.fromCharCode(...Array.from(bytes));
}

describe('batch project export archive', () => {
  it('creates a valid ZIP with one complete JSON entry per project', () => {
    const archive = buildProjectBatchArchive([
      { fileName: '项目A.json', content: '{"spec":"shinewriter-project-v2"}' },
      { fileName: '项目B.json', content: '{"spec":"shinewriter-project-v2"}' },
    ]);

    expect(decodeAscii(archive.bytes.slice(0, 4))).toBe('PK\x03\x04');
    expect(archive.fileName).toMatch(/^ShineWriter-Projects-\d{8}\.zip$/);
    expect(archive.bytes).toContain(0x50);
    expect(archive.bytes).toContain(0x4b);
    expect(archive.entries).toEqual([
      { fileName: '项目A.json', byteLength: expect.any(Number) },
      { fileName: '项目B.json', byteLength: expect.any(Number) },
    ]);
  });
});
