const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildUpdateMetadata,
  expectedApkName,
  readReleaseNotes,
  sha256File,
} = require('../scripts/generate-update-metadata');

describe('release metadata generation', () => {
  it('builds a strict V3.0.0 update descriptor', () => {
    const metadata = buildUpdateMetadata({
      versionJson: {
        versionName: 'V3.0.0',
        versionCode: 3000000,
        releaseTitle: 'ShineWriter V3.0.0',
      },
      apkSizeBytes: 123456,
      sha256: 'A'.repeat(64),
      notes: ['GitHub 应用内更新'],
    });

    expect(metadata).toEqual({
      versionName: '3.0.0',
      versionCode: 3000000,
      apkName: 'ShineWriter-V3.0.0-release.apk',
      apkUrl: '',
      sha256: 'a'.repeat(64),
      forceUpdate: false,
      minimumVersionCode: 0,
      title: 'ShineWriter V3.0.0',
      notes: ['GitHub 应用内更新'],
      apkSizeBytes: 123456,
    });
    expect(expectedApkName('3.0.0')).toBe('ShineWriter-V3.0.0-release.apk');
  });

  it('extracts the matching changelog section only', () => {
    const notes = readReleaseNotes(
      '# Changelog\n\n## [3.0.0] - 2026-09-08\n- First\n- Second\n\n## [2.30.2] - 2026-01-01\n- Older\n',
      '3.0.0',
    );
    expect(notes).toEqual(['First', 'Second']);
  });

  it('computes a streaming SHA-256 for an APK-sized file', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'shinewriter-metadata-'));
    const filePath = path.join(tempDirectory, 'test.apk');
    fs.writeFileSync(filePath, 'abc');
    try {
      await expect(sha256File(filePath)).resolves.toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
