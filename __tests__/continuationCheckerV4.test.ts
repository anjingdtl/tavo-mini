import {
  bindIssuesToArtifact,
  isRepairableCheckerIssue,
  parseCheckerLlmEnvelope,
  parseCheckerLlmJson,
} from '../src/services/continuation/generation/continuationChecker';

describe('Continuation V4 Checker parser', () => {
  test('只有带定位和具体动作的非 info issue 才能进入 Repair 修订单', () => {
    expect(
      isRepairableCheckerIssue({
        severity: 'warning',
        generatedStart: 0,
        generatedEnd: 4,
        generatedExcerpt: '问题原句',
        suggestedFix: '改写问题原句',
      }),
    ).toBe(true);
    expect(
      isRepairableCheckerIssue({
        severity: 'warning',
        generatedStart: null,
        generatedEnd: null,
        generatedExcerpt: '',
        suggestedFix: '注意一致性',
      }),
    ).toBe(false);
    expect(
      isRepairableCheckerIssue({
        severity: 'info',
        generatedStart: 0,
        generatedEnd: 4,
        generatedExcerpt: '观察片段',
        suggestedFix: '可考虑改写',
      }),
    ).toBe(false);
  });

  describe('field protocol unification', () => {
    test('reads standard fields directly', () => {
      const raw = JSON.stringify({
        schemaVersion: 1,
        writerArtifactHash: 'hash_abc',
        issues: [
          {
            issueId: 'chk_model_1',
            category: 'plot',
            subtype: 'canon_conflict',
            severity: 'error',
            confidence: 0.9,
            generatedStart: 0,
            generatedEnd: 4,
            generatedExcerpt: '问题原句',
            description: '与冻结 Canon 冲突',
            evidenceIds: [11],
            suggestedFix: '改写为符合冻结事实的表述',
          },
        ],
        warnings: [],
      });
      const envelope = parseCheckerLlmEnvelope(raw);
      expect(envelope.writerArtifactHash).toBe('hash_abc');
      expect(envelope.issues).toHaveLength(1);
      expect(envelope.issues[0].generatedExcerpt).toBe('问题原句');
      expect(envelope.issues[0].suggestedFix).toBe('改写为符合冻结事实的表述');
      expect(envelope.issues[0].generatedStart).toBe(0);
      expect(envelope.issues[0].generatedEnd).toBe(4);
    });

    test('兼容 draftQuote / suggestedAction / draftStart / draftEnd 旧字段', () => {
      const raw = JSON.stringify({
        schemaVersion: 1,
        writerArtifactHash: 'hash_abc',
        issues: [
          {
            category: 'plot',
            subtype: 'canon_conflict',
            severity: 'error',
            confidence: 0.9,
            draftStart: 5,
            draftEnd: 9,
            draftQuote: '旧字段引用',
            description: '冲突描述',
            evidenceIds: [11],
            suggestedAction: '改写为旧字段建议',
          },
        ],
        warnings: [],
      });
      const issues = parseCheckerLlmJson(raw);
      expect(issues).toHaveLength(1);
      // 别名应被标准化为内部字段
      expect(issues[0].generatedExcerpt).toBe('旧字段引用');
      expect(issues[0].suggestedFix).toBe('改写为旧字段建议');
      expect(issues[0].generatedStart).toBe(5);
      expect(issues[0].generatedEnd).toBe(9);
    });

    test('旧字段经标准化后合法 error 不被误降级为 warning', () => {
      // 关键回归：模型按旧 Prompt 输出 draftQuote/suggestedAction，
      // 经别名标准化后必须仍保留 error 严重度。
      const raw = JSON.stringify({
        schemaVersion: 1,
        writerArtifactHash: 'hash_abc',
        issues: [
          {
            category: 'plot',
            subtype: 'canon_conflict',
            severity: 'error',
            confidence: 0.95,
            draftQuote: '问题原句',
            description: '冻结剧情冲突',
            evidenceIds: [39],
            suggestedAction: '改写冲突',
          },
        ],
        warnings: [],
      });
      const issues = parseCheckerLlmJson(raw);
      expect(issues[0].severity).toBe('error');
      expect(issues[0].generatedExcerpt).toBe('问题原句');
      expect(issues[0].suggestedFix).toBe('改写冲突');
    });

    test('evidence 无效时仍按现有安全策略降级', () => {
      const raw = JSON.stringify({
        schemaVersion: 1,
        writerArtifactHash: 'hash_abc',
        issues: [
          {
            category: 'plot',
            subtype: 'semantic_conflict',
            severity: 'error',
            confidence: 0.9,
            generatedExcerpt: '问题原句',
            description: '冲突',
            evidenceIds: [999], // 不在 allowed 集合内
            suggestedFix: '修复',
          },
        ],
        warnings: [],
      });
      const issues = parseCheckerLlmJson(raw);
      const bound = bindIssuesToArtifact(
        issues,
        '问题原句需要被改写。',
        new Set([1, 2, 3]),
      );
      // 非本地确定性门禁 + evidence 被过滤空 → error 降级 warning
      expect(bound[0].severity).toBe('warning');
    });

    test('warnings 被强制为 warning 严重度且保留', () => {
      const raw = JSON.stringify({
        schemaVersion: 1,
        writerArtifactHash: 'hash_abc',
        issues: [],
        warnings: [
          {
            category: 'style',
            subtype: 'pov_shift',
            severity: 'error', // 模型试图把 warning 冒充 error
            confidence: 0.5,
            generatedExcerpt: '视角片段',
            description: '视角偏移',
            evidenceIds: [],
            suggestedFix: '统一视角',
          },
        ],
      });
      const issues = parseCheckerLlmJson(raw);
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
    });
  });

  describe('envelope artifact hash binding', () => {
    test('hash 一致时正常返回 envelope', () => {
      const raw = JSON.stringify({
        schemaVersion: 1,
        writerArtifactHash: 'hash_match',
        issues: [
          {
            category: 'plot',
            subtype: 'canon_conflict',
            severity: 'error',
            confidence: 0.9,
            generatedExcerpt: '片段',
            description: '冲突',
            evidenceIds: [1],
            suggestedFix: '修复',
          },
        ],
        warnings: [],
      });
      const envelope = parseCheckerLlmEnvelope(raw);
      expect(envelope.writerArtifactHash).toBe('hash_match');
      expect(envelope.issues).toHaveLength(1);
    });

    test('hash 缺失时仍解析 envelope 字段（Runner 负责判定不可用）', () => {
      // envelope parser 本身只负责解析；hash 校验是 Runner 的职责，
      // 这样 Runner 可以记录明确的 checker_artifact_hash_missing 错误码。
      const raw = JSON.stringify({
        schemaVersion: 1,
        issues: [
          {
            category: 'plot',
            subtype: 'canon_conflict',
            severity: 'error',
            confidence: 0.9,
            generatedExcerpt: '片段',
            description: '冲突',
            evidenceIds: [1],
            suggestedFix: '修复',
          },
        ],
        warnings: [],
      });
      const envelope = parseCheckerLlmEnvelope(raw);
      expect(envelope.writerArtifactHash).toBeNull();
      expect(envelope.issues).toHaveLength(1);
    });

    test('hash 不一致时 envelope 仍解析（Runner 负责丢弃）', () => {
      const raw = JSON.stringify({
        schemaVersion: 1,
        writerArtifactHash: 'different_hash',
        issues: [
          {
            category: 'plot',
            subtype: 'canon_conflict',
            severity: 'error',
            confidence: 0.9,
            generatedExcerpt: '片段',
            description: '冲突',
            evidenceIds: [1],
            suggestedFix: '修复',
          },
        ],
        warnings: [],
      });
      const envelope = parseCheckerLlmEnvelope(raw);
      expect(envelope.writerArtifactHash).toBe('different_hash');
      // issues 已解析，但 Runner 校验时会因 hash !== artifact.contentHash 丢弃
    });

    test('顶层只有 issues 数组（兼容裸数组包装）仍可解析', () => {
      const raw = JSON.stringify([
        {
          category: 'plot',
          subtype: 'canon_conflict',
          severity: 'warning',
          confidence: 0.5,
          generatedExcerpt: '片段',
          description: '提示',
          evidenceIds: [],
          suggestedFix: '修复',
        },
      ]);
      const envelope = parseCheckerLlmEnvelope(raw);
      expect(envelope.writerArtifactHash).toBeNull();
      expect(envelope.issues).toHaveLength(1);
    });

    test('非法 JSON 抛出明确错误', () => {
      expect(() => parseCheckerLlmEnvelope('{not json')).toThrow();
      expect(() => parseCheckerLlmJson('{not json')).toThrow();
    });

    test('缺少 issues 数组抛出明确错误', () => {
      const raw = JSON.stringify({
        schemaVersion: 1,
        writerArtifactHash: 'hash_abc',
        warnings: [],
      });
      expect(() => parseCheckerLlmEnvelope(raw)).toThrow('issues');
    });
  });
});
