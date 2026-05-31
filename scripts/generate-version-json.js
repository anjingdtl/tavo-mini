const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const pkg = require(path.join(projectRoot, 'package.json'));

let versionCode;
try {
  versionCode = parseInt(
    execSync('git rev-list --count HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim(),
    10,
  );
} catch {
  const parts = pkg.version.split('.');
  versionCode = parseInt(parts[0], 10) * 10000 + parseInt(parts[1], 10) * 100 + parseInt(parts[2], 10);
}

const versionJson = {
  versionName: `V${pkg.version}`,
  versionCode,
  buildTime: new Date().toISOString(),
};

const outDir = path.join(projectRoot, 'src', 'constants');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'version.json'),
  JSON.stringify(versionJson, null, 2) + '\n',
);

console.log(`version.json: versionName=${versionJson.versionName}, versionCode=${versionJson.versionCode}`);
