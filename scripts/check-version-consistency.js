/**
 * Version metadata consistency gate (V2.5.12+).
 * Exit 1 on any mismatch. Used by `npm run verify:version` and `npm run verify`.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function readText(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function fail(message) {
  console.error(`[verify:version] ${message}`);
  process.exit(1);
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const versionJson = readJson('src/constants/version.json');
const changelog = readText('CHANGELOG.md');
const readme = readText('README.md');

const version = String(pkg.version || '');
const parts = version.split('.').map(Number);
if (parts.length !== 3 || parts.some(n => !Number.isInteger(n) || n < 0)) {
  fail(`package.json.version must be major.minor.patch, got: ${version}`);
}
const [major, minor, patch] = parts;
const expectedVersionName = `V${version}`;
const expectedReleaseTitle = `ShineWriter ${expectedVersionName}`;
const baseVersionCode = major * 1_000_000 + minor * 10_000 + patch * 100;

// 1–3 package / lock
if (lock.version !== version) {
  fail(`package-lock.json.version=${lock.version} !== package.json=${version}`);
}
const lockRoot = lock.packages && lock.packages[''];
if (!lockRoot || lockRoot.version !== version) {
  fail(
    `package-lock.json.packages[""].version=${lockRoot?.version} !== package.json=${version}`,
  );
}

// 4 version.json
if (versionJson.versionName !== expectedVersionName) {
  fail(
    `version.json.versionName=${versionJson.versionName} !== ${expectedVersionName}`,
  );
}
if (versionJson.releaseTitle !== expectedReleaseTitle) {
  fail(
    `version.json.releaseTitle=${versionJson.releaseTitle} !== ${expectedReleaseTitle}`,
  );
}
if (!Number.isInteger(versionJson.versionCode)) {
  fail(`version.json.versionCode is not an integer: ${versionJson.versionCode}`);
}
// versionCode must share the major.minor.patch base (build suffix 0–99 allowed)
if (versionJson.versionCode < baseVersionCode) {
  fail(
    `version.json.versionCode=${versionJson.versionCode} < base ${baseVersionCode}`,
  );
}
if (versionJson.versionCode >= baseVersionCode + 100) {
  fail(
    `version.json.versionCode=${versionJson.versionCode} exceeds base+99 (${baseVersionCode + 99})`,
  );
}
if (Math.floor(versionJson.versionCode / 100) * 100 !== baseVersionCode) {
  fail(
    `version.json.versionCode=${versionJson.versionCode} does not match package version base ${baseVersionCode}`,
  );
}

// 5–6 README
if (!readme.includes(`当前版本：**${expectedVersionName}**`)) {
  fail(`README 中文“当前版本”缺少 ${expectedVersionName}`);
}
// English summary / badge
if (!readme.includes(`Version-${expectedVersionName}-`)) {
  fail(`README English badge 缺少 Version-${expectedVersionName}`);
}
// At least one more English mention (summary line or explicit V)
const englishHits = (readme.match(new RegExp(expectedVersionName, 'g')) || [])
  .length;
if (englishHits < 2) {
  fail(
    `README 中 ${expectedVersionName} 出现次数过少 (${englishHits})，中英文摘要应同步`,
  );
}

// 7 CHANGELOG top version
const changelogVersion = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
if (!changelogVersion) {
  fail('CHANGELOG 找不到顶部 ## [x.y.z] 版本标题');
}
// Prefer first released version section (skip Unreleased)
const allVersions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map(
  m => m[1],
);
if (!allVersions.includes(version)) {
  fail(`CHANGELOG 不包含版本 ${version}`);
}
if (allVersions[0] !== version) {
  fail(
    `CHANGELOG 顶部发布版本为 ${allVersions[0]}，期望 ${version}（Unreleased 可在前，但第一个数字版本必须是当前版）`,
  );
}

console.log(
  `[verify:version] ok ${expectedVersionName} versionCode=${versionJson.versionCode}`,
);
