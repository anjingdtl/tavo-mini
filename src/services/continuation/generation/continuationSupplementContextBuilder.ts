import { openDatabase } from '../../../data/connection/openDatabase';
import { listContinuationResourceBindings } from '../../../data/repositories/continuationResourceBindingRepository';
import { clipTextToTokenBudget, estimateTokens } from '../../../utils/tokenEstimator';
import { sha256Hex } from '../hashUtils';
import type { ContinuationSupplementBundle } from './types';

/** Builds only explicitly opted-in, non-Canon material. Never calls buildContext. */
export async function buildContinuationSupplementContext(input: {
  projectId: number;
  tokenBudget: number;
}): Promise<ContinuationSupplementBundle> {
  const bindings = (await listContinuationResourceBindings(input.projectId))
    .filter(
      item =>
        item.continuation_usage === 'external_supplement' &&
        item.enabled_for_continuation === 1,
    )
    .sort(
      (a, b) =>
        a.sort_order - b.sort_order ||
        a.resource_kind.localeCompare(b.resource_kind) ||
        a.resource_id - b.resource_id,
    );
  const db = await openDatabase();
  const selected: ContinuationSupplementBundle['selected'] = [];
  const excluded: ContinuationSupplementBundle['excluded'] = [];
  let remaining = Math.max(0, input.tokenBudget);
  const take = (
    kind: 'character' | 'worldbook' | 'note' | 'preset',
    id: number,
    title: string,
    raw: string,
    maxTokens?: number,
  ) => {
    if (remaining <= 0) {
      excluded.push({ resourceKind: kind, resourceId: id, title, reason: '外部补充预算不足' });
      return '';
    }
    const resourceBudget =
      typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0
        ? Math.min(remaining, Math.floor(maxTokens))
        : remaining;
    const text = clipTextToTokenBudget(raw, resourceBudget);
    if (!text) {
      excluded.push({ resourceKind: kind, resourceId: id, title, reason: '内容为空或预算不足' });
      return '';
    }
    remaining -= estimateTokens(text);
    selected.push({
      resourceKind: kind,
      resourceId: id,
      title,
      estimatedTokens: estimateTokens(text),
      contentHash: sha256Hex(text),
      constraintKind:
        kind === 'worldbook'
          ? 'factual'
          : kind === 'preset'
          ? 'stylistic'
          : kind === 'note'
          ? 'instruction'
          : 'creative',
      stageEligibility: ['writer', 'checker', 'repair'],
      selectionReason: 'external_supplement_enabled_and_within_stage_budget',
    });
    return text;
  };
  const ids = (kind: string) => bindings.filter(b => b.resource_kind === kind).map(b => b.resource_id);
  const readRows = async (table: string, resourceIds: number[]) => {
    if (!resourceIds.length) return [] as any[];
    const kind = table === 'characters' ? 'character' : table === 'worldbook_entries' ? 'worldbook' : table === 'notes' ? 'note' : 'preset';
    const [result] = await db.executeSql(`SELECT r.* FROM ${table} r
      JOIN project_resources pr ON pr.resource_id = r.id AND pr.resource_type = ?
      WHERE pr.project_id = ? AND pr.enabled = 1 AND r.id IN (${resourceIds.map(() => '?').join(',')})`, [kind, input.projectId, ...resourceIds]);
    return Array.from({ length: result.rows.length }, (_, index) => result.rows.item(index)).sort(
      (a, b) => resourceIds.indexOf(a.id) - resourceIds.indexOf(b.id),
    );
  };
  const characterLines: string[] = [];
  for (const row of await readRows('characters', ids('character'))) {
    let card: any = {};
    try { card = JSON.parse(row.data_json || '{}').data || JSON.parse(row.data_json || '{}'); } catch {}
    const title = row.name || card.name || '未命名角色';
    const text = take(
      'character',
      row.id,
      title,
      `角色「${title}」\n描述：${card.description || ''}\n性格：${card.personality || ''}\n场景：${card.scenario || ''}`,
      row.max_tokens,
    );
    if (text) characterLines.push(text);
  }
  const worldbookLines: string[] = [];
  for (const row of await readRows('worldbook_entries', ids('worldbook'))) {
    const title = row.keyword_primary || '未命名世界书条目';
    const text = take(
      'worldbook',
      row.id,
      title,
      `世界书「${title}」\n${row.content || ''}`,
      row.max_tokens,
    );
    if (text) worldbookLines.push(text);
  }
  const noteLines: string[] = [];
  for (const row of await readRows('notes', ids('note'))) {
    const title = row.title || '无标题笔记';
    const text = take(
      'note',
      row.id,
      title,
      `笔记「${title}」\n${row.content || ''}`,
      row.max_tokens,
    );
    if (text) noteLines.push(text);
  }
  const presetRows = await readRows('presets', ids('preset'));
  const preset = presetRows[0];
  const presetText = preset
    ? take(
        'preset',
        preset.id,
        preset.name || '续写补充预设',
        [
          preset.system_prompt,
          preset.writing_style && `写作风格：${preset.writing_style}`,
          preset.extra_instructions && `附加要求：${preset.extra_instructions}`,
        ]
          .filter(Boolean)
          .join('\n'),
        preset.max_tokens,
      )
    : '';
  return { characterText: characterLines.join('\n\n'), worldbookText: worldbookLines.join('\n\n'), noteText: noteLines.join('\n\n'), presetText, selected, excluded };
}
