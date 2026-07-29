import { SCHEMA_VERSION } from '../src/services/migrations';
import { buildV24toV25Statements } from '../src/services/migrations/v24-to-v25';

describe('schema 25 continuation resource bindings', () => {
  it('keeps ordinary resources opt-in for continuation use', () => {
    expect(SCHEMA_VERSION).toBe(26);
    const sql = buildV24toV25Statements().map(item => item.sql).join('\n');
    expect(sql).toContain('continuation_resource_bindings');
    expect(sql).toContain("'external_supplement'");
    expect(sql).toContain('idx_continuation_resource_bindings_one_preset');
  });
});
