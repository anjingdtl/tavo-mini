import fs from 'fs';
import path from 'path';

describe('C0-B project card statistics refresh contract', () => {
  test('reloads the shared writing stats when the project library regains focus', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/screens/ProjectListScreen.tsx'),
      'utf8',
    );

    expect(source).toMatch(
      /useFocusEffect\(\s*useCallback\(\(\) => \{\s*void loadProjects\(\);\s*\}, \[loadProjects\]\),\s*\);/s,
    );
  });
});
