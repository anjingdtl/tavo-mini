import type {
  LorebookEntry,
  LorebookV3,
  NovelWorldbookDraft,
  NovelWorldbookEntryDraft,
} from './targets';

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter(Boolean);
  const text = asString(value);
  return text
    ? text.split(/[,，\n、；;]/).map(item => item.trim()).filter(Boolean)
    : [];
}

/** 归一化模型世界资料，兼容少量旧 keys/comment 形态但不依赖其协议元数据。 */
export function parseNovelWorldbookDraft(value: unknown): NovelWorldbookDraft {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const data = source.data && typeof source.data === 'object' && !Array.isArray(source.data)
    ? (source.data as Record<string, unknown>)
    : source;
  const rawEntries = Array.isArray(data.entries)
    ? data.entries
    : data.entries && typeof data.entries === 'object'
      ? Object.values(data.entries as Record<string, unknown>)
      : [];
  const entries: NovelWorldbookEntryDraft[] = rawEntries.map(entry => {
    const record = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
    const title = asString(record.title ?? record.comment ?? record.name);
    const keywords = asStringArray(record.keywords ?? record.keys ?? record.keyword);
    return {
      title,
      category: asString(record.category) || undefined,
      keywords,
      content: asString(record.content),
    };
  });
  return { name: asString(data.name) || '未命名世界书', entries };
}

/** 把小说世界事实 draft 确定性编译为 Lorebook v3。 */
export function novelWorldbookDraftToLorebook(
  draft: NovelWorldbookDraft,
): LorebookV3 {
  const normalized = parseNovelWorldbookDraft(draft);
  const entries: LorebookEntry[] = normalized.entries.map((entry, index) => {
    const title = asString(entry.title) || `世界设定 ${index + 1}`;
    const keywords = asStringArray(entry.keywords);
    return {
      keys: keywords.length > 0 ? keywords : [title],
      secondary_keys: [],
      content: asString(entry.content),
      comment: title,
      ...(entry.category ? { category: asString(entry.category) } : {}),
      enabled: true,
      constant: true,
      insertion_order: index,
    };
  });
  return {
    spec: 'lorebook_v3',
    spec_version: '1.0',
    data: { name: normalized.name, entries },
  };
}
