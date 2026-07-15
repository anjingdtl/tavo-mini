const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const androidDir = path.join(projectRoot, 'android');
const variant = (process.argv[2] || '').toLowerCase();
const minifyRequested = process.argv.includes('--minify');

if (!['debug', 'release'].includes(variant)) {
  console.error('Usage: node scripts/build-apk.js <debug|release> [--minify]');
  process.exit(1);
}

if (minifyRequested && variant !== 'release') {
  console.error('The --minify option is only supported for release builds.');
  process.exit(1);
}

const gradleScript = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const task = variant === 'debug' ? 'assembleDebug' : 'assembleRelease';
const gradleArgs = [task, ...(minifyRequested ? ['-PenableReleaseMinification=true'] : [])];
const pkgVersion = require('../package.json').version;
const versionJson = require('../src/constants/version.json');
const expectedVersionName = `V${pkgVersion}`;
const expectedReleaseTitle = `ShineWriter ${expectedVersionName}`;

if (
  versionJson.versionName !== expectedVersionName
  || !Number.isInteger(versionJson.versionCode)
  || versionJson.releaseTitle !== expectedReleaseTitle
) {
  console.error(
    `Version metadata mismatch: package.json=${expectedVersionName}, version.json=${versionJson.versionName}, versionCode=${versionJson.versionCode}, releaseTitle=${versionJson.releaseTitle}`,
  );
  process.exit(1);
}

const gradlePath = path.join(androidDir, gradleScript);
const build = process.platform === 'win32'
  ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', gradlePath, ...gradleArgs], {
      cwd: androidDir,
      stdio: 'inherit',
      shell: false,
    })
  : spawnSync(gradlePath, gradleArgs, {
      cwd: androidDir,
      stdio: 'inherit',
      shell: false,
    });

if (build.status !== 0) {
  if (build.error) {
    console.error(build.error.message);
  }
  process.exit(build.status || 1);
}

const bundlePath = path.join(
  androidDir,
  'app',
  'build',
  'generated',
  'assets',
  'react',
  variant,
  'index.android.bundle',
);
if (!fs.existsSync(bundlePath) || !fs.readFileSync(bundlePath, 'utf8').includes(expectedVersionName)) {
  console.error(`Stale JS bundle: expected ${expectedVersionName} in ${bundlePath}`);
  process.exit(1);
}

const versionName = versionJson.versionName;
const source = path.join(androidDir, 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
const outDir = path.join(projectRoot, 'dist', 'apk', variant);
const target = path.join(outDir, `ShineWriter-${versionName}-${variant}.apk`);

if (!fs.existsSync(source)) {
  console.error(`APK not found: ${source}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(source, target);

const sizeMb = (fs.statSync(target).size / 1024 / 1024).toFixed(2);
console.log(`APK copied to ${target} (${sizeMb} MB)`);
