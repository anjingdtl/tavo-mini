import {
  buildContinuationControlFallback,
  buildContinuationControlMetrics,
  parseContinuationControlReport,
  resolveContinuationControlReport,
  bindStyleIssueToArtifact,
  getRepairReadyStyleFindings,
  requiredControlProgressHan,
  isStyleIssueRepairReady,
  STYLE_REPAIR_CONFIDENCE_MIN,
  CONTROL_PROGRESS_RATIO,
  CONTROL_PROGRESS_FLOOR_HAN,
} from '../src/services/continuation/generation/continuationControl';

describe('Continuation V4 local Control metrics', () => {
  test('本地计算汉字、UTF-16 段落范围、对话比例和插入边界', () => {
    const metrics = buildContinuationControlMetrics({
      text: '第一段😀。\n“第二段对白”。\n第三段。',
      target: 10,
    });
    expect(metrics.actualHanCharacters).toBe(11);
    expect(metrics.paragraphs).toHaveLength(3);
    expect(metrics.paragraphs[1].start).toBe('第一段😀。\n'.length);
    expect(metrics.paragraphs[1].end).toBeGreaterThan(metrics.paragraphs[1].start);
    expect(metrics.dialogueHanRatio).toBeGreaterThan(0);
    expect(metrics.insertionBoundaries).toContain(metrics.paragraphs[2].end);
  });

  test('重复段落返回每个精确 occurrence，不把中间正文合并进范围', () => {
    const repeated = '这是一个需要精确定位的重复段落内容。';
    const text = `${repeated}\n中间推进段落。\n${repeated}`;
    const metrics = buildContinuationControlMetrics({ text, target: 30 });
    expect(metrics.duplicateWindows).toHaveLength(1);
    const duplicate = metrics.duplicateWindows[0];
    expect(duplicate.occurrences).toHaveLength(2);
    expect(duplicate.occurrences[0].paragraphId).toBe('p_1');
    expect(duplicate.occurrences[1].paragraphId).toBe('p_3');
    expect(text.slice(duplicate.occurrences[0].start, duplicate.occurrences[0].end)).toBe(repeated);
    expect(text.slice(duplicate.occurrences[1].start, duplicate.occurrences[1].end)).toBe(repeated);
    expect(duplicate.end - duplicate.start).toBe(repeated.length);
  });

  test('fallback 保留篇幅诊断但不注入 expand/compress 强制任务', () => {
    const under = buildContinuationControlMetrics({ text: '', target: 3000 });
    const underReport = buildContinuationControlFallback(under);
    expect(underReport.action).toBe('expand');
    expect(underReport.currentHan).toBe(under.actualHanCharacters);
    expect(underReport.suggestions).toEqual([]);
    expect(underReport.findings).toEqual([]);
    expect(underReport.styleIssues).toEqual([]);

    const within = buildContinuationControlMetrics({ text: '你好世界', target: 4 });
    expect(buildContinuationControlFallback(within).action).toBe('keep');

    const over = buildContinuationControlMetrics({ text: '中'.repeat(1000), target: 1 });
    expect(buildContinuationControlFallback(over).action).toBe('compress');
    expect(buildContinuationControlFallback(over).suggestions).toEqual([]);
  });

  test('模型 currentHan 回显不一致时保留本地真值', () => {
    const metrics = buildContinuationControlMetrics({ text: '你好世界', target: 4 });
    const parsed = parseContinuationControlReport({
      metrics,
      raw: JSON.stringify({
        schemaVersion: 2,
        action: 'keep',
        currentHan: 999,
        issues: [],
        warnings: [],
      }),
    });
    expect(parsed.errorCode).toBeNull();
    expect(parsed.metricEchoMismatch).toBe(true);
    expect(parsed.report?.currentHan).toBe(metrics.actualHanCharacters);
  });

  test('V4 Control 使用独立比例篇幅参考带', () => {
    const metrics = buildContinuationControlMetrics({ text: '甲'.repeat(1000), target: 3000 });
    expect(metrics.minHanCharacters).toBe(2100);
    expect(metrics.maxHanCharacters).toBe(3900);
  });

  test('无效 JSON 或缺失 Control LLM 时返回本地 fallback', () => {
    const metrics = buildContinuationControlMetrics({ text: '你好', target: 3000 });
    expect(
      resolveContinuationControlReport({ metrics, raw: '{bad' }).errorCode,
    ).toBe('control_invalid_json');
    expect(resolveContinuationControlReport({ metrics }).report.currentHan).toBe(
      metrics.actualHanCharacters,
    );
  });
});

