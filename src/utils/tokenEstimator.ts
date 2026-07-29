import type { ChatMessage } from '../services/llm';

const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokens(text?: string | null): number {
  if (!text) return 0;
  let tokens = 0;
  let asciiRun = '';

  const flushAscii = () => {
    if (!asciiRun) return;
    const words = asciiRun.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) || [];
    tokens += Math.max(1, words.length);
    asciiRun = '';
  };

  for (const char of text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)) {
      flushAscii();
      tokens += 1;
    } else if (/\s/.test(char)) {
      flushAscii();
    } else {
      asciiRun += char;
    }
  }
  flushAscii();

  return Math.max(1, tokens);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (total, message) => total + MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.role) + estimateTokens(message.content),
    0,
  );
}

export function clipTextToTokenBudget(text: string, budget: number): string {
  if (budget <= 0 || !text) return '';
  let used = 0;
  let output = '';

  for (const char of text) {
    const nextCost = estimateTokens(char);
    if (used + nextCost > budget) break;
    used += nextCost;
    output += char;
  }

  return output;
}

/**
 * Retain the most recent part of text within a token budget.
 *
 * Continuation seams must end at the source boundary: keeping the prefix of a
 * previous chapter drops the event that the next chapter is meant to inherit.
 * Iterate backwards and slice once so long Chinese chapters remain O(n).
 */
export function clipTextTailToTokenBudget(text: string, budget: number): string {
  if (budget <= 0 || !text) return '';
  let used = 0;
  let start = text.length;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const cost = estimateTokens(text[index]);
    if (used + cost > budget) break;
    used += cost;
    start = index;
  }
  return text.slice(start).trimStart();
}
