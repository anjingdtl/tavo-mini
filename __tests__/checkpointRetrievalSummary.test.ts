/**
 * Checkpoint main path: dense chapterSummaries → memory_summary text.
 * Simulates smart-checkpoint JSON output after V2.5.9 prompt strengthening.
 */

import { renderEpisodicMemoryText } from '../src/services/storyMemory/storyMemoryService';
import {
  STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT,
  buildStoryMemoryCheckpointMessages,
} from '../src/services/storyMemory/storyMemoryPrompts';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';

const chapters = [
  {
    id: 1,
    project_id: 1,
    position: 0,
    title: '钥匙转交',
    synopsis: '',
    content:
      '林岚把银钥匙交给周恪，叮嘱他妥善保管，不得示人。周恪点头收下。',
    status: 'final' as const,
    summary_json: null,
    created_at: '',
    updated_at: '',
  },
  {
    id: 2,
    project_id: 1,
    position: 1,
    title: '保密承诺',
    synopsis: '',
    content:
      '周恪答应林岚不告诉白薇银钥匙的来源。林岚强调这是承诺。',
    status: 'final' as const,
    summary_json: null,
    created_at: '',
    updated_at: '',
  },
  {
    id: 3,
    project_id: 1,
    position: 2,
    title: '钥匙易手',
    synopsis: '',
    content:
      '周恪把银钥匙交给白薇，声称只是临时保管，未提与林岚的约定。',
    status: 'final' as const,
    summary_json: null,
    created_at: '',
    updated_at: '',
  },
];

/** Simulated Checkpoint LLM chapterSummaries following the strengthened contract. */
const simulatedChapterSummaries = [
  {
    chapterId: 1,
    chapterPosition: 0,
    brief: '林岚把银钥匙交给周恪，要求妥善保管',
    keywords: ['银钥匙', '林岚', '周恪'],
    events: ['林岚对周恪转交银钥匙，周恪收下'],
    characterChanges: ['周恪获得银钥匙'],
    relationshipChanges: ['林岚对周恪建立保管托付'],
    mainlineChanges: [],
    newThreads: ['银钥匙由谁持有'],
    resolvedThreads: [],
  },
  {
    chapterId: 2,
    chapterPosition: 1,
    brief: '周恪答应林岚不告诉白薇银钥匙来源',
    keywords: ['保密承诺'],
    events: ['周恪对林岚作出保密承诺，不得告知白薇'],
    characterChanges: ['周恪知晓并接受保密义务'],
    relationshipChanges: ['周恪与林岚因保密承诺加深信任'],
    mainlineChanges: [],
    newThreads: ['周恪对林岚的保密承诺尚未兑现或违约'],
    resolvedThreads: [],
  },
  {
    chapterId: 3,
    chapterPosition: 2,
    brief: '周恪把银钥匙交给白薇且未提保密约定',
    keywords: ['银钥匙', '白薇'],
    events: ['周恪对白薇转交银钥匙，未说明林岚约定'],
    characterChanges: ['白薇获得银钥匙', '周恪失去银钥匙持有'],
    relationshipChanges: ['周恪对林岚的保密承诺面临违约风险'],
    mainlineChanges: [],
    newThreads: ['白薇持有银钥匙与保密承诺的冲突'],
    resolvedThreads: [],
  },
];

describe('checkpoint retrieval summary main path', () => {
  it('uses strengthened checkpoint prompts for the three-chapter key arc', () => {
    expect(STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT).toContain(
      '逐章检索摘要要求',
    );
    const messages = buildStoryMemoryCheckpointMessages(
      chapters as any,
      createEmptyStoryMemory(1),
    );
    const blob = messages.map(m => m.content).join('\n');
    expect(blob).toContain('林岚把银钥匙交给周恪');
    expect(blob).toContain('周恪答应林岚不告诉白薇');
    expect(blob).toContain('周恪把银钥匙交给白薇');
    expect(blob).toContain('谁对谁做了什么');
  });

  it('renders memory_summary text that preserves actors, object, transfer and promise', () => {
    const memorySummaries = simulatedChapterSummaries.map(summary =>
      renderEpisodicMemoryText({
        brief: summary.brief,
        keywords: summary.keywords,
        events: summary.events,
        characterChanges: summary.characterChanges,
        relationshipChanges: summary.relationshipChanges,
        mainlineChanges: summary.mainlineChanges,
        newThreads: summary.newThreads,
        resolvedThreads: summary.resolvedThreads,
      }),
    );

    const joined = memorySummaries.join('\n');
    expect(joined).toContain('林岚');
    expect(joined).toContain('周恪');
    expect(joined).toContain('白薇');
    expect(joined).toContain('银钥匙');
    expect(joined).toMatch(/转交|交给/);
    expect(joined).toMatch(/保密|承诺/);

    expect(memorySummaries[0]).toContain('林岚');
    expect(memorySummaries[0]).toContain('周恪');
    expect(memorySummaries[1]).toContain('承诺');
    expect(memorySummaries[2]).toContain('白薇');
  });
});