describe('Continuation V4 Control style review contract', () => {
  const artifactText =
    '他感到非常悲伤，因为他终于意识到自己已经失去了一切。\n门外风声未停。\n她没有回头。';

  test('精准局部文风 issue 可 repairReady 并进入 findings', () => {
    const metrics = buildContinuationControlMetrics({
      text: artifactText,
      target: 40,
    });
    const resolved = resolveContinuationControlReport({
      metrics,
      artifactText,
      raw: JSON.stringify({
        schemaVersion: 2,
        writerArtifactHash: 'w1',
        issues: [
          {
            findingId: 'style_1',
            styleDimension: 'emotional_expression',
            severity: 'error',
            confidence: 0.91,
            generatedStart: 0,
            generatedEnd: 26,
            generatedExcerpt: '他感到非常悲伤，因为他终于意识到自己已经失去了一切。',
            description: '原著通常通过动作表现情绪，此处连续解释心理。',
            styleEvidenceIds: ['style_sample_7'],
            rewriteGoal: '保留悲伤事实，用动作或短句表现，删除解释性心理。',
            preserveMeaning: ['人物意识到损失', '情绪为悲伤'],
          },
        ],
        warnings: [],
      }),
    });
    expect(resolved.errorCode).toBeNull();
    expect(resolved.report.suggestions).toEqual([]);
    expect(resolved.report.styleIssues?.length).toBe(1);
    expect(resolved.report.styleIssues?.[0].repairReady).toBe(true);
    expect(resolved.report.findings[0].findingId).toBe('style_1');
    expect(resolved.report.findings[0].repairReady).toBe(true);
    expect(resolved.report.findings[0].confidence).toBe(0.91);
    expect(resolved.report.findings[0].styleEvidenceIds).toEqual(['style_sample_7']);
    expect(resolved.report.findings[0].preserveMeaning).toEqual([
      '人物意识到损失',
      '情绪为悲伤',
    ]);
    expect(resolved.report.findings[0].bindingStatus).toBe('bound_by_range');
    expect(getRepairReadyStyleFindings(resolved.report)).toHaveLength(1);
  });

  test('range/excerpt binding rejects mismatches and duplicate excerpts', () => {
    const matched = bindStyleIssueToArtifact(
      {
        findingId: 'matched',
        styleDimension: 'padding',
        severity: 'error',
        confidence: 0.9,
        generatedStart: 0,
        generatedEnd: 4,
        generatedExcerpt: '甲乙丙丁',
        description: '局部问题',
        styleEvidenceIds: ['e1'],
        rewriteGoal: '删去注水',
        preserveMeaning: ['事件'],
        repairReady: false,
      },
      '甲乙丙丁。',
    );
    expect(matched.bindingStatus).toBe('bound_by_range');
    expect(matched.repairReady).toBe(true);

    const mismatch = bindStyleIssueToArtifact(
      {
        findingId: 'mismatch',
        styleDimension: 'padding',
        severity: 'error',
        confidence: 0.9,
        generatedStart: 0,
        generatedEnd: 4,
        generatedExcerpt: '不存在的原句',
        description: '局部问题',
        styleEvidenceIds: ['e1'],
        rewriteGoal: '删去注水',
        preserveMeaning: ['事件'],
        repairReady: true,
      },
      '甲乙丙丁。',
    );
    expect(mismatch.bindingStatus).toBe('range_excerpt_mismatch');
    expect(mismatch.repairReady).toBe(false);

    const mismatchWithUniqueExcerptElsewhere = bindStyleIssueToArtifact(
      {
        findingId: 'mismatch-unique-elsewhere',
        styleDimension: 'padding',
        severity: 'error',
        confidence: 0.9,
        generatedStart: 0,
        generatedEnd: 4,
        generatedExcerpt: '己存在于别处',
        description: '局部问题',
        styleEvidenceIds: ['e1'],
        rewriteGoal: '删去注水',
        preserveMeaning: ['事件'],
        repairReady: true,
      },
      '甲乙丙丁。己存在于别处',
    );
    expect(mismatchWithUniqueExcerptElsewhere.bindingStatus).toBe(
      'range_excerpt_mismatch',
    );
    expect(mismatchWithUniqueExcerptElsewhere.repairReady).toBe(false);

    const uniqueExcerptFallback = bindStyleIssueToArtifact(
      {
        findingId: 'unique-excerpt-fallback',
        styleDimension: 'padding',
        severity: 'error',
        confidence: 0.9,
        generatedStart: 99,
        generatedEnd: 100,
        generatedExcerpt: '甲乙丙丁',
        description: '局部问题',
        styleEvidenceIds: ['e1'],
        rewriteGoal: '删去注水',
        preserveMeaning: ['事件'],
        repairReady: true,
      },
      '甲乙丙丁。',
    );
    expect(uniqueExcerptFallback.bindingStatus).toBe(
      'bound_by_unique_excerpt',
    );
    expect(uniqueExcerptFallback.repairReady).toBe(true);

    const duplicate = bindStyleIssueToArtifact(
      {
        findingId: 'duplicate',
        styleDimension: 'padding',
        severity: 'error',
        confidence: 0.9,
        generatedStart: null,
        generatedEnd: null,
        generatedExcerpt: '重复原句',
        description: '局部问题',
        styleEvidenceIds: ['e1'],
        rewriteGoal: '删去注水',
        preserveMeaning: ['事件'],
        repairReady: true,
      },
      '重复原句。\n重复原句。',
    );
    expect(duplicate.bindingStatus).toBe('excerpt_not_unique');
    expect(duplicate.repairReady).toBe(false);
  });

  test('Control 报告绑定 writer artifact/style profile/renderer，缺失或不一致时降级', () => {
    const metrics = buildContinuationControlMetrics({ text: '甲乙丙丁', target: 4 });
    const raw = JSON.stringify({
      schemaVersion: 2,
      writerArtifactHash: 'wrong-writer',
      styleProfileHash: 'wrong-style',
      styleRendererVersion: 'renderer-old',
      issues: [],
      warnings: [],
    });
    const resolved = resolveContinuationControlReport({
      metrics,
      artifactText: '甲乙丙丁',
      raw,
      writerArtifactHash: 'writer-hash',
      styleProfileHash: 'style-hash',
      styleRendererVersion: 'renderer-new',
    });
    expect(resolved.errorCode).toBe('control_artifact_hash_mismatch');
    expect(resolved.bindingErrorCodes).toEqual([
      'control_artifact_hash_mismatch',
      'control_style_profile_hash_mismatch',
      'control_style_renderer_version_mismatch',
    ]);
    expect(resolved.report.findings).toEqual([]);
    expect(resolved.report.styleIssues).toEqual([]);
    expect(resolved.report.echoedWriterArtifactHash).toBe('wrong-writer');
    expect(resolved.report.styleProfileHash).toBe('style-hash');
  });

  test('旧 findings 没有真实可信字段时只进入 audit 并记录降级计数', () => {
    const metrics = buildContinuationControlMetrics({ text: '甲乙丙丁', target: 4 });
    const resolved = parseContinuationControlReport({
      metrics,
      artifactText: '甲乙丙丁',
      raw: JSON.stringify({
        schemaVersion: 1,
        findings: [
          {
            findingId: 'legacy-1',
            subtype: 'padding',
            severity: 'error',
            generatedStart: 0,
            generatedEnd: 4,
            description: '旧格式风格观察',
            suggestedFix: '局部改写',
          },
        ],
      }),
    });
    expect(resolved.legacyFindingDowngradeCount).toBe(1);
    expect(resolved.report?.telemetryEvents).toContain(
      'control_legacy_finding_downgraded',
    );
    expect(resolved.report?.findings).toEqual([]);
    expect(resolved.report?.styleWarnings?.[0]).toEqual(
      expect.objectContaining({
        findingId: 'legacy-1',
        severity: 'warning',
        confidence: 0,
        styleEvidenceIds: [],
        preserveMeaning: [],
        repairReady: false,
      }),
    );
  });

  test('抽象整体风格 warning 不触发 repairReady', () => {
    const metrics = buildContinuationControlMetrics({
      text: artifactText,
      target: 40,
    });
    const resolved = resolveContinuationControlReport({
      metrics,
      artifactText,
      raw: JSON.stringify({
        schemaVersion: 2,
        issues: [
          {
            findingId: 'style_abstract',
            styleDimension: 'sentence_rhythm',
            severity: 'error',
            confidence: 0.95,
            generatedStart: null,
            generatedEnd: null,
            generatedExcerpt: '',
            description: '整体节奏略显平淡',
            styleEvidenceIds: ['s1'],
            rewriteGoal: '提升节奏',
            preserveMeaning: ['保留剧情'],
          },
        ],
        warnings: [],
      }),
    });
    expect(resolved.report.styleIssues ?? []).toEqual([]);
    expect(
      (resolved.report.styleWarnings ?? []).some(
        w => w.findingId === 'style_abstract',
      ),
    ).toBe(true);
    expect(resolved.report.findings).toEqual([]);
  });

  test('legacy expand/compress suggestions 被丢弃且不进入 Repair', () => {
    const metrics = buildContinuationControlMetrics({ text: '短', target: 3000 });
    const resolved = resolveContinuationControlReport({
      metrics,
      artifactText: '短',
      raw: JSON.stringify({
        schemaVersion: 1,
        action: 'expand',
        currentHan: metrics.actualHanCharacters,
        suggestions: [
          {
            suggestionId: 'ctrl_local_expand',
            type: 'expand_scene',
            location: 'paragraph_1_after',
            expectedDeltaHan: 500,
            instruction: '扩写',
            preserveBeatIds: [],
          },
        ],
        findings: [],
        preserve: [],
      }),
    });
    expect(resolved.report.action).toBe('expand');
    expect(resolved.report.suggestions).toEqual([]);
    expect(resolved.droppedSuggestionCount).toBeGreaterThan(0);
    expect(resolved.localSuggestionInjected).toBe(false);
  });

  test('isStyleIssueRepairReady 要求置信度阈值与证据', () => {
    expect(STYLE_REPAIR_CONFIDENCE_MIN).toBe(0.75);
    expect(
      isStyleIssueRepairReady({
        severity: 'error',
        confidence: 0.5,
        generatedStart: 0,
        generatedEnd: 10,
        generatedExcerpt: '模板句式测试',
        styleEvidenceIds: ['e1'],
        rewriteGoal: '改写',
        preserveMeaning: ['事实'],
        description: '问题',
      }),
    ).toBe(false);
    expect(
      isStyleIssueRepairReady({
        severity: 'error',
        confidence: 0.9,
        generatedStart: 0,
        generatedEnd: 10,
        generatedExcerpt: '模板句式测试',
        styleEvidenceIds: ['e1'],
        rewriteGoal: '改写为克制表达',
        preserveMeaning: ['事实'],
        description: '局部模板化',
        bindingStatus: 'bound_by_range',
      }),
    ).toBe(true);
  });

  test('requiredControlProgressHan 已停用，恒为 0', () => {
    expect(CONTROL_PROGRESS_RATIO).toBe(0);
    expect(CONTROL_PROGRESS_FLOOR_HAN).toBe(0);
    expect(requiredControlProgressHan(0)).toBe(0);
    expect(requiredControlProgressHan(100)).toBe(0);
    expect(requiredControlProgressHan(300)).toBe(0);
  });
});
