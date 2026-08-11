/**
 * Prompt byte-stability diagnostics (Prompt Cache P1).
 *
 * These helpers exist ONLY for testing and diagnostics. They let a test prove
 * that "the same business input produces the same request bytes" — the
 * precondition for DeepSeek prefix-cache reuse. They MUST NEVER:
 *
 * - enter the request body sent to the provider;
 * - enter the model prompt;
 * - influence any business branch, retry decision, budget gate or cache logic;
 * - be treated as the provider's real internal cache key (we cannot observe
 *   that; these fingerprints only describe the bytes WE send).
 *
 * The fingerprint is `JSON.stringify(messages)` over UTF-8 → SHA-256. It is
 * deliberately the same family as `computeFrozenDraftRequestFingerprint` /
 * `stageFingerprint`, but scoped to message bytes only (no window params), so
 * tests can isolate prompt-construction determinism from budget allocation.
 */
import type { ChatMessage } from './types';
import { sha256Hex } from '../continuation/hashUtils';

/**
 * Serialise chat messages into the canonical string used for diagnostics.
 * Mirrors what a fingerprint needs: role + content, in array order. This is a
 * pure function — calling it twice with structurally-equal messages MUST yield
 * the exact same string, otherwise there is a non-deterministic serialization
 * bug in prompt construction (the thing P1 hunts for).
 */
export function serializeChatMessagesForFingerprint(
  messages: readonly ChatMessage[],
): string {
  return JSON.stringify(messages);
}

/**
 * SHA-256 (lowercase hex, full 64 chars) of the serialised messages. Diagnostic
 * only. Two equal fingerprints mean the bytes we send are identical; two
 * different fingerprints prove a byte-level divergence that may hurt cache
 * reuse even though the business meaning is unchanged.
 */
export function fingerprintChatMessages(
  messages: readonly ChatMessage[],
): string {
  return sha256Hex(serializeChatMessagesForFingerprint(messages));
}
