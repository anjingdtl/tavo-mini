/**
 * Lightweight style profile extraction from bounded source text (Spec §13).
 * Statistics only — no long original passages for copy.
 */
import { openDatabase } from '../../../data/connection/openDatabase';
import { continuationSourceReader } from '../continuationSourceReader';
import { CanonQueryService } from '../canon/canonQueryService';
import type { ContinuationStyleProfile } from './types';

function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

export async function extractAndSaveStyleProfile(
  projectId: number,
): Promise<ContinuationStyleProfile> {
  const source = await continuationSourceReader.getSnapshot(projectId);
  const snap = await CanonQueryService.getActiveSnapshot(projectId);
  const chapters =
    await continuationSourceReader.listBoundedSourceChapters(source);

  // Sample last up to 5 bounded chapters for stats only.
  const sample = chapters.slice(-5).map(c => c.content).join('\n');
  const sentences = splitSentences(sample);
  const paragraphs = sample.split(/\n{2,}/).filter(p => p.trim());
  const avgSentence =
    sentences.length === 0
      ? 0
      : sentences.reduce((s, x) => s + x.length, 0) / sentences.length;
  const avgParagraph =
    paragraphs.length === 0
      ? 0
      : paragraphs.reduce((s, x) => s + x.length, 0) / paragraphs.length;
  const dialogueChars = (sample.match(/[“「『"].*?[”」』"]/gs) || []).join('')
    .length;
  const dialogueRatio =
    sample.length === 0 ? 0 : Math.min(1, dialogueChars / sample.length);
  const descriptionRatio = Math.max(0, 1 - dialogueRatio);

  let narrativePerson = '第三人称';
  if ((sample.match(/我/g) || []).length > (sample.match(/他|她/g) || []).length) {
    narrativePerson = '第一人称';
  }

  const profile: ContinuationStyleProfile = {
    projectId,
    sourceId: source.sourceId,
    canonSnapshotId: snap.id,
    canonRevision: snap.revision,
    narrativePerson,
    tense: '过去/叙述',
    averageSentenceLength: avgSentence,
    averageParagraphLength: avgParagraph,
    dialogueRatio,
    descriptionRatio,
    pacingNotes: avgSentence > 40 ? '长句偏多，节奏偏缓' : '句长适中',
    lexicalNotes: '基于原著末段统计，勿逐句复制',
    sampleEvidenceIds: [],
    reviewStatus: 'pending',
  };

  const db = await openDatabase();
  const ts = new Date().toISOString();
  await db.executeSql(
    `INSERT OR REPLACE INTO continuation_style_profiles (
      project_id, source_id, canon_snapshot_id, canon_revision,
      narrative_person, tense, average_sentence_length, average_paragraph_length,
      dialogue_ratio, description_ratio, pacing_notes, lexical_notes,
      sample_evidence_ids_json, review_status, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      profile.projectId,
      profile.sourceId,
      profile.canonSnapshotId,
      profile.canonRevision,
      profile.narrativePerson,
      profile.tense,
      profile.averageSentenceLength,
      profile.averageParagraphLength,
      profile.dialogueRatio,
      profile.descriptionRatio,
      profile.pacingNotes,
      profile.lexicalNotes,
      '[]',
      profile.reviewStatus,
      ts,
      ts,
    ],
  );
  return profile;
}

export async function getStyleProfile(
  projectId: number,
): Promise<ContinuationStyleProfile | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    'SELECT * FROM continuation_style_profiles WHERE project_id = ?',
    [projectId],
  );
  if (res.rows.length === 0) return null;
  const r = res.rows.item(0);
  return {
    projectId: r.project_id,
    sourceId: r.source_id,
    canonSnapshotId: r.canon_snapshot_id,
    canonRevision: r.canon_revision,
    narrativePerson: r.narrative_person,
    tense: r.tense,
    averageSentenceLength: r.average_sentence_length,
    averageParagraphLength: r.average_paragraph_length,
    dialogueRatio: r.dialogue_ratio,
    descriptionRatio: r.description_ratio,
    pacingNotes: r.pacing_notes,
    lexicalNotes: r.lexical_notes,
    sampleEvidenceIds: JSON.parse(r.sample_evidence_ids_json || '[]'),
    reviewStatus: r.review_status,
  };
}
