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

  it('accepts natural novel prose: dialogue colons, ellipses, single title, closed brackets', () => {
    const natural = [
      '第2章 雨夜',
      '他推门而入，水迹在地板上拖出一条长线。',
      '“你可算回来了。”她没有抬头，声音混在雨声里。',
      '老板娘隔着柜台喊：打烊了——明天再来吧。',
      '他想起《潮汐图》第2章里也写过这样的雨。',
      'final 时刻，他犹豫了一下，还是把伞递了过去。',
      '屋檐还在滴水，一滴，又一滴……',
      '告示牌上写着：结果如下，恕不更改。他笑了笑，把伞收好。',
      '他抬头看天。【未完待续】',
    ].join('\n');
    const result = validatePlainTextNovelBody(natural);
    expect(result).toEqual({ valid: true, code: 'ok' });
  });

  it('does not kill patch-note vocabulary embedded in natural sentences', () => {
    expect(
      validatePlainTextNovelBody(
        '他反复交代，其余内容不变，只把最后一句压低，然后合上了那叠修改说明的草稿。',
      ).valid,
    ).toBe(true);
    expect(
      validatePlainTextNovelBody(
        '审稿人批注：以下为修改部分的红线，他都描了一遍，其余内容保持原样。',
      ).valid,
    ).toBe(true);
  });

  it('still rejects structural patch notes and diff syntax', () => {
    expect(
      validatePlainTextNovelBody('正文开头。\n修改说明：把结尾改得克制一些。')
        .code,
    ).toBe('patch_leak');
    expect(
      validatePlainTextNovelBody('正文。\n其余内容不变').code,
    ).toBe('patch_leak');
    expect(
      validatePlainTextNovelBody('正文。\n以下为修改部分：\n替换的句子。').code,
    ).toBe('patch_leak');
    expect(
      validatePlainTextNovelBody('{"patches":[{"start":0,"end":1}]}').code,
    ).toBe('json_wrapper');
    expect(validatePlainTextNovelBody('@@ -1,2 +1,2 @@\n正文').code).toBe(
      'patch_leak',
    );
  });

  it('duplicate title stays a wrapper only in the structural head position', () => {
    // Repeated title beyond the opening head lines is narrative echo, not a
    // wrapper — the validator must not hard-fail it.
    const echoed =
      '第1章 雨夜\n他推门而入。\n雨下了一整夜。\n天亮时他才睡去。\n梦里又是第1章 雨夜的那个门口。';
    expect(validatePlainTextNovelBody(echoed).valid).toBe(true);
  });
});
