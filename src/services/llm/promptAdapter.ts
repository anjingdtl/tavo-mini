import { estimateMessagesTokens, clipTextToTokenBudget } from '../../utils/tokenEstimator';
import type { ChatMessage } from './types';

export function adaptMessagesForLocalModel(
  messages: ChatMessage[],
  contextWindow: number,
  maxOutputTokens: number,
): ChatMessage[] {
  const safetyMargin = Math.max(128, Math.floor(contextWindow * 0.05));
  const inputBudget = contextWindow - maxOutputTokens - safetyMargin;

  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  let used = estimateMessagesTokens(systemMessages);
  const result: ChatMessage[] = [...systemMessages];

  const lastUser = nonSystem.filter(m => m.role === 'user').pop();
  const others = lastUser ? nonSystem.filter(m => m !== lastUser) : nonSystem;

  if (lastUser) {
    const cost = estimateMessagesTokens([lastUser]);
    if (used + cost <= inputBudget) {
      result.push(lastUser);
      used += cost;
    }
  }

  for (let i = others.length - 1; i >= 0; i -= 1) {
    const cost = estimateMessagesTokens([others[i]]);
    if (used + cost > inputBudget) break;
    result.splice(systemMessages.length, 0, others[i]);
    used += cost;
  }

  return result;
}

export { clipTextToTokenBudget };
