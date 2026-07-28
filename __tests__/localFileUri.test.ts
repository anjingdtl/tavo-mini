import { localFileUriToPath } from '../src/utils/localFileUri';

describe('localFileUriToPath', () => {
  it('decodes a document-picker URI with a Chinese file name', () => {
    expect(
      localFileUriToPath(
        'file:///data/user/0/com.shinewriter/cache/import/%E3%80%8A%E7%99%BD%E7%AF%B1%E6%A2%A6%E3%80%8B%E4%BD%9C%E8%80%85%EF%BC%9A%E5%B8%8C%E8%A1%8C.txt',
      ),
    ).toBe('/data/user/0/com.shinewriter/cache/import/《白篱梦》作者：希行.txt');
  });

  it('keeps an ASCII local file path unchanged', () => {
    expect(localFileUriToPath('file:///data/user/0/com.shinewriter/cache/import/original.txt')).toBe(
      '/data/user/0/com.shinewriter/cache/import/original.txt',
    );
  });

  it('does not throw for malformed percent escapes', () => {
    expect(localFileUriToPath('file:///data/user/0/com.shinewriter/cache/100%broken.txt')).toBe(
      '/data/user/0/com.shinewriter/cache/100%broken.txt',
    );
  });
});
