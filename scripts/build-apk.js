const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const androidDir = path.join(projectRoot, 'android');
const variant = (process.argv[2] || '').toLowerCase();

if (!['debug', 'release'].includes(variant)) {
  console.error('Usage: node scripts/build-apk.js <debug|release>');
  process.exit(1);
}

const gradleScript = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const task = variant === 'debug' ? 'assembleDebug' : 'assembleRelease';
const gradleArgs = [task];

const gradlePath = path.join(androidDir, gradleScript);
const build = process.platform === 'win32'
  ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', gradlePath, task], {
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

const buildGradle = fs.readFileSync(path.join(androidDir, 'app', 'build.gradle'), 'utf8');
const versionMatch = buildGradle.match(/versionName\s+["']([^"']+)["']/);
const rawVersion = versionMatch ? versionMatch[1] : '';
// If build.gradle contains a Gradle variable like ${pkgVersion}, resolve from package.json instead
const pkgVersion = require('../package.json').version;
const versionName = rawVersion.includes('$') ? `V${pkgVersion}` : rawVersion;
const source = path.join(androidDir, 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
const outDir = path.join(projectRoot, 'dist', 'apk', variant);
const target = path.join(outDir, `TavoMini-${versionName}-${variant}.apk`);

if (!fs.existsSync(source)) {
  console.error(`APK not found: ${source}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(source, target);

const sizeMb = (fs.statSync(target).size / 1024 / 1024).toFixed(2);
console.log(`APK copied to ${target} (${sizeMb} MB)`);
