const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

function fail(message) {
  throw new Error(`[release:verify] ${message}`);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function verify() {
  const pkg = readJson('package.json');
  const versionJson = readJson('src/constants/version.json');
  const expectedVersionName = `V${pkg.version}`;
  if (versionJson.versionName !== expectedVersionName) {
    fail(`versionName mismatch: ${versionJson.versionName} != ${expectedVersionName}`);
  }
  if (!Number.isSafeInteger(versionJson.versionCode)) {
    fail('versionCode must be an integer');
  }
  const expectedApkName = `ShineWriter-${expectedVersionName}-release.apk`;
  const releaseDir = path.join(projectRoot, 'dist', 'apk', 'release');
  const apkPath = path.join(releaseDir, expectedApkName);
  const metadataPath = path.join(releaseDir, 'update.json');
  if (!fs.existsSync(apkPath)) fail(`missing APK: ${apkPath}`);
  if (!fs.existsSync(metadataPath)) fail(`missing update.json: ${metadataPath}`);
  const metadata = readJson(path.relative(projectRoot, metadataPath));
  const requiredKeys = [
    'versionName',
    'versionCode',
    'apkName',
    'apkUrl',
    'sha256',
    'forceUpdate',
    'minimumVersionCode',
    'title',
    'notes',
  ];
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key)) fail(`missing field: ${key}`);
  }
  if (metadata.versionName !== pkg.version) fail('metadata versionName mismatch');
  if (metadata.versionCode !== versionJson.versionCode) fail('metadata versionCode mismatch');
  if (metadata.apkName !== expectedApkName) fail('metadata apkName mismatch');
  if (metadata.apkUrl !== '' && !/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(metadata.apkUrl)) {
    fail('metadata apkUrl must be empty or a GitHub HTTPS asset URL');
  }
  if (!/^[a-f0-9]{64}$/.test(metadata.sha256)) fail('metadata sha256 is invalid');
  if (typeof metadata.forceUpdate !== 'boolean') fail('metadata forceUpdate is invalid');
  if (!Number.isSafeInteger(metadata.minimumVersionCode) || metadata.minimumVersionCode < 0) {
    fail('metadata minimumVersionCode is invalid');
  }
  if (typeof metadata.title !== 'string' || !metadata.title.trim()) fail('metadata title is invalid');
  if (!Array.isArray(metadata.notes) || metadata.notes.some(note => typeof note !== 'string')) {
    fail('metadata notes is invalid');
  }
  const stats = fs.statSync(apkPath);
  const actualHash = sha256File(apkPath);
  if (metadata.apkSizeBytes !== undefined && metadata.apkSizeBytes !== stats.size) {
    fail(`metadata apkSizeBytes=${metadata.apkSizeBytes} != actual=${stats.size}`);
  }
  if (metadata.sha256 !== actualHash) fail(`metadata sha256=${metadata.sha256} != actual=${actualHash}`);
  console.log('[release:verify] PASS');
  console.log(`APK=${apkPath}`);
  console.log(`update.json=${metadataPath}`);
  console.log(`versionName=${metadata.versionName}`);
  console.log(`versionCode=${metadata.versionCode}`);
  console.log(`sha256=${actualHash}`);
  console.log(`apkSizeBytes=${stats.size}`);
}

if (require.main === module) {
  try {
    verify();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verify };
