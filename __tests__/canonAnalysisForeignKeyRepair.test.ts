describe('Canon foreign-key repair fail-closed guards', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../src/services/migrations/v19-to-v20');
    jest.dontMock('../src/services/database/schemaManifest');
  });

  it('rejects a migration when a Canon table definition is missing', () => {
    jest.doMock('../src/services/migrations/v19-to-v20', () => ({
      buildV19toV20Statements: () => [],
    }));

    const {
      buildCanonTableCreateStatements,
    } = require('../src/services/migrations/canonAnalysisForeignKeyRepair');

    expect(() => buildCanonTableCreateStatements()).toThrow(
      '缺少 canon_evidence 的 Canon 建表定义',
    );
  });

  it('rejects a migration when a Canon manifest column list is missing', () => {
    jest.doMock('../src/services/database/schemaManifest', () => ({
      SCHEMA_MANIFEST: [],
    }));

    const {
      buildCanonTableCopyStatements,
    } = require('../src/services/migrations/canonAnalysisForeignKeyRepair');

    expect(() => buildCanonTableCopyStatements('v30')).toThrow(
      '缺少 canon_evidence 的 Schema manifest 列定义',
    );
  });
});
