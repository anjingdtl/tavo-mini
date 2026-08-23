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
  // Two-phase elastic allocation (Context-Budget elastic semantics): the
  // per-resource `max_tokens` is a SOFT cap. When the supplement budget
  // covers the natural size of every opted-in resource, inject them whole —
  // the resource library borrows the plentiful context instead of being
  // truncated by a fixed per-item injection ceiling.
  interface PendingSupplement {
    kind: 'character' | 'worldbook' | 'note' | 'preset';
    id: number;
    title: string;
    raw: string;
    maxTokens?: number;
  }
  const pending: PendingSupplement[] = [];
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
  for (const row of await readRows('characters', ids('character'))) {
    let card: any = {};
    try { card = JSON.parse(row.data_json || '{}').data || JSON.parse(row.data_json || '{}'); } catch {}
    const title = row.name || card.name || '未命名角色';
    pending.push({
      kind: 'character',
      id: row.id,
      title,
      raw: `角色「${title}」\n描述：${card.description || ''}\n性格：${card.personality || ''}\n场景：${card.scenario || ''}`,
      maxTokens: row.max_tokens,
    });
  }
  for (const row of await readRows('worldbook_entries', ids('worldbook'))) {
    const title = row.keyword_primary || '未命名世界书条目';
    pending.push({
      kind: 'worldbook',
      id: row.id,
      title,
      raw: `世界书「${title}」\n${row.content || ''}`,
      maxTokens: row.max_tokens,
    });
  }
  for (const row of await readRows('notes', ids('note'))) {
    const title = row.title || '无标题笔记';
    pending.push({
      kind: 'note',
      id: row.id,
      title,
      raw: `笔记「${title}」\n${row.content || ''}`,
      maxTokens: row.max_tokens,
    });
  }
  const presetRows = await readRows('presets', ids('preset'));
  const preset = presetRows[0];
  if (preset) {
    pending.push({
      kind: 'preset',
      id: preset.id,
      title: preset.name || '续写补充作家风格',
      raw: [
        preset.system_prompt,
        preset.writing_style && `写作风格：${preset.writing_style}`,
        preset.extra_instructions && `附加要求：${preset.extra_instructions}`,
      ]
        .filter(Boolean)
        .join('\n'),
      maxTokens: preset.max_tokens,
    });
  }
  const naturalTotal = pending.reduce(
    (sum, item) => sum + estimateTokens(item.raw),
    0,
  );
  const fullFit = remaining > 0 && naturalTotal <= remaining;
  const take = (item: PendingSupplement) => {
    if (remaining <= 0) {
      excluded.push({ resourceKind: item.kind, resourceId: item.id, title: item.title, reason: '外部补充预算不足' });
      return '';
    }
    const resourceBudget = fullFit
      ? remaining
      : typeof item.maxTokens === 'number' && Number.isFinite(item.maxTokens) && item.maxTokens > 0
        ? Math.min(remaining, Math.floor(item.maxTokens))
        : remaining;
    const text = clipTextToTokenBudget(item.raw, resourceBudget);
    if (!text) {
      excluded.push({ resourceKind: item.kind, resourceId: item.id, title: item.title, reason: '内容为空或预算不足' });
      return '';
    }
    remaining -= estimateTokens(text);
    selected.push({
      resourceKind: item.kind,
      resourceId: item.id,
      title: item.title,
      estimatedTokens: estimateTokens(text),
      contentHash: sha256Hex(text),
      constraintKind:
        item.kind === 'worldbook'
          ? 'factual'
          : item.kind === 'preset'
          ? 'stylistic'
          : item.kind === 'note'
          ? 'instruction'
          : 'creative',
      stageEligibility: ['writer', 'checker', 'repair'],
      selectionReason: fullFit
        ? 'external_supplement_elastic_full_fit'
        : 'external_supplement_enabled_and_within_stage_budget',
    });
    return text;
  };
  const characterLines: string[] = [];
  const worldbookLines: string[] = [];
  const noteLines: string[] = [];
  let presetText = '';
  for (const item of pending) {
    const text = take(item);
    if (!text) continue;
    if (item.kind === 'character') characterLines.push(text);
    else if (item.kind === 'worldbook') worldbookLines.push(text);
    else if (item.kind === 'note') noteLines.push(text);
    else presetText = text;
  }
  return { characterText: characterLines.join('\n\n'), worldbookText: worldbookLines.join('\n\n'), noteText: noteLines.join('\n\n'), presetText, selected, excluded };
}
