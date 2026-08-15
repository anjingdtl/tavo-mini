import { sha256Hex } from '../../continuation/hashUtils';
import type { WritingSource, WritingSourceBundle, WritingScenario } from '../contracts/writingSource';

function fixtureSource(
  candidateId: string,
  kind: WritingSource['kind'],
  content: string,
  requirement: WritingSource['requirement'],
  revision = 'fixture-v1',
): WritingSource {
  return {
    candidateId,
    kind,
    sourceId: candidateId,
    revision,
    content,
    contentHash: sha256Hex(content),
    requirement,
    activation: requirement === 'mandatory' ? 'system' : 'automatic',
  };
}

function outlineFixture(options: {
  storyMemory?: boolean;
  note?: boolean;
  large?: boolean;
} = {}): WritingSourceBundle {
  const outline = options.large ? '主线节点：' + '推进剧情。'.repeat(1200) : '第一幕：主角发现线索并决定追查。';
  return {
    mandatory: [
      fixtureSource('instruction:current', 'instruction', '继续完成当前章节，保持悬念。', 'mandatory'),
      fixtureSource('chapter:1', 'chapter', '第1章\n主角发现线索。', 'mandatory'),
      fixtureSource('outline:1', 'outline', outline, 'mandatory'),
      fixtureSource('preset:1', 'preset', '保持中文小说叙事。', 'mandatory'),
    ],
    preferred: options.storyMemory
      ? [fixtureSource('story-memory:1', 'story_memory', '主角已经知道线索存在。', 'preferred')]
      : [],
    optional: options.note
      ? [fixtureSource('note:1', 'note', '不要提前揭示幕后身份。', 'optional')]
      : [],
  };
}

function continuationFixture(options: {
  canon?: boolean;
  seam?: boolean;
  storyMemory?: boolean;
  large?: boolean;
} = {}): WritingSourceBundle {
  const canon = options.large ? '世界规则：' + '边界事实。'.repeat(1200) : '世界规则：魔法必须付出代价。';
  return {
    mandatory: [
      fixtureSource('instruction:current', 'instruction', '从边界处自然续写下一章。', 'mandatory'),
      fixtureSource('canon:1', 'canon', options.canon === false ? '' : canon, 'mandatory'),
      fixtureSource('source-boundary:1', 'source_boundary', '原著源资料边界：第10章末。', 'mandatory'),
      fixtureSource('seam:10', 'seam', options.seam === false ? '' : '他握紧钥匙，门后传来脚步声。', 'mandatory'),
      fixtureSource('writer-style:1', 'writer_style', '克制、具体、少用总结。', 'mandatory'),
    ],
    preferred: options.storyMemory
      ? [fixtureSource('story-memory:1', 'story_memory', '上一阶段的状态已经冻结。', 'preferred')]
      : [],
    optional: [],
  };
}

export interface WritingGoldenFixture {
  id: string;
  scenario: WritingScenario;
  bundle: WritingSourceBundle;
}

export const WRITING_GOLDEN_FIXTURES: WritingGoldenFixture[] = [
  { id: 'OUTLINE_BASIC', scenario: 'outline', bundle: outlineFixture() },
  { id: 'OUTLINE_WITH_STORY_MEMORY', scenario: 'outline', bundle: outlineFixture({ storyMemory: true }) },
  { id: 'OUTLINE_WITH_NOTE_NONE', scenario: 'outline', bundle: outlineFixture({ note: false }) },
  { id: 'OUTLINE_1M_CONTEXT', scenario: 'outline', bundle: outlineFixture({ large: true }) },
  { id: 'CONTINUATION_BASIC', scenario: 'continuation', bundle: continuationFixture() },
  { id: 'CONTINUATION_WITH_CANON', scenario: 'continuation', bundle: continuationFixture({ canon: true }) },
  { id: 'CONTINUATION_WITH_SEAM', scenario: 'continuation', bundle: continuationFixture({ seam: true }) },
  { id: 'CONTINUATION_WITH_STORY_MEMORY', scenario: 'continuation', bundle: continuationFixture({ storyMemory: true }) },
  { id: 'CONTINUATION_1M_CONTEXT', scenario: 'continuation', bundle: continuationFixture({ large: true }) },
];
