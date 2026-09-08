import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  buildAvailableUpdate,
  displayVersionName,
  expectedApkName,
  parseGitHubRelease,
  parseUpdateMetadata,
  selectStableRelease,
  UpdateMetadataError,
} from '../src/services/updateProtocol';
import {
  checkForUpdate,
  isUpdateServiceError,
  shouldOfferUpdate,
  type UpdateServiceError,
} from '../src/services/updateService';

const APK_SHA = 'a'.repeat(64);

function asset(name: string, size = 10): Record<string, unknown> {
  return {
    name,
    browser_download_url: `https://github.com/anjingdtl/tavo-mini/releases/download/V3.0.0/${name}`,
    size,
  };
}

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: 'V3.0.0',
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/anjingdtl/tavo-mini/releases/tag/V3.0.0',
    assets: [
      asset('update.json'),
      asset('ShineWriter-V3.0.0-release.apk'),
    ],
    ...overrides,
  };
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    versionName: '3.0.0',
    versionCode: 3000000,
    apkName: 'ShineWriter-V3.0.0-release.apk',
    apkUrl: '',
    sha256: APK_SHA,
    forceUpdate: false,
    minimumVersionCode: 0,
    title: 'ShineWriter V3.0.0',
    notes: ['应用内更新能力', '正式发布流程增强'],
    apkSizeBytes: 10,
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(async () => body),
  } as unknown as Response;
}

describe('update protocol', () => {
  it('normalizes versions and derives the only accepted release APK name', () => {
    expect(displayVersionName('3.0.0')).toBe('V3.0.0');
    expect(displayVersionName('V3.0.0')).toBe('V3.0.0');
    expect(expectedApkName('3.0.0')).toBe('ShineWriter-V3.0.0-release.apk');
  });

  it('accepts a stable release with matching metadata and asset', () => {
    const parsedRelease = parseGitHubRelease(release());
    const apk = parsedRelease.assets[1];
    const parsedMetadata = parseUpdateMetadata(metadata(), parsedRelease, apk);
    const available = buildAvailableUpdate(parsedMetadata, parsedRelease, apk);

    expect(available.versionCode).toBe(3000000);
    expect(available.apkUrl).toContain('ShineWriter-V3.0.0-release.apk');
    expect(available.displayVersionName).toBe('V3.0.0');
  });

  it('filters draft and prerelease entries when selecting stable releases', () => {
    const selected = selectStableRelease([
      release({ draft: true }),
      release({ prerelease: true }),
      release(),
    ]);
    expect(selected?.tag_name).toBe('V3.0.0');
  });

  it('rejects missing metadata/APK assets and malformed metadata', () => {
    const parsedRelease = parseGitHubRelease(release());
    const apk = parsedRelease.assets[1];
    expect(() =>
      parseUpdateMetadata(
        metadata({ apkName: 'ShineWriter-V3.0.1-release.apk' }),
        parsedRelease,
        apk,
      ),
    ).toThrow(UpdateMetadataError);
    expect(() =>
      parseUpdateMetadata('not-json', parsedRelease, apk),
    ).toThrow(/JSON 对象/);
    expect(() =>
      parseUpdateMetadata(metadata({ versionCode: 0 }), parsedRelease, apk),
    ).toThrow(/versionCode/);
    expect(() => parseGitHubRelease({ ...release(), assets: [] })).not.toThrow();
  });

  it('compares integer version codes only and never offers a downgrade', () => {
    expect(shouldOfferUpdate(3000001, 3000000)).toBe(true);
    expect(shouldOfferUpdate(3000000, 3000000)).toBe(false);
    expect(shouldOfferUpdate(2999999, 3000000)).toBe(false);
    expect(shouldOfferUpdate(3, 30)).toBe(false);
  });
});

describe('update service HTTP validation', () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.restoreAllMocks();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it.each([403, 404, 500])('surfaces HTTP %s instead of claiming latest', async status => {
    (global.fetch as jest.Mock).mockResolvedValue(response({}, status));
    await expect(checkForUpdate({ force: true })).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status,
    } satisfies Partial<UpdateServiceError>);
  });

  it('classifies an aborted request as timeout', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    await expect(checkForUpdate({ force: true })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('handles normal latest, lower remote, missing assets and malformed JSON', async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock
      .mockResolvedValueOnce(response(release()))
      .mockResolvedValueOnce(response(metadata()));
    const latest = await checkForUpdate({ force: true });
    expect(latest.status).toBe('latest');

    fetchMock
      .mockResolvedValueOnce(
        response({
          ...release(),
          tag_name: 'V2.99.99',
          assets: [
            asset('update.json'),
            asset('ShineWriter-V2.99.99-release.apk'),
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(
          metadata({
            versionName: '2.99.99',
            versionCode: 2999999,
            apkName: 'ShineWriter-V2.99.99-release.apk',
          }),
        ),
      );
    await expect(checkForUpdate({ force: true })).resolves.toMatchObject({
      status: 'latest',
    });

    fetchMock.mockResolvedValueOnce(
      response({ ...release(), assets: [asset('update.json')] }),
    );
    fetchMock.mockResolvedValueOnce(response(metadata()));
    await expect(checkForUpdate({ force: true })).rejects.toMatchObject({
      code: 'MISSING_APK_ASSET',
    });

    fetchMock.mockResolvedValueOnce(
      response({ ...release(), assets: [asset('ShineWriter-V3.0.0-release.apk')] }),
    );
    await expect(checkForUpdate({ force: true })).rejects.toMatchObject({
      code: 'MISSING_METADATA_ASSET',
    });

    fetchMock
      .mockResolvedValueOnce(response(release()))
      .mockResolvedValueOnce(response('malformed'));
    await expect(checkForUpdate({ force: true })).rejects.toMatchObject({
      code: 'INVALID_METADATA',
    });
  });

  it('offers a newer remote version after both API and update.json validation', async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock
      .mockResolvedValueOnce(
        response(
          release({
            tag_name: 'V3.0.1',
            assets: [
              asset('update.json'),
              asset('ShineWriter-V3.0.1-release.apk'),
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        response(
          metadata({
            versionName: '3.0.1',
            versionCode: 3000100,
            apkName: 'ShineWriter-V3.0.1-release.apk',
            minimumVersionCode: 3000001,
          }),
        ),
      );
    const result = await checkForUpdate({ force: true });
    expect(result.status).toBe('update');
    expect(result.release?.displayVersionName).toBe('V3.0.1');
    expect(result.release?.forceUpdate).toBe(true);
    expect(isUpdateServiceError(new Error('x'))).toBe(false);
  });

  it('returns a still-new cached release without another network request', async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock
      .mockResolvedValueOnce(
        response(
          release({
            tag_name: 'V3.0.1',
            assets: [
              asset('update.json'),
              asset('ShineWriter-V3.0.1-release.apk'),
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        response(
          metadata({
            versionName: '3.0.1',
            versionCode: 3000100,
            apkName: 'ShineWriter-V3.0.1-release.apk',
          }),
        ),
      );
    await expect(checkForUpdate({ force: true })).resolves.toMatchObject({
      status: 'update',
    });

    fetchMock.mockImplementation(() => {
      throw new Error('network should not be used for a fresh cache');
    });
    await expect(checkForUpdate()).resolves.toMatchObject({
      status: 'skipped',
      fromCache: true,
      release: { displayVersionName: 'V3.0.1' },
    });
  });
});
