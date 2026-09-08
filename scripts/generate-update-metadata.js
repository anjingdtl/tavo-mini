const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

function displayVersionName(versionName) {
  const normalized = String(versionName).replace(/^V/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`Invalid versionName: ${versionName}`);
  }
  return `V${normalized}`;
}

function expectedApkName(versionName) {
  return `ShineWriter-${displayVersionName(versionName)}-release.apk`;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readReleaseNotes(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = changelog.match(
    new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[[^\\n]+\\]|(?![\\s\\S]))`, 'm'),
  );
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map(line => line.match(/^\s*[-*]\s+(.*)$/)?.[1]?.trim())
    .filter(Boolean);
}

function buildUpdateMetadata({
  versionJson,
  apkSizeBytes,
  sha256,
  notes,
  apkUrl = '',
}) {
  const versionName = displayVersionName(versionJson.versionName);
  const apkName = expectedApkName(versionName);
  if (!Number.isSafeInteger(versionJson.versionCode) || versionJson.versionCode < 1) {
    throw new Error(`Invalid versionCode: ${versionJson.versionCode}`);
  }
  if (!Number.isSafeInteger(apkSizeBytes) || apkSizeBytes <= 0) {
    throw new Error(`Invalid APK size: ${apkSizeBytes}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error('APK SHA-256 must be a 64-character hexadecimal string');
  }
  if (typeof apkUrl !== 'string') throw new Error('apkUrl must be a string');
  return {
    versionName: versionName.replace(/^V/, ''),
    versionCode: versionJson.versionCode,
    apkName,
    apkUrl,
    sha256: sha256.toLowerCase(),
    forceUpdate: false,
    minimumVersionCode: 0,
    title: versionJson.releaseTitle || `ShineWriter ${versionName}`,
    notes: Array.isArray(notes) ? notes : [],
    apkSizeBytes,
  };
}

function parseArguments(args) {
  const options = { apkUrl: process.env.SHINE_WRITER_RELEASE_APK_URL || '' };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--apk-url') {
      options.apkUrl = args[index + 1] || '';
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  return options;
}

async function main() {
  const versionJson = readJson('src/constants/version.json');
  const pkg = readJson('package.json');
  const versionName = displayVersionName(versionJson.versionName);
  if (versionName !== `V${pkg.version}`) {
    throw new Error(
      `version.json (${versionName}) does not match package.json (V${pkg.version})`,
    );
  }
  const apkName = expectedApkName(versionName);
  const apkPath = path.join(projectRoot, 'dist', 'apk', 'release', apkName);
  if (!fs.existsSync(apkPath)) {
    throw new Error(`Release APK not found: ${apkPath}`);
  }
  const stats = fs.statSync(apkPath);
  const sha256 = await sha256File(apkPath);
  const changelog = fs.readFileSync(path.join(projectRoot, 'CHANGELOG.md'), 'utf8');
  const metadata = buildUpdateMetadata({
    versionJson,
    apkSizeBytes: stats.size,
    sha256,
    notes: readReleaseNotes(changelog, pkg.version),
    apkUrl: parseArguments(process.argv.slice(2)).apkUrl,
  });
  const outputPath = path.join(projectRoot, 'dist', 'apk', 'release', 'update.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`update.json written to ${outputPath}`);
  console.log(`apkName=${metadata.apkName}`);
  console.log(`versionCode=${metadata.versionCode}`);
  console.log(`sha256=${metadata.sha256}`);
  console.log(`apkSizeBytes=${metadata.apkSizeBytes}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[release:metadata] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildUpdateMetadata,
  displayVersionName,
  expectedApkName,
  readReleaseNotes,
  sha256File,
};
