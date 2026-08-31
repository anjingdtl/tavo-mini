import { validatePlainTextNovelBody } from '../src/services/writing/contracts/plainTextNovelBody';

describe('final plain-text novel body contract', () => {
  it('accepts ordinary prose and JSON-looking dialogue inside prose', () => {
    expect(
      validatePlainTextNovelBody(
        '他看见纸上写着“{不是协议字段}”，随后把纸折了起来。',
      ).valid,
    ).toBe(true);
  });

  it.each([
    JSON.stringify({ schemaVersion: 1, content: '正文' }),
    JSON.stringify([{ start: 0, end: 1, replacement: '改' }]),
    JSON.stringify('正文'),
  ])('rejects a whole JSON wrapper: %s', value => {
    expect(validatePlainTextNovelBody(value).valid).toBe(false);
    expect(validatePlainTextNovelBody(value).code).toBe('json_wrapper');
  });

  it('rejects fences, protocol fields, model prefaces and duplicate title wrappers', () => {
    expect(validatePlainTextNovelBody('```text\n正文\n```').code).toBe(
      'markdown_fence',
    );
    expect(validatePlainTextNovelBody('schemaVersion: 1\n正文').code).toBe(
      'protocol_leak',
    );
    expect(validatePlainTextNovelBody('以下是正文：\n正文').code).toBe(
      'prompt_leak',
    );
    expect(
      validatePlainTextNovelBody('第1章 雨夜\n第1章 雨夜\n他推门而入。').code,
    ).toBe('duplicate_title_wrapper');
  });

  it('rejects labelled and JSON-like protocol wrappers, but not JSON dialogue', () => {
    expect(
      validatePlainTextNovelBody('结果如下：\n{"content":"正文"}').code,
    ).toBe('json_wrapper');
    expect(validatePlainTextNovelBody("{'content':'正文'}").code).toBe(
      'protocol_leak',
    );
    expect(
      validatePlainTextNovelBody('好的，以下是重写后的完整正文：\n正文。').code,
    ).toBe('prompt_leak');
    expect(
      validatePlainTextNovelBody('他说：“{"dialogue":"别过来。"}”，随后转身。')
        .valid,
    ).toBe(true);
  });
});
