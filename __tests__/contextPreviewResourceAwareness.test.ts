import fs from 'fs';
import path from 'path';

test('Context Preview distinguishes awareness-only from unused resources', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/screens/ContextPreviewScreen.tsx'),
    'utf8',
  );
  expect(source).toContain('AWARENESS_ONLY');
  expect(source).toContain('DETAIL_FULL');
  expect(source).toContain('DETAIL_CLIPPED');
  expect(source).toContain('NOT_SELECTED');
  expect(source).toContain('未选入详情');
  expect(source).toContain('item.warning');
  expect(source).toContain('仅全局感知');
  expect(source).toContain('详情已展开');
  expect(source).toContain('Resource Context V2');
  expect(source).toContain('Snapshot V4');
  expect(source).toContain('RESOURCE_AWARENESS_OVER_BUDGET');
});

test('Context config exposes detail intensity without an awareness slider', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/screens/ContextConfig.tsx'),
    'utf8',
  );
  expect(source).toContain('资料详情强度');
  expect(source).toContain('节省');
  expect(source).toContain('均衡');
  expect(source).toContain('丰富');
  expect(source).not.toContain('全局感知比例');
  expect(source).toContain('写作预设仍生效');
});
