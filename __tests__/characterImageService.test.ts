import RNFS from 'react-native-fs';
import {
  CHARACTER_IMAGE_MAX_BYTES,
  deleteCharacterImageFile,
  persistCharacterImage,
  validateCharacterVisualReference,
} from '../src/services/characterImageService';

describe('character image asset lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.stat as jest.Mock).mockResolvedValue({ size: 1024 });
  });

  it.each([
    ['image/gif', 'portrait.gif'],
    ['image/svg+xml', 'portrait.svg'],
    ['image/heic', 'portrait.heic'],
  ])('rejects unsupported visual format %s', async (mimeType, name) => {
    await expect(
      validateCharacterVisualReference({
        localPath: '/tmp/cache/portrait',
        name,
        mimeType,
      }),
    ).rejects.toThrow('仅支持 JPEG、PNG 或 WebP');
  });

  it('rejects an image over the 20 MB boundary', async () => {
    (RNFS.stat as jest.Mock).mockResolvedValue({
      size: CHARACTER_IMAGE_MAX_BYTES + 1,
    });
    await expect(
      validateCharacterVisualReference({
        localPath: '/tmp/cache/large.png',
        name: 'large.png',
        mimeType: 'image/png',
      }),
    ).rejects.toThrow('不能超过 20 MB');
  });

  it('accepts an image exactly at the 20 MB boundary', async () => {
    (RNFS.stat as jest.Mock).mockResolvedValue({
      size: CHARACTER_IMAGE_MAX_BYTES,
    });
    await expect(
      validateCharacterVisualReference({
        localPath: '/tmp/cache/limit.png',
        name: 'limit.png',
        mimeType: 'image/png',
      }),
    ).resolves.toMatchObject({
      size: CHARACTER_IMAGE_MAX_BYTES,
      mimeType: 'image/png',
    });
  });

  it('persists only validated supported images and deletes only app-owned assets', async () => {
    const imagePath = await persistCharacterImage({
      localPath: '/tmp/cache/portrait.png',
      name: 'portrait.png',
      mimeType: 'image/png',
      size: 1024,
    });
    expect(imagePath).toMatch(/^\/tmp\/documents\/character-images\//);
    expect(RNFS.copyFile).toHaveBeenCalledWith(
      '/tmp/cache/portrait.png',
      expect.stringContaining('/tmp/documents/character-images/'),
    );

    await deleteCharacterImageFile(imagePath);
    expect(RNFS.unlink).toHaveBeenCalledWith(imagePath);
    (RNFS.unlink as jest.Mock).mockClear();
    await deleteCharacterImageFile('/tmp/documents/other/should-not-delete.png');
    expect(RNFS.unlink).not.toHaveBeenCalled();
  });
});
