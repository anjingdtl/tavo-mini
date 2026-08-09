import type {
  FinalWritingBriefV1,
  FinalWritingBriefV31,
  FinalWritingBriefV32,
} from './briefCompilerTypes';

/** Render only human-readable writing instructions; machine IDs never enter Final. */
export function renderFinalWritingBrief(
  brief: FinalWritingBriefV1 | FinalWritingBriefV31 | FinalWritingBriefV32,
): string {
  const sections: string[] = [];
  if (brief.mustFix.length) {
    sections.push(
      `【必须修改】\n${brief.mustFix
        .map((item, index) => {
          const location =
            'target' in item
              ? `${item.target.kind}${item.target.hint ? `（${item.target.hint}）` : ''}`
              : item.location;
          return `${index + 1}. 位置：${location}\n   ${item.instruction}${item.preserve.length ? `\n   保持：${item.preserve.join('；')}` : ''}`;
        })
        .join('\n')}`,
    );
  }
  if (brief.mustPreserve.length) {
    sections.push(`【必须保持】\n${brief.mustPreserve.map(item => `- ${item}`).join('\n')}`);
  }
  if ('protectedFacts' in brief && brief.protectedFacts.length) {
    sections.push(`【保护事实】\n${brief.protectedFacts.map(item => `- ${item}`).join('\n')}`);
  }
  if ('hardConstraints' in brief && brief.hardConstraints.length) {
    sections.push(`【硬约束】\n${brief.hardConstraints.map(item => `- ${item}`).join('\n')}`);
  }
  if (brief.mustNotAdvance.length) {
    sections.push(`【不得提前推进】\n${brief.mustNotAdvance.map(item => `- ${item}`).join('\n')}`);
  }
  if (brief.openingContinuity.length) {
    sections.push(`【开头衔接】\n${brief.openingContinuity.map(item => `- ${item}`).join('\n')}`);
  }
  if (brief.endingState) sections.push(`【结尾状态】\n${brief.endingState}`);
  const advisories = 'styleAdvisories' in brief ? brief.styleAdvisories : brief.advisoryNotes;
  if (advisories.length) {
    sections.push(`【参考提醒】\n${advisories.map(item => `- ${item}`).join('\n')}`);
  }
  return sections.join('\n\n') || '【终稿要求】\n保持事实、剧情方向、衔接和文风稳定，完整输出本章正文。';
}
