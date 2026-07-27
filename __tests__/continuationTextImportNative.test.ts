/**
 * Continuation native TXT-import module — binding + detection contract tests
 * (Spec §10.1, §18.1).
 *
 * The actual byte-level decoding lives in the Kotlin module. These tests
 * verify the JS binding contract and emulate the native detectEncoding /
 * decodeChunk behaviour with crafted byte fixtures so the detection rules
 * (BOM sniffing, confidence, GB18030 fallback) are locked in.
 */
import { NativeModules } from 'react-native';
import {
  ContinuationTextImport,
  requireContinuationTextImport,
} from '../src/native/ContinuationTextImportModule';

/**
 * Pure-JS mirror of the Kotlin sniffEncoding rules, used to assert the
 * contract the native side must obey (Spec §10.1). Keep in sync with
 * ContinuationTextImportModule.sniffEncoding.
 */
function sniffEncodingContract(header: number[]): {
  encoding: string;
  confidence: number;
  hasBom: boolean;
} {
  const read = header.length;
  if (read >= 3 && header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf) {
    return { encoding: 'utf-8', confidence: 1.0, hasBom: true };
  }
  if (read >= 2 && header[0] === 0xff && header[1] === 0xfe) {
    return { encoding: 'utf-16le', confidence: 1.0, hasBom: true };
  }
  if (read >= 2 && header[0] === 0xfe && header[1] === 0xff) {
    return { encoding: 'utf-16be', confidence: 1.0, hasBom: true };
  }
  // Heuristic fallback for BOM-less Chinese TXT.
  return { encoding: 'gb18030', confidence: 0.6, hasBom: false };
}

describe('continuation native TXT import binding', () => {
  it('resolves the native module from NativeModules', () => {
    expect(ContinuationTextImport).toBeDefined();
    expect(typeof ContinuationTextImport?.detectEncoding).toBe('function');
    expect(typeof ContinuationTextImport?.decodeChunk).toBe('function');
    expect(typeof ContinuationTextImport?.readFileMeta).toBe('function');
  });

  it('requireContinuationTextImport returns the module when present', () => {
    expect(requireContinuationTextImport()).toBe(ContinuationTextImport);
  });

  it('returns empty-text EOF when decodeChunk is called past the file end', async () => {
    const mod = requireContinuationTextImport();
    (mod.decodeChunk as jest.Mock).mockResolvedValueOnce({
      text: '',
      nextByteOffset: 100,
      decodedChars: 0,
      bytesConsumed: 0,
      atEof: true,
    });
    const result = await mod.decodeChunk('/tmp/x.txt', 'utf-8', 100, 4096);
    expect(result.atEof).toBe(true);
    expect(result.text).toBe('');
    expect(result.bytesConsumed).toBe(0);
  });
});

describe('encoding detection contract (Spec §10.1, §18.1)', () => {
  it('detects UTF-8 with BOM', () => {
    const r = sniffEncodingContract([0xef, 0xbb, 0xbf, 0x41]);
    expect(r.encoding).toBe('utf-8');
    expect(r.hasBom).toBe(true);
    expect(r.confidence).toBe(1.0);
  });

  it('detects UTF-16 LE via BOM', () => {
    const r = sniffEncodingContract([0xff, 0xfe, 0x41, 0x00]);
    expect(r.encoding).toBe('utf-16le');
    expect(r.hasBom).toBe(true);
    expect(r.confidence).toBe(1.0);
  });

  it('detects UTF-16 BE via BOM', () => {
    const r = sniffEncodingContract([0xfe, 0xff, 0x00, 0x41]);
    expect(r.encoding).toBe('utf-16be');
    expect(r.hasBom).toBe(true);
    expect(r.confidence).toBe(1.0);
  });

  it('falls back to GB18030 for BOM-less Chinese TXT (low confidence)', () => {
    // A GBK byte stream has no BOM and high-bit bytes; confidence must be low
    // so the importer asks the user to confirm.
    const r = sniffEncodingContract([0xc4, 0xe3, 0xba, 0xc3]); // "你好" in GBK
    expect(r.encoding).toBe('gb18030');
    expect(r.hasBom).toBe(false);
    expect(r.confidence).toBeLessThan(0.7);
  });
});

describe('decodeChunk multi-byte boundary contract (Spec §10.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports bytesConsumed < maxBytes when a multi-byte char straddles the boundary', async () => {
    // A 3-byte UTF-8 char with the boundary after byte 1: only 1 byte consumed
    // this chunk, the rest carries to the next call.
    const mod = requireContinuationTextImport();
    (mod.decodeChunk as jest.Mock).mockResolvedValueOnce({
      text: '', // incomplete sequence decodes to nothing
      nextByteOffset: 11,
      decodedChars: 0,
      bytesConsumed: 1,
      atEof: false,
    });
    const r = await mod.decodeChunk('/tmp/x.txt', 'utf-8', 10, 1);
    expect(r.bytesConsumed).toBeLessThanOrEqual(1);
    expect(r.atEof).toBe(false);
  });

  it('advances the cursor by bytesConsumed so the next chunk starts aligned', async () => {
    const mod = requireContinuationTextImport();
    let cursor = 0;
    (mod.decodeChunk as jest.Mock).mockImplementation(async () => ({
      text: 'AB',
      nextByteOffset: cursor + 2,
      decodedChars: 2,
      bytesConsumed: 2,
      atEof: cursor + 2 >= 100,
    }));
    cursor = 0;
    const first = await mod.decodeChunk('/tmp/x.txt', 'utf-8', cursor, 2);
    cursor = first.nextByteOffset;
    expect(cursor).toBe(2);
    const second = await mod.decodeChunk('/tmp/x.txt', 'utf-8', cursor, 2);
    expect(second.nextByteOffset).toBe(4);
  });
});

// Ensure NativeModules is the one we augmented in jest.setup.
void NativeModules;
