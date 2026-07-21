const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const packagePath = path.join(projectRoot, 'package.json');
const versionPath = path.join(projectRoot, 'src', 'constants', 'version.json');
const readmePath = path.join(projectRoot, 'README.md');
const pkg = require(packagePath);

const parts = String(pkg.version).split('.').map(Number);
if (parts.length !== 3 || parts.some(part => !Number.isInteger(part) || part < 0)) {
  throw new Error(`package.json version must be major.minor.patch: ${pkg.version}`);
}

const [major, minor, patch] = parts;
let previous = null;
try {
  previous = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
} catch {
  // The generated file may not exist on a fresh checkout.
}

// V2.5.14+: never auto-pull GITHUB_RUN_NUMBER. CI run numbers exceed 99 after
// the first 99 runs, which previously broke prebuild with a hard throw.
// GITHUB_RUN_NUMBER is intentionally ignored on every code path.
//
// Build suffix contract (V2.5.15, clarified — the code below already did this,
// only the earlier comment was misleading):
//   - Explicit SHINE_WRITER_BUILD_NUMBER (0–99) ALWAYS wins and overrides any
//     inherited suffix.
//   - Clean checkout / version bump (no version.json, or versionName differs
//     from the current package version) → suffix defaults to 0.
//   - Same-version re-run (version.json.versionName == current package version)
//     with a previously-generated legal 0–99 suffix and no explicit env var →
//     the previous suffix is PRESERVED, so the versionCode does not regress.
//     An out-of-range inherited suffix (e.g. 100) or a versionCode below the
//     base is NOT inherited and falls back to 0.
const explicitBuildSource = process.env.SHINE_WRITER_BUILD_NUMBER;
const baseVersionCode = major * 1_000_000 + minor * 10_000 + patch * 100;
let buildSource = explicitBuildSource ?? '0';
if (!explicitBuildSource && previous?.versionName === `V${pkg.version}`) {
  const previousBuild = Number(previous.versionCode) - baseVersionCode;
  if (Number.isInteger(previousBuild) && previousBuild >= 0 && previousBuild <= 99) {
    buildSource = String(previousBuild);
  }
}
const build = Number(buildSource);

// Two decimal digits are reserved for the explicit build number. This makes
// every next patch release greater than every build of the previous patch and
// avoids Git commit history/shallow clones changing the Android version code.
// String form is validated first so non-numeric input (e.g. "abc") fails with
// a clear message instead of silently coercing to 0/NaN.
if (
  !/^-?\d+$/.test(String(buildSource))
  || !Number.isInteger(build)
  || build < 0
  || build > 99
) {
  throw new Error(
    `SHINE_WRITER_BUILD_NUMBER must be an integer from 0 to 99; received ${buildSource}`,
  );
}

const versionName = `V${pkg.version}`;
const versionCode = major * 1_000_000 + minor * 10_000 + patch * 100 + build;
const releaseTitle = `ShineWriter ${versionName}`;
if (previous && Number.isInteger(previous.versionCode) && previous.versionCode > versionCode) {
  throw new Error(
    `versionCode would move backwards from ${previous.versionCode} to ${versionCode}; increase package.json or SHINE_WRITER_BUILD_NUMBER`,
  );
}

const buildTime = previous?.versionName === versionName
  && previous?.versionCode === versionCode
  && typeof previous?.buildTime === 'string'
  ? previous.buildTime
  : process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString();

const versionJson = {
  versionName,
  versionCode,
  releaseTitle,
  buildTime,
};

fs.mkdirSync(path.dirname(versionPath), { recursive: true });
const serialized = `${JSON.stringify(versionJson, null, 2)}\n`;
if (!previous || JSON.stringify(previous) !== JSON.stringify(versionJson)) {
  fs.writeFileSync(versionPath, serialized);
}

if (fs.existsSync(readmePath)) {
  const readme = fs.readFileSync(readmePath, 'utf8');
  const versionBadge = `[![Version](https://img.shields.io/badge/Version-${versionName}-blue.svg)](CHANGELOG.md)`;
  const updatedReadme = readme.replace(
    /\[!\[Version\]\(https:\/\/img\.shields\.io\/badge\/Version-[^)]+\)\]\([^)]+\)/,
    versionBadge,
  );
  if (updatedReadme !== readme) {
    fs.writeFileSync(readmePath, updatedReadme);
  }
}

console.log(`version.json: versionName=${versionName}, versionCode=${versionCode}, releaseTitle=${releaseTitle}, build=${build}`);
