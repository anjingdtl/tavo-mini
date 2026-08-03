import {
  buildContinuationControlFallback,
  buildContinuationControlMetrics,
  parseContinuationControlReport,
  resolveContinuationControlReport,
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
