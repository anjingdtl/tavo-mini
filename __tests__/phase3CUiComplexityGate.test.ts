import fs from 'fs';
import path from 'path';

const root = process.cwd();
const auditPath = path.join(
  root,
  'docs/optimization/phase3-c-ui-complexity-audit.md',
);

describe('Phase III-C UI Complexity Gate', () => {
  test('has a durable audit record for all zero-increase gates and Android evidence', () => {
    expect(fs.existsSync(auditPath)).toBe(true);
    const audit = fs.readFileSync(auditPath, 'utf8');
    expect(audit).toContain('一级导航新增 = 0');
    expect(audit).toContain('核心写作步骤增加 = 0');
    expect(audit).toContain('默认展开技术信息增加 = 0');
    expect(audit).toContain('后台模块要求用户维护的新开关 = 0');
    expect(audit).toContain('真实 Android');
  });

  test('keeps the existing five primary tabs and hides C-round backend terms', () => {
    const navigation = fs.readFileSync(
      path.join(root, 'src/navigation/TabNavigator.tsx'),
      'utf8',
    );
    const tabNames = Array.from(
      navigation.matchAll(/<Tab\.Screen\s+name="([^"]+)"/g),
      match => match[1],
    );
    expect(tabNames).toEqual([
      'Projects',
      'Resources',
      'Editor',
      'Build',
      'Settings',
    ]);

    const userScreens = [
      'src/screens/ProjectListScreen.tsx',
      'src/screens/ContextAutoConfigScreen.tsx',
      'src/screens/LLMSettingsScreen.tsx',
    ].map(file => fs.readFileSync(path.join(root, file), 'utf8'));
    const forbiddenTerms = [
      'Memory Delta',
      'Fingerprint',
      'Prefetch',
      'Receipt',
      'Outbox',
      'Pipeline Resume',
      'Book Production Envelope',
      'Long-Horizon Dashboard',
    ];
    for (const screen of userScreens) {
      for (const term of forbiddenTerms) expect(screen).not.toContain(term);
    }
  });

  test('keeps the allowed project-card and same-page batch affordances', () => {
    const projectList = fs.readFileSync(
      path.join(root, 'src/screens/ProjectListScreen.tsx'),
      'utf8',
    );
    expect(projectList).toContain('项目章节和正文字数');
    expect(projectList).toContain('批量管理');
    expect(projectList).toContain('exportProjectsAsZip');
    expect(projectList).toContain('批量删除');
  });
});
