/* eslint-env jest */
/**
 * Red Test： Revision ChangeSet / Final Diff（B2）。
 *
 * ChangeSet 是 Draft → Final 的解释投影，不是第二正文：
 *  - 本地确定性 diff（段落 LCS + 句级细化），不新增 LLM Stage；
 *  - before/after 均为真实正文片段，可展示；
 *  - reason/findingIds 来自 QA findings 的本地关联；
 *  - 无修改时 changes 为空（「AI 未修改正文」）。
 */
import {
  computeRevisionChangeSet,
  buildRevisionChangeSetEmpty,
  type RevisionFindingLike,
} from '../src/services/writing/revisionChangeSet';

const noFindings: RevisionFindingLike[] = [];

describe('computeRevisionChangeSet：确定性 Draft → Final diff', () => {
  it('无修改：changes 为空', () => {
    const body = '第一段。\n第二段。\n第三段。';
    const set = computeRevisionChangeSet(body, body, noFindings);
    expect(set.changes).toHaveLength(0);
    expect(set.draftFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(set.finalFingerprint).toBe(set.draftFingerprint);
  });

  it('单处句子改写：before/after 精准为改动片段（含上下文段落）', () => {
    const draft = '第一章 起始\n少年出门时天未亮。\n江湖很远。';
    const final = '第一章 起始\n少年出门时晨光熹微。\n江湖很远。';
    const set = computeRevisionChangeSet(draft, final, noFindings);

    expect(set.changes).toHaveLength(1);
    const change = set.changes[0];
    expect(change.beforeText).toContain('天未亮');
    expect(change.afterText).toContain('晨光熹微');
    expect(change.beforeText).not.toBe(change.afterText);
    expect(change.changeType).toBe('rewrite');
    expect(change.beforeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(change.afterFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('纯插入：changeType=add', () => {
    const draft = '第一章\n正文。';
    const final = '第一章\n补充设定句。\n正文。';
    const set = computeRevisionChangeSet(draft, final, noFindings);
    expect(set.changes.length).toBeGreaterThanOrEqual(1);
    const change = set.changes.find(c => c.changeType === 'add');
    expect(change).toBeDefined();
    expect(change!.afterText).toContain('补充设定句');
  });

  it('纯删除：changeType=delete', () => {
    const draft = '第一章\n多余的句子。\n正文。';
    const final = '第一章\n正文。';
    const set = computeRevisionChangeSet(draft, final, noFindings);
    expect(set.changes.length).toBeGreaterThanOrEqual(1);
    const change = set.changes.find(c => c.changeType === 'delete');
    expect(change).toBeDefined();
    expect(change!.beforeText).toContain('多余的句子');
  });

  it('多处修改按位置排序，全部可展示', () => {
    const draft = [
      '第一章',
      '开头句甲。',
      '中间句不变。',
      '问题句乙。',
      '结尾句丙。',
    ].join('\n');
    const final = [
      '第一章',
      '开头句甲改了。',
      '中间句不变。',
      '问题句乙修好。',
      '结尾句丙。',
    ].join('\n');
    const set = computeRevisionChangeSet(draft, final, noFindings);
    expect(set.changes).toHaveLength(2);
    // 排序：按 beforeText 在 draft 中的位置
    const positions = set.changes.map(c => draft.indexOf(c.beforeText));
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(set.changes[1].beforeText).toContain('问题句乙');
  });

  it('修改数上限 20，超限截断不崩溃', () => {
    const draftLines: string[] = [];
    const finalLines: string[] = [];
    for (let i = 0; i < 40; i++) {
      draftLines.push(`段落 ${i} 原始文本。`);
      finalLines.push(`段落 ${i} 修改后文本。`);
    }
    const set = computeRevisionChangeSet(
      draftLines.join('\n'),
      finalLines.join('\n'),
      noFindings,
    );
    expect(set.changes.length).toBeLessThanOrEqual(20);
    expect(set.changes.length).toBeGreaterThan(0);
  });

  it('空 draft（重建缺初稿）→ 空 changes', () => {
    const set = computeRevisionChangeSet('', '最终稿只有。', noFindings);
    expect(set.changes).toHaveLength(0);
  });
});

describe('finding 关联：让用户知道为什么改', () => {
  it('issue 提到被改文本时关联 finding 并作为 reason', () => {
    const draft = '第一章\n少年说“明日再来”。\n正文。';
    const final = '第一章\n少年说“明日就出发”。\n正文。';
    const findings: RevisionFindingLike[] = [
      {
        issue: '人物对话与上一章承诺冲突：明日再来应改为明日就出发',
        severity: 'blocking' as const,
      },
      {
        issue: '无关警告：建议增加环境描写',
        severity: 'warning' as const,
      },
    ];
    const set = computeRevisionChangeSet(draft, final, findings);
    expect(set.changes).toHaveLength(1);
    expect(set.changes[0].findingIds).toContain('f0');
    expect(set.changes[0].findingIds).not.toContain('f1');
    expect(set.changes[0].reason).toContain('人物对话与上一章承诺冲突');
  });

  it('target 字段指向被改文本时同样关联', () => {
    const draft = '第一章\n文中的关键设定。\n正文。';
    const final = '第一章\n文中的修正设定。\n正文。';
    const findings: RevisionFindingLike[] = [
      {
        issue: '设定与 Canon 不一致',
        severity: 'blocking' as const,
        target: '文中的关键设定',
      },
    ];
    const set = computeRevisionChangeSet(draft, final, findings);
    expect(set.changes[0].findingIds).toContain('f0');
  });

  it('无关联 finding 时 reason 使用 finding 总数提示（不编造原因）', () => {
    const draft = '第一章\n被修改的内容。\n正文。';
    const final = '第一章\n被改善的内容。\n正文。';
    const findings: RevisionFindingLike[] = [
      {
        issue: '风格建议：朴实一些',
        severity: 'warning' as const,
      },
    ];
    const set = computeRevisionChangeSet(draft, final, findings);
    expect(set.changes).toHaveLength(1);
    expect(set.changes[0].findingIds).toHaveLength(0);
    expect(set.changes[0].reason).toContain('未关联');
  });
});

describe('buildRevisionChangeSetEmpty', () => {
  it('额定的空集合：fingerprint 精确、changes=[]、version=1', () => {
    const body = '正文。';
    const set = buildRevisionChangeSetEmpty(body);
    expect(set.version).toBe(1);
    expect(set.changes).toHaveLength(0);
    expect(set.draftFingerprint).toBe(set.finalFingerprint);
    expect(set.draftFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});