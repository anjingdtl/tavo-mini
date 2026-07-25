/**
 * Pipeline context → audit messages integration tests (SPEC §7, §8).
 *
 * Verifies the full chain:
 *   buildContext() → PipelineContextSnapshot
 *     → buildReviewContextFromSnapshot / buildFactCheckContextFromSnapshot
 *       / buildProofConstraintsFromSnapshot
 *     → buildReviewMessages / buildFactCheckMessages / buildProofMessages
 *
 * This catches drift between the snapshot shape and the message builders —
 * e.g. if a field is renamed in the snapshot but the message builder still
 * reads the old name, the audit stage would silently lose that context.
 */
import {
  buildReviewContextFromSnapshot,
  buildFactCheckContextFromSnapshot,
  buildProofConstraintsFromSnapshot,
} from '../src/types/pipelineContext';
import {
  buildReviewMessages,
  buildFactCheckMessages,
  buildProofMessages,
} from '../src/services/pipelineMessages';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';

function fullSnapshot(): PipelineContextSnapshot {
  return {
    presetText: '冷峻克制的悬疑风格，多用短句。',
    storyMemoryText: '张明与李雪是旧识。张明持有银钥匙。',
    characterText: '角色「张明」：资深刑警，谨慎多疑。',
    noteText: '注意：张明对密室有心理阴影。',
    worldbookText: '银钥匙是开启钟楼密室的唯一道具。龙族不能进入盐湖。',
    episodicMemoryText: '第3章：张明获得铜钥匙。第7章：张明把银钥匙交给李雪。',
    recentBridgeText: '【第7章】张明把银钥匙交给李雪，叮嘱她保管。',
    currentInstructionText: '当前章节：「第8章」 章节概要：张明独自调查盐湖边线索。',
    retrievalUserPrompt: '继续推进调查，让张明发现新证据。',
    sourceFingerprint: 'proj=7|chapter=8',
  };
}

test('review stage receives every enabled draft context from snapshot', () => {
  const snap = fullSnapshot();
  const ctx = buildReviewContextFromSnapshot(snap);
  const messages = buildReviewMessages('初稿正文', ctx);
  const userContent = messages.find(m => m.role === 'user')!.content;

  expect(userContent).toContain('冷峻克制');
  expect(userContent).toContain('张明');
  expect(userContent).toContain('旧识');
  expect(userContent).toContain('龙族不能进入盐湖');
  expect(userContent).toContain('心理阴影');
  expect(userContent).toContain('铜钥匙');
  expect(userContent).toContain('银钥匙交给李雪');
  expect(userContent).toContain('第8章');
});

test('fact-check stage receives every enabled draft context from snapshot', () => {
  const snap = fullSnapshot();
  const ctx = buildFactCheckContextFromSnapshot(snap);
  const messages = buildFactCheckMessages('初稿正文', ctx);
  const userContent = messages.find(m => m.role === 'user')!.content;

  // World rules
  expect(userContent).toContain('冷峻克制');
  expect(userContent).toContain('龙族不能进入盐湖');
  // Story Memory
  expect(userContent).toContain('旧识');
  // Episodic events
  expect(userContent).toContain('铜钥匙');
  expect(userContent).toContain('银钥匙交给李雪');
  // Bridge
  expect(userContent).toContain('第7章');
  // Character
  expect(userContent).toContain('刑警');
  // Note
  expect(userContent).toContain('心理阴影');
});

test('proof stage receives every enabled draft constraint + both reports from snapshot', () => {
  const snap = fullSnapshot();
  const constraints = buildProofConstraintsFromSnapshot(snap);
  const reviewText = '{"issues":["节奏过快"]}';
  const factCheckText = '{"errors":["张明不该持有银钥匙"]}';
  const messages = buildProofMessages('初稿正文', reviewText, factCheckText, constraints);
  const userContent = messages.find(m => m.role === 'user')!.content;

  // Hard constraints derived from snapshot
  expect(userContent).toContain('第8章');
  expect(userContent).toContain('银钥匙交给李雪');
  expect(userContent).toContain('刑警');
  expect(userContent).toContain('龙族不能进入盐湖');
  expect(userContent).toContain('冷峻克制');
  expect(userContent).toContain('心理阴影');
  expect(userContent).toContain('铜钥匙');
  // Both audit reports
  expect(userContent).toContain('节奏过快');
  expect(userContent).toContain('张明不该持有银钥匙');
  // Draft
  expect(userContent).toContain('初稿正文');
});

test('snapshot field renames would surface as missing context (regression guard)', () => {
  // If someone renamed e.g. worldbookText → wbText in PipelineContextSnapshot,
  // the snapshot→context converter would still compile (TS structural), but the
  // fact-check user content would lose the worldbook partition. This test pins
  // the contract: the worldbook MUST reach fact-check.
  const snap = fullSnapshot();
  const ctx = buildFactCheckContextFromSnapshot(snap);
  // The converter must carry the worldbook field through.
  expect(ctx.worldbookText).toBe(snap.worldbookText);
  expect(ctx.episodicMemoryText).toBe(snap.episodicMemoryText);
  expect(ctx.recentBridgeText).toBe(snap.recentBridgeText);
});

test('snapshot with empty sections does not break the audit message builders', () => {
  const snap: PipelineContextSnapshot = {
    presetText: '',
    storyMemoryText: '',
    characterText: '',
    noteText: '',
    worldbookText: '',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '',
    retrievalUserPrompt: '',
  };
  const reviewMessages = buildReviewMessages(
    'd',
    buildReviewContextFromSnapshot(snap),
  );
  const factCheckMessages = buildFactCheckMessages(
    'd',
    buildFactCheckContextFromSnapshot(snap),
  );
  const proofMessages = buildProofMessages(
    'd',
    '',
    '',
    buildProofConstraintsFromSnapshot(snap),
  );
  // All three builders must produce valid messages with at least the draft.
  expect(reviewMessages.length).toBeGreaterThan(0);
  expect(factCheckMessages.length).toBeGreaterThan(0);
  expect(proofMessages.length).toBeGreaterThan(0);
  // No empty partition headers leaked.
  const fcUser = factCheckMessages.find(m => m.role === 'user')!.content;
  expect(fcUser).not.toMatch(/【[^】]+】\n\n【/);
});
