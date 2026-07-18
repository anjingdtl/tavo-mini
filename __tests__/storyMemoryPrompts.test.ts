import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  buildStoryMemoryPatchMessages,
  buildStoryMemoryRepairMessages,
  STORY_MEMORY_SYSTEM_PROMPT,
} from '../src/services/storyMemory/storyMemoryPrompts';

const chapter = {
  id: 3,
  project_id: 7,
  position: 2,
  title: '雨夜钟楼',
  synopsis: '发现暗门',
  content: '林岚推开钟楼暗门。',
  status: 'final' as const,
  summary_json: null,
  created_at: '',
  updated_at: '',
};

describe('story memory prompts', () => {
  it('forbids cumulative summaries and requires evidence and system IDs', () => {
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('不得输出完整故事摘要');
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('evidenceQuote');
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('精确 ID');
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('不要输出 Markdown');
  });

  it('includes current state, full chapter content, and strict schema', () => {
    const messages = buildStoryMemoryPatchMessages(
      chapter,
      createEmptyStoryMemory(7),
    );
    expect(messages[1].content).toContain('林岚推开钟楼暗门');
    expect(messages[1].content).toContain('newCharacters');
    expect(messages[1].content).toContain('throughChapterPosition');
  });

  it('asks repair to preserve facts and fix only validation errors', () => {
    const initial = buildStoryMemoryPatchMessages(
      chapter,
      createEmptyStoryMemory(7),
    );
    const repaired = buildStoryMemoryRepairMessages(
      initial,
      '{bad',
      'JSON 无效',
    );
    expect(repaired.at(-1)?.content).toContain('不要重新创作或增加事实');
    expect(repaired.at(-1)?.content).toContain('JSON 无效');
  });
});
