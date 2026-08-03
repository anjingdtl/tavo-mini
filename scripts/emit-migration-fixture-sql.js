/*
 * Emit the real TypeScript migration statements for the SQLite fixture
 * generator. This keeps the committed Python fixture tool aligned with the
 * application migration registry without duplicating thirty-two schemas in
 * Python. It intentionally loads builders only; no database, model, or file
 * side effect is performed here.
 */
const fs = require('fs');
const path = require('path');
const typescript = require('typescript');

const root = path.resolve(__dirname, '..');
const moduleCache = new Map();

function resolveFile(parentFile, request) {
  if (!request.startsWith('.')) return null;
  const raw = path.resolve(path.dirname(parentFile), request);
  for (const candidate of [
    raw,
    `${raw}.ts`,
    `${raw}.js`,
    path.join(raw, 'index.ts'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`无法解析迁移模块 ${request}（来自 ${parentFile}）`);
}

function loadModule(file) {
  const absolute = path.resolve(file);
  if (moduleCache.has(absolute)) return moduleCache.get(absolute).exports;
  const source = fs.readFileSync(absolute, 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const moduleObject = { exports: {} };
  moduleCache.set(absolute, moduleObject);
  const localRequire = request => {
    const resolved = resolveFile(absolute, request);
    // Type-only/native imports do not participate in SQL builder execution.
    if (!resolved) return {};
    return loadModule(resolved);
  };
  // The fixture tool needs a tiny CommonJS loader so it can execute the
  // TypeScript-only migration builders without a runtime app/database.
  // eslint-disable-next-line no-new-func
  new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    output,
  )(
    localRequire,
    moduleObject,
    moduleObject.exports,
    absolute,
    path.dirname(absolute),
  );
  return moduleObject.exports;
}

const migrationSpecs = [
  [3, 'v3-to-v4', 'buildV3toV4Statements'],
  [4, 'v4-to-v5', 'buildV4toV5Statements'],
  [5, 'v5-to-v6', 'buildV5toV6Statements'],
  [6, 'v6-to-v7', 'buildV6toV7Statements'],
  [7, 'v7-to-v8', 'buildV7toV8Statements'],
  [8, 'v8-to-v9', 'buildV8toV9Statements'],
  [9, 'v9-to-v10', 'buildV9toV10Statements'],
  [10, 'v10-to-v11', 'buildV10toV11Statements'],
  [11, 'v11-to-v12', 'buildV11toV12Statements'],
  [12, 'v12-to-v13', 'buildV12toV13Statements'],
  [13, 'v13-to-v14', 'buildV13toV14Statements'],
  [14, 'v14-to-v15', 'buildV14toV15Statements'],
  [15, 'v15-to-v16', 'buildV15toV16Statements'],
  [16, 'v16-to-v17', 'buildV16toV17Statements'],
  [17, 'v17-to-v18', 'buildV17toV18Statements'],
  [18, 'v18-to-v19', 'buildV18toV19Statements'],
  [19, 'v19-to-v20', 'buildV19toV20Statements'],
  [20, 'v20-to-v21', 'buildV20toV21Statements'],
  [21, 'v21-to-v22', 'buildV21toV22Statements'],
  [22, 'v22-to-v23', 'buildV22toV23Statements'],
  [23, 'v23-to-v24', 'buildV23toV24Statements'],
  [24, 'v24-to-v25', 'buildV24toV25Statements'],
  [25, 'v25-to-v26', 'buildV25toV26Statements'],
  [26, 'v26-to-v27', 'buildV26toV27Statements'],
  [27, 'v27-to-v28', 'buildV27toV28Statements'],
  [28, 'v28-to-v29', 'buildV28toV29Statements'],
  [29, 'v29-to-v30', 'buildV29toV30Statements'],
  [30, 'v30-to-v31', 'buildV30toV31Statements'],
  [31, 'v31-to-v32', 'buildV31toV32Statements'],
];

const emptyDatabase = {
  executeSql: async () => [
    { rows: { length: 0, item: () => ({}) } },
  ],
};

async function main() {
  const migrations = [];
  for (const [from, file, functionName] of migrationSpecs) {
    const modulePath = path.join(root, 'src', 'services', 'migrations', `${file}.ts`);
    const migrationModule = loadModule(modulePath);
    const builder = migrationModule[functionName];
    if (typeof builder !== 'function') {
      throw new Error(`迁移 ${file} 缺少 ${functionName}`);
    }
    const statements = builder.length === 0
      ? builder()
      : await builder(emptyDatabase);
    migrations.push({
      from,
      statements: statements.map(statement => ({
        sql: statement.sql,
        params: statement.params || [],
      })),
    });
  }
  process.stdout.write(JSON.stringify(migrations));
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
