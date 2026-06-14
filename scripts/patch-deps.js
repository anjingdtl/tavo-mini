const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules');

const patches = [
  {
    label: 'react-native-keychain Android compileSdk',
    file: path.join(root, 'react-native-keychain', 'android', 'build.gradle'),
    apply(source) {
      // AGP 9.x removes the legacy `compileSdkVersion` getter. Rewrite
      // `compileSdkVersion safeExtGet(...)` to `compileSdk safeExtGet(...)`
      // so the library participates in the project-level compileSdk.
      return source.replace(
        /(^|\n)(\s*)compileSdkVersion\s+safeExtGet\(/g,
        '$1$2compileSdk safeExtGet(',
      );
    },
  },
  {
    label: 'react-native-svg Android compileSdk',
    file: path.join(root, 'react-native-svg', 'android', 'build.gradle'),
    apply(source) {
      return source.replace(
        /(^|\n)(\s*)compileSdkVersion\s+safeExtGet\(/g,
        '$1$2compileSdk safeExtGet(',
      );
    },
  },
  {
    label: 'react-native-svg Android jcenter removal',
    file: path.join(root, 'react-native-svg', 'android', 'build.gradle'),
    apply(source) {
      return source.replace(/(\s*)jcenter\(\)/g, '$1mavenCentral()');
    },
  },
];

let applied = 0;
for (const patch of patches) {
  if (!fs.existsSync(patch.file)) {
    continue;
  }
  const source = fs.readFileSync(patch.file, 'utf8');
  const patched = patch.apply(source);
  if (patched !== source) {
    fs.writeFileSync(patch.file, patched);
    console.log(`[patch-deps] ${patch.label} updated.`);
    applied += 1;
  }
}

if (applied === 0) {
  console.log('[patch-deps] All upstreams already match the expected shape.');
}
