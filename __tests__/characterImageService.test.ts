import RNFS from 'react-native-fs';
import {
  CHARACTER_IMAGE_MAX_BYTES,
  deleteCharacterImageFile,
  persistCharacterCardImage,
  persistCharacterImage,
  validateCharacterCardImportedImage,
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

  it('rejects a visual reference over the 5 MB boundary', async () => {
    (RNFS.stat as jest.Mock).mockResolvedValue({
      size: CHARACTER_IMAGE_MAX_BYTES + 1,
    });
    await expect(
      validateCharacterVisualReference({
        localPath: '/tmp/cache/large.png',
        name: 'large.png',
        mimeType: 'image/png',
      }),
    ).rejects.toThrow('不能超过 5 MB');
  });

  it('accepts a visual reference exactly at the 5 MB boundary', async () => {
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

  it('keeps legacy PNG card imports compatible above the visual-reference limit', async () => {
    const legacySize = CHARACTER_IMAGE_MAX_BYTES + 1;
    (RNFS.stat as jest.Mock).mockResolvedValue({ size: legacySize });

    await expect(
      validateCharacterCardImportedImage({
        localPath: '/tmp/cache/legacy-large.png',
        name: 'legacy-large.png',
        mimeType: 'image/png',
      }),
    ).resolves.toMatchObject({
      size: legacySize,
      mimeType: 'image/png',
    });

    await expect(
      persistCharacterCardImage({
        localPath: '/tmp/cache/legacy-large.png',
        name: 'legacy-large.png',
        mimeType: 'image/png',
        size: legacySize,
      }),
    ).resolves.toMatch(/^\/tmp\/documents\/character-images\//);
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
