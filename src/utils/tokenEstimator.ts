import type { ChatMessage } from '../services/llm';

const MESSAGE_OVERHEAD_TOKENS = 4;

const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const ASCII_WORD_RE = /[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;

/**
 * Same word model as `estimateTokens`: CJK chars cost 1 token each, a
 * contiguous ASCII run is charged per word/punctuation, whitespace is free.
 * Used by the per-char clip loop so the consumer and the estimator always
 * agree (a run estimated as N tokens can always be clipped back to N).
 */
function costOfRun(run: string): number {
  if (!run) return 0;
  const words = run.match(ASCII_WORD_RE) || [];
  return Math.max(1, words.length);
}

export function estimateTokens(text?: string | null): number {
  if (!text) return 0;
  let tokens = 0;
  let asciiRun = '';

  const flushAscii = () => {
    if (!asciiRun) return;
    tokens += costOfRun(asciiRun);
    asciiRun = '';
  };

  for (const char of text) {
    if (CJK_RE.test(char)) {
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
  let index = 0;

  while (index < text.length) {
    const ch = text[index];
    if (CJK_RE.test(ch)) {
      if (used + 1 > budget) break;
      used += 1;
      output += ch;
      index += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      output += ch;
      index += 1;
      continue;
    }
    // ASCII run: consume the whole run and charge like the estimator does
    // (words/punctuation, not characters), so clip never undershoots the
    // same text that `estimateTokens` already counted.
    let end = index + 1;
    while (end < text.length) {
      const next = text[end];
      if (CJK_RE.test(next) || /\s/.test(next)) break;
      end += 1;
    }
    const run = text.slice(index, end);
    const cost = costOfRun(run);
    if (used + cost > budget) break;
    used += cost;
    output += run;
    index = end;
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
