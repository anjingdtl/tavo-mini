import {
  buildContinuationControlFallback,
  buildContinuationControlMetrics,
  parseContinuationControlReport,
  resolveContinuationControlReport,
  requiredControlProgressHan,
  CONTROL_PROGRESS_RATIO,
  CONTROL_PROGRESS_FLOOR_HAN,
} from '../src/services/continuation/generation/continuationControl';

describe('Continuation V4 local Control', () => {
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

  test('fallback 的 action 和增减建议只来自本地指标', () => {
    const under = buildContinuationControlMetrics({ text: '', target: 3000 });
    const underReport = buildContinuationControlFallback(under);
    expect(underReport.action).toBe('expand');
    expect(underReport.currentHan).toBe(under.actualHanCharacters);
    expect(underReport.suggestions[0].expectedDeltaHan).toBe(
      under.missingToMinimum,
    );

    const within = buildContinuationControlMetrics({ text: '你好世界', target: 4 });
    expect(buildContinuationControlFallback(within).action).toBe('keep');

    const over = buildContinuationControlMetrics({ text: '中'.repeat(1000), target: 1 });
    expect(buildContinuationControlFallback(over).action).toBe('compress');
    expect(over.excessOverMaximum).toBeGreaterThan(0);
  });

  test('模型 currentHan 回显不一致时保留本地真值并记录 mismatch', () => {
    const metrics = buildContinuationControlMetrics({ text: '你好世界', target: 4 });
    const parsed = parseContinuationControlReport({
      metrics,
      raw: JSON.stringify({
        schemaVersion: 1,
        action: 'keep',
        currentHan: 999,
        targetHan: 999,
        allowedMinHan: 1,
        allowedMaxHan: 9999,
        suggestions: [],
        preserve: ['章末钩子'],
      }),
    });
    expect(parsed.errorCode).toBeNull();
    expect(parsed.metricEchoMismatch).toBe(true);
    expect(parsed.report?.currentHan).toBe(metrics.actualHanCharacters);
    expect(parsed.report?.targetHan).toBe(metrics.targetHanCharacters);
    expect(parsed.report?.allowedMinHan).toBe(metrics.minHanCharacters);
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

describe('Continuation V4 Control local suggestion injection', () => {
  test('expand + suggestions=[] 时自动保留 ctrl_local_expand', () => {
    const metrics = buildContinuationControlMetrics({ text: '短正文', target: 3000 });
    expect(metrics.missingToMinimum).toBeGreaterThan(0);
    const resolved = resolveContinuationControlReport({
      metrics,
      raw: JSON.stringify({
        schemaVersion: 1,
        action: 'expand',
        currentHan: metrics.actualHanCharacters,
        targetHan: metrics.targetHanCharacters,
        allowedMinHan: metrics.minHanCharacters,
        allowedMaxHan: metrics.maxHanCharacters,
        suggestions: [],
        preserve: [],
      }),
    });
    expect(resolved.report.action).toBe('expand');
    expect(resolved.report.suggestions.map(s => s.suggestionId)).toContain(
      'ctrl_local_expand',
    );
    expect(resolved.localSuggestionInjected).toBe(true);
  });

  test('compress + suggestions=[] 时自动保留 ctrl_local_compress', () => {
    const metrics = buildContinuationControlMetrics({
      text: '中'.repeat(4000),
      target: 1,
    });
    expect(metrics.excessOverMaximum).toBeGreaterThan(0);
    const resolved = resolveContinuationControlReport({
      metrics,
      raw: JSON.stringify({
        schemaVersion: 1,
        action: 'compress',
        currentHan: metrics.actualHanCharacters,
        targetHan: metrics.targetHanCharacters,
        allowedMinHan: metrics.minHanCharacters,
        allowedMaxHan: metrics.maxHanCharacters,
        suggestions: [],
        preserve: [],
      }),
    });
    expect(resolved.report.action).toBe('compress');
    expect(resolved.report.suggestions.map(s => s.suggestionId)).toContain(
      'ctrl_local_compress',
    );
  });

  test('模型 action=keep 但本地应 expand 时，本地 action 胜出', () => {
    const metrics = buildContinuationControlMetrics({ text: '短', target: 3000 });
    const resolved = resolveContinuationControlReport({
      metrics,
      raw: JSON.stringify({
        schemaVersion: 1,
        action: 'keep',
        currentHan: metrics.actualHanCharacters,
        targetHan: metrics.targetHanCharacters,
        allowedMinHan: metrics.minHanCharacters,
        allowedMaxHan: metrics.maxHanCharacters,
        suggestions: [],
        preserve: [],
      }),
    });
    expect(resolved.report.action).toBe('expand');
    expect(resolved.actionEchoMismatch).toBe(true);
    expect(resolved.report.suggestions.map(s => s.suggestionId)).toContain(
      'ctrl_local_expand',
    );
  });

  test('模型数字回显不一致时，本地数字胜出', () => {
    const metrics = buildContinuationControlMetrics({ text: '你好世界', target: 4 });
    const resolved = resolveContinuationControlReport({
      metrics,
      raw: JSON.stringify({
        schemaVersion: 1,
        action: 'keep',
        currentHan: 999,
        targetHan: 999,
        allowedMinHan: 1,
        allowedMaxHan: 9999,
        suggestions: [],
        preserve: [],
      }),
    });
    expect(resolved.report.currentHan).toBe(metrics.actualHanCharacters);
    expect(resolved.report.targetHan).toBe(metrics.targetHanCharacters);
    expect(resolved.report.allowedMinHan).toBe(metrics.minHanCharacters);
    expect(resolved.report.allowedMaxHan).toBe(metrics.maxHanCharacters);
    expect(resolved.metricEchoMismatch).toBe(true);
  });

  test('expectedDeltaHan 符号错误的模型 suggestion 被丢弃', () => {
    const metrics = buildContinuationControlMetrics({ text: '短', target: 3000 });
    const resolved = resolveContinuationControlReport({
      metrics,
      raw: JSON.stringify({
        schemaVersion: 1,
        action: 'expand',
        currentHan: metrics.actualHanCharacters,
        targetHan: metrics.targetHanCharacters,
        allowedMinHan: metrics.minHanCharacters,
        allowedMaxHan: metrics.maxHanCharacters,
        suggestions: [
          {
            suggestionId: 'ctrl_bad_sign',
            type: 'expand_scene',
            location: 'paragraph_1_after',
            expectedDeltaHan: -50, // expand 要求正号
            instruction: '反向建议',
            preserveBeatIds: [],
          },
        ],
        preserve: [],
      }),
    });
    expect(resolved.report.suggestions.map(s => s.suggestionId)).not.toContain(
      'ctrl_bad_sign',
    );
    expect(resolved.droppedSuggestionCount).toBeGreaterThan(0);
    // 本地强制建议仍然保留
    expect(resolved.report.suggestions.map(s => s.suggestionId)).toContain(
      'ctrl_local_expand',
    );
  });

  test('合法模型 suggestion 与本地 suggestion 合并去重', () => {
    const metrics = buildContinuationControlMetrics({ text: '短', target: 3000 });
    const resolved = resolveContinuationControlReport({
      metrics,
      raw: JSON.stringify({
        schemaVersion: 1,
        action: 'expand',
        currentHan: metrics.actualHanCharacters,
        targetHan: metrics.targetHanCharacters,
        allowedMinHan: metrics.minHanCharacters,
        allowedMaxHan: metrics.maxHanCharacters,
        suggestions: [
          {
            suggestionId: 'ctrl_model_extra',
            type: 'expand_scene',
            location: 'paragraph_2_after',
            expectedDeltaHan: 100,
            instruction: '补充对话',
            preserveBeatIds: [],
          },
        ],
        preserve: [],
      }),
    });
    const ids = resolved.report.suggestions.map(s => s.suggestionId);
    expect(ids).toContain('ctrl_local_expand');
    expect(ids).toContain('ctrl_model_extra');
    // 不重复
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('requiredControlProgressHan 满足 floor 与 ratio', () => {
    expect(CONTROL_PROGRESS_RATIO).toBe(0.35);
    expect(CONTROL_PROGRESS_FLOOR_HAN).toBe(80);
    // delta=0 -> 0
    expect(requiredControlProgressHan(0)).toBe(0);
    // delta 小于 floor 时取 floor
    expect(requiredControlProgressHan(100)).toBe(80);
    // delta 较大时取 ceil(delta*0.35)
    expect(requiredControlProgressHan(300)).toBe(Math.ceil(300 * 0.35));
    // 不超过 delta 本身
    expect(requiredControlProgressHan(50)).toBe(50);
  });
});
