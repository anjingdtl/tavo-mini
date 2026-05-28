const fs = require('fs');
const path = require('path');

const gradleFile = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-sqlite-storage',
  'platforms',
  'android',
  'build.gradle',
);

if (!fs.existsSync(gradleFile)) {
  process.exit(0);
}

const source = fs.readFileSync(gradleFile, 'utf8');
const patched = source.replace(/(\s*)jcenter\(\)/g, '$1mavenCentral()');

if (patched !== source) {
  fs.writeFileSync(gradleFile, patched);
  console.log('Patched react-native-sqlite-storage Android repositories for modern Gradle.');
}
